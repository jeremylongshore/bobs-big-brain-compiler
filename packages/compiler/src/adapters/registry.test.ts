import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectSourceType, ingestSource } from './registry.js';

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
// detectSourceType
// ---------------------------------------------------------------------------

describe('detectSourceType', () => {
  it('maps .md to markdown', () => {
    expect(detectSourceType('/some/path/doc.md')).toBe('markdown');
  });

  it('maps .mdx to markdown', () => {
    expect(detectSourceType('/some/path/doc.mdx')).toBe('markdown');
  });

  it('maps .pdf to pdf', () => {
    expect(detectSourceType('/some/path/document.pdf')).toBe('pdf');
  });

  it('maps .html to html', () => {
    expect(detectSourceType('/some/path/page.html')).toBe('html');
  });

  it('maps .htm to html', () => {
    expect(detectSourceType('/some/path/page.htm')).toBe('html');
  });

  it('maps .txt to text', () => {
    expect(detectSourceType('/some/path/notes.txt')).toBe('text');
  });

  it('maps unknown extension .csv to text', () => {
    expect(detectSourceType('/some/path/data.csv')).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// ingestSource
// ---------------------------------------------------------------------------

describe('ingestSource', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ico-registry-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ['markdown', '# Captured title\nBody'],
    ['text', '# Captured title\nBody'],
    ['html', '<html><title>Captured title</title><body>Body</body></html>'],
  ] as const)('parses captured %s bytes without opening a missing path', async (type, text) => {
    const captured = Buffer.from(text);
    const before = Buffer.from(captured);
    const result = await ingestSource(join(tmpDir, 'missing'), type, captured);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.metadata.title).toBe('Captured title');
    expect(result.value.content).toContain('Body');
    expect(captured.equals(before)).toBe(true);
  });

  it('routes a .md file to the markdown adapter', async () => {
    const content = `---
title: Registry Test
author: Test Author
date: 2024-01-01
tags: [registry]
---
# Registry Test

Body content for routing verification.
`;
    const filePath = writeTmp('doc.md', content);
    const result = await ingestSource(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sourceType).toBe('markdown');
    expect(result.value.metadata.title).toBe('Registry Test');
  });

  it('routes a .html file to the web-clip adapter', async () => {
    const content = `<!DOCTYPE html>
<html>
<head>
  <title>Clip Title</title>
</head>
<body>
  <p>Web clip paragraph content.</p>
</body>
</html>`;
    const filePath = writeTmp('clip.html', content);
    const result = await ingestSource(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sourceType).toBe('html');
    expect(result.value.metadata.title).toBe('Clip Title');
  });

  it('uses typeOverride instead of the file extension', async () => {
    // File has a .txt extension but we force it through the markdown adapter
    // by passing typeOverride: 'markdown'. Both resolve to ingestMarkdown,
    // but this test also verifies that a .html override on a .md file works.
    const content = `<!DOCTYPE html>
<html>
<head>
  <title>Override Title</title>
</head>
<body>
  <p>Overridden content.</p>
</body>
</html>`;
    // Write as .md so the auto-detect would pick markdown, but override to html
    const filePath = writeTmp('page.md', content);
    const result = await ingestSource(filePath, 'html');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The web-clip adapter was used (sourceType 'html'), not the markdown adapter
    expect(result.value.sourceType).toBe('html');
    expect(result.value.metadata.title).toBe('Override Title');
  });

  it('returns err when the file does not exist', async () => {
    const result = await ingestSource(join(tmpDir, 'nonexistent.md'));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(Error);
  });
});
