import { readFileSync } from 'node:fs';

import { err, ok, type Result } from '@ico/types';

import { type IngestResult } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split a raw markdown string into its YAML frontmatter fields and body text.
 *
 * Frontmatter must be a `---`-delimited block at the very start of the file.
 * Returns empty frontmatter and the full string as body when no block is found.
 */
function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  if (!raw.startsWith('---\n')) {
    return { frontmatter: {}, body: raw };
  }

  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }

  const fmBlock = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const frontmatter: Record<string, string | string[]> = {};

  for (const line of fmBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (key === '') continue;

    if (key === 'tags') {
      // Accept both `tags: [a, b, c]` and `tags: a, b, c`
      const cleaned = value.replace(/^\[|\]$/g, '');
      frontmatter[key] = cleaned
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    } else {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/**
 * Count words in a block of text by splitting on whitespace.
 *
 * Empty strings and pure-whitespace input return 0.
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Extract the text of the first ATX heading (`# …`) found in `body`.
 *
 * Returns `null` when no heading is present.
 */
function firstHeading(body: string): string | null {
  for (const line of body.split('\n')) {
    const match = /^#\s+(.+)/.exec(line);
    if (match !== null && match[1] !== undefined) {
      return match[1].trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingest a single Markdown file and return a normalised {@link IngestResult}.
 *
 * The function:
 * 1. Reads the file as UTF-8.
 * 2. Parses optional YAML frontmatter (`title`, `author`, `date`, `tags`).
 * 3. Falls back to the first `# Heading` when `title` is absent from frontmatter.
 * 4. Computes a word count over the body text (frontmatter excluded).
 * 5. Returns the body as `content` so downstream passes never see the delimiter block.
 *
 * Never throws — all failures are returned as `err(Error)`.
 *
 * @param filePath - Absolute path to the `.md` file to ingest.
 */
export function ingestMarkdown(filePath: string): Result<IngestResult, Error> {
  let raw: string;

  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  const fmTitle = typeof frontmatter['title'] === 'string' ? frontmatter['title'] : null;
  const fmAuthor = typeof frontmatter['author'] === 'string' ? frontmatter['author'] : null;
  const fmDate = typeof frontmatter['date'] === 'string' ? frontmatter['date'] : null;
  const fmTags = Array.isArray(frontmatter['tags']) ? frontmatter['tags'] : [];

  const title = fmTitle !== null && fmTitle !== '' ? fmTitle : firstHeading(body);

  return ok({
    content: body,
    metadata: {
      title,
      author: fmAuthor !== null && fmAuthor !== '' ? fmAuthor : null,
      date: fmDate !== null && fmDate !== '' ? fmDate : null,
      tags: fmTags,
      wordCount: countWords(body),
    },
    sourceType: 'markdown',
  });
}
