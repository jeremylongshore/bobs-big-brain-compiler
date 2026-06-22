/**
 * Unit tests for the shared batching + dedupe/merge helper.
 *
 * Pure functions only — no workspace, no DB, no Claude client.
 */

import { describe, expect, it } from 'vitest';

import {
  chunkArray,
  deriveStableId,
  extractFrontmatterField,
  mergePages,
  normalizeTitle,
  parseFrontmatterList,
  setFrontmatterField,
  setFrontmatterList,
} from './batch-helper.js';

// ---------------------------------------------------------------------------
// Page fixtures
// ---------------------------------------------------------------------------

function conceptPage(title: string, sourceIds: string[], body = 'A concept.'): string {
  return `---
type: concept
id: ${'rand-' + title.toLowerCase().replace(/\s+/g, '-')}
title: ${title}
definition: A short definition.
source_ids:
${sourceIds.map((s) => `  - ${s}`).join('\n')}
compiled_at: 2026-04-06T00:00:00.000Z
model: claude-sonnet-4-6
---

${body}`;
}

// ---------------------------------------------------------------------------
// chunkArray
// ---------------------------------------------------------------------------

describe('chunkArray', () => {
  it('splits an array into contiguous chunks of the given size', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one chunk when size exceeds the array length', () => {
    expect(chunkArray([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it('returns an empty array for an empty input', () => {
    expect(chunkArray([], 5)).toEqual([]);
  });

  it('falls back to a single chunk when size is non-positive', () => {
    expect(chunkArray([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(chunkArray([1, 2, 3], -1)).toEqual([[1, 2, 3]]);
  });

  it('produces ceil(n / size) chunks across many elements', () => {
    const arr = Array.from({ length: 60 }, (_, i) => i);
    const chunks = chunkArray(arr, 25);
    expect(chunks).toHaveLength(3); // ceil(60 / 25) = 3
    expect(chunks.flat()).toHaveLength(60);
  });
});

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------

describe('normalizeTitle', () => {
  it('lowercases and hyphenates', () => {
    expect(normalizeTitle('Knowledge Compilation')).toBe('knowledge-compilation');
  });

  it('collapses punctuation and trims edges', () => {
    expect(normalizeTitle('  Knowledge   Compilation!! ')).toBe('knowledge-compilation');
  });

  it('maps cosmetically-different spellings of the same title to the same key', () => {
    expect(normalizeTitle('Semantic Graphs')).toBe(normalizeTitle('semantic-graphs'));
    expect(normalizeTitle('Semantic Graphs')).toBe(normalizeTitle('Semantic, Graphs'));
  });
});

// ---------------------------------------------------------------------------
// deriveStableId
// ---------------------------------------------------------------------------

describe('deriveStableId', () => {
  it('is deterministic for the same normalized title', () => {
    expect(deriveStableId('knowledge-compilation')).toBe(deriveStableId('knowledge-compilation'));
  });

  it('differs for different titles', () => {
    expect(deriveStableId('knowledge-compilation')).not.toBe(deriveStableId('semantic-graphs'));
  });

  it('emits a v5-shaped UUID (version nibble 5, RFC-4122 variant)', () => {
    const id = deriveStableId('knowledge-compilation');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------------------
// frontmatter field access
// ---------------------------------------------------------------------------

describe('extractFrontmatterField', () => {
  it('reads a scalar field', () => {
    const page = conceptPage('Knowledge Compilation', ['s1']);
    expect(extractFrontmatterField(page, 'title')).toBe('Knowledge Compilation');
    expect(extractFrontmatterField(page, 'type')).toBe('concept');
  });

  it('returns undefined for an absent field', () => {
    expect(extractFrontmatterField(conceptPage('X', ['s1']), 'nope')).toBeUndefined();
  });
});

describe('parseFrontmatterList', () => {
  it('parses a block-style list', () => {
    const page = conceptPage('Knowledge Compilation', ['s1', 's2', 's3']);
    expect(parseFrontmatterList(page, 'source_ids')).toEqual(['s1', 's2', 's3']);
  });

  it('parses an inline flow-style list', () => {
    const page = `---
type: concept
title: Inline
source_ids: [a1, a2, a3]
---
body`;
    expect(parseFrontmatterList(page, 'source_ids')).toEqual(['a1', 'a2', 'a3']);
  });

  it('returns an empty array for an absent list field', () => {
    const page = `---
type: concept
title: NoList
---
body`;
    expect(parseFrontmatterList(page, 'source_ids')).toEqual([]);
  });

  it('does not pick up a list key from the markdown body', () => {
    const page = `---
type: concept
title: BodyTrap
source_ids:
  - real-1
---
source_ids:
  - body-not-real`;
    expect(parseFrontmatterList(page, 'source_ids')).toEqual(['real-1']);
  });
});

// ---------------------------------------------------------------------------
// frontmatter rewriting
// ---------------------------------------------------------------------------

describe('setFrontmatterField', () => {
  it('replaces an existing scalar field value', () => {
    const page = conceptPage('X', ['s1']);
    const out = setFrontmatterField(page, 'id', 'STABLE-ID');
    expect(extractFrontmatterField(out, 'id')).toBe('STABLE-ID');
  });

  it('inserts the field after the opening fence when absent', () => {
    const page = `---
type: concept
title: NoId
---
body`;
    const out = setFrontmatterField(page, 'id', 'STABLE-ID');
    expect(extractFrontmatterField(out, 'id')).toBe('STABLE-ID');
    expect(out).toContain('type: concept');
  });
});

describe('setFrontmatterList', () => {
  it('replaces an existing block list with the union values', () => {
    const page = conceptPage('X', ['s1']);
    const out = setFrontmatterList(page, 'source_ids', ['s1', 's2']);
    expect(parseFrontmatterList(out, 'source_ids')).toEqual(['s1', 's2']);
    // Other frontmatter survives.
    expect(extractFrontmatterField(out, 'title')).toBe('X');
    expect(out).toContain('A concept.');
  });
});

// ---------------------------------------------------------------------------
// mergePages — the dedupe/merge core
// ---------------------------------------------------------------------------

describe('mergePages', () => {
  it('collapses same-titled pages into one and unions the source_ids', () => {
    const pages = [
      conceptPage('Knowledge Compilation', ['s1']),
      conceptPage('knowledge   compilation', ['s2', 's3']),
    ];
    const merged = mergePages(pages, { listField: 'source_ids' });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.key).toBe('knowledge-compilation');
    expect(parseFrontmatterList(merged[0]!.content, 'source_ids').sort()).toEqual([
      's1',
      's2',
      's3',
    ]);
  });

  it('keeps distinct titles as separate pages, in first-seen order', () => {
    const pages = [
      conceptPage('Semantic Graphs', ['s1']),
      conceptPage('Knowledge Compilation', ['s2']),
    ];
    const merged = mergePages(pages, { listField: 'source_ids' });
    expect(merged.map((m) => m.key)).toEqual(['semantic-graphs', 'knowledge-compilation']);
  });

  it('stamps a stable id keyed on the normalized title (idempotent re-runs)', () => {
    const a = mergePages([conceptPage('Knowledge Compilation', ['s1'])], {
      listField: 'source_ids',
    });
    const b = mergePages([conceptPage('Knowledge Compilation', ['s9'])], {
      listField: 'source_ids',
    });
    // Different runs, different model-generated ids and source sets, but the
    // stamped id is identical because it derives from the title.
    expect(extractFrontmatterField(a[0]!.content, 'id')).toBe(
      extractFrontmatterField(b[0]!.content, 'id'),
    );
    expect(a[0]!.id).toBe(deriveStableId('knowledge-compilation'));
  });

  it('keeps the longest body as the canonical content', () => {
    const short = conceptPage('Topic', ['s1'], 'short');
    const long = conceptPage('topic', ['s2'], 'a much longer and richer definition body');
    const merged = mergePages([short, long], { listField: 'source_ids' });
    expect(merged[0]!.content).toContain('a much longer and richer definition body');
  });
});
