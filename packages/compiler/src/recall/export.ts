/**
 * Recall export (E9-B11) — produce Anki-importable tab-separated files
 * from the markdown flashcards B08 wrote under `recall/cards/`.
 *
 * Anki's "File → Import" accepts a TSV with three columns per line:
 * `<front><TAB><back><TAB><tag1 tag2 ...>`. Tags are space-separated
 * within the third column. We embed two kinds of tags:
 *
 *   - `topic:<topic-slug>` — the topic the card was generated for
 *   - `source:<source-page-slug>` — one tag per cited wiki page
 *
 * Tab characters and newlines inside question / answer text are
 * escaped to keep the TSV one-line-per-card; Anki understands `<br>`
 * on import and renders multi-line cards correctly.
 *
 * Pure-compiler — no Claude calls, no database calls. The output is
 * a single file (written atomically) or, when `path` is omitted, a
 * string returned to the caller for piping to stdout.
 *
 * All functions return `Result<T, Error>` — never throw.
 *
 * @module recall/export
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single card flattened to the three Anki columns. */
export interface AnkiCard {
  /** Path of the source markdown card file, relative to the workspace root. */
  sourcePath: string;
  /** Front (question) text with `<br>` substituted for newlines. */
  front: string;
  /** Back (answer) text with `<br>` substituted for newlines. */
  back: string;
  /** Space-separated Anki tag list. */
  tags: string;
  /** Concept the card was generated for. */
  concept: string;
  /** Topic the card was generated for. */
  topic: string;
}

/** Options for {@link exportRecallAnki}. */
export interface ExportAnkiOptions {
  /**
   * Filter to a single topic — when present, only cards whose
   * frontmatter `topic` matches are exported. Matched case-sensitively
   * against the unslugified topic string.
   */
  topic?: string;
  /**
   * Workspace-relative output path. When omitted, the TSV is returned
   * in the Result value but no file is written.
   */
  outPath?: string;
}

/** Result of an export pass. */
export interface ExportAnkiResult {
  /** TSV content (always populated, even when written to disk). */
  tsv: string;
  /** Parsed card metadata in the order written. */
  cards: AnkiCard[];
  /** Workspace-relative path of the written file, or null if not written. */
  outPath: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CardFrontmatter {
  type: string;
  topic: string;
  concept: string;
  sourcePages: string[];
}

/** Parse the frontmatter block we care about; tolerant of YAML list form. */
function parseCardFrontmatter(content: string): { fm: CardFrontmatter; bodyStart: number } | null {
  if (!content.startsWith('---')) return null;
  const fmEnd = content.indexOf('\n---', 4);
  if (fmEnd === -1) return null;
  const block = content.slice(4, fmEnd);
  const bodyStart = fmEnd + 4; // skip '\n---'

  const fm: CardFrontmatter = { type: '', topic: '', concept: '', sourcePages: [] };
  let inSources = false;
  for (const rawLine of block.split('\n')) {
    if (inSources) {
      const m = /^\s+-\s+(.+?)\s*$/.exec(rawLine);
      if (m !== null) {
        fm.sourcePages.push(m[1]!);
        continue;
      }
      inSources = false;
    }
    const colon = rawLine.indexOf(':');
    if (colon === -1) continue;
    const key = rawLine.slice(0, colon).trim();
    let value = rawLine.slice(colon + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = String(JSON.parse(value));
      } catch {
        // leave raw
      }
    }
    if (key === 'type') fm.type = value;
    else if (key === 'topic') fm.topic = value;
    else if (key === 'concept') fm.concept = value;
    else if (key === 'source_pages') {
      if (value === '[]' || value === '') {
        inSources = true;
      } else if (value.startsWith('[')) {
        // Flow-style inline list — best-effort split. Strip surrounding
        // quote chars so values match the block-list form.
        fm.sourcePages = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter((s) => s.length > 0);
      } else {
        inSources = true;
      }
    }
  }
  return { fm, bodyStart };
}

/**
 * Pull the `## Question` and `## Answer` sections out of a card body.
 * The card template B08 writes uses these exact headings; we split on
 * them and trim each section's body.
 */
function extractQA(body: string): { question: string; answer: string } | null {
  // Multiline match — `## Question` may appear at body start without a
  // leading newline if the card has no top-level heading.
  const qMatch = /^## Question[^\n]*\n/m.exec(body);
  const aMatch = /^## Answer[^\n]*\n/m.exec(body);
  if (qMatch === null || aMatch === null) return null;
  const qIdx = qMatch.index;
  const aIdx = aMatch.index;
  if (aIdx < qIdx) return null;

  const qStart = qIdx + qMatch[0].length;
  const qEnd = aIdx;
  const aStart = aIdx + aMatch[0].length;

  const question = body.slice(qStart, qEnd).trim();
  const answer = body.slice(aStart).trim();
  if (question === '' || answer === '') return null;
  return { question, answer };
}

/** Convert an arbitrary string into a safe Anki tag slug. */
function ankiTagSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** TSV-escape a field: replace tabs with spaces, newlines with `<br>`. */
function escapeTsvField(value: string): string {
  return value.replace(/\t/g, '    ').replace(/\r?\n/g, '<br>').trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export every card under `<workspace>/recall/cards/` as an Anki TSV.
 *
 * Behaviour:
 * 1. Lists every `.md` file under `recall/cards/`. Missing directory →
 *    err (Anki has nothing to import — user should run `recall generate`).
 * 2. For each file: parses frontmatter (skipping files without
 *    `type: recall-card`), extracts question + answer, builds the TSV
 *    row.
 * 3. When `options.topic` is provided, drops cards whose frontmatter
 *    `topic` does not match.
 * 4. When `options.outPath` is provided, writes the TSV to that path
 *    atomically (`.tmp + rename`). Parent dirs are created as needed.
 *
 * Failure modes (never throw):
 * - `recall/cards/` is missing.
 * - Zero cards match (no files or topic filter excludes everything).
 * - A card file is malformed (no Q/A sections, no frontmatter).
 * - Filesystem write failure.
 */
export function exportRecallAnki(
  workspacePath: string,
  options: ExportAnkiOptions = {},
): Result<ExportAnkiResult, Error> {
  const cardsDir = resolve(workspacePath, 'recall', 'cards');
  if (!existsSync(cardsDir)) {
    return err(
      new Error(`Cards directory not found at ${cardsDir}. Run \`ico recall generate\` first.`),
    );
  }

  let filenames: string[];
  try {
    filenames = readdirSync(cardsDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md') && d.name !== '.gitkeep')
      .map((d) => d.name)
      .sort();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (filenames.length === 0) {
    return err(
      new Error(`No card files found under ${cardsDir}. Run \`ico recall generate\` first.`),
    );
  }

  const cards: AnkiCard[] = [];
  for (const name of filenames) {
    const absPath = join(cardsDir, name);
    let raw: string;
    try {
      raw = readFileSync(absPath, 'utf-8');
    } catch (e) {
      return err(
        new Error(`Failed to read card ${name}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }

    const parsed = parseCardFrontmatter(raw);
    if (parsed === null) {
      return err(new Error(`Card ${name} is missing or has malformed frontmatter`));
    }
    if (parsed.fm.type !== 'recall-card') {
      // Tolerate non-recall-card files in the directory by skipping.
      continue;
    }
    if (options.topic !== undefined && parsed.fm.topic !== options.topic) {
      continue;
    }

    const qa = extractQA(raw.slice(parsed.bodyStart));
    if (qa === null) {
      return err(new Error(`Card ${name} is missing a Question or Answer section`));
    }

    const tagParts: string[] = [];
    if (parsed.fm.topic !== '') tagParts.push(`topic:${ankiTagSlug(parsed.fm.topic)}`);
    for (const src of parsed.fm.sourcePages) {
      const slug = ankiTagSlug(src);
      if (slug !== '') tagParts.push(`source:${slug}`);
    }

    cards.push({
      sourcePath: join('recall', 'cards', name),
      front: escapeTsvField(qa.question),
      back: escapeTsvField(qa.answer),
      tags: tagParts.join(' '),
      concept: parsed.fm.concept,
      topic: parsed.fm.topic,
    });
  }

  if (cards.length === 0) {
    const filter = options.topic !== undefined ? ` matching topic '${options.topic}'` : '';
    return err(new Error(`Zero cards exported${filter}.`));
  }

  // Build TSV. No header row — Anki treats the first line as data.
  const tsv = cards.map((c) => `${c.front}\t${c.back}\t${c.tags}`).join('\n') + '\n';

  let writtenPath: string | null = null;
  if (options.outPath !== undefined) {
    const outAbs = resolve(workspacePath, options.outPath);
    // Reject paths that escape the workspace via `..` or absolute paths.
    const wsAbs = resolve(workspacePath);
    const wsPrefix = wsAbs.endsWith('/') ? wsAbs : `${wsAbs}/`;
    if (outAbs !== wsAbs && !outAbs.startsWith(wsPrefix)) {
      return err(new Error(`Output path must be inside the workspace: ${options.outPath}`));
    }
    try {
      const outDir = dirname(outAbs);
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      const tmp = `${outAbs}.tmp`;
      writeFileSync(tmp, tsv, 'utf-8');
      renameSync(tmp, outAbs);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
    writtenPath = options.outPath;
  }

  return ok({ tsv, cards, outPath: writtenPath });
}
