import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { err, ok, type Result } from '@ico/types';

import { type IngestResult } from './types.js';

// ---------------------------------------------------------------------------
// Turndown bootstrap
//
// turndown ships as CJS with no ESM entry point.  With verbatimModuleSyntax
// and esModuleInterop=false we cannot use a default import directly, so we
// fall back to createRequire.  The require() call returns the constructor
// itself (not a `.default` sub-property) as confirmed by runtime inspection.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

// `export =` CommonJS module: `require` returns the constructor directly.
// Cast via `unknown` to avoid the namespace member error from the @types declaration.

const TurndownService = require('turndown') as unknown as new (
  options?: import('turndown').Options,
) => import('turndown');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content of a single HTML tag, e.g. `<title>My Page</title>`.
 *
 * Returns `null` when the tag is absent or its body is whitespace-only.
 */
function extractTag(html: string, tag: string): string | null {
  const match = html.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return match?.[1]?.trim() ?? null;
}

/**
 * Extract a `content` attribute from a `<meta>` element identified by a
 * given attribute name/value pair.
 *
 * Handles both attribute orderings:
 *   `<meta name="author" content="Jane">`
 *   `<meta content="Jane" name="author">`
 */
function extractMeta(html: string, attr: string, value: string): string | null {
  const pattern = new RegExp(
    `<meta\\s+(?:${attr}="${value}"\\s+content="([^"]*)")|(?:content="([^"]*)"\\s+${attr}="${value}")`,
    'i',
  );
  const match = html.match(pattern);
  return match?.[1] ?? match?.[2] ?? null;
}

/**
 * Extract the `href` from `<link rel="canonical" href="...">`.
 *
 * Returns `null` when absent.
 */
function extractCanonical(html: string): string | null {
  const match = html.match(/<link\s+[^>]*rel="canonical"[^>]*href="([^"]+)"/i);
  if (match?.[1] !== undefined) return match[1];

  // Also handle reversed attribute order
  const match2 = html.match(/<link\s+[^>]*href="([^"]+)"[^>]*rel="canonical"/i);
  return match2?.[1] ?? null;
}

/**
 * Extract the `datetime` attribute from the first `<time>` element.
 *
 * Returns `null` when absent.
 */
function extractTimeDate(html: string): string | null {
  const match = html.match(/<time\s+[^>]*datetime="([^"]+)"/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * Return the inner content of `<body>…</body>`.
 *
 * Falls back to the full HTML string when no `<body>` tag is found so that
 * fragment inputs still receive conversion.
 */
function extractBody(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch?.[1] ?? html;
}

/**
 * Count words by splitting on whitespace sequences and discarding empty tokens.
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// ---------------------------------------------------------------------------
// Shared Turndown instance
// ---------------------------------------------------------------------------

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingest a single web-clip HTML file and return a normalised {@link IngestResult}.
 *
 * The function:
 * 1. Reads the file as UTF-8.
 * 2. Extracts `<title>` as document title.
 * 3. Resolves the canonical URL from `<link rel="canonical">` or
 *    `<meta property="og:url">`.
 * 4. Extracts author from `<meta name="author">` or
 *    `<meta property="article:author">`.
 * 5. Extracts publish date from `<meta property="article:published_time">`
 *    or `<time datetime="…">`.
 * 6. Converts the `<body>` HTML to Markdown via Turndown.
 * 7. Computes a word count over the converted Markdown.
 * 8. Returns {@link IngestResult} with `sourceType: 'html'`.
 *
 * Never throws — all failures are returned as `err(Error)`.
 *
 * @param filePath - Absolute path to the `.html` file to ingest.
 */
export function ingestWebClip(filePath: string): Result<IngestResult, Error> {
  let html: string;

  try {
    html = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // --- Metadata extraction ---------------------------------------------------

  const title = extractTag(html, 'title');

  const sourceUrl = extractCanonical(html) ?? extractMeta(html, 'property', 'og:url') ?? undefined;

  const author =
    extractMeta(html, 'name', 'author') ?? extractMeta(html, 'property', 'article:author') ?? null;

  const date =
    extractMeta(html, 'property', 'article:published_time') ?? extractTimeDate(html) ?? null;

  // --- Content conversion ---------------------------------------------------

  const bodyHtml = extractBody(html);
  const content = turndown.turndown(bodyHtml);
  const wordCount = countWords(content);

  // --- Result assembly ------------------------------------------------------

  return ok({
    content,
    metadata: {
      title,
      author,
      date,
      tags: [],
      wordCount,
      // exactOptionalPropertyTypes requires omitting the key entirely when the
      // value would be `undefined` rather than assigning `undefined` explicitly.
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    },
    sourceType: 'html',
  });
}
