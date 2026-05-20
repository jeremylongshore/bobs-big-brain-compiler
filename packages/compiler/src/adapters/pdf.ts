/**
 * PDF ingest adapter.
 *
 * Converts a PDF file on disk into a normalised {@link IngestResult} using
 * `pdf-parse` (v2, ESM, class-based API).  All error paths return
 * `Result<_, Error>` — this module never throws.
 */

import { readFile } from 'node:fs/promises';

import {
  FormatError,
  InvalidPDFException,
  PasswordException,
  PDFParse,
  VerbosityLevel,
} from 'pdf-parse';

import { err, ok, type Result } from '@ico/types';

import type { IngestResult } from './types.js';

/**
 * Parse a PDF at `filePath` and return a normalised {@link IngestResult}.
 *
 * Error cases:
 * - File not found / unreadable → `err`
 * - Password-protected PDF → `err` with explicit message
 * - Corrupted / invalid PDF → `err` with explicit message
 * - Image-only PDF (zero text extracted) → `ok` with empty content and
 *   `warning` field set in metadata
 *
 * @param filePath - Absolute or workspace-relative path to the PDF file.
 */
export async function ingestPdf(filePath: string): Promise<Result<IngestResult, Error>> {
  // --- 1. Read raw bytes ---------------------------------------------------
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (cause) {
    const message =
      cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
        ? `PDF file not found: ${filePath}`
        : `Failed to read PDF file: ${filePath}`;
    return err(new Error(message, { cause }));
  }

  // --- 2. Parse with pdf-parse v2 -----------------------------------------
  //
  // Node.js `Buffer` objects are views over a shared pool `ArrayBuffer`
  // (for small allocations).  pdfjs-dist transfers the underlying
  // `ArrayBuffer` to its worker thread via `postMessage`.  A pooled
  // `ArrayBuffer` is not transferable, so we copy the bytes into a fresh,
  // standalone `ArrayBuffer` before handing it to the parser.
  const standalone = new Uint8Array(buffer.byteLength);
  buffer.copy(Buffer.from(standalone.buffer), 0, 0, buffer.byteLength);

  const parser = new PDFParse({
    data: standalone,
    verbosity: VerbosityLevel.ERRORS,
  });

  let textResult: Awaited<ReturnType<PDFParse['getText']>>;
  let infoResult: Awaited<ReturnType<PDFParse['getInfo']>>;

  try {
    // Run sequentially: pdfjs transfers the ArrayBuffer to its worker on first
    // load; concurrent calls risk a race on the transfer or the internal doc
    // reference.
    textResult = await parser.getText();
    infoResult = await parser.getInfo();
  } catch (cause) {
    await parser.destroy().catch(() => undefined);

    if (cause instanceof PasswordException) {
      return err(
        new Error(`PDF is password-protected and cannot be read without a password: ${filePath}`, {
          cause,
        }),
      );
    }
    if (cause instanceof InvalidPDFException) {
      return err(
        new Error(`PDF file is corrupted or not a valid PDF: ${filePath}`, {
          cause,
        }),
      );
    }
    if (cause instanceof FormatError) {
      return err(
        new Error(`PDF file has malformed structure and could not be parsed: ${filePath}`, {
          cause,
        }),
      );
    }

    // pdfjs-dist uses a worker thread and serialises the PDF data via
    // structuredClone / postMessage.  When the input bytes are completely
    // unrecognisable as a PDF, the engine throws a DOMException at the
    // transfer layer before any format-specific validation takes place.
    if (cause instanceof DOMException) {
      return err(
        new Error(`PDF file is corrupted or not a valid PDF (unreadable data): ${filePath}`, {
          cause,
        }),
      );
    }

    const message = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`Unexpected error while parsing PDF: ${message}`, { cause }));
  }

  await parser.destroy().catch(() => undefined);

  // --- 3. Extract text and page count -------------------------------------
  const content = textResult.text ?? '';
  const pageCount = textResult.total;

  // --- 4. Extract document metadata from Info dictionary ------------------
  // `infoResult.info` is typed as `any` by pdf-parse — access defensively.

  const info: Record<string, unknown> =
    typeof infoResult.info === 'object' && infoResult.info !== null
      ? (infoResult.info as Record<string, unknown>)
      : {};

  const title = typeof info['Title'] === 'string' ? info['Title'] : null;
  const author = typeof info['Author'] === 'string' ? info['Author'] : null;

  // Creation date — pdf-parse v2 exposes it via `getDateNode()`
  let date: string | null = null;
  try {
    const dateNode = infoResult.getDateNode();
    const creationDate =
      dateNode.CreationDate ?? dateNode.XmpCreateDate ?? dateNode.XapCreateDate ?? null;
    if (creationDate instanceof Date && !isNaN(creationDate.getTime())) {
      date = creationDate.toISOString();
    }
  } catch {
    // Date parsing is best-effort; leave null on failure.
  }

  // --- 5. Word count -------------------------------------------------------
  const wordCount = content.trim().length === 0 ? 0 : content.trim().split(/\s+/).length;

  // --- 6. Image-only PDF detection -----------------------------------------
  const extraMetadata: Record<string, unknown> = {};
  if (content.trim().length === 0 && pageCount > 0) {
    extraMetadata['warning'] =
      'No text could be extracted — the PDF may be image-only or use non-standard encoding.';
  }

  // --- 7. Build result -----------------------------------------------------
  return ok({
    content,
    metadata: {
      title,
      author,
      date,
      tags: [],
      wordCount,
      pageCount,
      ...extraMetadata,
    },
    sourceType: 'pdf',
  } satisfies IngestResult);
}
