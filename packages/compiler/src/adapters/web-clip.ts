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

interface ParsedElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
}
interface ParsedDocument {
  body: import('turndown').Node;
  querySelector(selector: string): ParsedElement | null;
}

// Use Turndown's existing HTML parser for metadata too. Parsing HTML with
// overlapping wildcard regexes made malformed tags an unbounded backtracking path.
const htmlParser = require('@mixmark-io/domino') as {
  createDocument(html: string, force: boolean): ParsedDocument;
};

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
 * @param capturedBytes - Optional captured file bytes; when supplied, the path is not reopened.
 * @param filePath - Absolute path to the `.html` file to ingest.
 */
export function ingestWebClip(
  filePath: string,
  capturedBytes?: Buffer,
): Result<IngestResult, Error> {
  let html: string;

  try {
    html = capturedBytes?.toString('utf8') ?? readFileSync(filePath, 'utf-8');
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  try {
    const document = htmlParser.createDocument(html, true);
    const attribute = (selector: string, name: string): string | null =>
      document.querySelector(selector)?.getAttribute(name) ?? null;
    const title = document.querySelector('title')?.textContent?.trim() ?? null;
    const sourceUrl =
      attribute('link[rel="canonical"]', 'href') ??
      attribute('meta[property="og:url"]', 'content') ??
      undefined;
    const author =
      attribute('meta[name="author"]', 'content') ??
      attribute('meta[property="article:author"]', 'content');
    const date =
      attribute('meta[property="article:published_time"]', 'content') ??
      attribute('time[datetime]', 'datetime')?.trim() ??
      null;
    const content = turndown.turndown(document.body);
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
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}
