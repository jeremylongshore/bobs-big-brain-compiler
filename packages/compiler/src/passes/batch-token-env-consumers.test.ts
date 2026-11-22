import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initDatabase } from '@ico/kernel';
import { err } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';

const originalMaxTokens = process.env['MAX_TOKENS_PER_OPERATION'];
const originalBatchSize = process.env['ICO_BATCH_SIZE'];
const summaryPath = 'wiki/sources/synthetic-source.md';
const summary = `---
type: source-summary
id: 10000000-0000-5000-8000-000000000001
title: Synthetic environment consumer source
---

This synthetic environment consumer source checks the configured response-token ceiling.
`;
let workspace: string;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('MAX_TOKENS_PER_OPERATION', '16000');
  vi.stubEnv('ICO_BATCH_SIZE', '20');
  workspace = mkdtempSync(join(tmpdir(), 'ico-batch-token-env-'));
  mkdirSync(join(workspace, 'wiki', 'sources'), { recursive: true });
  writeFileSync(join(workspace, summaryPath), summary);
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
  expect(process.env['MAX_TOKENS_PER_OPERATION']).toBe(originalMaxTokens);
  expect(process.env['ICO_BATCH_SIZE']).toBe(originalBatchSize);
});

describe('exported response-token configuration reaches each batched pass', () => {
  it.each(['extract', 'synthesize', 'contradict', 'gap'] as const)(
    '%s passes the configured 16000-token ceiling to its completion client',
    async (pass) => {
      const stop = new Error('Intentional fixture stop before database writes');
      const createCompletion = vi
        .fn<ClaudeClient['createCompletion']>()
        .mockResolvedValue(err(stop));
      const client: ClaudeClient = { createCompletion };
      // Custody reads precede the client; a failed completion must still write nothing.
      const opened = initDatabase(':memory:');
      if (!opened.ok) throw opened.error;
      const database = opened.value;
      const before = database.serialize();

      // Import AFTER stubbing the environment: each real pass captures its
      // configured default at module initialization, rather than per call.
      const result = await (async () => {
        switch (pass) {
          case 'extract': {
            const { extractConcepts } = await import('./extract.js');
            return extractConcepts(client, database, workspace, [summaryPath]);
          }
          case 'synthesize': {
            const { synthesizeTopics } = await import('./synthesize.js');
            return synthesizeTopics(client, database, workspace);
          }
          case 'contradict': {
            const { detectContradictions } = await import('./contradict.js');
            return detectContradictions(client, database, workspace);
          }
          case 'gap': {
            const { identifyGaps } = await import('./gap.js');
            return identifyGaps(client, database, workspace);
          }
        }
      })();

      expect(createCompletion).toHaveBeenCalledTimes(1);
      expect(createCompletion.mock.calls[0]?.[1]).toContain(
        'synthetic environment consumer source',
      );
      expect(createCompletion.mock.calls[0]?.[2]?.maxTokens).toBe(16000);
      expect(result).toEqual(err(stop));
      expect(database.serialize()).toEqual(before);
      database.close();
      expect(readFileSync(join(workspace, summaryPath), 'utf8')).toBe(summary);
    },
  );
});
