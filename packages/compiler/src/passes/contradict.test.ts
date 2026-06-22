/**
 * Tests for the contradict compilation pass.
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
import { detectContradictions } from './contradict.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SUMMARY_A = `---
type: source-summary
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
title: Paper A
---

## Key Claims
1. Semantic graphs improve knowledge retrieval.
`;

const MOCK_SUMMARY_B = `---
type: source-summary
id: bbbbbbbb-cccc-dddd-eeee-ffffffffffff
title: Paper B
---

## Key Claims
1. Semantic graphs do NOT improve knowledge retrieval.
`;

const MOCK_CONTRADICTION_PAGE = `---
type: contradiction
id: cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa
title: Contradictory claims about semantic graph efficacy
severity: high
source_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
  - bbbbbbbb-cccc-dddd-eeee-ffffffffffff
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

## Conflicting Claims

1. Paper A claims: "Semantic graphs improve knowledge retrieval."
2. Paper B claims: "Semantic graphs do NOT improve knowledge retrieval."

## Analysis

These claims are directly contradictory.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockClient(response: string): ClaudeClient {
  return {
    createCompletion: vi.fn().mockResolvedValue(
      ok({
        content: response,
        inputTokens: 600,
        outputTokens: 250,
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

/** Build a minimal contradiction page string with a given title + source_ids list. */
function contradictionPage(title: string, sourceIds: string[]): string {
  return `---
type: contradiction
id: gen-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}
title: ${title}
severity: medium
source_ids:
${sourceIds.map((s) => `  - ${s}`).join('\n')}
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

## Analysis
Conflict body for ${title}.`;
}

interface TestEnv {
  wsRoot: string;
  dbPath: string;
  db: Database;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('detectContradictions', () => {
  let env: TestEnv;
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ico-contradict-base-'));
    const wsResult = initWorkspace('ws', base);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    const { root: wsRoot, dbPath } = wsResult.value;
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    env = { wsRoot, dbPath, db: dbResult.value };

    // Pre-create two summary files.
    const summaryDir = join(wsRoot, 'wiki', 'sources');
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(join(summaryDir, 'paper-a.md'), MOCK_SUMMARY_A, 'utf-8');
    writeFileSync(join(summaryDir, 'paper-b.md'), MOCK_SUMMARY_B, 'utf-8');
  });

  afterEach(() => {
    closeDatabase(env.db);
    rmSync(base, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. No summaries → returns ok([])
  // -------------------------------------------------------------------------

  it('returns ok([]) when wiki/sources/ is empty', async () => {
    const emptyBase = mkdtempSync(join(tmpdir(), 'ico-contradict-empty-'));
    const wsResult = initWorkspace('ws', emptyBase);
    if (!wsResult.ok) throw wsResult.error;
    const dbResult = initDatabase(wsResult.value.dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const emptyDb = dbResult.value;

    try {
      const client = mockClient(MOCK_CONTRADICTION_PAGE);
      const result = await detectContradictions(client, emptyDb, wsResult.value.root);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    } finally {
      closeDatabase(emptyDb);
      rmSync(emptyBase, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. Contradiction page written to wiki/contradictions/
  // -------------------------------------------------------------------------

  it('writes contradiction page to wiki/contradictions/<slug>.md', async () => {
    const client = mockClient(MOCK_CONTRADICTION_PAGE);
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(1);

    const contradictionPath = join(env.wsRoot, result.value[0]!.outputPath);
    expect(existsSync(contradictionPath)).toBe(true);
    expect(contradictionPath).toContain('wiki/contradictions');
  });

  // -------------------------------------------------------------------------
  // 3. Output file contains frontmatter from API
  // -------------------------------------------------------------------------

  it('output file contains frontmatter from the API response', async () => {
    const client = mockClient(MOCK_CONTRADICTION_PAGE);
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = readFileSync(join(env.wsRoot, result.value[0]!.outputPath), 'utf-8');
    expect(written).toContain('type: contradiction');
    expect(written).toContain('severity: high');
  });

  // -------------------------------------------------------------------------
  // 4. NO_CONTRADICTIONS_FOUND sentinel → returns ok([])
  // -------------------------------------------------------------------------

  it('returns ok([]) when the API returns NO_CONTRADICTIONS_FOUND', async () => {
    const client = mockClient('NO_CONTRADICTIONS_FOUND');
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. Compilation record inserted in DB
  // -------------------------------------------------------------------------

  it('inserts a compilation record of type "contradiction" in the database', async () => {
    const client = mockClient(MOCK_CONTRADICTION_PAGE);
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = env.db
      .prepare<[], { type: string }>(`SELECT type FROM compilations WHERE type = 'contradiction'`)
      .all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 6. Trace events written
  // -------------------------------------------------------------------------

  it('writes compile.contradict trace events', async () => {
    const client = mockClient(MOCK_CONTRADICTION_PAGE);
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tracesResult = readTraces(env.db, { eventType: 'compile.contradict' });
    expect(tracesResult.ok).toBe(true);
    if (!tracesResult.ok) return;
    expect(tracesResult.value.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 7. Token counts returned
  // -------------------------------------------------------------------------

  it('returns correct token counts', async () => {
    const client = mockClient(MOCK_CONTRADICTION_PAGE);
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value[0]!.inputTokens).toBe(600);
    expect(result.value[0]!.outputTokens).toBe(250);
    expect(result.value[0]!.tokensUsed).toBe(850);
  });

  // -------------------------------------------------------------------------
  // 8. API error → returns err
  // -------------------------------------------------------------------------

  it('returns err when the Claude API call fails', async () => {
    const client = mockClientError('Claude API rate_limit_error (HTTP 429): Too many requests');
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('rate_limit_error');
  });

  // -------------------------------------------------------------------------
  // 9. Audit log updated
  // -------------------------------------------------------------------------

  it('appends an entry to audit/log.md', async () => {
    const client = mockClient(MOCK_CONTRADICTION_PAGE);
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logPath = join(env.wsRoot, 'audit', 'log.md');
    expect(existsSync(logPath)).toBe(true);
    const logContents = readFileSync(logPath, 'utf-8');
    expect(logContents).toContain('compile.contradict');
  });

  // -------------------------------------------------------------------------
  // 10. Multiple contradiction pages from PAGE_BREAK response
  // -------------------------------------------------------------------------

  it('creates multiple contradiction pages when the API returns multiple pages', async () => {
    const secondPage = `---
type: contradiction
id: dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb
title: Contradictory evidence quality assessments
severity: medium
source_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

## Analysis
A secondary contradiction about evidence standards.
`;
    const client = mockClient(`${MOCK_CONTRADICTION_PAGE}\n---PAGE_BREAK---\n${secondPage}`);
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 11. Small-corpus parity — a corpus that fits in one batch makes exactly
  //     one Claude call (the old single-call behavior is unchanged).
  // -------------------------------------------------------------------------

  it('makes exactly one Claude call when all summaries fit in a single batch', async () => {
    // beforeEach writes 2 summaries; default batch size (25) holds them in one batch.
    const client = mockClient(MOCK_CONTRADICTION_PAGE);
    const result = await detectContradictions(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 12. Batching — many summaries are processed across batches, each yielding a
  //     distinct contradiction, far exceeding a single truncated call.
  // -------------------------------------------------------------------------

  it('processes all summaries across batches, far exceeding a single call', async () => {
    // Write 40 distinct summary files.
    const sourcesDir = join(env.wsRoot, 'wiki', 'sources');
    mkdirSync(sourcesDir, { recursive: true });
    for (let i = 0; i < 40; i++) {
      writeFileSync(
        join(sourcesDir, `source-${String(i).padStart(2, '0')}.md`),
        `---\ntype: source-summary\nid: src-${i}\ntitle: Source ${i}\n---\n\nClaim ${i}.`,
        'utf-8',
      );
    }

    // Each batch emits one DISTINCT contradiction page (parameterised by call index).
    let call = 0;
    const client: ClaudeClient = {
      createCompletion: vi.fn().mockImplementation(() => {
        const idx = call++;
        return Promise.resolve(
          ok({
            content: contradictionPage(`Conflict Batch ${idx}`, [`src-${idx}`]),
            inputTokens: 500,
            outputTokens: 200,
            model: 'claude-sonnet-4-6',
            stopReason: 'end_turn',
          }),
        );
      }),
    };

    // batchSize 10 over 42 summaries (2 from beforeEach + 40 here) → 5 batches.
    const result = await detectContradictions(client, env.db, env.wsRoot, { batchSize: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 42 / 10 = 5 batch calls (last batch holds the remainder).
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);

    // Far more than the single page a single-call run would yield.
    expect(result.value.length).toBe(5);
    expect(result.value.length).toBeGreaterThan(1);
  });

  // -------------------------------------------------------------------------
  // 13. Per-batch sentinel — a batch returning NO_CONTRADICTIONS_FOUND
  //     contributes no pages; other batches still produce theirs.
  // -------------------------------------------------------------------------

  it('honors NO_CONTRADICTIONS_FOUND per batch (mixed empty + non-empty batches)', async () => {
    // beforeEach wrote 2 summaries → batchSize 1 forces two batch calls.
    // Batch 1 finds nothing; batch 2 finds a contradiction. Only one page results.
    const client = mockClientSequence([
      'NO_CONTRADICTIONS_FOUND',
      contradictionPage('Only Conflict', ['src-x']),
    ]);

    const result = await detectContradictions(client, env.db, env.wsRoot, { batchSize: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(result.value).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 14. Dedupe/merge — two batches emitting the same-titled contradiction
  //     collapse to one page whose source_ids union both contributions.
  // -------------------------------------------------------------------------

  it('merges a same-titled contradiction from two batches with both source_ids', async () => {
    const client = mockClientSequence([
      contradictionPage('Shared Conflict', ['s-aaa']),
      contradictionPage('Shared Conflict', ['s-bbb']),
    ]);

    const result = await detectContradictions(client, env.db, env.wsRoot, { batchSize: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(result.value).toHaveLength(1);

    const written = readFileSync(join(env.wsRoot, result.value[0]!.outputPath), 'utf-8');
    expect(written).toContain('s-aaa');
    expect(written).toContain('s-bbb');

    const rows = env.db
      .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM compilations`)
      .all();
    expect(rows[0]!.count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 15. Idempotency — re-running does not duplicate compilation rows.
  // -------------------------------------------------------------------------

  it('re-running the pass UPSERTs rather than duplicating compilation rows', async () => {
    const client1 = mockClient(contradictionPage('Stable Conflict', ['s1']));
    const first = await detectContradictions(client1, env.db, env.wsRoot);
    expect(first.ok).toBe(true);

    const client2 = mockClient(contradictionPage('Stable Conflict', ['s1', 's2']));
    const second = await detectContradictions(client2, env.db, env.wsRoot);
    expect(second.ok).toBe(true);

    const rows = env.db
      .prepare<
        [],
        { count: number }
      >(`SELECT COUNT(*) AS count FROM compilations WHERE type = 'contradiction'`)
      .all();
    expect(rows[0]!.count).toBe(1);
  });
});
