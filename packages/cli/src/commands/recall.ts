/**
 * `ico recall` command group (E9-B08+).
 *
 * Currently implemented:
 *   - `ico recall generate --topic <name>` — Generate flashcards and quiz
 *     questions for a topic from compiled knowledge (E9-B08).
 *
 * Future subcommands (B09–B11) will plug into this same group.
 *
 * @module commands/recall
 */

import type { Command } from 'commander';

import {
  calculateCost,
  createClaudeClient,
  generateRecall,
  type RecallGenerateResult,
} from '@ico/compiler';
import {
  closeDatabase,
  createSearchIndex,
  indexCompiledPages,
  initDatabase,
  loadConfig,
} from '@ico/kernel';

import { dim, formatError, formatInfo, formatJSON, formatSuccess } from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  workspace?: string;
}

interface RecallGenerateOpts {
  topic?: string;
  model?: string;
  maxPages?: number;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Core logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Run the recall card generation pipeline for a single topic.
 *
 * Side effects:
 * - Opens the workspace DB, builds FTS5 index, calls Claude, writes card +
 *   quiz files under `recall/`, emits a `recall.generate` trace.
 * - Prints either the result summary (default) or a JSON document (`--json`).
 *
 * @param topic      - Topic phrase used both for FTS5 search and the quiz filename slug.
 * @param opts       - Subcommand options.
 * @param globalOpts - Global CLI flags (json, verbose, workspace).
 */
export async function runRecallGenerate(
  topic: string,
  opts: RecallGenerateOpts,
  globalOpts: GlobalOptions,
): Promise<{ ok: true; value: RecallGenerateResult } | { ok: false; error: Error }> {
  // 1. Resolve workspace.
  const wsResolveOpts =
    globalOpts.workspace !== undefined ? { workspace: globalOpts.workspace } : {};
  const wsResult = resolveWorkspace(wsResolveOpts);
  if (!wsResult.ok) return { ok: false, error: wsResult.error };
  const { root: wsPath, dbPath } = wsResult.value;

  // 2. Load config and create Claude client.
  let config: { apiKey: string; model: string };
  try {
    config = loadConfig(wsPath);
  } catch (e) {
    return {
      ok: false,
      error: new Error(`Config error: ${e instanceof Error ? e.message : String(e)}`),
    };
  }
  const client = createClaudeClient(config.apiKey);

  // 3. Open DB.
  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) return { ok: false, error: dbResult.error };
  const db = dbResult.value;

  try {
    // 4. Ensure FTS5 index is present and current.
    const createIdx = createSearchIndex(db);
    if (!createIdx.ok) return { ok: false, error: createIdx.error };
    const idxResult = indexCompiledPages(db, wsPath);
    if (!idxResult.ok) return { ok: false, error: idxResult.error };
    if (globalOpts.verbose === true) {
      process.stdout.write(formatInfo(`Indexed ${idxResult.value} compiled pages`) + '\n');
    }

    // 5. Generate.
    const model = opts.model ?? config.model;
    const result = await generateRecall(db, wsPath, topic, client, {
      ...(opts.maxPages !== undefined && { maxPages: opts.maxPages }),
      ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
      model,
    });
    if (!result.ok) return { ok: false, error: result.error };

    // 6. Emit output.
    if (globalOpts.json === true) {
      process.stdout.write(formatJSON(result.value) + '\n');
    } else {
      const cost = calculateCost(result.value.inputTokens, result.value.outputTokens, model);
      process.stdout.write('\n');
      process.stdout.write(formatSuccess('Recall material generated') + '\n');
      process.stdout.write(formatInfo(`  Topic:     ${result.value.topic}`) + '\n');
      process.stdout.write(formatInfo(`  Cards:     ${result.value.cards.length}`) + '\n');
      process.stdout.write(
        formatInfo(`  Quiz:      ${result.value.quiz.questionCount} questions`) + '\n',
      );
      process.stdout.write(formatInfo(`  Sources:   ${result.value.sourcePages.length} pages`) + '\n');
      process.stdout.write(formatInfo(`  Quiz file: ${result.value.quiz.path}`) + '\n');
      process.stdout.write(
        dim(`  Tokens:    ${result.value.tokensUsed.toLocaleString()} (~$${cost.toFixed(2)})`) + '\n',
      );
      process.stdout.write('\n');
    }

    return { ok: true, value: result.value };
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `ico recall` and its `generate` subcommand on the root program.
 */
export function register(program: Command): void {
  const recall = program.command('recall').description('Recall, flashcards, and quizzes (Epic 9)');

  recall
    .command('generate')
    .description('Generate flashcards and quiz questions for a topic')
    .requiredOption('--topic <name>', 'Topic phrase to generate recall material for')
    .option('--model <model>', 'Claude model override')
    .option('--max-pages <n>', 'Max wiki pages fed to the generator', (v: string) =>
      parseInt(v, 10),
    )
    .option('--max-tokens <n>', 'Maximum response tokens', (v: string) => parseInt(v, 10))
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ ico recall generate --topic "transformer attention"',
        '  $ ico recall generate --topic embeddings --model claude-opus-4-6',
      ].join('\n'),
    )
    .action(async (opts: RecallGenerateOpts, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      const global: GlobalOptions = {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      };

      // requiredOption ensures topic is defined; assert for the type system.
      const topic = opts.topic ?? '';
      const result = await runRecallGenerate(topic, opts, global);
      if (!result.ok) {
        process.stderr.write(formatError(result.error.message) + '\n');
        process.exit(1);
      }
    });
}
