/**
 * Tests for the synthesize compilation pass.
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
import { synthesizeTopics } from './synthesize.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SUMMARY = `---
type: source-summary
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
title: Paper A
---

## Summary
Paper A discusses knowledge graphs and semantic linking.
`;

const MOCK_SUMMARY_B = `---
type: source-summary
id: bbbbbbbb-cccc-dddd-eeee-ffffffffffff
title: Paper B
---

## Summary
Paper B also covers semantic graphs but from a different angle.
`;

const MOCK_TOPIC_PAGE = `---
type: topic
id: cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa
title: Semantic Knowledge Graphs
summary: An overview of semantic knowledge graph approaches across literature.
source_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
  - bbbbbbbb-cccc-dddd-eeee-ffffffffffff
concept_ids: []
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

## Overview

Both sources converge on the importance of semantic linking for knowledge retrieval.
`;

const MOCK_API_RESPONSE = MOCK_TOPIC_PAGE;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockClient(response: string): ClaudeClient {
  return {
    createCompletion: vi.fn().mockResolvedValue(
      ok({
        content: response,
        inputTokens: 900,
        outputTokens: 350,
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

/** Build a minimal topic page string with a given title + concept_ids list. */
function topicPage(title: string, conceptIds: string[]): string {
  return `---
type: topic
id: gen-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}
title: ${title}
summary: A short summary of ${title}.
source_ids:
  - some-source
concept_ids:
${conceptIds.map((c) => `  - ${c}`).join('\n')}
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

describe('synthesizeTopics', () => {
  let env: TestEnv;
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ico-synthesize-base-'));
    const wsResult = initWorkspace('ws', base);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    const { root: wsRoot, dbPath } = wsResult.value;
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    env = { wsRoot, dbPath, db: dbResult.value };

    // Pre-create two summary files.
    const summaryDir = join(wsRoot, 'wiki', 'sources');
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(join(summaryDir, 'paper-a.md'), MOCK_SUMMARY, 'utf-8');
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
    // Create a fresh workspace without any summary files.
    const emptyBase = mkdtempSync(join(tmpdir(), 'ico-synthesize-empty-'));
    const wsResult = initWorkspace('ws', emptyBase);
    if (!wsResult.ok) throw wsResult.error;
    const dbResult = initDatabase(wsResult.value.dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const emptyDb = dbResult.value;

    try {
      const client = mockClient(MOCK_API_RESPONSE);
      const result = await synthesizeTopics(client, emptyDb, wsResult.value.root);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pages).toHaveLength(0);
    } finally {
      closeDatabase(emptyDb);
      rmSync(emptyBase, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. Topic page written to wiki/topics/
  // -------------------------------------------------------------------------

  it('writes topic page to wiki/topics/<slug>.md', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await synthesizeTopics(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pages.length).toBeGreaterThanOrEqual(1);

    const topicPath = join(env.wsRoot, result.value.pages[0]!.outputPath);
    expect(existsSync(topicPath)).toBe(true);
    expect(topicPath).toContain('wiki/topics');
  });

  // -------------------------------------------------------------------------
  // 3. Output file contains frontmatter from API
  // -------------------------------------------------------------------------

  it('output file contains frontmatter from the API response', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await synthesizeTopics(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = readFileSync(join(env.wsRoot, result.value.pages[0]!.outputPath), 'utf-8');
    expect(written).toContain('type: topic');
    expect(written).toContain('Semantic Knowledge Graphs');
  });

  // -------------------------------------------------------------------------
  // 4. Compilation record inserted in DB
  // -------------------------------------------------------------------------

  it('inserts a compilation record of type "topic" in the database', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await synthesizeTopics(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = env.db
      .prepare<[], { type: string }>(`SELECT type FROM compilations WHERE type = 'topic'`)
      .all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 5. Trace events written
  // -------------------------------------------------------------------------

  it('writes compile.synthesize trace events', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await synthesizeTopics(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tracesResult = readTraces(env.db, { eventType: 'compile.synthesize' });
    expect(tracesResult.ok).toBe(true);
    if (!tracesResult.ok) return;
    expect(tracesResult.value.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 6. Token counts returned
  // -------------------------------------------------------------------------

  it('returns correct token counts', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await synthesizeTopics(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.pages[0]!.inputTokens).toBe(900);
    expect(result.value.pages[0]!.outputTokens).toBe(350);
    expect(result.value.pages[0]!.tokensUsed).toBe(1250);
  });

  // -------------------------------------------------------------------------
  // 7. API error → returns err
  // -------------------------------------------------------------------------

  it('returns err when the Claude API call fails', async () => {
    const client = mockClientError('Claude API server_error (HTTP 500): Internal server error');
    const result = await synthesizeTopics(client, env.db, env.wsRoot);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('server_error');
  });

  // -------------------------------------------------------------------------
  // 8. Audit log updated
  // -------------------------------------------------------------------------

  it('appends an entry to audit/log.md', async () => {
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await synthesizeTopics(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logPath = join(env.wsRoot, 'audit', 'log.md');
    expect(existsSync(logPath)).toBe(true);
    const logContents = readFileSync(logPath, 'utf-8');
    expect(logContents).toContain('compile.synthesize');
  });

  // -------------------------------------------------------------------------
  // 9. Works with no concept pages present
  // -------------------------------------------------------------------------

  it('runs successfully even when wiki/concepts/ does not exist', async () => {
    // The beforeEach only creates wiki/sources/ — concepts dir is absent.
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await synthesizeTopics(client, env.db, env.wsRoot);
    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 10. Multiple topic pages from PAGE_BREAK response
  // -------------------------------------------------------------------------

  it('creates multiple topic pages when the API returns multiple pages', async () => {
    const secondTopic = `---
type: topic
id: dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb
title: Evidence Quality
summary: Analysis of evidence quality across sources.
source_ids:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
concept_ids: []
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

## Overview

Evidence quality varies significantly across the reviewed sources.
`;
    const multiPageResponse = `${MOCK_TOPIC_PAGE}\n---PAGE_BREAK---\n${secondTopic}`;
    const client = mockClient(multiPageResponse);
    const result = await synthesizeTopics(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pages.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 11. Small-corpus parity — a corpus that fits in one batch makes exactly
  //     one Claude call (the old single-call behavior is unchanged).
  // -------------------------------------------------------------------------

  it('makes exactly one Claude call when all summaries fit in a single batch', async () => {
    // beforeEach writes 2 summaries; default batch size (25) holds them in one batch.
    const client = mockClient(MOCK_API_RESPONSE);
    const result = await synthesizeTopics(client, env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 12. Batching — many summaries are processed across batches, yielding more
  //     topic pages than a single truncated call would.
  // -------------------------------------------------------------------------

  it('processes all summaries across batches, far exceeding a single call', async () => {
    // Write 60 distinct summary files.
    const sourcesDir = join(env.wsRoot, 'wiki', 'sources');
    mkdirSync(sourcesDir, { recursive: true });
    for (let i = 0; i < 60; i++) {
      writeFileSync(
        join(sourcesDir, `source-${String(i).padStart(2, '0')}.md`),
        `---\ntype: source-summary\nid: src-${i}\ntitle: Source ${i}\n---\n\nContent about theme ${i}.`,
        'utf-8',
      );
    }

    // Each batch call emits one DISTINCT topic page (parameterised by call index),
    // so the page count scales with the number of batches. A single call (the old
    // behavior) would have produced just 1 page.
    let call = 0;
    const client: ClaudeClient = {
      createCompletion: vi.fn().mockImplementation(() => {
        const idx = call++;
        return Promise.resolve(
          ok({
            content: topicPage(`Topic Batch ${idx}`, [`c-${idx}`]),
            inputTokens: 500,
            outputTokens: 200,
            model: 'claude-sonnet-4-6',
            stopReason: 'end_turn',
          }),
        );
      }),
    };

    // batchSize 10 over 62 summaries (2 from beforeEach + 60 here) → 7 batches.
    const result = await synthesizeTopics(client, env.db, env.wsRoot, { batchSize: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 62 / 10 = 7 batch calls (last batch holds the remainder).
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(7);

    // Far more than the single page a single-call run would yield.
    expect(result.value.pages.length).toBe(7);
    expect(result.value.pages.length).toBeGreaterThan(1);

    // Every page was actually written to disk.
    for (const r of result.value.pages) {
      expect(existsSync(join(env.wsRoot, r.outputPath))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 13. Dedupe/merge — two batches emitting the same-titled topic collapse to
  //     one page whose concept_ids union both batches' contributions.
  // -------------------------------------------------------------------------

  it('merges a same-titled topic from two batches into one page with both concept_ids', async () => {
    // beforeEach already wrote 2 summaries → batchSize 1 forces two batch calls.
    // Batch 1 emits the topic with concept c-aaa; batch 2 emits the SAME topic
    // title with concept c-bbb. They must merge to one page.
    const client = mockClientSequence([
      topicPage('Shared Theme', ['c-aaa']),
      topicPage('Shared Theme', ['c-bbb']),
    ]);

    const result = await synthesizeTopics(client, env.db, env.wsRoot, { batchSize: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Two batch calls were made.
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);

    // But only ONE merged topic page results.
    expect(result.value.pages).toHaveLength(1);

    // The written page carries BOTH concept_ids.
    const written = readFileSync(join(env.wsRoot, result.value.pages[0]!.outputPath), 'utf-8');
    expect(written).toContain('c-aaa');
    expect(written).toContain('c-bbb');

    // And exactly one compilations row exists (idempotent UPSERT on the stable id).
    const rows = env.db
      .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM compilations`)
      .all();
    expect(rows[0]!.count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 14. Idempotency — re-running over the same summaries does not duplicate
  //     compilation rows (stable id + UPSERT).
  // -------------------------------------------------------------------------

  it('re-running the pass UPSERTs rather than duplicating compilation rows', async () => {
    const client1 = mockClient(topicPage('Stable Topic', ['c1']));
    const first = await synthesizeTopics(client1, env.db, env.wsRoot);
    expect(first.ok).toBe(true);

    const client2 = mockClient(topicPage('Stable Topic', ['c1', 'c2']));
    const second = await synthesizeTopics(client2, env.db, env.wsRoot);
    expect(second.ok).toBe(true);

    const rows = env.db
      .prepare<
        [],
        { count: number }
      >(`SELECT COUNT(*) AS count FROM compilations WHERE type = 'topic'`)
      .all();
    expect(rows[0]!.count).toBe(1);
  });
});
