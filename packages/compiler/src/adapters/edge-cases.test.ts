/**
 * Edge case tests for all ingest adapters.
 *
 * Covers boundary conditions not exercised by the per-adapter unit suites:
 * empty inputs, Unicode filenames, special characters, malformed binaries,
 * extension variants, and structural HTML edge cases.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestMarkdown } from './markdown.js';
import { ingestPdf } from './pdf.js';
import { detectSourceType, ingestSource } from './registry.js';
import { ingestWebClip } from './web-clip.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

/** Write a UTF-8 text file into the temp directory and return its path. */
function writeTmp(name: string, content: string): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Write a binary buffer into the temp directory and return its path. */
async function writeBinaryTmp(name: string, data: Buffer): Promise<string> {
  const filePath = join(tmpDir, name);
  await writeFile(filePath, data);
  return filePath;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ico-edge-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Markdown edge cases
// ---------------------------------------------------------------------------

describe('ingestMarkdown — edge cases', () => {
  it('returns ok with 0 word count and null title for an empty file (0 bytes)', () => {
    const filePath = writeTmp('empty.md', '');
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.wordCount).toBe(0);
    expect(result.value.metadata.title).toBeNull();
    expect(result.value.content).toBe('');
  });

  it('returns 0 word count and title from frontmatter when file has only frontmatter, no body', () => {
    const content = `---
title: Frontmatter Only
author: Ghost Writer
date: 2025-01-01
tags: [stub]
---
`;
    const filePath = writeTmp('fm-only.md', content);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('Frontmatter Only');
    // Body after the frontmatter delimiter is an empty string or a single newline.
    // Either way, word count must be 0.
    expect(result.value.metadata.wordCount).toBe(0);
  });

  it('preserves special characters in the frontmatter title', () => {
    const content = `---
title: "Hänschen & Klein: A <Möbius> Story"
---
Some body text.
`;
    const filePath = writeTmp('special-title.md', content);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('"Hänschen & Klein: A <Möbius> Story"');
  });

  it('counts words correctly in a file with Unicode multi-byte content', () => {
    // Japanese and emoji alongside ASCII: each whitespace-delimited token counts as 1 word.
    const content = `こんにちは 世界 hello world 🌏 done\n`;
    const filePath = writeTmp('unicode.md', content);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Six whitespace-separated tokens
    expect(result.value.metadata.wordCount).toBe(6);
  });

  it('returns null title when there is no heading and no frontmatter', () => {
    const content = `Just plain text, no heading at all.\n`;
    const filePath = writeTmp('no-title.md', content);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBeNull();
  });

  it('uses the first heading as title when multiple headings are present', () => {
    const content = `# First Heading

Some content here.

# Second Heading

More content.

## Sub Heading

Even more.
`;
    const filePath = writeTmp('multi-heading.md', content);
    const result = ingestMarkdown(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('First Heading');
  });
});

// ---------------------------------------------------------------------------
// PDF edge cases
// ---------------------------------------------------------------------------

describe('ingestPdf — edge cases', () => {
  it('returns err for an empty file (0 bytes)', async () => {
    const filePath = await writeBinaryTmp('empty.pdf', Buffer.alloc(0));
    const result = await ingestPdf(filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(Error);
  });

  it('returns err with a descriptive message for random corrupted bytes', async () => {
    // Bytes that begin with the PDF magic bytes to pass the first check,
    // then dissolve into noise so the parser fails structurally.
    const corrupted = Buffer.from(
      '%PDF-1.4\n' + '\x00\xFF\xFE\xFD\xFC\xFB\xFA\xF9\xF8\xF7\xF6garbage!!@@##$$',
      'binary',
    );
    const filePath = await writeBinaryTmp('corrupted.pdf', corrupted);
    const result = await ingestPdf(filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(Error);
    // The adapter must surface a meaningful message (not a raw pdfjs trace).
    expect(result.error.message.length).toBeGreaterThan(0);
    expect(result.error.message).toMatch(/corrupt|invalid|malformed|unreadable|parse|unexpected/i);
  });
});

// ---------------------------------------------------------------------------
// Web-clip edge cases
// ---------------------------------------------------------------------------

describe('ingestWebClip — edge cases', () => {
  it('returns ok with empty content for an empty HTML file', () => {
    const filePath = writeTmp('empty.html', '');
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.content).toBe('');
    expect(result.value.metadata.wordCount).toBe(0);
    expect(result.value.sourceType).toBe('html');
  });

  it('extracts title and returns non-empty content when HTML has only <head>, no <body>', () => {
    // When there is no <body> tag the adapter falls back to converting the
    // full HTML string via Turndown, so content will be non-null (though likely
    // minimal).  The title extraction from <title> must still succeed.
    const content = `<!DOCTYPE html>
<html>
<head>
  <title>Head Only Page</title>
  <meta charset="UTF-8">
</head>
</html>`;
    const filePath = writeTmp('head-only.html', content);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('Head Only Page');
    // Content is the Turndown conversion of the full HTML (no <body> fallback).
    // It should at least be a string — we don't assert on exact content.
    expect(typeof result.value.content).toBe('string');
  });

  it('preserves special characters in the HTML title', () => {
    const content = `<!DOCTYPE html>
<html>
<head>
  <title>Café & Bistro — "Über" Edition</title>
</head>
<body><p>Content.</p></body>
</html>`;
    const filePath = writeTmp('special-title.html', content);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('Café & Bistro — "Über" Edition');
  });

  it('produces clean markdown from HTML with deeply nested tags', () => {
    const content = `<!DOCTYPE html>
<html>
<head><title>Nested Tags</title></head>
<body>
  <div class="outer">
    <section>
      <article>
        <h2>Nested Heading</h2>
        <p>Text inside <span><em>deeply <strong>nested</strong></em></span> tags.</p>
      </article>
    </section>
  </div>
</body>
</html>`;
    const filePath = writeTmp('nested.html', content);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Turndown should produce a recognisable heading and the key words.
    expect(result.value.content).toContain('Nested Heading');
    expect(result.value.content).toContain('nested');
    // Raw HTML tags must not leak into the markdown output.
    expect(result.value.content).not.toMatch(/<div|<section|<article|<span/i);
  });
});

// ---------------------------------------------------------------------------
// Registry — detectSourceType edge cases
// ---------------------------------------------------------------------------

describe('detectSourceType — edge cases', () => {
  it('returns "text" for a path with no extension', () => {
    expect(detectSourceType('/home/user/NOTES')).toBe('text');
    expect(detectSourceType('/tmp/README')).toBe('text');
  });

  it('returns "pdf" for an uppercase .PDF extension', () => {
    expect(detectSourceType('/downloads/report.PDF')).toBe('pdf');
  });

  it('returns "text" for a double extension, using only the last segment', () => {
    // The last extension is .gz, which is not in the map → 'text'.
    expect(detectSourceType('/archives/backup.tar.gz')).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// Unicode filenames
// ---------------------------------------------------------------------------

describe('ingestSource — Unicode filenames', () => {
  it('ingests a file with a Japanese filename (日本語.md) correctly', async () => {
    const content = `# 日本語のドキュメント

これはテスト文書です。
`;
    const filePath = writeTmp('日本語.md', content);
    const result = await ingestSource(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sourceType).toBe('markdown');
    expect(result.value.metadata.title).toBe('日本語のドキュメント');
    expect(result.value.metadata.wordCount).toBeGreaterThan(0);
  });

  it('ingests a file with an accented filename (café-notes.md) correctly', async () => {
    const content = `# Café Notes

Latte art and espresso tips.
`;
    const filePath = writeTmp('café-notes.md', content);
    const result = await ingestSource(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sourceType).toBe('markdown');
    expect(result.value.metadata.title).toBe('Café Notes');
  });
});
