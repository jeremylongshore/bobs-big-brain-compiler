/**
 * `ico ask "<question>"` — Answer a question from compiled knowledge (E7-B05).
 *
 * Full pipeline:
 *   1. Resolve workspace and open the SQLite database.
 *   2. Ensure the FTS5 index is up-to-date (`createSearchIndex` + `indexCompiledPages`).
 *   3. Analyse the question (classify type, retrieve relevant pages).
 *   4. No-knowledge fallback when the index has no relevant results (E7-B09).
 *   5. Read full content of the relevant compiled pages.
 *   6. Generate an answer via the Claude API.
 *   7. Verify citations against the wiki directory.
 *   8. Display the answer, citations, and provenance chain.
 *   9. Write a trace event to the audit trail (E7-B07).
 *  10. Show token usage summary.
 *  11. Suggest `ico research` when the question is too complex.
 *
 * @module commands/ask
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import {
  analyzeQuestion,
  calculateCost,
  createClaudeClient,
  generateAnswer,
  verifyCitations,
} from '@ico/compiler';
import {
  closeDatabase,
  createSearchIndex,
  findRelevantPages,
  indexCompiledPages,
  initDatabase,
  loadConfig,
  writeTrace,
} from '@ico/kernel';

import {
  bold,
  dim,
  formatError,
  formatHeader,
  formatInfo,
  formatSuccess,
  formatWarning,
} from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AskOptions {
  model?: string;
  maxTokens?: number;
  workspace?: string;
}

interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  workspace?: string;
}

// ---------------------------------------------------------------------------
// No-knowledge fallback (E7-B09)
// ---------------------------------------------------------------------------

/**
 * Emit a helpful message when no compiled knowledge exists for the question.
 *
 * @param question      - The user's original question.
 * @param workspacePath - Absolute workspace root (used for raw directory hint).
 */
function printNoKnowledgeFallback(question: string, workspacePath: string, asJson = false): void {
  // JSON mode — emit a single record consistent with the happy-path shape so
  // parsers like the ico-your-internals dog-food orchestrator can handle both
  // outcomes uniformly. Use empty answer + zero counts + a `no_knowledge: true`
  // sentinel so verify pipelines can distinguish "ICO didn't engage" from
  // "ICO engaged but gave a bad answer".
  if (asJson) {
    const rawPath = join(workspacePath, 'raw');
    process.stdout.write(
      JSON.stringify({
        question,
        answer: '',
        citations: [],
        question_type: null,
        retrieved_pages: [],
        tokens_in: 0,
        tokens_out: 0,
        tokens_total: 0,
        cost_usd: 0,
        model: null,
        latency_ms: 0,
        verified_citations: 0,
        unverified_citations: 0,
        provenance_chain: [],
        suggest_research: false,
        no_knowledge: true,
        has_uncompiled_sources: existsSync(rawPath),
      }) + '\n',
    );
    return;
  }

  process.stdout.write('\n');
  process.stdout.write(formatWarning(`No compiled knowledge found for: "${question}"`) + '\n');
  process.stdout.write('\n');
  process.stdout.write('Suggestions:\n');
  process.stdout.write(`  ${dim('•')} Ingest sources on this topic:  ico ingest <path>\n`);
  process.stdout.write(`  ${dim('•')} Compile ingested sources:       ico compile all\n`);
  process.stdout.write(`  ${dim('•')} Check what is available:        ico status --sources\n`);
  process.stdout.write('\n');

  // Hint about uncompiled sources when the raw directory exists.
  const rawPath = join(workspacePath, 'raw');
  if (existsSync(rawPath)) {
    process.stdout.write(
      dim('Tip: You may have uncompiled sources. Run `ico compile all` to compile them.\n'),
    );
    process.stdout.write('\n');
  }
}

// ---------------------------------------------------------------------------
// Core ask logic (exported for testing without Commander)
// ---------------------------------------------------------------------------

/**
 * Run the full ask pipeline for `question`.
 *
 * @param question   - The user's question string.
 * @param askOptions - Command-level options (model, maxTokens, workspace).
 * @param globalOpts - Global CLI flags (json, verbose, workspace).
 */
export async function runAsk(
  question: string,
  askOptions: AskOptions,
  globalOpts: GlobalOptions,
): Promise<void> {
  const startTime = Date.now();

  // -------------------------------------------------------------------------
  // 1. Resolve workspace
  // -------------------------------------------------------------------------
  const wsOverride = askOptions.workspace ?? globalOpts.workspace;
  const wsResult = resolveWorkspace(wsOverride !== undefined ? { workspace: wsOverride } : {});

  if (!wsResult.ok) {
    process.stderr.write(formatError(wsResult.error.message) + '\n');
    process.exitCode = 1;
    return;
  }

  const { root: wsPath, dbPath } = wsResult.value;

  // -------------------------------------------------------------------------
  // 2. Load config and create Claude client
  // -------------------------------------------------------------------------
  let config: { apiKey: string; model: string };

  try {
    config = loadConfig(wsPath);
  } catch (e) {
    process.stderr.write(
      formatError(`Config error: ${e instanceof Error ? e.message : String(e)}`) + '\n',
    );
    process.exitCode = 1;
    return;
  }

  const model = askOptions.model ?? config.model;
  const client = createClaudeClient(config.apiKey);

  // -------------------------------------------------------------------------
  // 3. Open database
  // -------------------------------------------------------------------------
  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) {
    process.stderr.write(formatError(`Database error: ${dbResult.error.message}`) + '\n');
    process.exitCode = 1;
    return;
  }

  const db = dbResult.value;

  try {
    // -----------------------------------------------------------------------
    // 4. Ensure FTS5 index is initialised and populated
    // -----------------------------------------------------------------------
    const indexCreateResult = createSearchIndex(db);
    if (!indexCreateResult.ok) {
      process.stderr.write(
        formatError(`Failed to create search index: ${indexCreateResult.error.message}`) + '\n',
      );
      process.exitCode = 1;
      return;
    }

    const indexResult = indexCompiledPages(db, wsPath);
    if (!indexResult.ok) {
      process.stderr.write(
        formatError(`Failed to index pages: ${indexResult.error.message}`) + '\n',
      );
      process.exitCode = 1;
      return;
    }

    if (globalOpts.verbose === true) {
      process.stdout.write(formatInfo(`Indexed ${indexResult.value} compiled pages`) + '\n');
    }

    // -----------------------------------------------------------------------
    // 5. Analyse the question (E7-B02)
    // -----------------------------------------------------------------------
    const analysisResult = analyzeQuestion(db, wsPath, question);
    if (!analysisResult.ok) {
      process.stderr.write(formatError(`Analysis failed: ${analysisResult.error.message}`) + '\n');
      process.exitCode = 1;
      return;
    }

    const analysis = analysisResult.value;

    // -----------------------------------------------------------------------
    // 6. No-knowledge fallback (E7-B09)
    // -----------------------------------------------------------------------
    if (analysis.relevantPages.length === 0) {
      printNoKnowledgeFallback(question, wsPath, globalOpts.json === true);
      return;
    }

    // -----------------------------------------------------------------------
    // 7. Retrieve top relevant pages with question-type boosting (E7-B08)
    // -----------------------------------------------------------------------
    const boostResult = findRelevantPages(db, question, analysis.type, 5);
    const topPages =
      boostResult.ok && boostResult.value.length > 0
        ? boostResult.value
        : analysis.relevantPages.slice(0, 5);

    // Read full content of each selected page.
    const pagesWithContent: Array<{ path: string; title: string; content: string }> = [];

    for (const page of topPages) {
      const absPath = join(wsPath, 'wiki', page.path);
      if (!existsSync(absPath)) continue;

      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      pagesWithContent.push({ path: page.path, title: page.title, content });
    }

    if (pagesWithContent.length === 0) {
      printNoKnowledgeFallback(question, wsPath, globalOpts.json === true);
      return;
    }

    // -----------------------------------------------------------------------
    // 8. Generate answer via Claude (E7-B03)
    // -----------------------------------------------------------------------
    // Progress indicator on stderr so --json output stays a single line on
    // stdout for parsers like the ico-your-internals dog-food orchestrator.
    if (globalOpts.json !== true) {
      process.stdout.write(dim('Generating answer...') + '\n');
    }

    const generateResult = await generateAnswer(client, question, pagesWithContent, {
      model,
      ...(askOptions.maxTokens !== undefined && { maxTokens: askOptions.maxTokens }),
    });

    if (!generateResult.ok) {
      process.stderr.write(
        formatError(`Generation failed: ${generateResult.error.message}`) + '\n',
      );
      process.exitCode = 1;
      return;
    }

    const { answer, citations, inputTokens, outputTokens } = generateResult.value;

    // -----------------------------------------------------------------------
    // 9. Verify citations (E7-B04)
    // -----------------------------------------------------------------------
    const verifyResult = verifyCitations(wsPath, citations);
    if (!verifyResult.ok) {
      process.stderr.write(
        formatError(`Verification failed: ${verifyResult.error.message}`) + '\n',
      );
      process.exitCode = 1;
      return;
    }

    const { verified, unverified, provenanceChain } = verifyResult.value;

    // -----------------------------------------------------------------------
    // 10. Write trace event (E7-B07)
    // -----------------------------------------------------------------------
    const latencyMs = Date.now() - startTime;

    writeTrace(db, wsPath, 'ask', {
      question,
      questionType: analysis.type,
      retrievedPages: topPages.map((p) => p.path),
      answerLength: answer.length,
      citationCount: citations.length,
      tokensUsed: inputTokens + outputTokens,
      latencyMs,
      verifiedCitations: verified.length,
      unverifiedCitations: unverified.length,
    });

    // -----------------------------------------------------------------------
    // 11. Display output
    // -----------------------------------------------------------------------

    // JSON mode (global --json flag) — emit a single structured record on
    // stdout and skip the pretty-printed surface. Consumers like the
    // ico-your-internals dog-food skill parse this record verbatim; do not
    // print anything else to stdout when --json is on.
    if (globalOpts.json) {
      const totalTokens = inputTokens + outputTokens;
      const cost = calculateCost(inputTokens, outputTokens, model);
      const verifiedSet = new Set(verified.map((c) => c.pagePath));
      const payload = {
        question,
        answer,
        citations: citations.map((c) => ({
          source: `wiki/${c.pagePath}`,
          title: c.pageTitle,
          verified: verifiedSet.has(c.pagePath),
        })),
        question_type: analysis.type,
        retrieved_pages: topPages.map((p) => p.path),
        tokens_in: inputTokens,
        tokens_out: outputTokens,
        tokens_total: totalTokens,
        cost_usd: Number(cost.toFixed(4)),
        model,
        latency_ms: latencyMs,
        verified_citations: verified.length,
        unverified_citations: unverified.length,
        provenance_chain: provenanceChain.map((e) => ({
          level: e.level,
          path: 'path' in e ? e.path : null,
        })),
        suggest_research: analysis.suggestResearch,
      };
      process.stdout.write(JSON.stringify(payload) + '\n');
      return;
    }

    process.stdout.write('\n');

    // Answer section
    process.stdout.write(formatHeader('Answer') + '\n\n');
    const displayAnswer = answer
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    process.stdout.write(displayAnswer + '\n');

    // Citations section
    if (citations.length > 0) {
      process.stdout.write('\n');
      process.stdout.write(formatHeader('Citations') + '\n\n');

      for (const citation of verified) {
        process.stdout.write(
          `  ${formatSuccess(citation.pageTitle)}  ${dim(`(wiki/${citation.pagePath})`)}` + '\n',
        );
      }

      for (const citation of unverified) {
        process.stdout.write(
          `  ${formatWarning(citation.pageTitle)}  ${dim('(unverified — could not locate page)')}` +
            '\n',
        );
      }
    }

    // Provenance section
    if (provenanceChain.length > 1) {
      process.stdout.write('\n');
      process.stdout.write(formatHeader('Provenance') + '\n\n');

      const chain = provenanceChain
        .map((e) => {
          if (e.level === 'answer') return dim('answer');
          if (e.level === 'raw-source') return dim(e.path);
          return dim(`wiki/${e.path}`);
        })
        .join(' → ');

      process.stdout.write(`  ${chain}\n`);
    }

    // Token usage
    process.stdout.write('\n');
    const totalTokens = inputTokens + outputTokens;
    const cost = calculateCost(inputTokens, outputTokens, model);
    process.stdout.write(
      dim(`Used ${totalTokens.toLocaleString()} tokens (~$${cost.toFixed(2)})`) + '\n',
    );

    // Suggest research if the question is complex
    if (analysis.suggestResearch) {
      process.stdout.write('\n');
      process.stdout.write(
        formatInfo(
          `This question appears complex. For deeper analysis consider: ${bold('ico research')} "${question}"`,
        ) + '\n',
      );
    }

    process.stdout.write('\n');
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `ico ask <question>` on the root Commander program.
 *
 * @param program - The root Commander `Command` instance.
 */
export function register(program: Command): void {
  program
    .command('ask <question>')
    .description('Answer a question from compiled knowledge')
    .option('--model <model>', 'Claude model to use for answer generation')
    .option('--max-tokens <n>', 'Maximum tokens in the response', (v: string) => parseInt(v, 10))
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ ico ask "What is self-attention?"',
        '  $ ico ask "Compare BERT and GPT architectures"',
        '  $ ico ask "Why does gradient descent converge?"',
      ].join('\n'),
    )
    .action(async (question: string, opts: AskOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();

      const askOptions: AskOptions = {
        ...(opts.model !== undefined && { model: opts.model }),
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
      };

      const global: GlobalOptions = {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      };

      await runAsk(question, askOptions, global);
    });
}
