/**
 * Tests for the synthetic corpus generator (E10-B06).
 *
 * The generator's contract is determinism: same seed + same count =
 * byte-identical output. Benchmark before/after comparisons depend on
 * this — drift here would silently invalidate every recorded result.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateCorpus } from './corpus.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ico-bench-corpus-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('generateCorpus', () => {
  it('writes exactly sourceCount files with predictable names', () => {
    const r = generateCorpus({ outputDir: dir, sourceCount: 5, seed: 1 });
    expect(r.files).toHaveLength(5);
    const names = readdirSync(dir).sort();
    expect(names).toEqual([
      'source-0000.md',
      'source-0001.md',
      'source-0002.md',
      'source-0003.md',
      'source-0004.md',
    ]);
    expect(r.totalBytes).toBeGreaterThan(0);
  });

  it('produces valid markdown with parseable frontmatter', () => {
    const r = generateCorpus({ outputDir: dir, sourceCount: 3, seed: 42 });
    for (const path of r.files) {
      const content = readFileSync(path, 'utf-8');
      const parsed = matter(content);
      expect(parsed.data['title']).toMatch(/#\d+$/);
      expect(parsed.data['type']).toBe('source');
      expect(parsed.data['created']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(parsed.data['tags'])).toBe(true);
      expect((parsed.data['tags'] as string[]).length).toBeGreaterThanOrEqual(1);
      expect(parsed.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('is deterministic — same seed yields byte-identical output', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'ico-bench-corpus2-'));
    try {
      const r1 = generateCorpus({ outputDir: dir, sourceCount: 4, seed: 7, bodyWords: 200 });
      const r2 = generateCorpus({ outputDir: dir2, sourceCount: 4, seed: 7, bodyWords: 200 });
      expect(r1.totalBytes).toBe(r2.totalBytes);
      for (let i = 0; i < r1.files.length; i += 1) {
        const a = readFileSync(r1.files[i]!, 'utf-8');
        const b = readFileSync(r2.files[i]!, 'utf-8');
        expect(a).toBe(b);
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('different seeds yield different content for the same index', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'ico-bench-corpus-diff-'));
    try {
      const r1 = generateCorpus({ outputDir: dir, sourceCount: 2, seed: 1, bodyWords: 100 });
      const r2 = generateCorpus({ outputDir: dir2, sourceCount: 2, seed: 2, bodyWords: 100 });
      const a = readFileSync(r1.files[0]!, 'utf-8');
      const b = readFileSync(r2.files[0]!, 'utf-8');
      expect(a).not.toBe(b);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('each file in a single corpus is unique by content hash', () => {
    // Dedup detection in the ingest pipeline keys on content hash. If
    // the generator produces duplicates, the benchmark would short-
    // circuit registration for most files and silently understate cost.
    const r = generateCorpus({ outputDir: dir, sourceCount: 25, seed: 100, bodyWords: 200 });
    const bodies = new Set(r.files.map((p) => readFileSync(p, 'utf-8')));
    expect(bodies.size).toBe(25);
  });

  it('honors bodyWords roughly — generated body has at least the requested word count', () => {
    const r = generateCorpus({ outputDir: dir, sourceCount: 1, seed: 1, bodyWords: 300 });
    const content = readFileSync(r.files[0]!, 'utf-8');
    const parsed = matter(content);
    // Count only alphabetic words to avoid markdown punctuation noise.
    const words = parsed.content.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
    expect(words.length).toBeGreaterThanOrEqual(300);
  });

  it('rejects sourceCount < 1', () => {
    expect(() => generateCorpus({ outputDir: dir, sourceCount: 0, seed: 1 })).toThrow(
      /sourceCount must be >= 1/,
    );
  });
});
