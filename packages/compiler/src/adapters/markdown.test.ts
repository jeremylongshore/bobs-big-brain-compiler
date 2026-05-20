import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestMarkdown } from './markdown.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_FRONTMATTER = `---
title: Test Document
author: Jane Doe
date: 2024-01-15
tags: [typescript, testing, markdown]
---
# Test Document

This is the body of the document.
It has multiple words for counting purposes.
`;

const ARRAY_TAGS_NO_BRACKETS = `---
title: Tag Test
tags: alpha, beta, gamma
---
Some body content here.
`;

const NO_FRONTMATTER_WITH_HEADING = `# My Heading

Here is some content without any frontmatter at all.
Just plain markdown.
`;

const NO_FRONTMATTER_NO_HEADING = `This document has no heading and no frontmatter.
Just a plain body.
`;

const EMPTY_FILE = ``;

const FRONTMATTER_NO_TITLE = `---
author: John Smith
date: 2024-06-01
tags: [notes]
---
# Fallback Heading

Body text follows the heading.
`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function writeTmp(name: string, content: string): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ingestMarkdown', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ico-md-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts title, author, date, and tags from frontmatter', () => {
    const filePath = writeTmp('full.md', FULL_FRONTMATTER);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('Test Document');
    expect(result.value.metadata.author).toBe('Jane Doe');
    expect(result.value.metadata.date).toBe('2024-01-15');
    expect(result.value.metadata.tags).toEqual(['typescript', 'testing', 'markdown']);
    expect(result.value.sourceType).toBe('markdown');
  });

  it('falls back to first # heading when frontmatter has no title', () => {
    const filePath = writeTmp('no-title.md', FRONTMATTER_NO_TITLE);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('Fallback Heading');
    expect(result.value.metadata.author).toBe('John Smith');
    expect(result.value.metadata.tags).toEqual(['notes']);
  });

  it('uses first heading as title when there is no frontmatter', () => {
    const filePath = writeTmp('heading-only.md', NO_FRONTMATTER_WITH_HEADING);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('My Heading');
    expect(result.value.metadata.author).toBeNull();
    expect(result.value.metadata.date).toBeNull();
    expect(result.value.metadata.tags).toEqual([]);
  });

  it('returns null title when there is no frontmatter and no heading', () => {
    const filePath = writeTmp('bare.md', NO_FRONTMATTER_NO_HEADING);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBeNull();
  });

  it('computes an accurate word count from the body', () => {
    const filePath = writeTmp('full.md', FULL_FRONTMATTER);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Body after frontmatter:
    // "# Test Document\n\nThis is the body of the document.\nIt has multiple words for counting purposes.\n"
    // Words: Test, Document, This, is, the, body, of, the, document., It, has, multiple, words, for, counting, purposes.
    // That is 16 tokens split on whitespace.
    const body = result.value.content;
    const expectedCount = body.split(/\s+/).filter((w) => w.length > 0).length;

    expect(result.value.metadata.wordCount).toBe(expectedCount);
    expect(result.value.metadata.wordCount).toBeGreaterThan(0);
  });

  it('parses tags as an array from bracket notation', () => {
    const filePath = writeTmp('full.md', FULL_FRONTMATTER);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Array.isArray(result.value.metadata.tags)).toBe(true);
    expect(result.value.metadata.tags).toHaveLength(3);
  });

  it('parses tags as an array from bare comma-separated notation', () => {
    const filePath = writeTmp('tags.md', ARRAY_TAGS_NO_BRACKETS);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('excludes the frontmatter block from content', () => {
    const filePath = writeTmp('full.md', FULL_FRONTMATTER);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.content).not.toContain('---');
    expect(result.value.content).not.toContain('author: Jane Doe');
    expect(result.value.content).toContain('This is the body');
  });

  it('returns err when the file does not exist', () => {
    const result = ingestMarkdown(join(tmpDir, 'nonexistent.md'));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(Error);
  });

  it('returns 0 word count for an empty file', () => {
    const filePath = writeTmp('empty.md', EMPTY_FILE);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.wordCount).toBe(0);
    expect(result.value.metadata.title).toBeNull();
    expect(result.value.content).toBe('');
  });
});
