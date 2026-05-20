/**
 * `ico render report|slides` — Generate reports and slide decks from compiled
 * knowledge or task outputs (E8-B03).
 *
 * Subcommands:
 *   ico render report --topic <name>   Render a structured markdown report from a compiled topic
 *   ico render report --task <id>      (stub — requires Epic 9)
 *   ico render slides --topic <name>   Render a Marp slide deck from a compiled topic
 *   ico render slides --task <id>      (stub — requires Epic 9)
 *
 * Pipeline for --topic:
 *   1. Resolve workspace and open DB.
 *   2. Load config (apiKey, model).
 *   3. Find compiled pages matching the topic name in wiki subdirectories.
 *   4. Read full content of each matching page.
 *   5. Call renderReport() or renderSlides() from @ico/compiler.
 *   6. Show success message with output path, token usage, and cost.
 *   7. Write a trace event to the audit trail.
 *   8. Close DB.
 *
 * @module commands/render
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Command } from 'commander';

import {
  calculateCost,
  createClaudeClient,
  renderReport,
  renderSlides,
  type ReportSource,
  type SlideSource,
} from '@ico/compiler';
import { closeDatabase, initDatabase, loadConfig, writeTrace } from '@ico/kernel';

import {
  bold,
  dim,
  formatError,
  formatHeader,
  formatInfo,
  formatKeyValue,
  formatSuccess,
} from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wiki subdirectories searched when resolving topic names to page files. */
const WIKI_SUBDIRS = ['topics', 'concepts', 'entities', 'sources'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RenderOptions {
  topic?: string;
  task?: string;
  title?: string;
  output?: string;
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
// Topic discovery
// ---------------------------------------------------------------------------

/**
 * Extract the `title` field from a YAML frontmatter block using a simple
 * regex. Returns `undefined` when no title can be found.
 *
 * Supports both quoted and unquoted title values:
 *   title: "My Topic"
 *   title: My Topic
 */
function extractFrontmatterTitle(content: string): string | undefined {
  const match = content.match(/^---[\s\S]*?\ntitle:\s*["']?([^"'\n]+?)["']?\s*\n/m);
  if (match !== null && match[1] !== undefined && match[1].trim() !== '') {
    return match[1].trim();
  }
  return undefined;
}

/**
 * Slugify a string for filesystem comparison.
 *
 * Lowercase, spaces/underscores to hyphens, strip non-alnum/hyphen chars,
 * collapse consecutive hyphens, trim leading/trailing hyphens.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Find compiled wiki pages that match a given topic name.
 *
 * Matching strategy (first match wins per file):
 *   1. Exact filename slug match: `<slug>.md` where slug is derived from name.
 *   2. Fuzzy frontmatter title match: title contains the search term (case-insensitive).
 *
 * @param wikiPath  - Absolute path to `workspace/wiki/`.
 * @param topicName - User-supplied topic name to search for.
 * @returns Array of absolute paths to matching page files.
 */
export function findTopicPages(wikiPath: string, topicName: string): string[] {
  const topicSlug = slugify(topicName);
  const searchTerm = topicName.toLowerCase();
  const matched: string[] = [];
  const seen = new Set<string>();

  for (const subdir of WIKI_SUBDIRS) {
    const dirPath = join(wikiPath, subdir);
    if (!existsSync(dirPath)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.md') || entry === '.gitkeep') continue;

      const absPath = join(dirPath, entry);
      if (seen.has(absPath)) continue;

      // Strategy 1: slug-based filename match.
      const fileSlug = basename(entry, '.md');
      if (fileSlug === topicSlug) {
        matched.push(absPath);
        seen.add(absPath);
        continue;
      }

      // Strategy 2: fuzzy frontmatter title match.
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const title = extractFrontmatterTitle(content);
      if (title !== undefined && title.toLowerCase().includes(searchTerm)) {
        matched.push(absPath);
        seen.add(absPath);
      }
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Core render logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Run the render pipeline for a single subcommand type.
 *
 * @param type       - 'report' or 'slides'.
 * @param opts       - Command-level options.
 * @param globalOpts - Global CLI flags.
 */
export async function runRender(
  type: 'report' | 'slides',
  opts: RenderOptions,
  globalOpts: GlobalOptions,
): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. --task is not yet implemented
  // -------------------------------------------------------------------------
  if (opts.task !== undefined) {
    process.stdout.write(
      formatInfo('Task-based rendering will be available after Epic 9 (Multi-Agent Research).') +
        '\n',
    );
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------------------------------
  // 2. --topic is required
  // -------------------------------------------------------------------------
  if (opts.topic === undefined || opts.topic.trim() === '') {
    process.stderr.write(
      formatError('Either --topic or --task is required for ico render.') + '\n',
    );
    process.exitCode = 1;
    return;
  }

  const topicName = opts.topic.trim();

  // -------------------------------------------------------------------------
  // 3. Resolve workspace
  // -------------------------------------------------------------------------
  const wsOverride = opts.workspace ?? globalOpts.workspace;
  const wsResult = resolveWorkspace(wsOverride !== undefined ? { workspace: wsOverride } : {});

  if (!wsResult.ok) {
    process.stderr.write(formatError(wsResult.error.message) + '\n');
    process.exitCode = 1;
    return;
  }

  const { root: wsPath, dbPath } = wsResult.value;

  // -------------------------------------------------------------------------
  // 4. Load config
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

  const model = opts.model ?? config.model;

  // -------------------------------------------------------------------------
  // 5. Open database
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
    // 6. Discover matching pages
    // -----------------------------------------------------------------------
    const wikiPath = join(wsPath, 'wiki');
    const matchedPaths = findTopicPages(wikiPath, topicName);

    if (matchedPaths.length === 0) {
      process.stderr.write(formatError(`No compiled pages found for topic: "${topicName}"`) + '\n');
      process.stderr.write(
        dim(`  Tip: Run \`ico compile all\` to compile sources, or check \`ico status\`.\n`),
      );
      process.exitCode = 1;
      return;
    }

    if (globalOpts.verbose === true) {
      process.stdout.write(
        formatInfo(`Found ${matchedPaths.length} page(s) for topic "${topicName}"`) + '\n',
      );
    }

    // -----------------------------------------------------------------------
    // 7. Read page content
    // -----------------------------------------------------------------------
    const sources: Array<ReportSource & SlideSource> = [];

    for (const absPath of matchedPaths) {
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch (e) {
        process.stderr.write(
          formatError(
            `Failed to read page "${absPath}": ${e instanceof Error ? e.message : String(e)}`,
          ) + '\n',
        );
        continue;
      }

      const title = extractFrontmatterTitle(content) ?? basename(absPath, '.md');
      // Store path relative to workspace root
      const relPath = absPath.startsWith(wsPath)
        ? absPath.slice(wsPath.length).replace(/^[/\\]/, '')
        : absPath;

      sources.push({ title, content, path: relPath });
    }

    if (sources.length === 0) {
      process.stderr.write(formatError('Could not read any matching page files.') + '\n');
      process.exitCode = 1;
      return;
    }

    // -----------------------------------------------------------------------
    // 8. Create Claude client and call render function
    // -----------------------------------------------------------------------
    const client = createClaudeClient(config.apiKey);

    process.stdout.write(dim(`Rendering ${type}...`) + '\n');

    const startTime = Date.now();
    let outputPath: string;
    let inputTokens: number;
    let outputTokens: number;
    let resultModel: string;
    let title: string;

    if (type === 'report') {
      const result = await renderReport(wsPath, sources, {
        client,
        model,
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        ...(opts.title !== undefined && { title: opts.title }),
        ...(opts.output !== undefined && { outputPath: opts.output }),
      });

      if (!result.ok) {
        process.stderr.write(formatError(`Render failed: ${result.error.message}`) + '\n');
        process.exitCode = 1;
        return;
      }

      outputPath = result.value.outputPath;
      inputTokens = result.value.inputTokens;
      outputTokens = result.value.outputTokens;
      resultModel = result.value.model;
      title = result.value.title;
    } else {
      const result = await renderSlides(wsPath, sources, {
        client,
        model,
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        ...(opts.title !== undefined && { title: opts.title }),
        ...(opts.output !== undefined && { outputPath: opts.output }),
      });

      if (!result.ok) {
        process.stderr.write(formatError(`Render failed: ${result.error.message}`) + '\n');
        process.exitCode = 1;
        return;
      }

      outputPath = result.value.outputPath;
      inputTokens = result.value.inputTokens;
      outputTokens = result.value.outputTokens;
      resultModel = result.value.model;
      title = result.value.title;
    }

    const latencyMs = Date.now() - startTime;

    // -----------------------------------------------------------------------
    // 9. Write trace event
    // -----------------------------------------------------------------------
    writeTrace(db, wsPath, 'render', {
      renderType: type,
      topic: topicName,
      title,
      outputPath,
      sourceCount: sources.length,
      inputTokens,
      outputTokens,
      tokensUsed: inputTokens + outputTokens,
      model: resultModel,
      latencyMs,
    });

    // -----------------------------------------------------------------------
    // 10. Display success
    // -----------------------------------------------------------------------
    const totalTokens = inputTokens + outputTokens;
    const cost = calculateCost(inputTokens, outputTokens, resultModel);

    process.stdout.write('\n');
    process.stdout.write(
      formatHeader(`${type === 'report' ? 'Report' : 'Slide Deck'} Generated`) + '\n\n',
    );
    process.stdout.write(formatSuccess(`Saved: ${bold(outputPath)}`) + '\n');
    process.stdout.write('\n');
    process.stdout.write(
      formatKeyValue([
        ['Title', title],
        ['Sources', String(sources.length)],
        ['Model', resultModel],
        ['Tokens', `${totalTokens.toLocaleString()} (~$${cost.toFixed(4)})`],
      ]) + '\n',
    );
    process.stdout.write('\n');
    process.stdout.write(
      dim(
        `Tip: Run \`ico promote ${outputPath} --as topic\` to file this into the knowledge base.`,
      ) + '\n',
    );
    process.stdout.write('\n');
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `ico render` and its `report` / `slides` subcommands on the root
 * Commander program.
 *
 * @param program - The root Commander `Command` instance.
 */
export function register(program: Command): void {
  const render = program
    .command('render')
    .description('Generate reports and slide decks from compiled knowledge');

  // ── report ──────────────────────────────────────────────────────────────────
  render
    .command('report')
    .description('Render a structured markdown report')
    .option('--topic <name>', 'Topic to render from compiled wiki pages')
    .option('--task <id>', 'Task to render from (available after Epic 9)')
    .option('--title <title>', 'Override the generated title')
    .option('--output <path>', 'Override the output file path')
    .option('--model <model>', 'Claude model to use')
    .option('--max-tokens <n>', 'Maximum tokens in the response', (v: string) => parseInt(v, 10))
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ ico render report --topic "transformer architecture"',
        '  $ ico render report --topic "self-attention" --title "Attention Report"',
        '  $ ico render report --topic "neural networks" --output reports/neural.md',
      ].join('\n'),
    )
    .action(async (opts: RenderOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      await runRender('report', opts, {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      });
    });

  // ── slides ───────────────────────────────────────────────────────────────────
  render
    .command('slides')
    .description('Render a Marp-compatible slide deck')
    .option('--topic <name>', 'Topic to render from compiled wiki pages')
    .option('--task <id>', 'Task to render from (available after Epic 9)')
    .option('--title <title>', 'Override the slide deck title')
    .option('--output <path>', 'Override the output file path')
    .option('--model <model>', 'Claude model to use')
    .option('--max-tokens <n>', 'Maximum tokens in the response', (v: string) => parseInt(v, 10))
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ ico render slides --topic "transformer architecture"',
        '  $ ico render slides --topic "self-attention" --title "Attention Deck"',
      ].join('\n'),
    )
    .action(async (opts: RenderOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      await runRender('slides', opts, {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      });
    });
}
