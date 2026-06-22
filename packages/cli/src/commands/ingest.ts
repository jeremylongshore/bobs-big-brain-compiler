/**
 * `ico ingest <path>` — Ingest a source file into the workspace.
 *
 * Copies the file into the appropriate `workspace/raw/<subdir>/` directory,
 * registers it in SQLite, writes a trace event, and appends an audit log entry.
 *
 * @module commands/ingest
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';

import type { Command } from 'commander';

import { ingestSource } from '@ico/compiler';
import {
  appendAuditLog,
  closeDatabase,
  computeFileHash,
  disclosureLabel,
  initDatabase,
  isSourceChanged,
  registerSource,
  scanForDisclosure,
  writeTrace,
} from '@ico/kernel';
import type { Source } from '@ico/types';

import {
  formatError,
  formatInfo,
  formatJSON,
  formatSuccess,
  formatWarning,
} from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file sizes in bytes, per type. Matches workspace policy defaults. */
const SIZE_LIMITS: Record<SourceType, number> = {
  pdf: 52_428_800, // 50 MiB
  markdown: 5_242_880, // 5 MiB
  html: 10_485_760, // 10 MiB
  text: 5_242_880, // 5 MiB
};

/** Maps source type to raw/ subdirectory name. */
const TYPE_TO_SUBDIR: Record<SourceType, string> = {
  pdf: 'papers',
  markdown: 'notes',
  html: 'articles',
  text: 'notes',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceType = 'pdf' | 'markdown' | 'html' | 'text';

export interface IngestOptions {
  title?: string;
  author?: string;
  force?: boolean;
}

export interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  workspace?: string;
}

export interface IngestResult {
  id: string;
  path: string;
  type: SourceType;
  hash: string;
  ingestedAt: string;
  alreadyIngested?: boolean;
}

export interface BatchIngestSummary {
  total: number;
  ingested: number;
  skipped: number;
  alreadyIngested: number;
  errors: Array<{ file: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

/** File extensions accepted by the ingest pipeline. */
export const SUPPORTED_EXTENSIONS = new Set(['.md', '.mdx', '.pdf', '.html', '.htm', '.txt']);

/**
 * Recursively scan a directory and return all files whose extensions are in
 * `SUPPORTED_EXTENSIONS`. Hidden entries (starting with `.`) and
 * `node_modules` directories are skipped at every level. Results are sorted
 * alphabetically for deterministic processing order.
 *
 * @param dirPath - Absolute path to the directory to scan.
 * @returns Sorted array of absolute file paths.
 */
export function scanDirectory(dirPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return results.sort();
}

// ---------------------------------------------------------------------------
// Batch ingest logic
// ---------------------------------------------------------------------------

/**
 * Ingest every supported file discovered under `dirPath`.
 *
 * Hidden files, `node_modules`, and files with unsupported extensions are
 * silently skipped (the skipped count is reported in the summary). Each file
 * is ingested via `runIngest`; failures are collected and reported at the end
 * rather than aborting the batch.
 *
 * @param dirPath    - Absolute path to the directory to scan.
 * @param ingestOpts - Per-file ingest options (title/author not typically used
 *                     for batch; force is respected).
 * @param globalOpts - Global CLI options forwarded to each `runIngest` call.
 * @returns A summary object with counts of ingested, skipped, and errored files.
 */
export function runBatchIngest(
  dirPath: string,
  ingestOpts: IngestOptions,
  globalOpts: GlobalOptions,
): BatchIngestSummary {
  const files = scanDirectory(dirPath);
  const summary: BatchIngestSummary = {
    total: files.length,
    ingested: 0,
    skipped: 0,
    alreadyIngested: 0,
    errors: [],
  };

  if (files.length === 0) {
    return summary;
  }

  for (const file of files) {
    const result = runIngest(file, ingestOpts, globalOpts);
    if (!result.ok) {
      summary.errors.push({ file, message: result.error.message });
      summary.skipped++;
    } else if (result.value.alreadyIngested === true) {
      summary.alreadyIngested++;
    } else {
      summary.ingested++;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Determine the source type from a file extension.
 *
 * @param filePath - Any path; only the extension is examined.
 * @returns The canonical source type.
 */
export function detectSourceType(filePath: string): SourceType {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'pdf';
    case '.md':
    case '.mdx':
      return 'markdown';
    case '.html':
    case '.htm':
      return 'html';
    default:
      return 'text';
  }
}

/**
 * Produce a filesystem-safe slug for a filename, preserving the extension.
 *
 * Lowercases, replaces spaces/underscores with hyphens, strips everything
 * except alphanumerics, hyphens, and the lowercased extension.
 *
 * @param filename - The original basename (with extension).
 * @returns A slugified filename.
 */
export function slugify(filename: string): string {
  const ext = extname(filename);
  const stem = basename(filename, ext);
  const slug = stem
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug}${ext.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Core logic (extracted so tests can call it without spawning a process)
// ---------------------------------------------------------------------------

/**
 * Run the full ingest sequence for a single file.
 *
 * @param filePath    - Absolute (or cwd-relative) path to the file to ingest.
 * @param ingestOpts  - Command-specific options (title, author, force).
 * @param globalOpts  - Global CLI options (json, verbose, workspace).
 * @returns `{ ok: true, value: IngestResult }` on success (including no-ops),
 *          or `{ ok: false, error: Error }` on failure.
 */
export function runIngest(
  filePath: string,
  ingestOpts: IngestOptions,
  globalOpts: GlobalOptions,
): { ok: true; value: IngestResult } | { ok: false; error: Error } {
  // 1. Resolve workspace
  const wsResolveOpts =
    globalOpts.workspace !== undefined ? { workspace: globalOpts.workspace } : {};
  const wsResult = resolveWorkspace(wsResolveOpts);
  if (!wsResult.ok) {
    return { ok: false, error: wsResult.error };
  }
  const { root: wsRoot, dbPath } = wsResult.value;

  // 2. Read the source once — this single read is the existence gate, the size
  //    measurement, AND the bytes the disclosure scan (step 5b) operates on.
  //    Reading once, rather than exists/stat THEN read, avoids a check-then-use
  //    (TOCTOU) race where the file changes between the check and the read.
  let rawBytes: Buffer;
  try {
    rawBytes = readFileSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: new Error(`File not found: ${filePath}`) };
    }
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
  const fileSize = rawBytes.length;

  // 3. Determine source type
  const sourceType = detectSourceType(filePath);

  // 4. Enforce size limit (unless --force)
  if (!ingestOpts.force) {
    const limit = SIZE_LIMITS[sourceType];
    if (fileSize > limit) {
      const mb = (limit / 1_048_576).toFixed(0);
      return {
        ok: false,
        error: new Error(
          `File exceeds ${mb} MiB size limit for type "${sourceType}". Use --force to override.`,
        ),
      };
    }
  }

  // 5. Compute content hash
  const hashResult = computeFileHash(filePath);
  if (!hashResult.ok) {
    return { ok: false, error: hashResult.error };
  }
  const hash = hashResult.value;

  // 5b. Disclosure pre-check — reject comp/PII at the source, before any write.
  //     The governed brain is append-only and must never hold compensation,
  //     comp-splits, anyone's pay, or PII. `ico ingest` copies the source into the
  //     workspace + SQLite *before* it spools to INTKB, so this is the source-side
  //     choke (mirrors intent-os/ci/disclosure-gate.sh + INTKB's intake filter).
  //     Scans the bytes read in step 2 as UTF-8 — complete for markdown/html/text
  //     (the corpus); a PDF's compressed text is not reached here, but INTKB's
  //     repository-layer choke backstops the spool path. Runs before the DB is
  //     opened so a rejection leaks no resources and leaves no trace/audit entry.
  const violation = scanForDisclosure(rawBytes.toString('utf-8'));
  if (violation) {
    return {
      ok: false,
      error: new Error(
        `Disclosure check failed: ${disclosureLabel(violation.category)} content detected ` +
          `("${violation.match}") in ${basename(filePath)}. The governed brain must never hold ` +
          `compensation or PII — move it to Jeremy-private and leave a pointer, then re-ingest.`,
      ),
    };
  }

  // 6. Build destination path: workspace/raw/<subdir>/<slug>
  const subdir = TYPE_TO_SUBDIR[sourceType];
  const sluggedName = slugify(basename(filePath));
  const destAbsDir = join(wsRoot, 'raw', subdir);
  const destAbsPath = join(destAbsDir, sluggedName);

  // 7. Compute relative path from workspace root (used as the canonical path in DB)
  const relPath = relative(wsRoot, destAbsPath);

  // 8. Open database
  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) {
    return { ok: false, error: dbResult.error };
  }
  const db = dbResult.value;

  try {
    // 9. Check if already ingested (same relative path + same hash = no-op)
    const changedResult = isSourceChanged(db, relPath, hash);
    if (!changedResult.ok) {
      return { ok: false, error: changedResult.error };
    }

    if (!changedResult.value) {
      // Unchanged — look up the existing record for its id/ingestedAt.
      // registerSource is idempotent on (path, hash) and returns the existing row.
      const existingResult = registerSource(db, {
        path: relPath,
        type: sourceType,
        hash,
        ...(ingestOpts.title !== undefined && { title: ingestOpts.title }),
        ...(ingestOpts.author !== undefined && { author: ingestOpts.author }),
      });

      if (!existingResult.ok) {
        return { ok: false, error: existingResult.error };
      }

      const result: IngestResult = {
        id: existingResult.value.id,
        path: relPath,
        type: sourceType,
        hash,
        ingestedAt: existingResult.value.ingested_at,
        alreadyIngested: true,
      };

      if (globalOpts.json === true) {
        process.stdout.write(formatJSON(result) + '\n');
      } else {
        process.stdout.write(formatWarning(`Already ingested: ${sluggedName}`) + '\n');
        process.stdout.write(formatInfo(`  Path:      ${relPath}`) + '\n');
        process.stdout.write(formatInfo(`  Source ID: ${result.id}`) + '\n');
      }

      return { ok: true, value: result };
    }

    // 10. Copy file to destination (create subdir if needed)
    mkdirSync(destAbsDir, { recursive: true });
    copyFileSync(filePath, destAbsPath);

    // 11. Register source in SQLite
    const sourceResult = registerSource(db, {
      path: relPath,
      type: sourceType,
      hash,
      ...(ingestOpts.title !== undefined && { title: ingestOpts.title }),
      ...(ingestOpts.author !== undefined && { author: ingestOpts.author }),
    });

    if (!sourceResult.ok) {
      return { ok: false, error: sourceResult.error };
    }

    const source: Source = sourceResult.value;

    // 12. Write trace event
    writeTrace(db, wsRoot, 'source.ingest', {
      sourceId: source.id,
      path: relPath,
      hash,
      type: sourceType,
    });

    // 13. Append audit log (best-effort; non-fatal)
    appendAuditLog(
      wsRoot,
      'source.ingest',
      `Ingested "${sluggedName}" (${sourceType}) from ${filePath}`,
    );

    // 14. Emit output
    const result: IngestResult = {
      id: source.id,
      path: relPath,
      type: sourceType,
      hash,
      ingestedAt: source.ingested_at,
    };

    if (globalOpts.json === true) {
      process.stdout.write(formatJSON(result) + '\n');
    } else {
      printHumanOutput(sluggedName, result);
    }

    return { ok: true, value: result };
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function printHumanOutput(displayName: string, result: IngestResult): void {
  process.stdout.write('\n');
  process.stdout.write(formatSuccess(`Ingested: ${displayName}`) + '\n');
  process.stdout.write(formatInfo(`  Type:      ${result.type}`) + '\n');
  process.stdout.write(formatInfo(`  Hash:      sha256:${result.hash.slice(0, 16)}...`) + '\n');
  process.stdout.write(formatInfo(`  Path:      ${result.path}`) + '\n');
  process.stdout.write(formatInfo(`  Source ID: ${result.id}`) + '\n');
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Confirmation helpers
// ---------------------------------------------------------------------------

/**
 * Prompt the user with a yes/no question and return `true` unless the answer
 * is 'n' or 'N'.  Returns `false` immediately when stdin is not a TTY.
 *
 * @param message - The prompt string (should end with a trailing space).
 */
async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() !== 'n');
    });
  });
}

/**
 * Display a metadata preview for a file about to be ingested.
 *
 * @param filePath - Path to the source file.
 * @param type     - Detected source type.
 * @param fileSize - File size in bytes.
 */
async function showPreview(filePath: string, type: SourceType, fileSize: number): Promise<void> {
  const adapterResult = await ingestSource(filePath, type);

  const title = adapterResult.ok
    ? (adapterResult.value.metadata.title ?? '(untitled)')
    : '(untitled)';
  const author = adapterResult.ok ? (adapterResult.value.metadata.author ?? '') : '';
  const wordCount = adapterResult.ok ? adapterResult.value.metadata.wordCount : 0;
  const estTokens = Math.round((wordCount * 1.33) / 4) * 4;
  const sizeMb = (fileSize / (1024 * 1024)).toFixed(1);

  process.stdout.write('\n');
  process.stdout.write(formatInfo(`Source:      ${basename(filePath)}`) + '\n');
  process.stdout.write(formatInfo(`Type:        ${type}`) + '\n');
  process.stdout.write(formatInfo(`Title:       ${title}`) + '\n');
  if (author) {
    process.stdout.write(formatInfo(`Author:      ${author}`) + '\n');
  }
  process.stdout.write(formatInfo(`Words:       ~${wordCount.toLocaleString()}`) + '\n');
  process.stdout.write(formatInfo(`Size:        ${sizeMb} MB`) + '\n');
  process.stdout.write(formatInfo(`Est. tokens: ~${estTokens.toLocaleString()}`) + '\n');
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `ico ingest <path>` on the root Commander program.
 *
 * @param program - The root Commander `Command` instance.
 */
export function register(program: Command): void {
  program
    .command('ingest <path>')
    .description('Ingest a source file into the workspace')
    .option('--title <title>', 'Source title')
    .option('--author <author>', 'Source author')
    .option('--force', 'Override size limits')
    .option('--yes', 'Skip confirmation prompt')
    .addHelpText(
      'after',
      '\nExamples:\n  $ ico ingest paper.pdf\n  $ ico ingest notes.md --title "Meeting Notes" --author "Jeremy"\n  $ ico ingest paper.pdf --yes',
    )
    .action(async (filePath: string, opts: IngestOptions & { yes?: boolean }, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions & IngestOptions & { yes?: boolean }>();

      const ingestOpts: IngestOptions = {
        ...(opts.title !== undefined && { title: opts.title }),
        ...(opts.author !== undefined && { author: opts.author }),
        ...(opts.force !== undefined && { force: opts.force }),
      };

      const global: GlobalOptions = {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      };

      const skipConfirm = opts.yes === true || globalOpts.yes === true;

      // ------------------------------------------------------------------
      // Determine whether the path is a directory or a single file.
      // ------------------------------------------------------------------
      const pathStat = statSync(filePath, { throwIfNoEntry: false });

      if (pathStat?.isDirectory()) {
        // ----------------------------------------------------------------
        // Batch ingest mode
        // ----------------------------------------------------------------
        const files = scanDirectory(filePath);

        if (files.length === 0) {
          process.stdout.write(formatWarning('No supported files found.') + '\n');
          return;
        }

        process.stdout.write(
          formatInfo(`Found ${files.length} supported file(s) in ${filePath}`) + '\n',
        );

        let batchIngested = 0;
        let batchAlreadyIngested = 0;
        let batchSkipped = 0;
        const batchErrors: Array<{ file: string; message: string }> = [];

        for (const file of files) {
          if (!skipConfirm && process.stdin.isTTY) {
            let fileSize = 0;
            try {
              fileSize = statSync(file).size;
            } catch {
              /* non-fatal */
            }
            const previewType = detectSourceType(file);
            await showPreview(file, previewType, fileSize);
            const confirmed = await confirm('Ingest this file? [Y/n] ');
            if (!confirmed) {
              process.stdout.write(formatWarning(`Skipped: ${basename(file)}`) + '\n');
              batchSkipped++;
              continue;
            }
          } else if (!skipConfirm && !process.stdin.isTTY) {
            process.stderr.write(
              formatError('Non-TTY input detected. Use --yes to bypass confirmation.') + '\n',
            );
            process.exit(1);
          }

          const result = runIngest(file, ingestOpts, global);
          if (!result.ok) {
            process.stderr.write(formatError(`${basename(file)}: ${result.error.message}`) + '\n');
            batchErrors.push({ file, message: result.error.message });
            batchSkipped++;
          } else if (result.value.alreadyIngested === true) {
            batchAlreadyIngested++;
          } else {
            batchIngested++;
          }
        }

        // Summary line
        process.stdout.write('\n');
        process.stdout.write(
          formatSuccess(
            `Ingested ${batchIngested} of ${files.length} files` +
              ` (${batchSkipped} skipped, ${batchAlreadyIngested} already ingested)`,
          ) + '\n',
        );

        if (batchErrors.length > 0) {
          process.exit(1);
        }
        return;
      }

      // ------------------------------------------------------------------
      // Single file mode (original behavior)
      // ------------------------------------------------------------------
      if (!skipConfirm) {
        // Detect type early so we can pass it to the preview helper.
        if (!existsSync(filePath)) {
          process.stderr.write(formatError(`File not found: ${filePath}`) + '\n');
          process.exit(1);
        }

        let fileSize = 0;
        try {
          fileSize = statSync(filePath).size;
        } catch {
          // Non-fatal — preview will still show without accurate size.
        }

        const previewType = detectSourceType(filePath);
        await showPreview(filePath, previewType, fileSize);

        if (!process.stdin.isTTY) {
          process.stderr.write(
            formatError('Non-TTY input detected. Use --yes to bypass confirmation.') + '\n',
          );
          process.exit(1);
        }

        const confirmed = await confirm('Proceed? [Y/n] ');
        if (!confirmed) {
          process.stdout.write(formatWarning('Aborted.') + '\n');
          return;
        }
      }

      const result = runIngest(filePath, ingestOpts, global);
      if (!result.ok) {
        process.stderr.write(formatError(result.error.message) + '\n');
        process.exit(1);
      }
    });
}
