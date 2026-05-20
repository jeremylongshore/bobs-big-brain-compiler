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
});
