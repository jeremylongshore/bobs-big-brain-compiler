/**
 * Tests for the gap identification compilation pass.
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
import { identifyGaps } from './gap.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SUMMARY = `---
type: source-summary
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
title: Research Paper
---

## Summary
This paper mentions a technique called "latent semantic indexing" but provides no definition.
`;

const MOCK_GAP_PAGE = `---
type: open-question
id: cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa
title: Definition of latent semantic indexing is missing
priority: high
evidence_strength: weak
related_page_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

## The Gap

The concept of "latent semantic indexing" is referenced but never defined.

## Current Evidence

Only a passing reference exists.

## Suggested Next Steps

Find a primary source that defines this technique.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockClient(response: string): ClaudeClient {
  return {
    createCompletion: vi.fn().mockResolvedValue(
      ok({
        content: response,
        inputTokens: 700,
        outputTokens: 280,
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

describe('identifyGaps', () => {
  let env: TestEnv;
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ico-gap-base-'));
    const wsResult = initWorkspace('ws', base);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    const { root: wsRoot, dbPath } = wsResult.value;
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    env = { wsRoot, dbPath, db: dbResult.value };

    // Pre-create one summary file.
    const summaryDir = join(wsRoot, 'wiki', 'sources');
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(join(summaryDir, 'research-paper.md'), MOCK_SUMMARY, 'utf-8');
  });

  afterEach(() => {
    closeDatabase(env.db);
    rmSync(base, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Empty wiki → returns ok([])
  // -------------------------------------------------------------------------

  it('returns ok([]) when wiki/ is empty', async () => {
    const emptyBase = mkdtempSync(join(tmpdir(), 'ico-gap-empty-'));
    const wsResult = initWorkspace('ws', emptyBase);
    if (!wsResult.ok) throw wsResult.error;
    const dbResult = initDatabase(wsResult.value.dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const emptyDb = dbResult.value;

    try {
      const client = mockClient(MOCK_GAP_PAGE);
      const result = await identifyGaps(client, emptyDb, wsResult.value.root);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    } finally {
      closeDatabase(emptyDb);
      rmSync(emptyBase, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. Gap page written to wiki/open-questions/
  // -------------------------------------------------------------------------

  it('writes gap page to wiki/open-questions/<slug>.md', async () => {
    const client = mockClient(MOCK_GAP_PAGE);
    const result = await identifyGaps(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(1);

    const gapPath = join(env.wsRoot, result.value[0]!.outputPath);
    expect(existsSync(gapPath)).toBe(true);
    expect(gapPath).toContain('wiki/open-questions');
  });

  // -------------------------------------------------------------------------
  // 3. Output file contains frontmatter from API
  // -------------------------------------------------------------------------

  it('output file contains frontmatter from the API response', async () => {
    const client = mockClient(MOCK_GAP_PAGE);
    const result = await identifyGaps(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = readFileSync(join(env.wsRoot, result.value[0]!.outputPath), 'utf-8');
    expect(written).toContain('type: open-question');
    expect(written).toContain('priority: high');
    expect(written).toContain('## The Gap');
  });

  // -------------------------------------------------------------------------
  // 4. NO_GAPS_FOUND sentinel → returns ok([])
  // -------------------------------------------------------------------------

  it('returns ok([]) when the API returns NO_GAPS_FOUND', async () => {
    const client = mockClient('NO_GAPS_FOUND');
    const result = await identifyGaps(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. Compilation record inserted in DB
  // -------------------------------------------------------------------------

  it('inserts a compilation record of type "open-question" in the database', async () => {
    const client = mockClient(MOCK_GAP_PAGE);
    const result = await identifyGaps(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = env.db
      .prepare<[], { type: string }>(`SELECT type FROM compilations WHERE type = 'open-question'`)
      .all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 6. Trace events written
  // -------------------------------------------------------------------------

  it('writes compile.gap trace events', async () => {
    const client = mockClient(MOCK_GAP_PAGE);
    const result = await identifyGaps(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tracesResult = readTraces(env.db, { eventType: 'compile.gap' });
    expect(tracesResult.ok).toBe(true);
    if (!tracesResult.ok) return;
    expect(tracesResult.value.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 7. Token counts returned
  // -------------------------------------------------------------------------

  it('returns correct token counts', async () => {
    const client = mockClient(MOCK_GAP_PAGE);
    const result = await identifyGaps(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value[0]!.inputTokens).toBe(700);
    expect(result.value[0]!.outputTokens).toBe(280);
    expect(result.value[0]!.tokensUsed).toBe(980);
  });

  // -------------------------------------------------------------------------
  // 8. API error → returns err
  // -------------------------------------------------------------------------

  it('returns err when the Claude API call fails', async () => {
    const client = mockClientError('Claude API authentication_error (HTTP 401): Unauthorized');
    const result = await identifyGaps(client, env.db, env.wsRoot);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('authentication_error');
  });

  // -------------------------------------------------------------------------
  // 9. Audit log updated
  // -------------------------------------------------------------------------

  it('appends an entry to audit/log.md', async () => {
    const client = mockClient(MOCK_GAP_PAGE);
    const result = await identifyGaps(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logPath = join(env.wsRoot, 'audit', 'log.md');
    expect(existsSync(logPath)).toBe(true);
    const logContents = readFileSync(logPath, 'utf-8');
    expect(logContents).toContain('compile.gap');
  });

  // -------------------------------------------------------------------------
  // 10. Multiple gap pages from PAGE_BREAK response
  // -------------------------------------------------------------------------

  it('creates multiple gap pages when the API returns multiple pages', async () => {
    const secondGap = `---
type: open-question
id: dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb
title: Evaluation methodology not described
priority: medium
evidence_strength: none
related_page_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

## The Gap

No evaluation methodology is described.
`;
    const client = mockClient(`${MOCK_GAP_PAGE}\n---PAGE_BREAK---\n${secondGap}`);
    const result = await identifyGaps(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 11. Also reads wiki/concepts/ and wiki/topics/ for gap analysis
  // -------------------------------------------------------------------------

  it('reads compiled pages from concepts and topics subdirectories', async () => {
    // Add a concept page.
    const conceptsDir = join(env.wsRoot, 'wiki', 'concepts');
    mkdirSync(conceptsDir, { recursive: true });
    writeFileSync(
      join(conceptsDir, 'semantic-graph.md'),
      '---\ntype: concept\ntitle: Semantic Graph\n---\nA concept.\n',
      'utf-8',
    );

    const client = mockClient(MOCK_GAP_PAGE);
    // The API should be called with content from all subdirs.
    const result = await identifyGaps(client, env.db, env.wsRoot);
    expect(result.ok).toBe(true);

    // Verify the client was called (and thus got content from multiple sources).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockFn = vi.mocked(client.createCompletion);
    expect(mockFn.mock.calls).toHaveLength(1);
    const callArgs = mockFn.mock.calls[0] ?? [];
    // The user prompt (second argument) should contain content from both subdirs.
    const userPrompt = String(callArgs[1] ?? '');
    expect(userPrompt).toContain('wiki/sources');
    expect(userPrompt).toContain('wiki/concepts');
  });
});
