/**
 * Terminal output formatting utilities for the ico CLI.
 *
 * All functions are pure and never throw — they always return a string.
 * Colors are suppressed when stdout is not a TTY or when NO_COLOR is set.
 *
 * @module output
 */

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';

// ---------------------------------------------------------------------------
// Color detection
// ---------------------------------------------------------------------------

/**
 * Returns true when ANSI color sequences should be emitted.
 * Colors are suppressed when:
 *   - `NO_COLOR` environment variable is set (any non-empty value), or
 *   - stdout is not a TTY (e.g. piped to a file or another process).
 */
function useColors(): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
    return false;
  }
  return process.stdout.isTTY === true;
}

/**
 * Wrap `text` in an ANSI sequence only when colors are active.
 * Always resets to `RESET` after the sequence to avoid bleed.
 */
function colorize(code: string, text: string): string {
  if (!useColors()) return text;
  return `${code}${text}${RESET}`;
}

// ---------------------------------------------------------------------------
// Public color helpers
// ---------------------------------------------------------------------------

/**
 * Dim text (for secondary / less important information).
 *
 * @param text - The string to dim.
 * @returns The dimmed string, or plain text when colors are suppressed.
 */
export function dim(text: string): string {
  return colorize(DIM, text);
}

/**
 * Bold text (for emphasis).
 *
 * @param text - The string to bold.
 * @returns The bolded string, or plain text when colors are suppressed.
 */
export function bold(text: string): string {
  return colorize(BOLD, text);
}

// ---------------------------------------------------------------------------
// Status-line formatters
// ---------------------------------------------------------------------------

/**
 * Format a success message with a green checkmark prefix.
 *
 * @param message - Human-readable success description.
 * @returns `"✓ <message>"` with green color when supported.
 */
export function formatSuccess(message: string): string {
  const mark = colorize(GREEN, '✓');
  return `${mark} ${message}`;
}

/**
 * Format an error message with a red X prefix.
 *
 * @param message - Human-readable error description.
 * @returns `"✗ <message>"` with red color when supported.
 */
export function formatError(message: string): string {
  const mark = colorize(RED, '✗');
  return `${mark} ${message}`;
}

/**
 * Format a warning message with a yellow triangle prefix.
 *
 * @param message - Human-readable warning description.
 * @returns `"⚠ <message>"` with yellow color when supported.
 */
export function formatWarning(message: string): string {
  const mark = colorize(YELLOW, '⚠');
  return `${mark} ${message}`;
}

/**
 * Format an info message with a blue filled-circle prefix.
 *
 * @param message - Human-readable informational message.
 * @returns `"● <message>"` with blue color when supported.
 */
export function formatInfo(message: string): string {
  const mark = colorize(BLUE, '●');
  return `${mark} ${message}`;
}

// ---------------------------------------------------------------------------
// Structural formatters
// ---------------------------------------------------------------------------

/**
 * Format a section header with a horizontal rule underline.
 *
 * @param title - The section title.
 * @returns A string of the form `"\n<title>\n────────"`.
 */
export function formatHeader(title: string): string {
  const rule = '─'.repeat(title.length);
  return `\n${title}\n${rule}`;
}

/**
 * Format data as an aligned ASCII table.
 *
 * Column widths are calculated from the widest cell in each column
 * (including the header). Columns are separated by two spaces and
 * padded with trailing spaces so every cell reaches the column width.
 * The header row is separated from data rows by a dashed rule using `─`.
 *
 * @param headers - Column header labels.
 * @param rows    - Array of row arrays; each inner array must have the
 *                  same length as `headers`.
 * @returns A formatted table string, or a header-only table when `rows`
 *          is empty.
 *
 * @example
 * formatTable(['Type', 'Count'], [['pdf', '12'], ['markdown', '8']])
 * // =>
 * // Type       Count
 * // ─────────  ─────
 * // pdf        12
 * // markdown   8
 */
export function formatTable(headers: string[], rows: string[][]): string {
  // Calculate column widths: max of header width and widest data cell.
  const widths: number[] = headers.map((h, col) => {
    const dataMax = rows.reduce((max, row) => {
      const cell = row[col] ?? '';
      return Math.max(max, cell.length);
    }, 0);
    return Math.max(h.length, dataMax);
  });

  const pad = (text: string, width: number): string => text + ' '.repeat(width - text.length);

  const separator = '  '; // two-space column gap

  const headerLine = headers.map((h, i) => pad(h, widths[i]!)).join(separator);
  const ruleLine = widths.map((w) => '─'.repeat(w)).join(separator);

  const dataLines = rows.map((row) =>
    row.map((cell, i) => pad(cell ?? '', widths[i]!)).join(separator),
  );

  return [headerLine, ruleLine, ...dataLines].join('\n');
}

/**
 * Format a key-value display suitable for status output.
 *
 * Keys are right-padded to a consistent width derived from the longest
 * key in the set. Values are rendered as-is.
 *
 * @param pairs - Array of `[key, value]` tuples. Values may be strings
 *                or numbers.
 * @returns A multi-line string, one `"Key:     value"` entry per line.
 *
 * @example
 * formatKeyValue([['Sources', 23], ['Compiled', 18]])
 * // =>
 * // Sources:   23
 * // Compiled:  18
 */
export function formatKeyValue(pairs: [string, string | number][]): string {
  if (pairs.length === 0) return '';

  // The label includes the trailing colon, so add 1 for it.
  const maxLabelLen = Math.max(...pairs.map(([k]) => k.length)) + 1;

  return pairs
    .map(([key, value]) => {
      const label = `${key}:`;
      const padding = ' '.repeat(maxLabelLen - label.length + 1);
      return `${label}${padding}${String(value)}`;
    })
    .join('\n');
}

/**
 * Format arbitrary data as pretty-printed JSON.
 *
 * Uses 2-space indentation. Never throws — non-serialisable values
 * (e.g. circular references) fall back to a descriptive error string.
 *
 * @param data - Any value to serialise.
 * @returns A JSON string with 2-space indentation.
 */
export function formatJSON(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return '"[unserializable value]"';
  }
}
