/**
 * Adapter registry and source-type detection.
 *
 * Provides a unified entry point for ingesting any supported file type.
 * Auto-detects the source type from the file extension, then delegates to the
 * appropriate adapter.  A `typeOverride` allows callers to force a specific
 * adapter regardless of extension.
 *
 * Never throws — all failures are returned as `err(Error)`.
 */

import { err, type Result } from '@ico/types';

import { ingestMarkdown } from './markdown.js';
import { type IngestResult } from './types.js';
import { ingestWebClip } from './web-clip.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated union of all recognised source types. */
export type SourceType = 'markdown' | 'pdf' | 'html' | 'text';

// ---------------------------------------------------------------------------
// Extension → SourceType map
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Readonly<Record<string, SourceType>> = {
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.pdf': 'pdf',
  '.html': 'html',
  '.htm': 'html',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the {@link SourceType} for a file based solely on its extension.
 *
 * Unknown or missing extensions default to `'text'`, which is processed by
 * the markdown adapter (plain text without frontmatter).
 *
 * @param filePath - Any path string; only the final extension is inspected.
 */
export function detectSourceType(filePath: string): SourceType {
  const dotIndex = filePath.lastIndexOf('.');

  if (dotIndex === -1) {
    return 'text';
  }

  const ext = filePath.slice(dotIndex).toLowerCase();
  return EXTENSION_MAP[ext] ?? 'text';
}

/**
 * Ingest a file using the adapter that matches its source type.
 *
 * Resolution order:
 * 1. `typeOverride` when provided.
 * 2. Auto-detection via {@link detectSourceType}.
 *
 * Routing:
 * - `'markdown'` → {@link ingestMarkdown}
 * - `'pdf'`      → {@link ingestPdf}
 * - `'html'`     → {@link ingestWebClip}
 * - `'text'`     → {@link ingestMarkdown} (plain text treated as markdown without frontmatter)
 *
 * @param filePath     - Absolute path to the file to ingest.
 * @param typeOverride - Optional explicit source type; bypasses extension detection.
 */
export async function ingestSource(
  filePath: string,
  typeOverride?: SourceType,
): Promise<Result<IngestResult, Error>> {
  const sourceType = typeOverride ?? detectSourceType(filePath);

  switch (sourceType) {
    case 'markdown':
      return ingestMarkdown(filePath);

    case 'pdf':
      try {
        // PDF parsing initializes native dependencies. Keep that work off every
        // other route (including compiler imports and CLI help/version).
        const { ingestPdf } = await import('./pdf.js');
        return await ingestPdf(filePath);
      } catch (cause) {
        // Dynamic module loading and an adapter failure both obey the registry's
        // Result contract, including failures before the adapter's own catches.
        return err(cause instanceof Error ? cause : new Error(String(cause)));
      }

    case 'html':
      return ingestWebClip(filePath);

    case 'text':
      return ingestMarkdown(filePath);
  }
}
