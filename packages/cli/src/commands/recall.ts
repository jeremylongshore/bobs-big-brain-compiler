/**
 * `ico recall` command group (E9-B08+).
 *
 * Currently implemented:
 *   - `ico recall generate --topic <name>` — Generate flashcards and quiz
 *     questions for a topic from compiled knowledge (E9-B08).
 *   - `ico recall quiz --topic <name>` — Run an interactive quiz over a
 *     generated quiz file. Supports `--answers-file <path>` for non-
 *     interactive use in CI / scripted contexts (E9-B09, audit M13).
 *
 * Future subcommands (B10–B11) will plug into this same group.
 *
 * @module commands/recall
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import type { Command } from 'commander';

import {
  calculateCost,
  createClaudeClient,
  type ExportAnkiResult,
  exportRecallAnki,
  generateRecall,
  type QuizMode,
  type QuizSummary,
  type RecallGenerateResult,
  runQuiz,
  slugifyRecall,
} from '@ico/compiler';
import {
  closeDatabase,
  type ConceptRetention,
  createSearchIndex,
  getRetentionReport,
  getWeakAreas,
  indexCompiledPages,
  initDatabase,
  loadConfig,
  type RetentionReport,
} from '@ico/kernel';

import {
  bold,
  dim,
  formatError,
  formatHeader,
  formatInfo,
  formatJSON,
  formatSuccess,
  formatWarning,
} from '../lib/output.js';
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

interface RecallQuizOpts {
  topic?: string;
  mode?: string;
  model?: string;
  maxTokens?: number;
  answersFile?: string;
}

interface RecallWeakOpts {
  limit?: number;
  minSampleSize?: number;
  report?: boolean;
}

interface RecallExportOpts {
  format?: string;
  topic?: string;
  out?: string;
}

// ---------------------------------------------------------------------------
// recall generate
// ---------------------------------------------------------------------------

export async function runRecallGenerate(
  topic: string,
  opts: RecallGenerateOpts,
  globalOpts: GlobalOptions,
): Promise<{ ok: true; value: RecallGenerateResult } | { ok: false; error: Error }> {
  const wsResolveOpts =
    globalOpts.workspace !== undefined ? { workspace: globalOpts.workspace } : {};
  const wsResult = resolveWorkspace(wsResolveOpts);
  if (!wsResult.ok) return { ok: false, error: wsResult.error };
  const { root: wsPath, dbPath } = wsResult.value;

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

  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) return { ok: false, error: dbResult.error };
  const db = dbResult.value;

  try {
    const createIdx = createSearchIndex(db);
    if (!createIdx.ok) return { ok: false, error: createIdx.error };
    const idxResult = indexCompiledPages(db, wsPath);
    if (!idxResult.ok) return { ok: false, error: idxResult.error };
    if (globalOpts.verbose === true) {
      process.stdout.write(formatInfo(`Indexed ${idxResult.value} compiled pages`) + '\n');
    }

    const model = opts.model ?? config.model;
    const result = await generateRecall(db, wsPath, topic, client, {
      ...(opts.maxPages !== undefined && { maxPages: opts.maxPages }),
      ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
      model,
    });
    if (!result.ok) return { ok: false, error: result.error };

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
      process.stdout.write(
        formatInfo(`  Sources:   ${result.value.sourcePages.length} pages`) + '\n',
      );
      process.stdout.write(formatInfo(`  Quiz file: ${result.value.quiz.path}`) + '\n');
      process.stdout.write(
        dim(`  Tokens:    ${result.value.tokensUsed.toLocaleString()} (~$${cost.toFixed(2)})`) +
          '\n',
      );
      process.stdout.write('\n');
    }

    return { ok: true, value: result.value };
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// recall quiz
// ---------------------------------------------------------------------------

/**
 * Load and validate `--answers-file`. The file is JSON: either a top-level
 * array of strings, or an object with an `answers` array. The latter form
 * leaves room for richer fixtures (confidence values, timestamps) later
 * without breaking existing files.
 */
function loadAnswersFile(
  path: string,
): { ok: true; value: string[] } | { ok: false; error: Error } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    return {
      ok: false,
      error: new Error(
        `Failed to read answers file ${path}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: new Error(
        `Answers file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  }

  let candidate: unknown = parsed;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    'answers' in candidate
  ) {
    candidate = (candidate as { answers: unknown }).answers;
  }
  if (!Array.isArray(candidate)) {
    return {
      ok: false,
      error: new Error('Answers file must be a JSON array of strings or { "answers": [...] }'),
    };
  }
  const out: string[] = [];
  for (let i = 0; i < candidate.length; i += 1) {
    const a: unknown = candidate[i];
    if (typeof a !== 'string') {
      return { ok: false, error: new Error(`answers[${i}] is not a string`) };
    }
    out.push(a);
  }
  return { ok: true, value: out };
}

/**
 * Run a quiz session, end-to-end. Interactive by default; non-interactive
 * when `--answers-file` is passed.
 */
export async function runRecallQuiz(
  opts: RecallQuizOpts,
  globalOpts: GlobalOptions,
): Promise<{ ok: true; value: QuizSummary } | { ok: false; error: Error }> {
  const topic = opts.topic ?? '';
  if (topic.trim() === '') {
    return { ok: false, error: new Error('--topic is required') };
  }

  const wsResolveOpts =
    globalOpts.workspace !== undefined ? { workspace: globalOpts.workspace } : {};
  const wsResult = resolveWorkspace(wsResolveOpts);
  if (!wsResult.ok) return { ok: false, error: wsResult.error };
  const { root: wsPath, dbPath } = wsResult.value;

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

  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) return { ok: false, error: dbResult.error };
  const db = dbResult.value;

  try {
    const topicSlug = slugifyRecall(topic);
    if (topicSlug === '') {
      return { ok: false, error: new Error(`Topic '${topic}' produced an empty slug`) };
    }

    const mode: QuizMode = opts.mode === 'test' ? 'test' : 'review';
    const model = opts.model ?? config.model;

    // Decide interactive vs non-interactive.
    let answers: string[] | undefined;
    if (opts.answersFile !== undefined) {
      const loaded = loadAnswersFile(opts.answersFile);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      answers = loaded.value;
    }

    let rl: ReturnType<typeof createInterface> | undefined;
    const prompter =
      answers === undefined
        ? async (params: { index: number; total: number; question: string }): Promise<string> => {
            rl ??= createInterface({ input: process.stdin, output: process.stdout });
            process.stdout.write('\n');
            process.stdout.write(
              formatHeader(`Question ${params.index} of ${params.total}`) + '\n\n',
            );
            process.stdout.write(`  ${params.question}\n\n`);
            const answer = await rl.question(`${bold('Your answer:')} `);
            return answer;
          }
        : undefined;

    try {
      const result = await runQuiz(db, wsPath, topicSlug, client, {
        mode,
        model,
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        ...(answers !== undefined ? { answers } : {}),
        ...(prompter !== undefined ? { prompter } : {}),
      });
      if (!result.ok) return { ok: false, error: result.error };

      if (globalOpts.json === true) {
        process.stdout.write(formatJSON(result.value) + '\n');
      } else {
        printQuizSummary(result.value);
      }

      return { ok: true, value: result.value };
    } finally {
      rl?.close();
    }
  } finally {
    closeDatabase(db);
  }
}

function printQuizSummary(summary: QuizSummary): void {
  process.stdout.write('\n');
  process.stdout.write(formatHeader('Quiz Complete') + '\n\n');
  process.stdout.write(formatInfo(`  Topic:      ${summary.topic}`) + '\n');
  process.stdout.write(formatInfo(`  Session:    ${summary.sessionId}`) + '\n');
  process.stdout.write(
    formatInfo(`  Score:      ${summary.correctCount} / ${summary.total}`) + '\n',
  );

  if (summary.weakConcepts.length > 0) {
    process.stdout.write(formatWarning(`  Weak areas: ${summary.weakConcepts.join(', ')}`) + '\n');
  } else {
    process.stdout.write(formatSuccess(`  No weak areas detected.`) + '\n');
  }

  process.stdout.write('\n');
  process.stdout.write(formatHeader('Per-question results') + '\n\n');
  for (const r of summary.results) {
    const marker = r.correct ? formatSuccess('✓') : formatWarning('✗');
    process.stdout.write(`  ${marker} Q${r.question.index}: ${r.feedback}\n`);
  }
  process.stdout.write(
    dim(`\n  Used ${summary.tokensUsed.toLocaleString()} tokens (model: ${summary.model})\n`),
  );
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// recall weak
// ---------------------------------------------------------------------------

/**
 * List the lowest-retention concepts. With `--report`, prints the full
 * retention report (overall + weakest + strongest).
 */
export function runRecallWeak(
  opts: RecallWeakOpts,
  globalOpts: GlobalOptions,
):
  | { ok: true; value: { weak: ConceptRetention[]; report: RetentionReport | null } }
  | { ok: false; error: Error } {
  const wsResolveOpts =
    globalOpts.workspace !== undefined ? { workspace: globalOpts.workspace } : {};
  const wsResult = resolveWorkspace(wsResolveOpts);
  if (!wsResult.ok) return { ok: false, error: wsResult.error };
  const { dbPath } = wsResult.value;

  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) return { ok: false, error: dbResult.error };
  const db = dbResult.value;

  try {
    const weakResult = getWeakAreas(db, {
      ...(opts.limit !== undefined && { limit: opts.limit }),
      ...(opts.minSampleSize !== undefined && { minSampleSize: opts.minSampleSize }),
    });
    if (!weakResult.ok) return { ok: false, error: weakResult.error };

    let report: RetentionReport | null = null;
    if (opts.report === true) {
      const reportResult = getRetentionReport(db, {
        ...(opts.minSampleSize !== undefined && { minSampleSize: opts.minSampleSize }),
      });
      if (!reportResult.ok) return { ok: false, error: reportResult.error };
      report = reportResult.value;
    }

    if (globalOpts.json === true) {
      process.stdout.write(formatJSON({ weak: weakResult.value, report }) + '\n');
    } else {
      printWeakAreas(weakResult.value, report);
    }
    return { ok: true, value: { weak: weakResult.value, report } };
  } finally {
    closeDatabase(db);
  }
}

function printWeakAreas(weak: ConceptRetention[], report: RetentionReport | null): void {
  process.stdout.write('\n');
  if (report !== null) {
    process.stdout.write(formatHeader('Retention Report') + '\n\n');
    process.stdout.write(formatInfo(`  Total answers:  ${report.totalAnswers}`) + '\n');
    process.stdout.write(formatInfo(`  Total correct:  ${report.totalCorrect}`) + '\n');
    process.stdout.write(
      formatInfo(`  Overall:        ${(report.overall * 100).toFixed(1)}%`) + '\n',
    );
    process.stdout.write(formatInfo(`  Concepts seen:  ${report.conceptCount}`) + '\n');
    process.stdout.write('\n');
    if (report.strongest.length > 0) {
      process.stdout.write(formatHeader('Strongest concepts') + '\n\n');
      for (const c of report.strongest) {
        process.stdout.write(
          `  ${formatSuccess('●')} ${c.concept.padEnd(40)} ${(c.retention * 100).toFixed(0).padStart(3)}%  ${dim(`(${c.correct}/${c.total})`)}\n`,
        );
      }
      process.stdout.write('\n');
    }
  }

  process.stdout.write(formatHeader('Weakest concepts') + '\n\n');
  if (weak.length === 0) {
    process.stdout.write(
      dim('  No recall results recorded yet. Run `ico recall quiz` first.') + '\n',
    );
    process.stdout.write('\n');
    return;
  }
  for (const c of weak) {
    process.stdout.write(
      `  ${formatWarning('●')} ${c.concept.padEnd(40)} ${(c.retention * 100).toFixed(0).padStart(3)}%  ${dim(`(${c.correct}/${c.total})`)}\n`,
    );
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// recall export
// ---------------------------------------------------------------------------

/**
 * Export all recall cards (or a single topic's cards) as an Anki-importable
 * TSV. Currently `--format anki` is the only supported format; the option is
 * kept so future formats (CSV, JSON) can plug in without breaking the CLI.
 */
export function runRecallExport(
  opts: RecallExportOpts,
  globalOpts: GlobalOptions,
): { ok: true; value: ExportAnkiResult } | { ok: false; error: Error } {
  const format = opts.format ?? 'anki';
  if (format !== 'anki') {
    return {
      ok: false,
      error: new Error(`Unsupported format '${format}'. Only 'anki' is supported in v1.`),
    };
  }

  const wsResolveOpts =
    globalOpts.workspace !== undefined ? { workspace: globalOpts.workspace } : {};
  const wsResult = resolveWorkspace(wsResolveOpts);
  if (!wsResult.ok) return { ok: false, error: wsResult.error };
  const { root: wsPath } = wsResult.value;

  const result = exportRecallAnki(wsPath, {
    ...(opts.topic !== undefined && { topic: opts.topic }),
    ...(opts.out !== undefined && { outPath: opts.out }),
  });
  if (!result.ok) return { ok: false, error: result.error };

  // When --out is omitted and --json is not set, dump TSV to stdout so the
  // user can pipe it (e.g. `ico recall export > deck.txt`).
  if (globalOpts.json === true) {
    process.stdout.write(formatJSON(result.value) + '\n');
  } else if (opts.out === undefined) {
    process.stdout.write(result.value.tsv);
  } else {
    process.stdout.write('\n');
    process.stdout.write(formatSuccess('Anki deck exported') + '\n');
    process.stdout.write(formatInfo(`  Cards:  ${result.value.cards.length}`) + '\n');
    process.stdout.write(formatInfo(`  Out:    ${result.value.outPath}`) + '\n');
    process.stdout.write('\n');
  }
  return { ok: true, value: result.value };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

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

      const topic = opts.topic ?? '';
      const result = await runRecallGenerate(topic, opts, global);
      if (!result.ok) {
        process.stderr.write(formatError(result.error.message) + '\n');
        process.exit(1);
      }
    });

  recall
    .command('quiz')
    .description('Run a quiz session over a previously generated quiz file')
    .requiredOption('--topic <name>', 'Topic to quiz on (same name passed to `recall generate`)')
    .option('--mode <mode>', 'review | test (default: review)', 'review')
    .option('--model <model>', 'Claude model override for scoring')
    .option('--max-tokens <n>', 'Max tokens per scoring call', (v: string) => parseInt(v, 10))
    .option(
      '--answers-file <path>',
      'Read answers from a JSON file (array of strings or { "answers": [...] }) for non-interactive runs',
    )
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ ico recall quiz --topic "transformer attention"',
        '  $ ico recall quiz --topic attention --answers-file tests/answers.json',
      ].join('\n'),
    )
    .action(async (opts: RecallQuizOpts, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      const global: GlobalOptions = {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      };
      const result = await runRecallQuiz(opts, global);
      if (!result.ok) {
        process.stderr.write(formatError(result.error.message) + '\n');
        process.exit(1);
      }
    });

  recall
    .command('weak')
    .description('Show the lowest-retention concepts')
    .option('--limit <n>', 'Max number of weak concepts to show (default: 10)', (v: string) =>
      parseInt(v, 10),
    )
    .option(
      '--min-sample-size <n>',
      'Exclude concepts with fewer than n results (default: 1)',
      (v: string) => parseInt(v, 10),
    )
    .option('--report', 'Include the full retention report (overall + strongest + weakest)')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ ico recall weak',
        '  $ ico recall weak --limit 5 --report',
        '  $ ico recall weak --min-sample-size 3',
      ].join('\n'),
    )
    .action((opts: RecallWeakOpts, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      const global: GlobalOptions = {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      };
      const result = runRecallWeak(opts, global);
      if (!result.ok) {
        process.stderr.write(formatError(result.error.message) + '\n');
        process.exit(1);
      }
    });

  recall
    .command('export')
    .description(
      'Export recall cards (Anki TSV by default; writes to stdout when --out is omitted)',
    )
    .option('--format <format>', 'Output format (only "anki" supported)', 'anki')
    .option('--topic <name>', 'Export only cards for the given topic')
    .option('--out <path>', 'Workspace-relative output path; omit to write TSV to stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ ico recall export > deck.txt',
        '  $ ico recall export --topic "transformer attention" --out recall/exports/attn.txt',
      ].join('\n'),
    )
    .action((opts: RecallExportOpts, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      const global: GlobalOptions = {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      };
      const result = runRecallExport(opts, global);
      if (!result.ok) {
        process.stderr.write(formatError(result.error.message) + '\n');
        process.exit(1);
      }
    });
}
