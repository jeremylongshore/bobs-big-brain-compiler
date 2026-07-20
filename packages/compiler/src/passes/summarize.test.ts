/**
 * Tests for the summarize compilation pass.
 *
 * Each test case uses:
 * - A real temporary workspace (via `initWorkspace`) so filesystem assertions
 *   work against actual directories.
 * - A real on-disk SQLite database (via `initDatabase`) so SQL reads verify
 *   the compilation record was persisted.
 * - A mocked `ClaudeClient` so no network calls are made.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  type Database,
  getDerivations,
  initDatabase,
  initWorkspace,
  readTraces,
} from '@ico/kernel';
import { ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import { CompileSkipError } from './output-filter.js';
import { summarizeSource } from './summarize.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SOURCE_PATH = 'raw/notes/my-research-paper.md';
const CONTENT_HASH = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';

const MOCK_FRONTMATTER = `---
type: source-summary
id: ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb
title: My Research Paper
source_id: ${SOURCE_ID}
source_path: ${SOURCE_PATH}
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
content_hash: ${CONTENT_HASH}
---`;

const MOCK_BODY = `
## Summary

This paper investigates knowledge compilation.

## Key Claims

1. Compilation improves knowledge retrieval.
2. Semantic structure enables better reasoning.

## Methods

The authors used controlled experiments with human evaluators.

## Conclusions

Structured knowledge bases outperform flat text indexes.
`;

const MOCK_API_RESPONSE = `${MOCK_FRONTMATTER}${MOCK_BODY}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a mock ClaudeClient that always returns a successful completion
 * with the given response text.
 */
function mockClient(response: string): ClaudeClient {
  return {
    createCompletion: vi.fn().mockResolvedValue(
      ok({
        content: response,
        inputTokens: 500,
        outputTokens: 200,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      }),
    ),
  };
}

/**
 * Builds a mock ClaudeClient that always returns an error.
 */
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

/**
 * Inserts a minimal source row so FK constraints on `compilations` are satisfied.
 */
function insertSource(db: Database, id: string, path: string): void {
  db.prepare(`INSERT INTO sources (id, path, type, ingested_at, hash) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    path,
    'markdown',
    new Date().toISOString(),
    CONTENT_HASH,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('summarizeSource', () => {
  let env: TestEnv;
  let base: string;

  beforeEach(() => {
    // Capture the tmpdir base so we can remove it after each test.
    base = mkdtempSync(join(tmpdir(), 'ico-summarize-base-'));
    const wsResult = initWorkspace('ws', base);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    const { root: wsRoot, dbPath } = wsResult.value;
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    env = { wsRoot, dbPath, db: dbResult.value };
    insertSource(env.db, SOURCE_ID, SOURCE_PATH);
  });

  afterEach(() => {
    closeDatabase(env.db);
    rmSync(base, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. File is created in wiki/sources/
  // -------------------------------------------------------------------------

  it('writes the API response to wiki/sources/<slug>.md', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Source body text.',
      SOURCE_PATH,
      CONTENT_HASH,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedPath = join(env.wsRoot, 'wiki', 'sources', 'my-research-paper.md');
    expect(existsSync(expectedPath)).toBe(true);
    expect(result.value.outputPath).toBe('wiki/sources/my-research-paper.md');
  });

  // -------------------------------------------------------------------------
  // 2. Output file contains the frontmatter returned by the API
  // -------------------------------------------------------------------------

  it('output file contains the frontmatter from the API response', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Source body text.',
      SOURCE_PATH,
      CONTENT_HASH,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outputAbsPath = join(env.wsRoot, result.value.outputPath);
    const written = readFileSync(outputAbsPath, 'utf-8');
    expect(written).toContain('type: source-summary');
    expect(written).toContain(`source_id: ${SOURCE_ID}`);
    expect(written).toContain('## Summary');
  });

  // -------------------------------------------------------------------------
  // 3. Compilation record inserted in DB
  // -------------------------------------------------------------------------

  it('inserts a compilation record in the database', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Source body text.',
      SOURCE_PATH,
      CONTENT_HASH,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = env.db
      .prepare<
        [string],
        { source_id: string; type: string; output_path: string; tokens_used: number }
      >(`SELECT source_id, type, output_path, tokens_used FROM compilations WHERE source_id = ?`)
      .get(SOURCE_ID);

    expect(row).not.toBeNull();
    expect(row!.type).toBe('summary');
    expect(row!.output_path).toBe('wiki/sources/my-research-paper.md');
    expect(row!.tokens_used).toBe(700); // 500 + 200
  });

  // -------------------------------------------------------------------------
  // 4. Provenance recorded
  // -------------------------------------------------------------------------

  it('records provenance for the source → output derivation', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Source body text.',
      SOURCE_PATH,
      CONTENT_HASH,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const derivResult = getDerivations(env.db, env.wsRoot, SOURCE_ID);
    expect(derivResult.ok).toBe(true);
    if (!derivResult.ok) return;

    // At least one provenance record should exist for compile.summarize.
    const summarizeRecords = derivResult.value.filter((r) => r.operation === 'compile.summarize');
    expect(summarizeRecords.length).toBeGreaterThanOrEqual(1);
    expect(summarizeRecords[0]!.outputPath).toBe('wiki/sources/my-research-paper.md');
    expect(summarizeRecords[0]!.outputType).toBe('summary');
  });

  // -------------------------------------------------------------------------
  // 5. Trace event written
  // -------------------------------------------------------------------------

  it('writes a compile.summarize trace event', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Source body text.',
      SOURCE_PATH,
      CONTENT_HASH,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tracesResult = readTraces(env.db, { eventType: 'compile.summarize' });
    expect(tracesResult.ok).toBe(true);
    if (!tracesResult.ok) return;

    const summarizeTraces = tracesResult.value.filter((t) => t.event_type === 'compile.summarize');
    expect(summarizeTraces.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 6. Correct token counts returned
  // -------------------------------------------------------------------------

  it('returns correct token counts from the API response', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Source body text.',
      SOURCE_PATH,
      CONTENT_HASH,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.inputTokens).toBe(500);
    expect(result.value.outputTokens).toBe(200);
    expect(result.value.tokensUsed).toBe(700);
  });

  // -------------------------------------------------------------------------
  // 7. API error → returns err
  // -------------------------------------------------------------------------

  it('returns err when the Claude API call fails', async () => {
    const client = mockClientError('Claude API rate_limit_error (HTTP 429): Too many requests');
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Source body text.',
      SOURCE_PATH,
      CONTENT_HASH,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('rate_limit_error');

    // Verify no compilation record was inserted on failure.
    // better-sqlite3 returns undefined (not null) when no row matches.
    const row = env.db
      .prepare<[string], { id: string }>(`SELECT id FROM compilations WHERE source_id = ?`)
      .get(SOURCE_ID);
    expect(row).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8. Audit log updated
  // -------------------------------------------------------------------------

  it('appends an entry to audit/log.md', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Source body text.',
      SOURCE_PATH,
      CONTENT_HASH,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logPath = join(env.wsRoot, 'audit', 'log.md');
    expect(existsSync(logPath)).toBe(true);
    const logContents = readFileSync(logPath, 'utf-8');
    expect(logContents).toContain('compile.summarize');
  });

  // -------------------------------------------------------------------------
  // Additional: slug generation from various source paths
  // -------------------------------------------------------------------------

  it('handles source paths with underscores and mixed case in the slug', async () => {
    const altSourcePath = 'raw/papers/My_Research_Paper_2024.pdf';
    const altSourceId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    insertSource(env.db, altSourceId, altSourcePath);

    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      altSourceId,
      'Source body text.',
      altSourcePath,
      CONTENT_HASH,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Underscores and mixed case → lowercased with hyphens, no extension.
    expect(result.value.outputPath).toBe('wiki/sources/my-research-paper-2024.md');
  });

  // -------------------------------------------------------------------------
  // Inline output validation (l13.1)
  // -------------------------------------------------------------------------

  it('skips an empty raw source before any Claude call, with a receipted trace', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      '   \n  ', // empty after trim
      SOURCE_PATH,
      CONTENT_HASH,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(CompileSkipError);
    expect((result.error as CompileSkipError).code).toBe('EMPTY_SOURCE');
    // No Claude call was made and no file was written.
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(existsSync(join(env.wsRoot, 'wiki', 'sources', 'my-research-paper.md'))).toBe(false);
    const traces = readTraces(env.db, { eventType: 'compile.validation.reject' });
    expect(traces.ok).toBe(true);
    if (traces.ok) expect(traces.value.length).toBe(1);
  });

  it('retries once then skips-with-trace when the model keeps refusing', async () => {
    const client: ClaudeClient = {
      createCompletion: vi.fn().mockResolvedValue(
        ok({
          content: 'I cannot summarize this document.',
          inputTokens: 100,
          outputTokens: 20,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        }),
      ),
    };
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Real source body.',
      SOURCE_PATH,
      CONTENT_HASH,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(CompileSkipError);
    // Two attempts (initial + one retry).
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(existsSync(join(env.wsRoot, 'wiki', 'sources', 'my-research-paper.md'))).toBe(false);
  });

  it('stamps deterministic pass provenance (compiled_by, pass_version, real path/hash) on the page', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await summarizeSource(
      client,
      env.db,
      env.wsRoot,
      SOURCE_ID,
      'Real source body.',
      SOURCE_PATH,
      CONTENT_HASH,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = readFileSync(join(env.wsRoot, result.value.outputPath), 'utf-8');
    expect(written).toContain('compiled_by: compile.summarize');
    expect(written).toContain('pass_version:');
    expect(written).toContain(`content_hash: ${CONTENT_HASH}`);
    expect(written).toContain(`source_path: ${SOURCE_PATH}`);
  });
});
