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
  type ClaudeClient,
  createClaudeClient,
  detectContradictions,
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

interface CompileContext {
  workspacePath: string;
  dbPath: string;
  db: Database;
  client: ClaudeClient;
  model: string;
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
 * Run the summarize pass: read uncompiled sources from the DB and call
 * summarizeSource for each one.
 */
async function runSummarize(ctx: CompileContext): Promise<void> {
  const uncompiledResult = getUncompiledSources(ctx.db);
  if (!uncompiledResult.ok) {
    process.stderr.write(
      formatError(`Failed to list sources: ${uncompiledResult.error.message}`) + '\n',
    );
    process.exit(1);
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
      process.stderr.write(
        formatWarning(`  Failed: ${source.path}: ${result.error.message}`) + '\n',
      );
      failed++;
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
    process.exit(1);
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
    process.exit(1);
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
    process.exit(1);
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
    process.exit(1);
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
    process.exit(1);
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
      `\nTargets:\n  sources         Summarize uncompiled sources\n  concepts        Extract concepts from summaries\n  topics          Synthesize topic pages\n  links           Add backlinks\n  contradictions  Detect contradictions\n  gaps            Identify knowledge gaps\n  all             Run all passes in order\n\nExamples:\n  $ ico compile sources\n  $ ico compile all\n  $ ico compile concepts --model claude-opus-4-6`,
    )
    .option('--model <model>', 'Override model for this pass')
    .action(async (target: string, opts: { model?: string }, cmd: Command) => {
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
      } finally {
        closeDatabase(db);
      }
    });
}
