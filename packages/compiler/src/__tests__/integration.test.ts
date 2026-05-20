/**
 * Compiler integration test — exercises all 6 passes end-to-end with a
 * mocked ClaudeClient.
 *
 * The mock client routes responses by inspecting the system prompt, so each
 * pass gets a realistic-looking compiled page without any network calls. No
 * API key is required.
 *
 * Test scenarios:
 *   1. Full pipeline happy path (ingest → all 6 passes → wiki index rebuilt)
 *   2. Deterministic quality guards (validation, concept count, word count)
 *   3. Staleness detection after source modification
 *   4. Link pass idempotency
 *   5. No-contradictions sentinel handled correctly
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  type Database,
  initDatabase,
  initWorkspace,
  rebuildWikiIndex,
} from '@ico/kernel';
import { ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import { runIngestPipeline } from '../ingest-pipeline.js';
import { detectContradictions } from '../passes/contradict.js';
import { extractConcepts } from '../passes/extract.js';
import { identifyGaps } from '../passes/gap.js';
import { addBacklinks } from '../passes/link.js';
import { summarizeSource } from '../passes/summarize.js';
import { synthesizeTopics } from '../passes/synthesize.js';
import { detectStalePages, getUncompiledSources } from '../staleness.js';
import { validateCompiledPage } from '../validation.js';

// ---------------------------------------------------------------------------
// Mock fixture responses
// ---------------------------------------------------------------------------

const PAGE_BREAK = '---PAGE_BREAK---';

/**
 * Realistic source-summary page returned by the summarize pass mock.
 * The source_id and content_hash placeholders are filled at runtime.
 */
function makeMockSummary(sourceId: string, sourcePath: string, hash: string): string {
  return `---
type: source-summary
id: 11111111-2222-3333-4444-555555555555
title: Test Source Summary
source_id: ${sourceId}
source_path: ${sourcePath}
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
content_hash: ${hash}
---

# Test Source Summary

## Summary

This is a test summary of the source document covering knowledge compilation.

## Key Claims

1. First key claim about knowledge representation.
2. Second key claim about semantic graphs.

## Methods

Test methods description involving controlled experiments.

## Conclusions

Test conclusions about structured knowledge bases.
`;
}

/**
 * Second source summary for a different source — used for the synthesize
 * pass which requires at least two sources.
 */
function makeMockSummary2(sourceId: string, sourcePath: string, hash: string): string {
  return `---
type: source-summary
id: 22222222-3333-4444-5555-666666666666
title: Second Source Summary
source_id: ${sourceId}
source_path: ${sourcePath}
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
content_hash: ${hash}
---

# Second Source Summary

## Summary

This is a test summary of the second source document about semantic networks.
It discusses [[test-concept]] and how knowledge graphs relate to [[test-source]].

## Key Claims

1. Semantic networks improve knowledge retrieval.
2. Ontology design affects query performance.

## Methods

Comparative analysis across multiple knowledge base implementations.

## Conclusions

Well-structured ontologies reduce query latency significantly.
`;
}

const MOCK_CONCEPT_PAGE = `---
type: concept
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
title: Test Concept
definition: A test concept for validation purposes.
source_ids:
  - 11111111-2222-3333-4444-555555555555
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

# Test Concept

## Definition

A test concept for validation purposes.

## Discussion

Extended discussion of the test concept and its implications for knowledge systems.

## Sources

- [[test-source]] -- primary reference
`;

const MOCK_ENTITY_PAGE = `---
type: entity
id: bbbbbbbb-cccc-dddd-eeee-ffffffffffff
title: Test Entity
entity_type: tool
source_ids:
  - 11111111-2222-3333-4444-555555555555
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

# Test Entity

A test entity representing a knowledge compilation tool.
`;

const MOCK_TOPIC_PAGE = `---
type: topic
id: cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa
title: Test Topic
summary: A topic synthesized from multiple source summaries.
source_ids:
  - 11111111-2222-3333-4444-555555555555
  - 22222222-3333-4444-5555-666666666666
concept_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

# Test Topic

## Overview

This topic synthesizes insights from both source documents about knowledge representation.

## Key Aspects

### Semantic Structure

Both sources agree that semantic structure improves knowledge retrieval.

### Graph-Based Approaches

Graph-based knowledge representations support complex query patterns.
`;

const MOCK_CONTRADICTION_PAGE = `---
type: contradiction
id: dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb
title: Test Contradiction
severity: low
source_ids:
  - 11111111-2222-3333-4444-555555555555
  - 22222222-3333-4444-5555-666666666666
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

# Test Contradiction

## Conflicting Claims

1. Source A claims flat indexes suffice for small corpora.
2. Source B claims graph structure is always beneficial.

## Sources

Source A: "flat text indexes work well" vs Source B: "structured knowledge is required".

## Analysis

The contradiction is minor and may reflect differences in corpus scale rather than genuine conflict.
`;

const MOCK_GAP_PAGE = `---
type: open-question
id: eeeeeeee-ffff-aaaa-bbbb-cccccccccccc
title: Test Open Question
priority: medium
evidence_strength: weak
related_page_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

# Test Open Question

## The Gap

The current knowledge base lacks empirical evaluation of the proposed methods.

## Current Evidence

Only theoretical claims are present without experimental validation.

## Suggested Next Steps

Locate empirical studies that evaluate knowledge compilation approaches.
`;

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock ClaudeClient that returns different fixture responses based
 * on the system prompt content, mimicking how each pass identifies itself.
 *
 * The mock inspects key phrases unique to each pass's frozen system prompt
 * (from 017-AT-PRMP) to route the correct fixture response.
 *
 * Call `setNextSummary` before each summarize invocation to supply per-call
 * responses when multiple sources are being summarized sequentially.
 */
function createMockClient(summaryPages: string[]): ClaudeClient {
  let summaryCallCount = 0;

  return {
    createCompletion: vi.fn().mockImplementation((system: string, _user: string) => {
      // Summarize pass — identified by its unique system prompt phrase.
      if (system.includes('source summary page')) {
        const page = summaryPages[summaryCallCount] ?? summaryPages[summaryPages.length - 1] ?? '';
        summaryCallCount++;
        return ok({
          content: page,
          inputTokens: 100,
          outputTokens: 200,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }

      // Extract pass.
      if (system.includes('extract discrete concepts')) {
        return ok({
          content: `${MOCK_CONCEPT_PAGE}${PAGE_BREAK}\n${MOCK_ENTITY_PAGE}`,
          inputTokens: 150,
          outputTokens: 300,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }

      // Synthesize pass.
      if (system.includes('synthesize topic pages')) {
        return ok({
          content: MOCK_TOPIC_PAGE,
          inputTokens: 200,
          outputTokens: 250,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }

      // Contradict pass — default returns a contradiction page.
      if (system.includes('detect contradictions')) {
        return ok({
          content: MOCK_CONTRADICTION_PAGE,
          inputTokens: 120,
          outputTokens: 180,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }

      // Gap pass.
      if (system.includes('knowledge gaps')) {
        return ok({
          content: MOCK_GAP_PAGE,
          inputTokens: 130,
          outputTokens: 190,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }

      // Fallback — should not normally be reached.
      return ok({
        content: '---\ntype: unknown\n---\nFallback response.',
        inputTokens: 10,
        outputTokens: 10,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      });
    }),
  };
}

/**
 * Creates a mock ClaudeClient whose contradiction pass returns the
 * NO_CONTRADICTIONS_FOUND sentinel.
 */
function createNoContradictionsClient(summaryPages: string[]): ClaudeClient {
  let summaryCallCount = 0;

  return {
    createCompletion: vi.fn().mockImplementation((system: string, _user: string) => {
      if (system.includes('source summary page')) {
        const page = summaryPages[summaryCallCount] ?? summaryPages[summaryPages.length - 1] ?? '';
        summaryCallCount++;
        return ok({
          content: page,
          inputTokens: 100,
          outputTokens: 200,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }
      if (system.includes('extract discrete concepts')) {
        return ok({
          content: MOCK_CONCEPT_PAGE,
          inputTokens: 150,
          outputTokens: 300,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }
      if (system.includes('synthesize topic pages')) {
        return ok({
          content: MOCK_TOPIC_PAGE,
          inputTokens: 200,
          outputTokens: 250,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }
      if (system.includes('detect contradictions')) {
        return ok({
          content: 'NO_CONTRADICTIONS_FOUND',
          inputTokens: 120,
          outputTokens: 5,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }
      if (system.includes('knowledge gaps')) {
        return ok({
          content: MOCK_GAP_PAGE,
          inputTokens: 130,
          outputTokens: 190,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        });
      }
      return ok({
        content: '---\ntype: unknown\n---\nFallback.',
        inputTokens: 10,
        outputTokens: 10,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// Test environment setup
// ---------------------------------------------------------------------------

interface TestEnv {
  base: string;
  wsRoot: string;
  dbPath: string;
  db: Database;
  sourceDir: string;
}

/** Writes a UTF-8 file and returns its absolute path. */
function writeFixture(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function setupEnv(): TestEnv {
  const base = mkdtempSync(join(tmpdir(), 'ico-integration-'));
  const wsResult = initWorkspace('ws', base);
  if (!wsResult.ok) throw new Error(`initWorkspace: ${wsResult.error.message}`);
  const { root: wsRoot, dbPath } = wsResult.value;
  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) throw new Error(`initDatabase: ${dbResult.error.message}`);
  const sourceDir = mkdtempSync(join(tmpdir(), 'ico-integration-src-'));
  return { base, wsRoot, dbPath, db: dbResult.value, sourceDir };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('compiler integration', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    closeDatabase(env.db);
    rmSync(env.base, { recursive: true, force: true });
    try {
      rmSync(env.sourceDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // =========================================================================
  // 1. Full pipeline happy path
  // =========================================================================

  describe('full pipeline happy path', () => {
    it('runs all 6 passes and produces output files', async () => {
      // ---- Arrange: write 2 fixture source files and ingest them -----------
      const src1 = writeFixture(
        env.sourceDir,
        'source-one.md',
        '# Source One\n\nKnowledge compilation is the process of transforming raw documents into structured knowledge.\n',
      );
      const src2 = writeFixture(
        env.sourceDir,
        'source-two.md',
        '# Source Two\n\nSemantic networks provide a graph-based approach to knowledge representation.\n',
      );

      const ingest1 = await runIngestPipeline(src1, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest1.ok, `ingest1: ${!ingest1.ok ? ingest1.error.message : ''}`).toBe(true);
      if (!ingest1.ok) return;

      const ingest2 = await runIngestPipeline(src2, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest2.ok, `ingest2: ${!ingest2.ok ? ingest2.error.message : ''}`).toBe(true);
      if (!ingest2.ok) return;

      const summary1 = makeMockSummary(
        ingest1.value.sourceId,
        ingest1.value.path,
        ingest1.value.hash,
      );
      const summary2 = makeMockSummary2(
        ingest2.value.sourceId,
        ingest2.value.path,
        ingest2.value.hash,
      );
      const client = createMockClient([summary1, summary2]);

      // ---- Pass 1: summarize both sources ----------------------------------
      const sum1 = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest1.value.sourceId,
        '# Source One\n\nKnowledge compilation...',
        ingest1.value.path,
        ingest1.value.hash,
      );
      expect(sum1.ok, `sum1: ${!sum1.ok ? sum1.error.message : ''}`).toBe(true);

      const sum2 = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest2.value.sourceId,
        '# Source Two\n\nSemantic networks...',
        ingest2.value.path,
        ingest2.value.hash,
      );
      expect(sum2.ok, `sum2: ${!sum2.ok ? sum2.error.message : ''}`).toBe(true);
      if (!sum1.ok || !sum2.ok) return;

      // ---- Pass 2: extract concepts ----------------------------------------
      const extractResult = await extractConcepts(client, env.db, env.wsRoot, [
        sum1.value.outputPath,
        sum2.value.outputPath,
      ]);
      expect(
        extractResult.ok,
        `extract: ${!extractResult.ok ? extractResult.error.message : ''}`,
      ).toBe(true);
      if (!extractResult.ok) return;

      // ---- Pass 3: synthesize topics ---------------------------------------
      const synthResult = await synthesizeTopics(client, env.db, env.wsRoot);
      expect(synthResult.ok, `synth: ${!synthResult.ok ? synthResult.error.message : ''}`).toBe(
        true,
      );
      if (!synthResult.ok) return;

      // ---- Pass 4: add backlinks (deterministic) ---------------------------
      const linkResult = await addBacklinks(client, env.db, env.wsRoot);
      expect(linkResult.ok, `link: ${!linkResult.ok ? linkResult.error.message : ''}`).toBe(true);
      if (!linkResult.ok) return;

      // ---- Pass 5: detect contradictions -----------------------------------
      const contradictResult = await detectContradictions(client, env.db, env.wsRoot);
      expect(
        contradictResult.ok,
        `contradict: ${!contradictResult.ok ? contradictResult.error.message : ''}`,
      ).toBe(true);
      if (!contradictResult.ok) return;

      // ---- Pass 6: identify gaps -------------------------------------------
      const gapResult = await identifyGaps(client, env.db, env.wsRoot);
      expect(gapResult.ok, `gap: ${!gapResult.ok ? gapResult.error.message : ''}`).toBe(true);
      if (!gapResult.ok) return;

      // ---- Assertions: files exist on disk ---------------------------------

      // wiki/sources/ has 2 summary files
      const sourcesDir = resolve(env.wsRoot, 'wiki', 'sources');
      const summaryFiles = readdirSync(sourcesDir).filter(
        (f) => f.endsWith('.md') && f !== '.gitkeep',
      );
      expect(summaryFiles.length).toBe(2);

      // wiki/concepts/ has at least 1 concept file (mock returns concept + entity)
      const conceptsDir = resolve(env.wsRoot, 'wiki', 'concepts');
      expect(existsSync(conceptsDir)).toBe(true);
      const conceptFiles = readdirSync(conceptsDir).filter(
        (f) => f.endsWith('.md') && f !== '.gitkeep',
      );
      expect(conceptFiles.length).toBeGreaterThanOrEqual(1);

      // wiki/topics/ has at least 1 topic file
      const topicsDir = resolve(env.wsRoot, 'wiki', 'topics');
      expect(existsSync(topicsDir)).toBe(true);
      const topicFiles = readdirSync(topicsDir).filter(
        (f) => f.endsWith('.md') && f !== '.gitkeep',
      );
      expect(topicFiles.length).toBeGreaterThanOrEqual(1);

      // wiki/contradictions/ has at least 1 file
      const contradictionsDir = resolve(env.wsRoot, 'wiki', 'contradictions');
      expect(existsSync(contradictionsDir)).toBe(true);
      const contradictionFiles = readdirSync(contradictionsDir).filter(
        (f) => f.endsWith('.md') && f !== '.gitkeep',
      );
      expect(contradictionFiles.length).toBeGreaterThanOrEqual(1);

      // wiki/open-questions/ has at least 1 file
      const openQDir = resolve(env.wsRoot, 'wiki', 'open-questions');
      expect(existsSync(openQDir)).toBe(true);
      const gapFiles = readdirSync(openQDir).filter((f) => f.endsWith('.md') && f !== '.gitkeep');
      expect(gapFiles.length).toBeGreaterThanOrEqual(1);

      // ---- Assertions: compilation records in DB ---------------------------
      const compilations = env.db
        .prepare<[], { type: string }>('SELECT type FROM compilations')
        .all();
      const types = compilations.map((r) => r.type);
      expect(types).toContain('summary');
      expect(types).toContain('concept');
      expect(types).toContain('topic');
      expect(types).toContain('contradiction');
      expect(types).toContain('open-question');

      // ---- Assertions: wiki index rebuilt and lists all pages --------------
      const indexResult = rebuildWikiIndex(env.wsRoot);
      expect(
        indexResult.ok,
        `indexRebuild: ${!indexResult.ok ? indexResult.error.message : ''}`,
      ).toBe(true);
      if (!indexResult.ok) return;

      // Total pages: 2 summaries + at least 2 extracted (concept + entity) + 1 topic + 1 contradiction + 1 gap
      expect(indexResult.value).toBeGreaterThanOrEqual(7);

      const indexPath = resolve(env.wsRoot, 'wiki', 'index.md');
      const indexContent = readFileSync(indexPath, 'utf-8');
      expect(indexContent).toContain('## Sources');
      expect(indexContent).toContain('## Concepts');
      expect(indexContent).toContain('## Topics');
    });
  });

  // =========================================================================
  // 2. Deterministic quality guards (no API key needed)
  // =========================================================================

  describe('deterministic quality guards', () => {
    it('all summarize mock pages pass Zod validation via validateCompiledPage', async () => {
      const src = writeFixture(
        env.sourceDir,
        'validation-source.md',
        '# Validation Source\n\nContent for schema validation testing.\n',
      );

      const ingest = await runIngestPipeline(src, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest.ok).toBe(true);
      if (!ingest.ok) return;

      const summaryPage = makeMockSummary(
        ingest.value.sourceId,
        ingest.value.path,
        ingest.value.hash,
      );
      const client = createMockClient([summaryPage]);

      const sumResult = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest.value.sourceId,
        '# Validation Source\n\nContent.',
        ingest.value.path,
        ingest.value.hash,
      );
      expect(sumResult.ok).toBe(true);
      if (!sumResult.ok) return;

      const absPath = resolve(env.wsRoot, sumResult.value.outputPath);
      const validationResult = validateCompiledPage(absPath);
      expect(validationResult.ok, 'validateCompiledPage returned err').toBe(true);
      if (!validationResult.ok) return;
      expect(
        validationResult.value.valid,
        `Schema errors: ${validationResult.value.errors.join(', ')}`,
      ).toBe(true);
      expect(validationResult.value.pageType).toBe('source-summary');
    });

    it('concept pages produced by extract pass satisfy their Zod schema', async () => {
      const src = writeFixture(
        env.sourceDir,
        'concept-source.md',
        '# Concept Source\n\nContent about concepts.\n',
      );

      const ingest = await runIngestPipeline(src, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest.ok).toBe(true);
      if (!ingest.ok) return;

      const summaryPage = makeMockSummary(
        ingest.value.sourceId,
        ingest.value.path,
        ingest.value.hash,
      );
      const client = createMockClient([summaryPage]);

      const sumResult = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest.value.sourceId,
        '# Concept Source\n\nContent.',
        ingest.value.path,
        ingest.value.hash,
      );
      expect(sumResult.ok).toBe(true);
      if (!sumResult.ok) return;

      const extractResult = await extractConcepts(client, env.db, env.wsRoot, [
        sumResult.value.outputPath,
      ]);
      expect(extractResult.ok).toBe(true);
      if (!extractResult.ok) return;
      expect(extractResult.value.length).toBeGreaterThan(0);

      // Validate each extracted page against its schema.
      for (const extracted of extractResult.value) {
        const absPath = resolve(env.wsRoot, extracted.outputPath);
        const vr = validateCompiledPage(absPath);
        expect(vr.ok, `validateCompiledPage err for ${extracted.outputPath}`).toBe(true);
        if (!vr.ok) continue;
        expect(
          vr.value.valid,
          `Invalid page ${extracted.outputPath}: ${vr.value.errors.join(', ')}`,
        ).toBe(true);
      }
    });

    it('extract pass produces at least 1 concept', async () => {
      const src = writeFixture(
        env.sourceDir,
        'count-source.md',
        '# Count Source\n\nContent for concept counting.\n',
      );

      const ingest = await runIngestPipeline(src, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest.ok).toBe(true);
      if (!ingest.ok) return;

      const summaryPage = makeMockSummary(
        ingest.value.sourceId,
        ingest.value.path,
        ingest.value.hash,
      );
      const client = createMockClient([summaryPage]);

      const sumResult = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest.value.sourceId,
        '# Count Source\n\nContent.',
        ingest.value.path,
        ingest.value.hash,
      );
      expect(sumResult.ok).toBe(true);
      if (!sumResult.ok) return;

      const extractResult = await extractConcepts(client, env.db, env.wsRoot, [
        sumResult.value.outputPath,
      ]);
      expect(extractResult.ok).toBe(true);
      if (!extractResult.ok) return;
      expect(extractResult.value.length).toBeGreaterThan(0);
    });

    it('summary word count is within the 10-5000 word range', async () => {
      const src = writeFixture(
        env.sourceDir,
        'wordcount-source.md',
        '# Word Count Source\n\nContent for word count testing.\n',
      );

      const ingest = await runIngestPipeline(src, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest.ok).toBe(true);
      if (!ingest.ok) return;

      const summaryPage = makeMockSummary(
        ingest.value.sourceId,
        ingest.value.path,
        ingest.value.hash,
      );
      const client = createMockClient([summaryPage]);

      const sumResult = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest.value.sourceId,
        '# Word Count Source\n\nContent.',
        ingest.value.path,
        ingest.value.hash,
      );
      expect(sumResult.ok).toBe(true);
      if (!sumResult.ok) return;

      const absPath = resolve(env.wsRoot, sumResult.value.outputPath);
      const content = readFileSync(absPath, 'utf-8');
      const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
      expect(wordCount).toBeGreaterThanOrEqual(10);
      expect(wordCount).toBeLessThanOrEqual(5000);
    });
  });

  // =========================================================================
  // 3. Staleness detection after source modification
  // =========================================================================

  describe('staleness detection', () => {
    it('detects stale summary after the source ingested_at timestamp advances past compiled_at', async () => {
      const srcFile = writeFixture(
        env.sourceDir,
        'stale-source.md',
        '# Stale Source\n\nOriginal content for staleness testing.\n',
      );

      // Initial ingest via runIngestPipeline (manages its own DB connection).
      const ingest1 = await runIngestPipeline(srcFile, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest1.ok).toBe(true);
      if (!ingest1.ok) return;

      const summaryPage = makeMockSummary(
        ingest1.value.sourceId,
        ingest1.value.path,
        ingest1.value.hash,
      );
      const client = createMockClient([summaryPage]);

      // Summarize the source — this writes a compilation record with compiled_at = NOW.
      const sumResult = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest1.value.sourceId,
        '# Stale Source\n\nOriginal content.',
        ingest1.value.path,
        ingest1.value.hash,
      );
      expect(sumResult.ok).toBe(true);
      if (!sumResult.ok) return;

      // Verify no stale pages immediately after compilation.
      const beforeStale = detectStalePages(env.db);
      expect(beforeStale.ok).toBe(true);
      if (!beforeStale.ok) return;
      expect(beforeStale.value).toHaveLength(0);

      // Simulate re-ingest by advancing the source's ingested_at timestamp to a
      // future time. This is exactly what detectStalePages detects: the source was
      // re-ingested (ingested_at updated) after the compilation was run.
      const futureTimestamp = new Date(Date.now() + 60_000).toISOString();
      env.db
        .prepare<[string, string]>('UPDATE sources SET ingested_at = ? WHERE id = ?')
        .run(futureTimestamp, ingest1.value.sourceId);

      // Now detectStalePages should return the summary as stale.
      const afterStale = detectStalePages(env.db);
      expect(afterStale.ok).toBe(true);
      if (!afterStale.ok) return;
      expect(afterStale.value.length).toBeGreaterThan(0);

      const staleEntry = afterStale.value.find((p) => p.type === 'summary');
      expect(staleEntry).toBeDefined();
      expect(staleEntry?.reason).toBe('source-changed');
      expect(staleEntry?.sourceId).toBe(ingest1.value.sourceId);
    });

    it('getUncompiledSources returns empty after all sources are compiled', async () => {
      const src = writeFixture(
        env.sourceDir,
        'compiled-check.md',
        '# Compiled Check\n\nContent.\n',
      );

      const ingest = await runIngestPipeline(src, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest.ok).toBe(true);
      if (!ingest.ok) return;

      // Before compiling — source should appear as uncompiled.
      const beforeResult = getUncompiledSources(env.db);
      expect(beforeResult.ok).toBe(true);
      if (!beforeResult.ok) return;
      expect(beforeResult.value.some((s) => s.id === ingest.value.sourceId)).toBe(true);

      const summaryPage = makeMockSummary(
        ingest.value.sourceId,
        ingest.value.path,
        ingest.value.hash,
      );
      const client = createMockClient([summaryPage]);

      const sumResult = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest.value.sourceId,
        '# Compiled Check\n\nContent.',
        ingest.value.path,
        ingest.value.hash,
      );
      expect(sumResult.ok).toBe(true);

      // After compiling — no uncompiled sources remain.
      const afterResult = getUncompiledSources(env.db);
      expect(afterResult.ok).toBe(true);
      if (!afterResult.ok) return;
      expect(afterResult.value).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. Link pass is idempotent
  // =========================================================================

  describe('link pass idempotency', () => {
    it('running addBacklinks twice produces the same result', async () => {
      const src1 = writeFixture(
        env.sourceDir,
        'link-source-one.md',
        '# Link Source One\n\nKnowledge about [[link-source-two]] compilation.\n',
      );
      const src2 = writeFixture(
        env.sourceDir,
        'link-source-two.md',
        '# Link Source Two\n\nContent about semantic networks and [[link-source-one]].\n',
      );

      const ingest1 = await runIngestPipeline(src1, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      const ingest2 = await runIngestPipeline(src2, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest1.ok).toBe(true);
      expect(ingest2.ok).toBe(true);
      if (!ingest1.ok || !ingest2.ok) return;

      const summary1 = makeMockSummary(
        ingest1.value.sourceId,
        ingest1.value.path,
        ingest1.value.hash,
      );
      const summary2 = makeMockSummary2(
        ingest2.value.sourceId,
        ingest2.value.path,
        ingest2.value.hash,
      );
      const client = createMockClient([summary1, summary2]);

      const sum1 = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest1.value.sourceId,
        '# Link Source One\n\nKnowledge about [[link-source-two]] compilation.',
        ingest1.value.path,
        ingest1.value.hash,
      );
      const sum2 = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest2.value.sourceId,
        '# Link Source Two\n\nContent about [[link-source-one]].',
        ingest2.value.path,
        ingest2.value.hash,
      );
      expect(sum1.ok).toBe(true);
      expect(sum2.ok).toBe(true);

      // First link pass run.
      const link1 = await addBacklinks(client, env.db, env.wsRoot);
      expect(link1.ok).toBe(true);
      if (!link1.ok) return;

      // Capture all file contents after first run.
      const sourcesDir = resolve(env.wsRoot, 'wiki', 'sources');
      const filesAfterFirst = readdirSync(sourcesDir)
        .filter((f) => f.endsWith('.md') && f !== '.gitkeep')
        .map((f) => ({
          name: f,
          content: readFileSync(join(sourcesDir, f), 'utf-8'),
        }));

      // Second link pass run.
      const link2 = await addBacklinks(client, env.db, env.wsRoot);
      expect(link2.ok).toBe(true);
      if (!link2.ok) return;

      // File contents must be identical after the second run.
      const filesAfterSecond = readdirSync(sourcesDir)
        .filter((f) => f.endsWith('.md') && f !== '.gitkeep')
        .map((f) => ({
          name: f,
          content: readFileSync(join(sourcesDir, f), 'utf-8'),
        }));

      expect(filesAfterSecond.length).toBe(filesAfterFirst.length);
      for (const after of filesAfterSecond) {
        const before = filesAfterFirst.find((f) => f.name === after.name);
        expect(before).toBeDefined();
        expect(after.content).toBe(before!.content);
      }

      // Results should report the same counts.
      expect(link2.value.pagesUpdated).toBe(link1.value.pagesUpdated);
      expect(link2.value.totalBacklinks).toBe(link1.value.totalBacklinks);
    });
  });

  // =========================================================================
  // 5. No-contradictions sentinel
  // =========================================================================

  describe('no-contradictions sentinel', () => {
    it('returns an empty array when the mock returns NO_CONTRADICTIONS_FOUND', async () => {
      const src1 = writeFixture(
        env.sourceDir,
        'nocontra-one.md',
        '# No Contradiction One\n\nHarmless content that does not conflict.\n',
      );
      const src2 = writeFixture(
        env.sourceDir,
        'nocontra-two.md',
        '# No Contradiction Two\n\nAlso harmless content that does not conflict.\n',
      );

      const ingest1 = await runIngestPipeline(src1, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      const ingest2 = await runIngestPipeline(src2, {
        workspacePath: env.wsRoot,
        dbPath: env.dbPath,
      });
      expect(ingest1.ok).toBe(true);
      expect(ingest2.ok).toBe(true);
      if (!ingest1.ok || !ingest2.ok) return;

      const summary1 = makeMockSummary(
        ingest1.value.sourceId,
        ingest1.value.path,
        ingest1.value.hash,
      );
      const summary2 = makeMockSummary2(
        ingest2.value.sourceId,
        ingest2.value.path,
        ingest2.value.hash,
      );
      const client = createNoContradictionsClient([summary1, summary2]);

      const sum1 = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest1.value.sourceId,
        '# No Contradiction One\n\nHarmless content.',
        ingest1.value.path,
        ingest1.value.hash,
      );
      const sum2 = await summarizeSource(
        client,
        env.db,
        env.wsRoot,
        ingest2.value.sourceId,
        '# No Contradiction Two\n\nAlso harmless.',
        ingest2.value.path,
        ingest2.value.hash,
      );
      expect(sum1.ok).toBe(true);
      expect(sum2.ok).toBe(true);

      const contradictResult = await detectContradictions(client, env.db, env.wsRoot);
      expect(contradictResult.ok).toBe(true);
      if (!contradictResult.ok) return;

      // Sentinel response → empty results array, no files written.
      expect(contradictResult.value).toHaveLength(0);

      const contradictionsDir = resolve(env.wsRoot, 'wiki', 'contradictions');
      const contraFiles = existsSync(contradictionsDir)
        ? readdirSync(contradictionsDir).filter((f) => f.endsWith('.md') && f !== '.gitkeep')
        : [];
      expect(contraFiles).toHaveLength(0);
    });
  });
});
