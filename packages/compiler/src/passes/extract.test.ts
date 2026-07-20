/**
 * Tests for the extract compilation pass.
 *
 * Uses a real temporary workspace and SQLite database, with a mocked
 * ClaudeClient to avoid network calls.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, type Database, initDatabase, initWorkspace, readTraces } from '@ico/kernel';
import { ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import { extractConcepts } from './extract.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUMMARY_PATH = 'wiki/sources/my-research-paper.md';

const MOCK_SUMMARY_CONTENT = `---
type: source-summary
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
title: My Research Paper
---

## Summary
This paper discusses knowledge compilation and semantic graphs.
`;

const MOCK_CONCEPT_PAGE = `---
type: concept
id: cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa
title: Knowledge Compilation
definition: The process of transforming raw source documents into structured semantic knowledge.
source_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

Knowledge compilation transforms raw documents into structured, queryable knowledge.
`;

const MOCK_ENTITY_PAGE = `---
type: entity
id: eeeeeeee-ffff-aaaa-bbbb-cccccccccccc
title: Claude
entity_type: tool
source_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

Claude is an AI assistant developed by Anthropic.
`;

const MOCK_API_RESPONSE = `${MOCK_CONCEPT_PAGE}
---PAGE_BREAK---
${MOCK_ENTITY_PAGE}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockClient(response: string): ClaudeClient {
  return {
    createCompletion: vi.fn().mockResolvedValue(
      ok({
        content: response,
        inputTokens: 800,
        outputTokens: 300,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      }),
    ),
  };
}

function mockClientError(message: string): ClaudeClient {
  return {
    createCompletion: vi.fn().mockResolvedValue({
      ok: false,
      error: new Error(message),
    }),
  };
}

/**
 * Mock a client that returns a different response per call. The Nth invocation
 * (1-indexed by batch) resolves the Nth response in `responsesByCall`; calls
 * past the end re-use the last response. Lets a test drive multi-batch behavior.
 */
function mockClientSequence(responsesByCall: string[]): ClaudeClient {
  let call = 0;
  return {
    createCompletion: vi.fn().mockImplementation(() => {
      const response = responsesByCall[Math.min(call, responsesByCall.length - 1)] ?? '';
      call++;
      return Promise.resolve(
        ok({
          content: response,
          inputTokens: 500,
          outputTokens: 200,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        }),
      );
    }),
  };
}

/** Build a minimal concept page string with a given title + source_ids list. */
function conceptPage(title: string, sourceIds: string[]): string {
  return `---
type: concept
id: gen-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}
title: ${title}
definition: A short definition of ${title}.
source_ids:
${sourceIds.map((s) => `  - ${s}`).join('\n')}
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

Body for ${title}.`;
}

interface TestEnv {
  wsRoot: string;
  dbPath: string;
  db: Database;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('extractConcepts', () => {
  let env: TestEnv;
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ico-extract-base-'));
    const wsResult = initWorkspace('ws', base);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    const { root: wsRoot, dbPath } = wsResult.value;
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    env = { wsRoot, dbPath, db: dbResult.value };

    // Pre-create the summary file the pass will read.
    const summaryDir = join(wsRoot, 'wiki', 'sources');
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(join(wsRoot, SUMMARY_PATH), MOCK_SUMMARY_CONTENT, 'utf-8');
  });

  afterEach(() => {
    closeDatabase(env.db);
    rmSync(base, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Empty summaryPaths → returns ok([])
  // -------------------------------------------------------------------------

  it('returns ok([]) when summaryPaths is empty', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await extractConcepts(client, env.db, env.wsRoot, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. Concept page written to wiki/concepts/
  // -------------------------------------------------------------------------

  it('writes concept page to wiki/concepts/<slug>.md', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const conceptFiles = result.value.filter((r) => r.pageType === 'concept');
    expect(conceptFiles.length).toBeGreaterThanOrEqual(1);

    const conceptPath = join(env.wsRoot, conceptFiles[0]!.outputPath);
    expect(existsSync(conceptPath)).toBe(true);
    expect(conceptPath).toContain('wiki/concepts');
  });

  // -------------------------------------------------------------------------
  // 3. Entity page written to wiki/entities/
  // -------------------------------------------------------------------------

  it('writes entity page to wiki/entities/<slug>.md', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entityFiles = result.value.filter((r) => r.pageType === 'entity');
    expect(entityFiles.length).toBeGreaterThanOrEqual(1);

    const entityPath = join(env.wsRoot, entityFiles[0]!.outputPath);
    expect(existsSync(entityPath)).toBe(true);
    expect(entityPath).toContain('wiki/entities');
  });

  // -------------------------------------------------------------------------
  // 4. Output files contain the API response content
  // -------------------------------------------------------------------------

  it('output files contain frontmatter from the API response', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const conceptResult = result.value.find((r) => r.pageType === 'concept');
    expect(conceptResult).toBeDefined();
    if (!conceptResult) return;

    const written = readFileSync(join(env.wsRoot, conceptResult.outputPath), 'utf-8');
    expect(written).toContain('type: concept');
    expect(written).toContain('Knowledge Compilation');
  });

  // -------------------------------------------------------------------------
  // 5. Compilation records inserted in DB
  // -------------------------------------------------------------------------

  it('inserts compilation records in the database for each page', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = env.db
      .prepare<
        [],
        { type: string; output_path: string }
      >(`SELECT type, output_path FROM compilations`)
      .all();

    // Should have at least one concept and one entity record.
    const conceptRows = rows.filter((r) => r.type === 'concept');
    const entityRows = rows.filter((r) => r.type === 'entity');
    expect(conceptRows.length).toBeGreaterThanOrEqual(1);
    expect(entityRows.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 6. Trace events written
  // -------------------------------------------------------------------------

  it('writes compile.extract trace events', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tracesResult = readTraces(env.db, { eventType: 'compile.extract' });
    expect(tracesResult.ok).toBe(true);
    if (!tracesResult.ok) return;

    expect(tracesResult.value.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 7. Token counts returned
  // -------------------------------------------------------------------------

  it('returns correct token counts from the API response', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All results share the same token counts from the single API call.
    for (const r of result.value) {
      expect(r.inputTokens).toBe(800);
      expect(r.outputTokens).toBe(300);
      expect(r.tokensUsed).toBe(1100);
    }
  });

  // -------------------------------------------------------------------------
  // 8. API error → returns err
  // -------------------------------------------------------------------------

  it('returns err when the Claude API call fails', async () => {
    const client = mockClientError('Claude API rate_limit_error (HTTP 429): Too many requests');
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('rate_limit_error');
  });

  // -------------------------------------------------------------------------
  // 9. Audit log updated
  // -------------------------------------------------------------------------

  it('appends entries to audit/log.md', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logPath = join(env.wsRoot, 'audit', 'log.md');
    expect(existsSync(logPath)).toBe(true);
    const logContents = readFileSync(logPath, 'utf-8');
    expect(logContents).toContain('compile.extract');
  });

  // -------------------------------------------------------------------------
  // 10. Missing summary file → returns err
  // -------------------------------------------------------------------------

  it('returns err when a summary file cannot be read', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await extractConcepts(client, env.db, env.wsRoot, [
      'wiki/sources/nonexistent.md',
    ]);

    expect(result.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 11. Batching — 60 summaries are processed across batches, yielding far
  //     more pages than a single truncated call would.
  // -------------------------------------------------------------------------

  it('processes all 60 summaries across batches, far exceeding a single call', async () => {
    // Write 60 distinct summary files.
    const summaryPaths: string[] = [];
    const sourcesDir = join(env.wsRoot, 'wiki', 'sources');
    mkdirSync(sourcesDir, { recursive: true });
    for (let i = 0; i < 60; i++) {
      const rel = `wiki/sources/source-${String(i).padStart(2, '0')}.md`;
      writeFileSync(
        join(env.wsRoot, rel),
        `---\ntype: source-summary\nid: src-${i}\ntitle: Source ${i}\n---\n\nContent about concept ${i}.`,
        'utf-8',
      );
      summaryPaths.push(rel);
    }

    // Each batch call emits one DISTINCT concept page per call (parameterised by
    // call index), so the number of pages scales with the number of batches.
    // A single call (the old behavior) would have produced just 1 page.
    let call = 0;
    const client: ClaudeClient = {
      createCompletion: vi.fn().mockImplementation(() => {
        const idx = call++;
        return Promise.resolve(
          ok({
            content: conceptPage(`Concept Batch ${idx}`, [`src-${idx}`]),
            inputTokens: 500,
            outputTokens: 200,
            model: 'claude-sonnet-4-6',
            stopReason: 'end_turn',
          }),
        );
      }),
    };

    // batchSize 10 over 60 summaries → 6 batches → 6 distinct concept pages.
    const result = await extractConcepts(client, env.db, env.wsRoot, summaryPaths, {
      batchSize: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 60 / 10 = 6 batch calls.
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);

    // Far more than the single page a single-call run would yield.
    expect(result.value.length).toBe(6);
    expect(result.value.length).toBeGreaterThan(1);

    // Every page was actually written to disk.
    for (const r of result.value) {
      expect(existsSync(join(env.wsRoot, r.outputPath))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 12. Dedupe/merge — two batches emitting the same-titled concept collapse
  //     to one page whose source_ids union both batches' contributions.
  // -------------------------------------------------------------------------

  it('merges a same-titled concept from two batches into one page with both source_ids', async () => {
    // Two summary files → batchSize 1 forces two separate batch calls.
    const summaryPaths: string[] = [];
    const sourcesDir = join(env.wsRoot, 'wiki', 'sources');
    mkdirSync(sourcesDir, { recursive: true });
    for (let i = 0; i < 2; i++) {
      const rel = `wiki/sources/dup-source-${i}.md`;
      writeFileSync(
        join(env.wsRoot, rel),
        `---\ntype: source-summary\nid: dup-src-${i}\ntitle: Dup Source ${i}\n---\n\nBoth mention shared concept.`,
        'utf-8',
      );
      summaryPaths.push(rel);
    }

    // Batch 1 emits the concept with source s-aaa; batch 2 emits the SAME
    // concept title with source s-bbb. They must merge to one page.
    const client = mockClientSequence([
      conceptPage('Shared Concept', ['s-aaa']),
      conceptPage('Shared Concept', ['s-bbb']),
    ]);

    const result = await extractConcepts(client, env.db, env.wsRoot, summaryPaths, {
      batchSize: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Two batch calls were made.
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);

    // But only ONE merged concept page results.
    expect(result.value).toHaveLength(1);

    // The written page carries BOTH source_ids.
    const written = readFileSync(join(env.wsRoot, result.value[0]!.outputPath), 'utf-8');
    expect(written).toContain('s-aaa');
    expect(written).toContain('s-bbb');

    // And exactly one compilations row exists (idempotent UPSERT on the stable id).
    const rows = env.db
      .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM compilations`)
      .all();
    expect(rows[0]!.count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 13. Idempotency — re-running over the same summaries does not duplicate
  //     compilation rows (stable id + UPSERT).
  // -------------------------------------------------------------------------

  it('re-running the pass UPSERTs rather than duplicating compilation rows', async () => {
    const client1 = mockClient(conceptPage('Stable Topic', ['s1']));
    const first = await extractConcepts(client1, env.db, env.wsRoot, [SUMMARY_PATH]);
    expect(first.ok).toBe(true);

    const client2 = mockClient(conceptPage('Stable Topic', ['s1', 's2']));
    const second = await extractConcepts(client2, env.db, env.wsRoot, [SUMMARY_PATH]);
    expect(second.ok).toBe(true);

    const rows = env.db
      .prepare<
        [],
        { count: number }
      >(`SELECT COUNT(*) AS count FROM compilations WHERE type = 'concept'`)
      .all();
    expect(rows[0]!.count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 14. Inline output validation (l13.1): a refusal/junk model page is
  //     skipped with a receipted compile.validation.reject trace — never a
  //     visible file.
  // -------------------------------------------------------------------------

  it('skips a refusal-boilerplate model page with a receipted trace, writing no file', async () => {
    const client = mockClient('I cannot help with this request.');
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);

    const traces = readTraces(env.db, { eventType: 'compile.validation.reject' });
    expect(traces.ok).toBe(true);
    if (traces.ok) expect(traces.value.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 15. Source attribution (l13.5): a model source_id that matches a real
  //     summary compilation lands in compilation_sources; a ghost id does
  //     not, and pass provenance is stamped.
  // -------------------------------------------------------------------------

  it('populates compilation_sources from validated advisory source_ids', async () => {
    const SRC = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // the summary's source
    // Insert the source first (compilations.source_id has a FK to sources.id),
    // then the summary's deterministic compilations row so attribution has a
    // ground-truth input set to intersect against.
    env.db
      .prepare(
        `INSERT INTO sources (id, path, type, ingested_at, hash) VALUES (?, 'raw/x.md', 'markdown', '2026-06-01T00:00:00.000Z', 'h')`,
      )
      .run(SRC);
    env.db
      .prepare(
        `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model)
         VALUES ('sum-1', ?, 'summary', ?, '2026-06-01T00:00:00.000Z', 0, 'deepseek-chat')`,
      )
      .run(SRC, SUMMARY_PATH);

    const client = mockClient(conceptPage('Attributed Concept', [SRC, 'ghost-source-id']));
    const result = await extractConcepts(client, env.db, env.wsRoot, [SUMMARY_PATH]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const junction = env.db
      .prepare<[], { source_id: string }>(`SELECT source_id FROM compilation_sources`)
      .all();
    expect(junction.map((r) => r.source_id)).toContain(SRC);
    expect(junction.map((r) => r.source_id)).not.toContain('ghost-source-id');

    // Pass provenance stamped on the written page.
    const written = readFileSync(join(env.wsRoot, result.value[0]!.outputPath), 'utf-8');
    expect(written).toContain('compiled_by: compile.extract');
    expect(written).toContain('pass_version:');
  });
});
