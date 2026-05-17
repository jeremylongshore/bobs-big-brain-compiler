/**
 * Tests for the wiki fixture generator (E10-B06).
 *
 * The lint benchmark relies on these fixtures passing the same
 * validateCompiledPage checks that `runLint` uses. If this generator
 * drifts away from the live schemas, the lint scenario silently degrades
 * into "schema-error timing" — a useless number.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateCompiledPage } from '@ico/compiler';
import { initWorkspace } from '@ico/kernel';

import { generateWiki } from './wiki.js';

let base: string;
let wsPath: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ico-bench-wiki-'));
  const ws = initWorkspace('bench', base);
  if (!ws.ok) throw ws.error;
  wsPath = ws.value.root;
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('generateWiki', () => {
  it('writes the requested number of concept and topic pages', () => {
    const r = generateWiki({
      workspacePath: wsPath,
      conceptCount: 4,
      topicCount: 2,
      seed: 1,
    });
    expect(r.conceptPaths).toHaveLength(4);
    expect(r.topicPaths).toHaveLength(2);
    expect(r.conceptIds).toHaveLength(4);
    expect(r.topicIds).toHaveLength(2);
  });

  it('every generated concept page passes validateCompiledPage', () => {
    const r = generateWiki({
      workspacePath: wsPath,
      conceptCount: 5,
      topicCount: 0,
      seed: 2,
    });
    for (const path of r.conceptPaths) {
      const validation = validateCompiledPage(path);
      if (!validation.ok) throw validation.error;
      expect(
        validation.value.valid,
        `concept page ${path} failed: ${validation.value.errors.join('; ')}`,
      ).toBe(true);
    }
  });

  it('every generated topic page passes validateCompiledPage', () => {
    const r = generateWiki({
      workspacePath: wsPath,
      conceptCount: 3,
      topicCount: 3,
      seed: 3,
    });
    for (const path of r.topicPaths) {
      const validation = validateCompiledPage(path);
      if (!validation.ok) throw validation.error;
      expect(
        validation.value.valid,
        `topic page ${path} failed: ${validation.value.errors.join('; ')}`,
      ).toBe(true);
    }
  });

  it('is deterministic — same seed yields byte-identical output', () => {
    const base2 = mkdtempSync(join(tmpdir(), 'ico-bench-wiki2-'));
    try {
      const ws2 = initWorkspace('bench', base2);
      if (!ws2.ok) throw ws2.error;
      const r1 = generateWiki({
        workspacePath: wsPath,
        conceptCount: 3,
        topicCount: 2,
        seed: 99,
      });
      const r2 = generateWiki({
        workspacePath: ws2.value.root,
        conceptCount: 3,
        topicCount: 2,
        seed: 99,
      });
      for (let i = 0; i < r1.conceptPaths.length; i += 1) {
        const a = readFileSync(r1.conceptPaths[i]!, 'utf-8');
        const b = readFileSync(r2.conceptPaths[i]!, 'utf-8');
        expect(a).toBe(b);
      }
      for (let i = 0; i < r1.topicPaths.length; i += 1) {
        const a = readFileSync(r1.topicPaths[i]!, 'utf-8');
        const b = readFileSync(r2.topicPaths[i]!, 'utf-8');
        expect(a).toBe(b);
      }
    } finally {
      rmSync(base2, { recursive: true, force: true });
    }
  });

  it('concept UUIDs are unique within a single run', () => {
    const r = generateWiki({
      workspacePath: wsPath,
      conceptCount: 25,
      topicCount: 0,
      seed: 50,
    });
    expect(new Set(r.conceptIds).size).toBe(25);
  });

  it('handles zero counts without error', () => {
    const r = generateWiki({
      workspacePath: wsPath,
      conceptCount: 0,
      topicCount: 0,
      seed: 1,
    });
    expect(r.conceptPaths).toEqual([]);
    expect(r.topicPaths).toEqual([]);
  });

  it('rejects negative counts', () => {
    expect(() =>
      generateWiki({ workspacePath: wsPath, conceptCount: -1, topicCount: 0 }),
    ).toThrow(/conceptCount/);
    expect(() =>
      generateWiki({ workspacePath: wsPath, conceptCount: 0, topicCount: -1 }),
    ).toThrow(/topicCount/);
  });
});
