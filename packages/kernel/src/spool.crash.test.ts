/**
 * Crash-safety tests for the spool write sequence (bead l13.4).
 *
 * Invariant under test: the consumer-visible artifact (`spool-*.jsonl`) never
 * exists without its `.manifest.json` sidecar. We fault-inject at every step
 * of `atomicWriteSpool` (open/write/rename) through a mocked `node:fs`, and
 * also simulate a hard kill (no catch block runs) by pre-seeding leftovers.
 */

import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FailPoint =
  | 'open-spool-tmp'
  | 'write-spool'
  | 'open-manifest-tmp'
  | 'write-manifest'
  | 'rename-manifest'
  | 'rename-spool';

const hooks = vi.hoisted(() => ({
  failAt: null as string | null,
  /** Set true only around emitSpool so workspace/db setup is unaffected. */
  armed: false,
  /** Manifest visibility at the moment the spool body is published. */
  atSpoolPublish: null as null | { manifestExists: boolean; manifestSha: string | null },
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const boom = (): never => {
    throw Object.assign(new Error('ENOSPC: injected'), { code: 'ENOSPC' });
  };
  const fdPaths = new Map<number, string>();
  return {
    ...fs,
    openSync: ((path: string, ...rest: unknown[]) => {
      if (hooks.armed) {
        if (hooks.failAt === 'open-spool-tmp' && path.endsWith('.jsonl.tmp')) boom();
        if (hooks.failAt === 'open-manifest-tmp' && path.endsWith('.manifest.json.tmp')) boom();
      }
      const fd = (fs.openSync as (...a: unknown[]) => number)(path, ...rest);
      fdPaths.set(fd, path);
      return fd;
    }) as typeof fs.openSync,
    writeSync: ((fd: number, ...rest: unknown[]) => {
      if (hooks.armed) {
        const p = fdPaths.get(fd) ?? '';
        if (hooks.failAt === 'write-spool' && p.endsWith('.jsonl.tmp')) boom();
        if (hooks.failAt === 'write-manifest' && p.endsWith('.manifest.json.tmp')) boom();
      }
      return (fs.writeSync as (...a: unknown[]) => number)(fd, ...rest);
    }) as typeof fs.writeSync,
    renameSync: ((from: string, to: string) => {
      if (hooks.armed) {
        if (hooks.failAt === 'rename-manifest' && to.endsWith('.manifest.json')) boom();
        if (hooks.failAt === 'rename-spool' && to.endsWith('.jsonl')) boom();
        if (to.endsWith('.jsonl')) {
          const m = `${to}.manifest.json`;
          const present = fs.existsSync(m);
          hooks.atSpoolPublish = {
            manifestExists: present,
            manifestSha: present
              ? (JSON.parse(fs.readFileSync(m, 'utf-8')) as { spoolFileSha256: string })
                  .spoolFileSha256
              : null,
          };
        }
      }
      fs.renameSync(from, to);
    }) as typeof fs.renameSync,
  };
});

import { emitSpool } from './spool.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { initWorkspace } from './workspace.js';

let workspacePath: string;
let db: Database;

function spoolDir(): string {
  return join(workspacePath, 'spool');
}

function listing(): string[] {
  return existsSync(spoolDir()) ? readdirSync(spoolDir()) : [];
}

beforeEach(() => {
  hooks.failAt = null;
  hooks.armed = false;
  hooks.atSpoolPublish = null;
  const root = mkdtempSync(join(tmpdir(), 'ico-spool-crash-'));
  const init = initWorkspace('workspace', root);
  if (!init.ok) throw init.error;
  workspacePath = init.value.root;
  const d = initDatabase(join(workspacePath, '.ico', 'state.db'));
  if (!d.ok) throw d.error;
  db = d.value;
  const dir = join(workspacePath, 'wiki', 'concepts');
  realFs.mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'c.md'),
    [
      '---',
      'type: concept',
      'title: Backpressure',
      'id: 00000000-0000-4000-8000-000000000000',
      'compiled_at: 2026-05-23T00:00:00.000Z',
      'model: claude-sonnet-4-6',
      '---',
      '',
      'Backpressure lets a slow consumer signal a fast producer to slow down, preventing unbounded queue growth and memory exhaustion in pipelines.',
      '',
    ].join('\n'),
  );
});

afterEach(() => {
  hooks.armed = false;
  closeDatabase(db);
  rmSync(resolve(workspacePath, '..'), { recursive: true, force: true });
});

function emit() {
  hooks.armed = true;
  try {
    return emitSpool(db, workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
  } finally {
    hooks.armed = false;
  }
}

describe('spool write ordering: a failure at any step never leaves a manifest-less spool', () => {
  const points: FailPoint[] = [
    'open-spool-tmp',
    'write-spool',
    'open-manifest-tmp',
    'write-manifest',
    'rename-manifest',
    'rename-spool',
  ];

  it.each(points)('fault at %s: emit fails, nothing consumer-visible, no leftovers', (point) => {
    hooks.failAt = point;
    const r = emit();
    expect(r.ok).toBe(false);
    const files = listing();
    expect(files.filter((f) => f.endsWith('.jsonl'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // Cleanup also removes a manifest published before a failing spool rename.
    expect(files.filter((f) => f.endsWith('.manifest.json'))).toEqual([]);
  });

  it('publishes the manifest strictly before the spool body, with a matching hash', () => {
    const r = emit();
    expect(r.ok).toBe(true);
    expect(hooks.atSpoolPublish?.manifestExists).toBe(true);
    const spool = listing().find((f) => f.endsWith('.jsonl')) as string;
    const sha = createHash('sha256')
      .update(readFileSync(join(spoolDir(), spool), 'utf-8'), 'utf-8')
      .digest('hex');
    expect(hooks.atSpoolPublish?.manifestSha).toBe(sha);
  });

  it('a hard kill leaving tmp files and an orphan manifest does not block or corrupt a retry', () => {
    const first = emit();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const spoolFile = first.value.spoolFile;
    // Simulate SIGKILL after the manifest rename: body never published,
    // stale tmps and an orphan manifest left behind (same-second name reuse).
    rmSync(spoolFile);
    writeFileSync(`${spoolFile}.tmp`, 'partial');
    writeFileSync(`${spoolFile}.manifest.json.tmp`, '{');
    writeFileSync(`${spoolFile}.manifest.json`, '{"stale":true}');

    // The consumer sees no .jsonl, so nothing is ingested from the crashed run.
    expect(listing().filter((f) => f.endsWith('.jsonl'))).toEqual([]);

    const retry = emit();
    expect(retry.ok).toBe(true);
    const files = listing();
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    for (const j of files.filter((f) => f.endsWith('.jsonl'))) {
      expect(files).toContain(`${j}.manifest.json`);
    }
  });
});
