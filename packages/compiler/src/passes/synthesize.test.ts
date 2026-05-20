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
      expect(result.value).toHaveLength(0);
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
    expect(result.value.length).toBeGreaterThanOrEqual(1);

    const topicPath = join(env.wsRoot, result.value[0]!.outputPath);
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

    const written = readFileSync(join(env.wsRoot, result.value[0]!.outputPath), 'utf-8');
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

    expect(result.value[0]!.inputTokens).toBe(900);
    expect(result.value[0]!.outputTokens).toBe(350);
    expect(result.value[0]!.tokensUsed).toBe(1250);
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
    expect(result.value.length).toBe(2);
  });
});
