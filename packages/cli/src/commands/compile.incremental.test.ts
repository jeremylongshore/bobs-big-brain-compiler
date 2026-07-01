/**
 * Unit tests for the incremental-compile CLI helper `parseChangedList`
 * (e06.5 / R12 / umbrella #27).
 *
 * `parseChangedList` turns a `--changed` argument (inline comma/newline list OR
 * a manifest file) into the `ChangedFile[]` the diff consumes, computing each
 * path's current on-disk hash. It fails toward freshness: an unreadable path is
 * still returned (empty hash) rather than silently dropped. Deterministic,
 * zero-LLM-cost — real temp files only.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseChangedList } from './compile.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('parseChangedList', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ico-incr-cli-'));
    mkdirSync(join(ws, 'raw', 'notes'), { recursive: true });
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('parses an inline comma-separated list and hashes each existing file', () => {
    writeFileSync(join(ws, 'raw/notes/a.md'), 'AAA', 'utf-8');
    writeFileSync(join(ws, 'raw/notes/b.md'), 'BBB', 'utf-8');

    const changed = parseChangedList('raw/notes/a.md,raw/notes/b.md', ws);
    expect(changed).toHaveLength(2);
    expect(changed[0]).toEqual({ path: 'raw/notes/a.md', hash: sha256('AAA') });
    expect(changed[1]).toEqual({ path: 'raw/notes/b.md', hash: sha256('BBB') });
  });

  it('parses a newline-separated manifest file', () => {
    writeFileSync(join(ws, 'raw/notes/a.md'), 'AAA', 'utf-8');
    writeFileSync(join(ws, 'raw/notes/b.md'), 'BBB', 'utf-8');
    const manifest = join(ws, '.changed');
    writeFileSync(manifest, 'raw/notes/a.md\nraw/notes/b.md\n', 'utf-8');

    const changed = parseChangedList(manifest, ws);
    expect(changed.map((c) => c.path)).toEqual(['raw/notes/a.md', 'raw/notes/b.md']);
    expect(changed[0]?.hash).toBe(sha256('AAA'));
  });

  it('deduplicates repeated paths and skips blanks', () => {
    writeFileSync(join(ws, 'raw/notes/a.md'), 'AAA', 'utf-8');
    const changed = parseChangedList('raw/notes/a.md,,raw/notes/a.md\n  \n', ws);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.path).toBe('raw/notes/a.md');
  });

  it('fails toward freshness: an unreadable path is kept with an empty hash', () => {
    // No file on disk — the diff will treat empty-hash != stored-hash as changed,
    // so the trigger is never silently dropped.
    const changed = parseChangedList('raw/notes/missing.md', ws);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toEqual({ path: 'raw/notes/missing.md', hash: '' });
  });
});
