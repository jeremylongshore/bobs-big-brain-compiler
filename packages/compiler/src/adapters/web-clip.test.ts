import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestWebClip } from './web-clip.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>My Article Title</title>
  <link rel="canonical" href="https://example.com/my-article">
  <meta name="author" content="Jane Doe">
  <meta property="article:published_time" content="2024-03-15T10:00:00Z">
  <meta property="og:url" content="https://example.com/og-url">
</head>
<body>
  <h1>My Article Title</h1>
  <p>This is the first paragraph of the article.</p>
  <p>This is the second paragraph with more content.</p>
</body>
</html>`;

const NO_METADATA_HTML = `<!DOCTYPE html>
<html>
<head>
</head>
<body>
  <p>Just some content with no metadata.</p>
</body>
</html>`;

const TITLE_ONLY_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Only a Title</title>
</head>
<body>
  <p>Body content here.</p>
</body>
</html>`;

const CANONICAL_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Canonical Test</title>
  <link rel="canonical" href="https://example.com/canonical-path">
</head>
<body>
  <p>Content.</p>
</body>
</html>`;

const OG_URL_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>OG URL Test</title>
  <meta property="og:url" content="https://example.com/og-path">
</head>
<body>
  <p>Content.</p>
</body>
</html>`;

const BODY_CONTENT_HTML = `<!DOCTYPE html>
<html>
<head><title>Body Test</title></head>
<body>
  <h1>Main Heading</h1>
  <p>A paragraph with <strong>bold</strong> text.</p>
  <pre><code>const x = 1;</code></pre>
</body>
</html>`;

const WORD_COUNT_HTML = `<!DOCTYPE html>
<html>
<head><title>Word Count</title></head>
<body>
  <p>one two three four five</p>
</body>
</html>`;

const EMPTY_HTML = ``;

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

describe('ingestWebClip', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ico-web-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts all metadata from a full HTML document', () => {
    const filePath = writeTmp('full.html', FULL_HTML);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('My Article Title');
    expect(result.value.metadata.author).toBe('Jane Doe');
    expect(result.value.metadata.date).toBe('2024-03-15T10:00:00Z');
    // canonical takes priority over og:url
    expect(result.value.metadata.sourceUrl).toBe('https://example.com/my-article');
    expect(result.value.sourceType).toBe('html');
    expect(Array.isArray(result.value.metadata.tags)).toBe(true);
    expect(result.value.metadata.tags).toHaveLength(0);
  });

  it('returns null title and undefined sourceUrl when metadata is absent', () => {
    const filePath = writeTmp('no-meta.html', NO_METADATA_HTML);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBeNull();
    expect(result.value.metadata.sourceUrl).toBeUndefined();
    expect(result.value.metadata.author).toBeNull();
    expect(result.value.metadata.date).toBeNull();
  });

  it('extracts title from <title> tag', () => {
    const filePath = writeTmp('title-only.html', TITLE_ONLY_HTML);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.title).toBe('Only a Title');
  });

  it('extracts sourceUrl from <link rel="canonical">', () => {
    const filePath = writeTmp('canonical.html', CANONICAL_HTML);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.sourceUrl).toBe('https://example.com/canonical-path');
  });

  it('falls back to og:url when no canonical link is present', () => {
    const filePath = writeTmp('og-url.html', OG_URL_HTML);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.sourceUrl).toBe('https://example.com/og-path');
  });

  it('converts body HTML to clean markdown', () => {
    const filePath = writeTmp('body.html', BODY_CONTENT_HTML);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ATX heading style — should produce `# Main Heading`
    expect(result.value.content).toContain('# Main Heading');
    // Fenced code block — should produce ``` fences
    expect(result.value.content).toContain('```');
    expect(result.value.content).toContain('const x = 1;');
    // Bold text
    expect(result.value.content).toContain('**bold**');
  });

  it('computes word count from the converted markdown', () => {
    const filePath = writeTmp('words.html', WORD_COUNT_HTML);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // "one two three four five" = 5 words
    expect(result.value.metadata.wordCount).toBe(5);
    // wordCount must match what you get counting the content directly
    const derivedCount = result.value.content.split(/\s+/).filter((w) => w.length > 0).length;
    expect(result.value.metadata.wordCount).toBe(derivedCount);
  });

  it('returns err when the file does not exist', () => {
    const result = ingestWebClip(join(tmpDir, 'nonexistent.html'));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(Error);
  });

  it('returns a result with empty content for an empty HTML file', () => {
    const filePath = writeTmp('empty.html', EMPTY_HTML);
    const result = ingestWebClip(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.content).toBe('');
    expect(result.value.metadata.title).toBeNull();
    expect(result.value.metadata.wordCount).toBe(0);
    expect(result.value.sourceType).toBe('html');
  });
});
