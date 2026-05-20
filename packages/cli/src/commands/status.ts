/**
 * `ico status` — display workspace summary: sources by type, mounts, tasks
 * by status, and the most recent trace event.
 *
 * Supports `--json` for machine-readable output.
 */

import { resolve } from 'node:path';

import type { Command } from 'commander';

import { getTokenUsageSummary, type TokenUsageSummary } from '@ico/compiler';
import {
  closeDatabase,
  initDatabase,
  listMounts,
  listSources,
  listTasks,
  readTraces,
} from '@ico/kernel';
import type { Source } from '@ico/types';

import { dim, formatHeader, formatJSON, formatTable } from '../lib/output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source types tracked by the kernel. */
const SOURCE_TYPES = ['pdf', 'markdown', 'html', 'text'] as const;

interface SourceCounts {
  total: number;
  pdf: number;
  markdown: number;
  html: number;
  text: number;
}

/** Task statuses defined by the kernel state machine. */
const TASK_STATUSES = [
  'created',
  'collecting',
  'synthesizing',
  'critiquing',
  'rendering',
  'completed',
  'archived',
] as const;
type TaskStatusKey = (typeof TASK_STATUSES)[number];

type TaskCounts = Record<TaskStatusKey, number>;

interface LastOperation {
  timestamp: string;
  type: string;
}

export interface StatusData {
  sources: SourceCounts;
  mounts: number;
  tasks: TaskCounts;
  lastOperation: LastOperation | null;
  compilationTokens: TokenUsageSummary | null;
}

// ---------------------------------------------------------------------------
// Workspace helper
// ---------------------------------------------------------------------------

/**
 * Resolves the path to `state.db` relative to the workspace option.
 * Mirrors the pattern used across other commands in this package.
 */
export function resolveWorkspaceDb(globalOpts: { workspace?: string }): string {
  const wsPath = globalOpts.workspace ?? '.';
  return resolve(wsPath, '.ico', 'state.db');
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

/** Groups a flat source array into counts by type. */
export function countSources(sources: Source[]): SourceCounts {
  const counts: SourceCounts = {
    total: sources.length,
    pdf: 0,
    markdown: 0,
    html: 0,
    text: 0,
  };
  for (const src of sources) {
    const t = src.type;
    if (t === 'pdf') counts.pdf++;
    else if (t === 'markdown') counts.markdown++;
    else if (t === 'html') counts.html++;
    else if (t === 'text') counts.text++;
  }
  return counts;
}

/** Builds a zero-initialised task-count record then tallies each task row. */
export function countTasks(tasks: Array<{ status: string }>): TaskCounts {
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as TaskCounts;
  for (const task of tasks) {
    const s = task.status as TaskStatusKey;
    if (s in counts) {
      counts[s]++;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Pads a label + colon to a fixed width for aligned key/value output. */
function kv(label: string, value: string | number, indent = ''): string {
  const colonLabel = `${label}:`;
  // Align values at column 16 from the start of the non-indented text.
  const padding = ' '.repeat(Math.max(1, 16 - colonLabel.length));
  return `${indent}${colonLabel}${padding}${value}`;
}

export function renderStatusNormal(data: StatusData): string {
  const lines: string[] = [];

  lines.push(formatHeader('Workspace Status'));
  lines.push('');

  // Sources block
  lines.push(kv('Sources', data.sources.total));
  for (const t of SOURCE_TYPES) {
    lines.push(kv(t, data.sources[t], '  '));
  }
  lines.push('');
  lines.push(kv('Mounts', data.mounts));
  lines.push(kv('Compiled', dim('0 (not yet implemented)')));
  lines.push('');

  // Tasks block
  lines.push(formatHeader('Tasks'));
  lines.push('');
  for (const s of TASK_STATUSES) {
    lines.push(kv(s, data.tasks[s], '  '));
  }
  lines.push('');

  // Compilation token block — only shown when compilations exist
  if (data.compilationTokens !== null && data.compilationTokens.compilationCount > 0) {
    const ct = data.compilationTokens;
    lines.push('');
    lines.push(formatHeader('Compilation'));
    lines.push('');
    lines.push(kv('Total tokens', ct.totalTokens.toLocaleString(), '  '));
    lines.push(kv('Est. cost', `$${ct.estimatedCost.toFixed(2)}`, '  '));
    lines.push(kv('Compilations', ct.compilationCount, '  '));
    lines.push('');
  }

  // Last operation
  if (data.lastOperation !== null) {
    const op = data.lastOperation;
    lines.push(kv('Last Operation', `${op.timestamp} ${dim('—')} ${op.type}`));
  } else {
    lines.push(kv('Last Operation', dim('none')));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------

/**
 * Queries all status-related tables and returns a `StatusData` snapshot.
 * Throws on any kernel error. Exported for use in tests.
 */
export function collectStatusData(db: import('@ico/kernel').Database): StatusData {
  const sourcesResult = listSources(db);
  if (!sourcesResult.ok) {
    throw new Error(`Failed to read sources: ${sourcesResult.error.message}`);
  }

  const mountsResult = listMounts(db);
  if (!mountsResult.ok) {
    throw new Error(`Failed to read mounts: ${mountsResult.error.message}`);
  }

  const tasksResult = listTasks(db);
  if (!tasksResult.ok) {
    throw new Error(`Failed to read tasks: ${tasksResult.error.message}`);
  }

  // readTraces returns rows in ASC timestamp order; the last element is newest.
  const tracesResult = readTraces(db);
  let lastOperation: LastOperation | null = null;
  if (tracesResult.ok && tracesResult.value.length > 0) {
    const t = tracesResult.value[tracesResult.value.length - 1]!;
    lastOperation = { timestamp: t.timestamp, type: t.event_type };
  }

  const tokenResult = getTokenUsageSummary(db);
  const compilationTokens = tokenResult.ok ? tokenResult.value : null;

  return {
    sources: countSources(sourcesResult.value),
    mounts: mountsResult.value.length,
    tasks: countTasks(tasksResult.value),
    lastOperation,
    compilationTokens,
  };
}

// ---------------------------------------------------------------------------
// Sources table rendering
// ---------------------------------------------------------------------------

/**
 * Render a detailed table of all ingested sources.
 *
 * @param sources - Array of {@link Source} rows from the kernel.
 * @returns A formatted string ready to print.
 */
export function renderSourcesTable(sources: Source[]): string {
  const lines: string[] = [];
  lines.push(formatHeader('Sources'));
  lines.push('');

  if (sources.length === 0) {
    lines.push('  No sources ingested yet.');
    return lines.join('\n');
  }

  const rows = sources.map((s) => [
    s.type,
    s.title ?? '(untitled)',
    s.hash.slice(0, 8),
    s.ingested_at.slice(0, 10),
  ]);

  // Indent each line of the table by two spaces for visual alignment.
  const table = formatTable(['Type', 'Title', 'Hash (short)', 'Ingested'], rows);
  for (const line of table.split('\n')) {
    lines.push(`  ${line}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('status')
    .description('Show workspace status')
    .option('--sources', 'Show detailed sources table')
    .addHelpText(
      'after',
      '\nExamples:\n  $ ico status\n  $ ico status --json\n  $ ico status --sources',
    )
    .action((opts: { sources?: boolean }) => {
      const globalOpts = program.opts<{ workspace?: string; json?: boolean }>();
      const dbPath = resolveWorkspaceDb(globalOpts);

      const dbResult = initDatabase(dbPath);
      if (!dbResult.ok) {
        throw new Error(`Failed to open database: ${dbResult.error.message}`);
      }
      const db = dbResult.value;

      try {
        if (opts.sources === true) {
          const sourcesResult = listSources(db);
          if (!sourcesResult.ok) {
            throw new Error(`Failed to read sources: ${sourcesResult.error.message}`);
          }
          if (globalOpts.json === true) {
            console.log(formatJSON(sourcesResult.value));
          } else {
            console.log(renderSourcesTable(sourcesResult.value));
          }
          return;
        }

        const data = collectStatusData(db);

        if (globalOpts.json === true) {
          console.log(formatJSON(data));
        } else {
          console.log(renderStatusNormal(data));
        }
      } finally {
        closeDatabase(db);
      }
    });
}
