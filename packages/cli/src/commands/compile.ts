/**
 * `ico compile <target>` — Run compiler passes to build the wiki knowledge base.
 *
 * Subcommands:
 *   ico compile sources         Summarize uncompiled sources
 *   ico compile concepts        Extract concepts from summaries
 *   ico compile topics          Synthesize topic pages
 *   ico compile links           Add backlinks
 *   ico compile contradictions  Detect contradictions
 *   ico compile gaps            Identify knowledge gaps
 *   ico compile all             Run all passes in order
 *
 * Each subcommand:
 *   1. Resolves workspace.
 *   2. Opens database.
 *   3. Loads config (API key from env/.env).
 *   4. Creates Claude client.
 *   5. Runs the appropriate pass (or all passes in order for `all`).
 *   6. Shows progress and token usage.
 *   7. Rebuilds wiki index.
 *   8. Closes database.
 *
 * @module commands/compile
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import {
  addBacklinks,
  type ChangedFile,
  type ClaudeClient,
  computeAffectedSet,
  createClaudeClient,
  detectContradictions,
  evaluateCostGate,
  extractConcepts,
  getUncompiledSources,
  identifyGaps,
  summarizeSource,
  synthesizeTopics,
} from '@ico/compiler';
import {
  closeDatabase,
  computeFileHash,
  type Database,
  initDatabase,
  loadConfig,
  rebuildWikiIndex,
  withWriteLock,
} from '@ico/kernel';

import { formatError, formatInfo, formatSuccess, formatWarning } from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GlobalOptions {
  workspace?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface CompileContext {
  workspacePath: string;
  dbPath: string;
  db: Database;
  client: ClaudeClient;
  model: string;
}

// ---------------------------------------------------------------------------
// Pass-failure signal
// ---------------------------------------------------------------------------

/**
 * A recoverable compile-pass failure that carries the intended process exit
 * code WITHOUT terminating the process.
 *
 * The pass runners (`runSummarize`/`runExtract`/…) previously called
 * `process.exit(1|2)` directly. That immediately killed Node, bypassing the
 * action handler's `finally { closeDatabase(db) }` — so a mid-compile failure
 * (especially on the incremental / governed-freshness path, which reuses the
 * same runners under the `~/.teamkb` write-lock) left the SQLite connection
 * open, risking a stale lock, an unflushed WAL, or corruption (Gemini review,
 * PR #154).
 *
 * Now a pass THROWS this error instead. The single action-handler `try/catch/
 * finally` catches it, lets `finally` close the database, THEN sets
 * `process.exitCode` — cleanup always runs, on every path, before exit.
 */
export class CompilePassError extends Error {
  constructor(
    /** The process exit code this failure should ultimately produce. */
    public readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'CompilePassError';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Collect relative paths for all .md files in wiki/sources/.
 */
function collectSummaryPaths(workspacePath: string): string[] {
  const sourcesDir = join(workspacePath, 'wiki', 'sources');
  if (!existsSync(sourcesDir)) return [];
  return readdirSync(sourcesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => `wiki/sources/${f}`);
}

// ---------------------------------------------------------------------------
// Pass runners
// ---------------------------------------------------------------------------

/**
 * Detect Claude API authentication / authorization failures by error message.
 * `sanitizeApiError` (claude-client.ts) wraps every API error with the
 * category string and HTTP status, so this is a stable substring match.
 *
 * Auth failures are configuration errors — the same bad key fails every
 * subsequent request, so the pass fast-aborts rather than burning through
 * the whole source list with identical errors and exiting 0 (bead `u0j`).
 */
export function isAuthError(message: string): boolean {
  return (
    message.includes('authentication_error') ||
    message.includes('HTTP 401') ||
    message.includes('invalid_api_key') ||
    message.includes('permission_error') ||
    message.includes('HTTP 403')
  );
}

/**
 * Run the summarize pass: read uncompiled sources from the DB and call
 * summarizeSource for each one.
 *
 * Failure contract (per bead `u0j`): on failure this THROWS a
 * `CompilePassError` carrying the intended exit code, rather than calling
 * `process.exit` — so the action handler can close the database before the
 * process exits (Gemini review, PR #154). Codes:
 *   (returns) — at least one source compiled OR nothing to do (zero uncompiled sources)
 *   throws exitCode 1 — all sources failed for non-auth reasons (likely transient / content-level)
 *   throws exitCode 2 — Claude API authentication failed (fast-fail on first 401/403)
 *
 * The original behavior was to log per-source failures as warnings and exit 0
 * regardless of total failure count — masked bad API keys as silent success
 * with empty wiki dirs.
 */
export async function runSummarize(ctx: CompileContext): Promise<void> {
  const uncompiledResult = getUncompiledSources(ctx.db);
  if (!uncompiledResult.ok) {
    const msg = `Failed to list sources: ${uncompiledResult.error.message}`;
    process.stderr.write(formatError(msg) + '\n');
    throw new CompilePassError(1, msg);
  }

  const sources = uncompiledResult.value;
  if (sources.length === 0) {
    process.stdout.write(
      formatWarning('No uncompiled sources found. Run `ico ingest` first.') + '\n',
    );
    return;
  }

  process.stdout.write(formatInfo(`Found ${sources.length} uncompiled source(s).`) + '\n');

  let totalTokens = 0;
  let compiled = 0;
  let failed = 0;

  for (const source of sources) {
    const absPath = join(ctx.workspacePath, source.path);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch (e) {
      process.stderr.write(
        formatWarning(`  Skipped ${source.path}: ${e instanceof Error ? e.message : String(e)}`) +
          '\n',
      );
      failed++;
      continue;
    }

    const hashResult = computeFileHash(absPath);
    const hash = hashResult.ok ? hashResult.value : '';

    process.stdout.write(formatInfo(`  Compiling: ${source.path}`) + '\n');

    const result = await summarizeSource(
      ctx.client,
      ctx.db,
      ctx.workspacePath,
      source.id,
      content,
      source.path,
      hash,
      { model: ctx.model },
    );

    if (!result.ok) {
      const errMsg = result.error.message;
      process.stderr.write(formatWarning(`  Failed: ${source.path}: ${errMsg}`) + '\n');
      failed++;

      // Auth/permission errors fast-fail — the same bad key will fail every
      // remaining source identically. Exit 2 distinguishes config failures
      // from per-source content failures (exit 1).
      if (isAuthError(errMsg)) {
        const msg =
          'Claude API authentication failed. Check ANTHROPIC_API_KEY in your .env or environment.';
        process.stderr.write(formatError(msg) + '\n');
        throw new CompilePassError(2, msg);
      }
      continue;
    }

    totalTokens += result.value.tokensUsed;
    compiled++;
    process.stdout.write(
      formatSuccess(`  Done: ${result.value.outputPath} (${result.value.tokensUsed} tokens)`) +
        '\n',
    );
  }

  rebuildWikiIndex(ctx.workspacePath);

  process.stdout.write('\n');

  // All-failed sentinel — if no source compiled and at least one failed,
  // the pass produced no usable output. Exit 1 so callers (CI, demo
  // orchestrator, operators) see the failure instead of cascading
  // "no input found" warnings through the rest of the pipeline.
  if (compiled === 0 && failed > 0) {
    const msg = `Summarize pass: ALL ${failed} source(s) failed. Workspace produced no compiled output.`;
    process.stderr.write(formatError(msg) + '\n');
    throw new CompilePassError(1, msg);
  }

  process.stdout.write(
    formatSuccess(
      `Summarize pass complete: ${compiled} compiled, ${failed} failed, ${totalTokens} tokens used.`,
    ) + '\n',
  );
}

/** Run the extract pass: extract concepts and entities from summaries. */
async function runExtract(ctx: CompileContext): Promise<void> {
  process.stdout.write(formatInfo('Running extract pass...') + '\n');

  const summaryPaths = collectSummaryPaths(ctx.workspacePath);
  if (summaryPaths.length === 0) {
    process.stdout.write(
      formatWarning('No summaries found. Run `ico compile sources` first.') + '\n',
    );
    return;
  }

  const result = await extractConcepts(ctx.client, ctx.db, ctx.workspacePath, summaryPaths, {
    model: ctx.model,
  });

  if (!result.ok) {
    process.stderr.write(formatError(result.error.message) + '\n');
    throw new CompilePassError(1, result.error.message);
  }

  rebuildWikiIndex(ctx.workspacePath);

  process.stdout.write(
    formatSuccess(`Extract pass complete: ${result.value.length} pages written.`) + '\n',
  );
}

/** Run the synthesize pass: create topic pages from summaries + concepts. */
async function runSynthesize(ctx: CompileContext): Promise<void> {
  process.stdout.write(formatInfo('Running synthesize pass...') + '\n');

  const result = await synthesizeTopics(ctx.client, ctx.db, ctx.workspacePath, {
    model: ctx.model,
  });

  if (!result.ok) {
    process.stderr.write(formatError(result.error.message) + '\n');
    throw new CompilePassError(1, result.error.message);
  }

  rebuildWikiIndex(ctx.workspacePath);

  process.stdout.write(
    formatSuccess(`Synthesize pass complete: ${result.value.length} topic pages written.`) + '\n',
  );
}

/** Run the link pass: add backlinks deterministically. */
async function runLink(ctx: CompileContext): Promise<void> {
  process.stdout.write(formatInfo('Running link pass (deterministic)...') + '\n');

  const result = await addBacklinks(ctx.client, ctx.db, ctx.workspacePath);

  if (!result.ok) {
    process.stderr.write(formatError(result.error.message) + '\n');
    throw new CompilePassError(1, result.error.message);
  }

  process.stdout.write(
    formatSuccess(
      `Link pass complete: ${result.value.pagesUpdated} pages updated, ${result.value.totalBacklinks} backlinks added.`,
    ) + '\n',
  );
}

/** Run the contradict pass: detect conflicting claims. */
async function runContradict(ctx: CompileContext): Promise<void> {
  process.stdout.write(formatInfo('Running contradict pass...') + '\n');

  const result = await detectContradictions(ctx.client, ctx.db, ctx.workspacePath, {
    model: ctx.model,
  });

  if (!result.ok) {
    process.stderr.write(formatError(result.error.message) + '\n');
    throw new CompilePassError(1, result.error.message);
  }

  rebuildWikiIndex(ctx.workspacePath);

  if (result.value.length === 0) {
    process.stdout.write(
      formatSuccess('Contradict pass complete: no contradictions found.') + '\n',
    );
  } else {
    process.stdout.write(
      formatSuccess(`Contradict pass complete: ${result.value.length} contradiction(s) recorded.`) +
        '\n',
    );
  }
}

/** Run the gap pass: identify knowledge gaps and open questions. */
async function runGap(ctx: CompileContext): Promise<void> {
  process.stdout.write(formatInfo('Running gap pass...') + '\n');

  const result = await identifyGaps(ctx.client, ctx.db, ctx.workspacePath, {
    model: ctx.model,
  });

  if (!result.ok) {
    process.stderr.write(formatError(result.error.message) + '\n');
    throw new CompilePassError(1, result.error.message);
  }

  rebuildWikiIndex(ctx.workspacePath);

  if (result.value.length === 0) {
    process.stdout.write(formatSuccess('Gap pass complete: no gaps identified.') + '\n');
  } else {
    process.stdout.write(
      formatSuccess(`Gap pass complete: ${result.value.length} open question(s) recorded.`) + '\n',
    );
  }
}

// ---------------------------------------------------------------------------
// Incremental compile — governed freshness (e06.5 / R12 / umbrella #27)
// ---------------------------------------------------------------------------

/**
 * Parse a `--changed` argument into the `ChangedFile[]` the diff consumes.
 *
 * The argument is a comma- and/or newline-separated list of workspace-relative
 * raw paths (e.g. `raw/notes/a.md,raw/notes/b.md`) OR a path to a manifest file
 * containing one such path per line. Each path's CURRENT content hash is
 * computed from disk so the diff can compare it against the `sources` table.
 *
 * A path that cannot be read on disk is still returned (with an empty hash) so
 * the diff treats it as changed/new and fails toward freshness — a compile
 * trigger should never be silently dropped because a file read hiccuped.
 *
 * @param arg           - The raw `--changed` value.
 * @param workspacePath - Absolute workspace root (paths resolve against it).
 * @returns The changed-file list (deduplicated, order-stable).
 */
export function parseChangedList(arg: string, workspacePath: string): ChangedFile[] {
  // Resolve manifest-vs-inline with a SINGLE read, not exists/stat-then-read:
  // reading once (and deciding from the result) closes the check-then-use
  // (TOCTOU) window where the path could change between the check and the read
  // — the same one-read discipline `ico ingest` uses. If the read succeeds the
  // argument is a manifest file; if it throws (ENOENT/EISDIR/…) the argument is
  // an inline comma/newline list, used verbatim.
  let text: string;
  try {
    text = readFileSync(arg, 'utf-8');
  } catch {
    text = arg;
  }

  const seen = new Set<string>();
  const out: ChangedFile[] = [];
  for (const token of text.split(/[\n,]/)) {
    const relPath = token.trim();
    if (relPath === '' || seen.has(relPath)) continue;
    seen.add(relPath);
    const absPath = join(workspacePath, relPath);
    const hashResult = computeFileHash(absPath);
    out.push({ path: relPath, hash: hashResult.ok ? hashResult.value : '' });
  }
  return out;
}

/**
 * Run an incremental compile: regenerate ONLY the pages affected by a set of
 * changed raw files, gated by the DeepSeek-priced cost model, serialised under
 * the `~/.teamkb` write-lock.
 *
 * The affected pages re-enter the SAME pass pipeline as a full compile — there
 * is no fast-path that skips govern. Today this drives the summarize pass for
 * affected single-source pages and re-runs the cross-source passes (topics,
 * contradictions, gaps) when the conservative sweep fired; extract/link follow
 * the full-compile ordering. When nothing is affected it is a no-op.
 *
 * @returns the process exit code (0 = ran or no-op; 3 = deferred by cost gate;
 *          4 = coalesced within the debounce window). Non-zero-but-benign codes
 *          let a CI trigger distinguish "did nothing on purpose" from failure.
 */
export async function runIncremental(
  ctx: CompileContext,
  changed: ChangedFile[],
  opts: {
    dryRun: boolean;
    dailyCeilingUsd?: number;
    debounceWindowSeconds?: number;
    lastCompileAtMs?: number | null;
  },
): Promise<number> {
  // 1. Diff — which pages are affected? (fail toward freshness)
  const affectedResult = computeAffectedSet(ctx.db, changed);
  if (!affectedResult.ok) {
    process.stderr.write(formatError(`Diff failed: ${affectedResult.error.message}`) + '\n');
    return 1;
  }
  const affected = affectedResult.value;

  process.stdout.write(
    formatInfo(
      `Incremental diff: ${affected.changedSourcePaths.length} changed, ` +
        `${affected.newSourcePaths.length} new, ${affected.unchangedSourcePaths.length} unchanged; ` +
        `${affected.affectedPages.length} page(s) to recompile` +
        (affected.conservativeSweep ? ' (conservative cross-source sweep applied)' : ''),
    ) + '\n',
  );

  // 2. Cost gate — enforce the per-UTC-day ceiling + debounce window.
  const gateResult = evaluateCostGate(
    ctx.db,
    {
      affectedTypes: affected.affectedPages.map((p) => p.type),
      lastCompileAtMs: opts.lastCompileAtMs ?? null,
    },
    {
      model: ctx.model,
      ...(opts.dailyCeilingUsd !== undefined && { dailyCeilingUsd: opts.dailyCeilingUsd }),
      ...(opts.debounceWindowSeconds !== undefined && {
        debounceWindowSeconds: opts.debounceWindowSeconds,
      }),
    },
  );
  if (!gateResult.ok) {
    process.stderr.write(formatError(`Cost gate failed: ${gateResult.error.message}`) + '\n');
    return 1;
  }
  const verdict = gateResult.value;
  process.stdout.write(
    formatInfo(
      `Cost gate [${verdict.pricedModel}]: projected $${verdict.projectedCostUsd.toFixed(4)}, ` +
        `day total $${verdict.projectedDayTotalUsd.toFixed(4)} / $${verdict.ceilingUsd.toFixed(2)} ceiling`,
    ) + '\n',
  );

  if (verdict.decision === 'coalesce') {
    process.stdout.write(formatWarning(verdict.reason) + '\n');
    return 4;
  }
  if (verdict.decision === 'defer') {
    process.stdout.write(formatWarning(verdict.reason) + '\n');
    return 3;
  }

  if (affected.affectedPages.length === 0) {
    process.stdout.write(formatSuccess('Nothing affected — brain is already fresh.') + '\n');
    return 0;
  }

  if (opts.dryRun) {
    process.stdout.write(formatInfo('Dry run — affected pages (not recompiling):') + '\n');
    for (const p of affected.affectedPages) {
      process.stdout.write(formatInfo(`  ${p.type}\t${p.outputPath}\t(${p.reason})`) + '\n');
    }
    process.stdout.write(formatSuccess(verdict.reason) + '\n');
    return 0;
  }

  // 3. Recompile under the single-writer lock (serialises vs nightly + backup).
  const lockResult = await withWriteLock(async () => {
    // Affected single-source pages recompile via the summarize pass (it reads
    // uncompiled/changed sources from the DB). Cross-source passes re-run when
    // the conservative sweep flagged them. Deltas run the FULL pipeline — no
    // fast-path around govern.
    const hasSingleSource = affected.affectedPages.some((p) =>
      ['summary', 'concept', 'entity'].includes(p.type),
    );
    const hasCrossSource =
      affected.conservativeSweep ||
      affected.affectedPages.some((p) =>
        ['topic', 'contradiction', 'open-question'].includes(p.type),
      );

    if (hasSingleSource) {
      await runSummarize(ctx);
      await runExtract(ctx);
    }
    if (hasCrossSource) {
      await runSynthesize(ctx);
      await runLink(ctx);
      await runContradict(ctx);
      await runGap(ctx);
    }
    rebuildWikiIndex(ctx.workspacePath);
  });

  if (!lockResult.ok) {
    // A sub-pass that failed inside the critical section threw a
    // CompilePassError; withWriteLock caught it and RELEASED the lock (its
    // `finally` closes the flock holder), then surfaced it here as a failed
    // Result. Preserve the sub-pass's intended exit code (e.g. 2 for an auth
    // failure) instead of flattening every failure to 1, matching the
    // full-compile path. The DB stays open — the CLI action handler's
    // `finally { closeDatabase(db) }` still runs because nothing called
    // process.exit (Gemini review, PR #154).
    process.stderr.write(
      formatError(`Incremental compile failed: ${lockResult.error.message}`) + '\n',
    );
    return lockResult.error instanceof CompilePassError ? lockResult.error.exitCode : 1;
  }
  if (!lockResult.value.ran) {
    // Another ~/.teamkb writer held the lock — skip-graceful, defer to next trigger.
    process.stdout.write(
      formatWarning(
        'Another ~/.teamkb writer holds the lock — skipped (will retry next trigger).',
      ) + '\n',
    );
    return 4;
  }
  if (!lockResult.value.locked) {
    process.stdout.write(
      formatWarning(
        'flock not on PATH — ran WITHOUT the ~/.teamkb writer lock (concurrent backup/compile could skew the brain).',
      ) + '\n',
    );
  }

  process.stdout.write(formatSuccess('Incremental compile complete.') + '\n');
  return 0;
}

// ---------------------------------------------------------------------------
// Compile command registration
// ---------------------------------------------------------------------------

const VALID_TARGETS = [
  'sources',
  'concepts',
  'topics',
  'links',
  'contradictions',
  'gaps',
  'all',
] as const;

type CompileTarget = (typeof VALID_TARGETS)[number];

function isValidTarget(s: string): s is CompileTarget {
  return (VALID_TARGETS as readonly string[]).includes(s);
}

/**
 * Register `ico compile <target>` and all its subcommands.
 */
export function register(program: Command): void {
  program
    .command('compile <target>')
    .description('Compile knowledge from sources')
    .addHelpText(
      'after',
      `\nTargets:\n  sources         Summarize uncompiled sources\n  concepts        Extract concepts from summaries\n  topics          Synthesize topic pages\n  links           Add backlinks\n  contradictions  Detect contradictions\n  gaps            Identify knowledge gaps\n  all             Run all passes in order\n\nIncremental (governed freshness — regenerate only affected pages):\n  --changed <list>          Comma/newline list of changed raw paths, or a manifest file.\n                            Recompiles only the affected pages, gated by the cost model,\n                            serialised under the ~/.teamkb write-lock. Enters the full\n                            pipeline (no fast-path around govern).\n  --dry-run                 With --changed: print the affected set + cost verdict; do not compile.\n  --daily-ceiling-usd <n>   Override the per-UTC-day spend ceiling (default $1.00).\n  --debounce-seconds <n>    Override the coalescing window (default 300s).\n\nExamples:\n  $ ico compile sources\n  $ ico compile all\n  $ ico compile concepts --model claude-opus-4-6\n  $ ico compile all --changed raw/notes/a.md,raw/notes/b.md\n  $ ico compile all --changed .changed-manifest --dry-run`,
    )
    .option('--model <model>', 'Override model for this pass')
    .option(
      '--changed <list>',
      'Incremental: comma/newline list of changed raw paths, or a manifest file',
    )
    .option('--dry-run', 'With --changed: report the affected set + cost verdict without compiling')
    .option(
      '--daily-ceiling-usd <n>',
      'Incremental cost gate: per-UTC-day USD ceiling (default 1.00)',
    )
    .option(
      '--debounce-seconds <n>',
      'Incremental cost gate: coalescing window in seconds (default 300)',
    )
    .action(
      async (
        target: string,
        opts: {
          model?: string;
          changed?: string;
          dryRun?: boolean;
          dailyCeilingUsd?: string;
          debounceSeconds?: string;
        },
        cmd: Command,
      ) => {
        const globalOpts = cmd.optsWithGlobals<GlobalOptions & { model?: string }>();
        const modelOverride = opts.model ?? globalOpts.model;

        if (!isValidTarget(target)) {
          process.stderr.write(
            formatError(
              `Unknown compile target: "${target}". Valid targets: ${VALID_TARGETS.join(', ')}`,
            ) + '\n',
          );
          process.exit(1);
        }

        // Resolve workspace.
        const wsResult = resolveWorkspace(
          globalOpts.workspace !== undefined ? { workspace: globalOpts.workspace } : undefined,
        );
        if (!wsResult.ok) {
          process.stderr.write(formatError(wsResult.error.message) + '\n');
          process.exit(1);
        }
        const { root: workspacePath, dbPath } = wsResult.value;

        // Open database.
        const dbResult = initDatabase(dbPath);
        if (!dbResult.ok) {
          process.stderr.write(
            formatError(`Failed to open database: ${dbResult.error.message}`) + '\n',
          );
          process.exit(1);
        }
        const db = dbResult.value;

        // Load config. The link pass is deterministic and does not need an API key,
        // so we gracefully degrade when the key is absent.
        let config: { apiKey: string; model: string };
        try {
          const loaded = loadConfig(workspacePath);
          config = { apiKey: loaded.apiKey, model: loaded.model };
        } catch (e) {
          if (target === 'links') {
            // Link pass is deterministic — no API key required.
            config = { apiKey: '', model: modelOverride ?? 'claude-sonnet-4-6' };
          } else {
            closeDatabase(db);
            process.stderr.write(formatError(e instanceof Error ? e.message : String(e)) + '\n');
            process.exit(1);
          }
        }

        const model = modelOverride ?? config.model;
        const client = createClaudeClient(config.apiKey);
        const ctx: CompileContext = { workspacePath, dbPath, db, client, model };

        try {
          // Incremental / governed-freshness path (e06.5 / R12 / umbrella #27):
          // when --changed is supplied, recompile ONLY the affected pages, gated
          // by the DeepSeek-priced cost model + debounce window, under the
          // ~/.teamkb write-lock. Short-circuits the normal target dispatch.
          if (opts.changed !== undefined) {
            const changed = parseChangedList(opts.changed, workspacePath);
            const parseNumber = (raw: string | undefined, label: string): number | undefined => {
              if (raw === undefined) return undefined;
              const n = Number(raw);
              if (!Number.isFinite(n) || n < 0) {
                // Throw (don't process.exit) so the action handler's
                // `finally { closeDatabase(db) }` runs — the DB is already open
                // here on the incremental path (Gemini review, PR #154).
                const msg = `Invalid ${label}: "${raw}" (must be a non-negative number).`;
                process.stderr.write(formatError(msg) + '\n');
                throw new CompilePassError(1, msg);
              }
              return n;
            };
            const dailyCeilingUsd = parseNumber(opts.dailyCeilingUsd, '--daily-ceiling-usd');
            const debounceWindowSeconds = parseNumber(opts.debounceSeconds, '--debounce-seconds');
            const exitCode = await runIncremental(ctx, changed, {
              dryRun: opts.dryRun === true,
              ...(dailyCeilingUsd !== undefined && { dailyCeilingUsd }),
              ...(debounceWindowSeconds !== undefined && { debounceWindowSeconds }),
            });
            if (exitCode !== 0) process.exitCode = exitCode;
            return;
          }

          if (target === 'all') {
            // Run all passes in order within a single DB session.
            process.stdout.write(formatInfo('Running all compilation passes in order...\n') + '\n');

            process.stdout.write(formatInfo('[1/6] Summarize...') + '\n');
            await runSummarize(ctx);

            process.stdout.write(formatInfo('[2/6] Extract...') + '\n');
            await runExtract(ctx);

            process.stdout.write(formatInfo('[3/6] Synthesize...') + '\n');
            await runSynthesize(ctx);

            process.stdout.write(formatInfo('[4/6] Link...') + '\n');
            await runLink(ctx);

            process.stdout.write(formatInfo('[5/6] Contradict...') + '\n');
            await runContradict(ctx);

            process.stdout.write(formatInfo('[6/6] Gap...') + '\n');
            await runGap(ctx);

            process.stdout.write('\n');
            process.stdout.write(formatSuccess('All compilation passes complete.') + '\n');
            return;
          }

          switch (target) {
            case 'sources':
              await runSummarize(ctx);
              break;
            case 'concepts':
              await runExtract(ctx);
              break;
            case 'topics':
              await runSynthesize(ctx);
              break;
            case 'links':
              await runLink(ctx);
              break;
            case 'contradictions':
              await runContradict(ctx);
              break;
            case 'gaps':
              await runGap(ctx);
              break;
          }
        } catch (e) {
          // A pass failure now THROWS (CompilePassError) instead of calling
          // process.exit mid-run, so this catch runs, the `finally` below
          // closes the DB, and only THEN do we set the exit code — the SQLite
          // connection is never abandoned open (Gemini review, PR #154).
          if (e instanceof CompilePassError) {
            process.exitCode = e.exitCode;
          } else {
            // Unexpected error — re-throw after the DB is closed by `finally`.
            throw e;
          }
        } finally {
          closeDatabase(db);
        }
      },
    );
}
