/**
 * Shared batching + dedupe/merge utilities for the cross-source compiler passes
 * (extract, synthesize, contradict, gap).
 *
 * The cross-source passes used to concatenate every wiki page into a single
 * prompt and make ONE Claude call. On large workspaces that silently truncates:
 * the model only emits pages for whatever fit inside its budget, so most of the
 * knowledge base is never compiled. This module fixes that by:
 *
 *   1. CHUNK — split the inputs into batches of a configurable size (default 25)
 *      so every input reaches the model across N calls instead of one.
 *   2. MERGE — after collecting raw pages from every batch, dedupe by normalized
 *      title. Two batches that each emit a page for the same concept (e.g. both
 *      mention "Knowledge Compilation") collapse to ONE page whose `source_ids`
 *      (or `concept_ids` / `related_page_ids`) are the UNION across duplicates.
 *   3. STABLE ID — assign each merged page a deterministic UUIDv5 derived from
 *      its normalized title, so re-running a pass produces the same `id:` and the
 *      compilations row UPSERTs rather than accumulating duplicate rows.
 *
 * Pure functions only — no disk I/O, no DB writes, no Claude client. The passes
 * own all side effects; this module is the in-memory transform between
 * "raw pages from all batches" and "merged pages ready to write".
 */

import { uuidV5 } from '@ico/kernel';

// ---------------------------------------------------------------------------
// Tunable
// ---------------------------------------------------------------------------

/**
 * Number of input documents sent to the model per Claude call.
 *
 * Overridable via the `ICO_BATCH_SIZE` env var, or per-call via the `batchSize`
 * option on each pass. Defaults to 25 — small enough to stay well inside the
 * model's output budget for the typical page count, large enough to keep call
 * count (and latency / cost) reasonable.
 */
export const DEFAULT_BATCH_SIZE = (() => {
  const raw = parseInt(process.env['ICO_BATCH_SIZE'] ?? '25', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 25;
})();

/**
 * Fixed namespace UUID for deriving stable per-page IDs. This is the canonical
 * RFC 4122 example namespace; it never changes, so the same normalized title
 * always maps to the same page `id:` across runs and across machines.
 */
const ICO_NAMESPACE_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split an array into contiguous chunks of at most `size` elements.
 * A non-positive `size` falls back to a single chunk containing everything,
 * so callers can never accidentally produce zero-length batches.
 */
export function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  if (size <= 0) return arr.length > 0 ? [arr.slice()] : [];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Title normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a page title into a stable comparison key: lowercase, collapse any
 * run of non-alphanumeric characters to a single hyphen, trim leading/trailing
 * hyphens. "Knowledge Compilation" and "knowledge   compilation!" both map to
 * `knowledge-compilation`, so they merge.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Frontmatter field access
// ---------------------------------------------------------------------------

/**
 * Read a single scalar frontmatter field (e.g. `title`, `type`, `id`) from a
 * page string. Returns undefined when the field is absent.
 */
export function extractFrontmatterField(content: string, key: string): string | undefined {
  const pattern = new RegExp(`^${key}:\\s*["']?([^\\n"']+)["']?`, 'm');
  const match = pattern.exec(content);
  return match?.[1]?.trim();
}

/**
 * Parse a YAML list field from a page's frontmatter into a string array.
 *
 * Handles both block style:
 *
 *   source_ids:
 *     - aaaa
 *     - bbbb
 *
 * and inline flow style:
 *
 *   source_ids: [aaaa, bbbb]
 *
 * Only the frontmatter (the first `---` … `---` fence) is scanned, so a list
 * key appearing in the markdown body is never picked up. Returns an empty array
 * when the field is absent or empty.
 */
export function parseFrontmatterList(content: string, key: string): string[] {
  const fm = extractFrontmatterBlock(content);
  if (fm === null) return [];

  // Inline flow style: key: [a, b, c]
  const inline = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(fm);
  if (inline?.[1] !== undefined) {
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }

  // Block style: key: \n  - a \n  - b
  const lines = fm.split('\n');
  const out: string[] = [];
  let collecting = false;
  const keyPattern = new RegExp(`^${key}:\\s*(.*)$`);

  for (const line of lines) {
    const keyMatch = keyPattern.exec(line);
    if (keyMatch !== null) {
      // A value on the same line that is not a list opener (e.g. `key: foo`)
      // is a scalar, not a list — nothing to collect.
      const trailing = keyMatch[1]?.trim() ?? '';
      collecting = trailing === '';
      continue;
    }
    if (collecting) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item?.[1] !== undefined) {
        out.push(item[1].replace(/^["']|["']$/g, ''));
      } else if (line.trim().length > 0) {
        // First non-list, non-blank line ends the block list.
        break;
      }
    }
  }
  return out;
}

/** Return the raw text between the first pair of `---` fences, or null. */
function extractFrontmatterBlock(content: string): string | null {
  const match = /^---\s*\n([\s\S]*?)\n---/m.exec(content.trimStart());
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Stable ID derivation
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic RFC-4122 UUIDv5 from a normalized title under the
 * fixed ICO namespace. Same title in → same UUID out, every run, every machine.
 *
 * Delegates to the canonical {@link uuidV5} in `@ico/kernel` — the single
 * source of truth for v5 derivation (SHA-1 of `namespace-bytes ‖ name-bytes`
 * with the version/variant bits patched). This module deliberately does NOT
 * re-implement the hash inline: the kernel helper is the reviewed, shared
 * contract, and duplicating the SHA-1 call here both risks drift and trips the
 * weak-crypto scanner on a sink that is really just standards-mandated UUIDv5.
 */
export function deriveStableId(normalizedTitle: string): string {
  return uuidV5(ICO_NAMESPACE_UUID, normalizedTitle);
}

// ---------------------------------------------------------------------------
// Page rewriting
// ---------------------------------------------------------------------------

/**
 * Replace a scalar frontmatter field's value, inserting it after the opening
 * `---` fence if the field is absent. Used to stamp the stable `id:` onto a
 * merged page in place of any model-generated random UUID.
 */
export function setFrontmatterField(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^(${key}:\\s*).*$`, 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, `$1${value}`);
  }
  // Field absent — insert just after the opening fence.
  const trimmed = content.trimStart();
  const leading = content.slice(0, content.length - trimmed.length);
  return `${leading}${trimmed.replace(/^---\s*\n/, `---\n${key}: ${value}\n`)}`;
}

/**
 * Replace (or insert) a YAML block-style list field with the given values.
 * Removes any prior occurrence of the key in the frontmatter and writes the
 * union list back in canonical block form.
 */
export function setFrontmatterList(content: string, key: string, values: string[]): string {
  const block =
    values.length > 0 ? `${key}:\n${values.map((v) => `  - ${v}`).join('\n')}` : `${key}: []`;

  // Strip any existing block- or inline-style occurrence of the key, scoped to
  // the frontmatter region only.
  const stripped = stripFrontmatterListKey(content, key);
  const fmMatch = /^(---\s*\n)([\s\S]*?)(\n---)/m.exec(stripped.trimStart());
  if (fmMatch === null) return stripped;

  const trimmed = stripped.trimStart();
  const leading = stripped.slice(0, stripped.length - trimmed.length);
  const [, open, body, close] = fmMatch;
  const newBody = body!.replace(/\n+$/, '');
  return `${leading}${open}${newBody}\n${block}${close}${trimmed.slice(fmMatch[0].length)}`;
}

/** Remove an existing list key (block or inline) from the frontmatter region. */
function stripFrontmatterListKey(content: string, key: string): string {
  const trimmed = content.trimStart();
  const leading = content.slice(0, content.length - trimmed.length);
  const fmMatch = /^(---\s*\n)([\s\S]*?)(\n---)/m.exec(trimmed);
  if (fmMatch === null) return content;

  const [, open, body, close] = fmMatch;
  const after = trimmed.slice(fmMatch[0].length);
  const lines = body!.split('\n');
  const kept: string[] = [];
  let skipping = false;
  const keyPattern = new RegExp(`^${key}:\\s*(.*)$`);

  for (const line of lines) {
    const keyMatch = keyPattern.exec(line);
    if (keyMatch !== null) {
      const trailing = keyMatch[1]?.trim() ?? '';
      // Block list opener (no trailing value) → skip subsequent `- ` items too.
      skipping = trailing === '';
      continue; // drop the key line itself (inline or block)
    }
    if (skipping) {
      if (/^\s*-\s*/.test(line)) continue; // drop list items
      if (line.trim().length === 0) continue; // drop blank padding
      skipping = false;
    }
    kept.push(line);
  }
  return `${leading}${open}${kept.join('\n')}${close}${after}`;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** A page after dedupe/merge, carrying its normalized key and stable ID. */
export interface MergedPage {
  /** Normalized title key the page was grouped under. */
  key: string;
  /** Deterministic UUIDv5 stamped into the page frontmatter. */
  id: string;
  /** Title as read from the (chosen) page's frontmatter. */
  title: string;
  /** Final page content with stable `id:` and unioned list field written back. */
  content: string;
}

/** Options controlling how raw batch pages are merged. */
export interface MergePagesOptions {
  /**
   * Frontmatter list field to UNION across duplicates and write back.
   * `source_ids` for extract/contradict, `concept_ids` for synthesize,
   * `related_page_ids` for gap.
   */
  listField: string;
  /** Fallback title for a page whose frontmatter has no `title:`. */
  fallbackTitle?: string;
}

/**
 * Dedupe + merge raw pages collected across all batches.
 *
 * Pages are grouped by normalized title. Within a group:
 *   - the longest body is kept as the canonical content (richest definition),
 *   - the `listField` values are UNIONed across every duplicate,
 *   - a stable UUIDv5 (of the normalized title) is stamped into `id:`.
 *
 * The returned pages are in first-seen order, so output is deterministic for a
 * given input ordering.
 */
export function mergePages(rawPages: readonly string[], options: MergePagesOptions): MergedPage[] {
  const fallback = options.fallbackTitle ?? 'untitled';
  const groups = new Map<string, { title: string; chosen: string; ids: string[] }>();
  const order: string[] = [];

  for (const page of rawPages) {
    const title = extractFrontmatterField(page, 'title') ?? fallback;
    const key = normalizeTitle(title) || normalizeTitle(fallback) || 'untitled';
    const ids = parseFrontmatterList(page, options.listField);

    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { title, chosen: page, ids: [...ids] });
      order.push(key);
    } else {
      // Keep the longest page as the canonical body/definition.
      if (page.length > existing.chosen.length) {
        existing.chosen = page;
        existing.title = title;
      }
      for (const id of ids) {
        if (!existing.ids.includes(id)) existing.ids.push(id);
      }
    }
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    const id = deriveStableId(key);
    let content = setFrontmatterField(group.chosen, 'id', id);
    content = setFrontmatterList(content, options.listField, group.ids);
    return { key, id, title: group.title, content };
  });
}
