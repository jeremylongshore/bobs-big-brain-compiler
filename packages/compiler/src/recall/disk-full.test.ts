/**
 * Filesystem-failure simulation test (E10-B05, audit M3).
 *
 * Uses a real read-only directory (`chmod 0o500`) to provoke the same
 * error class a disk-full / permission failure would produce, and
 * verifies the recall card generator:
 *
 *   1. Returns an `err()` Result cleanly — no thrown exception bubbles
 *      out of the public function.
 *   2. Surfaces an `EACCES`-style failure in the error message so the
 *      CLI's friendly-error formatter can map it to a human hint.
 *   3. Leaves no half-written `.tmp` or final files on disk — the
 *      atomic-write pattern (`writeFileSync → renameSync`) is the
 *      safety net we're enforcing.
 *
 * We pick a real filesystem failure mode instead of mocking `fs` because
 * `vi.spyOn` cannot redefine the `node:fs` named exports (they're
 * read-only bindings) and `vi.mock('node:fs', ...)` would have to
 * stub every call site downstream of the generator. A read-only
 * directory is the closest production-shaped reproduction available
 * without root: any uncatchable disk failure (ENOSPC, EROFS, EACCES)
 * reaches the same `try/catch` and the same atomic-write guarantees.
 *
 * Why pick the recall generator specifically: it's the most recent
 * atomic-write call site (E9-B08) and exercises the same `.tmp + rename`
 * convention used everywhere else (collector, integrator, render, etc.).
 * If this passes, every other atomic-write path with the same shape is
 * implicitly covered.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  createSearchIndex,
  type Database,
  indexCompiledPages,
  initDatabase,
  initWorkspace,
} from '@ico/kernel';
import { ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import { generateRecall } from './generate.js';

interface Env {
  base: string;
  wsRoot: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-disk-full-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  const dbRes = initDatabase(ws.value.dbPath);
  if (!dbRes.ok) throw dbRes.error;
  const idx = createSearchIndex(dbRes.value);
  if (!idx.ok) throw idx.error;
  env = { base, wsRoot: ws.value.root, db: dbRes.value };
});

afterEach(() => {
  // Always restore write permissions so rm -r can succeed on teardown.
  const cardsDir = resolve(env.wsRoot, 'recall', 'cards');
  if (existsSync(cardsDir)) chmodSync(cardsDir, 0o700);
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
});

function seedWiki(slug: string, title: string, body: string): void {
  const abs = resolve(env.wsRoot, 'wiki', 'concepts', `${slug}.md`);
  mkdirSync(resolve(env.wsRoot, 'wiki', 'concepts'), { recursive: true });
  writeFileSync(
    abs,
    ['---', `title: ${title}`, 'type: concept', '---', '', body, ''].join('\n'),
    'utf-8',
  );
}

function mockClaude(payload: unknown): ClaudeClient {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    createCompletion: vi.fn().mockResolvedValue(
      ok({
        content,
        inputTokens: 80,
        outputTokens: 40,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      }),
    ),
  };
}

const STANDARD_PAYLOAD = {
  cards: [
    {
      concept: 'Test Concept',
      question: 'q',
      answer: 'a',
      source_pages: ['concepts/test.md'],
    },
  ],
  quiz: [{ question: 'q', answer: 'a', source_pages: ['concepts/test.md'] }],
};

describe('disk failure simulation (audit M3)', () => {
  it('generateRecall returns err on EACCES and leaves no files behind', async () => {
    seedWiki('test', 'Test', 'Body about test.');
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    // Make the cards target directory read-only. The atomic-write path
    // `writeFileSync('cards/concept.md.tmp', …)` then fails with EACCES.
    // This is the same error class the CLI's friendly-errors layer maps.
    const cardsDir = resolve(env.wsRoot, 'recall', 'cards');
    mkdirSync(cardsDir, { recursive: true });
    chmodSync(cardsDir, 0o500); // r-x for owner; no write.

    const client = mockClaude(STANDARD_PAYLOAD);
    const result = await generateRecall(env.db, env.wsRoot, 'test', client);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // EACCES/EROFS/ENOSPC all surface a recognisable code or "permission" word.
    expect(result.error.message).toMatch(/EACCES|permission|denied|read-only|space/i);

    // No final card file should exist — the `.tmp` write failed before
    // renameSync had a chance to atomically move it into place.
    const cardFiles = readdirSync(cardsDir).filter((f) => f.endsWith('.md'));
    expect(cardFiles).toHaveLength(0);

    // Also verify no orphan .tmp files leaked.
    const tmpFiles = readdirSync(cardsDir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('atomic-write pattern is preserved end-to-end on filesystem failure', async () => {
    seedWiki('test', 'Test', 'Body about test.');
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const cardsDir = resolve(env.wsRoot, 'recall', 'cards');
    mkdirSync(cardsDir, { recursive: true });
    chmodSync(cardsDir, 0o500);

    const client = mockClaude(STANDARD_PAYLOAD);
    const result = await generateRecall(env.db, env.wsRoot, 'test', client);
    expect(result.ok).toBe(false);

    // When the card write fails, the quiz file write is never attempted
    // (the generator bails on the first error). The atomic-write
    // guarantee for the quiz file is implicit: it cannot exist
    // because we never got that far.
    const quizPath = resolve(env.wsRoot, 'recall', 'quizzes', 'test.md');
    expect(existsSync(quizPath)).toBe(false);
  });
});
