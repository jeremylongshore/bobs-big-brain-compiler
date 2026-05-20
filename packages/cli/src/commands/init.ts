/**
 * `ico init <name>` — Initialize a new ICO workspace.
 *
 * Creates the full workspace directory tree, opens the SQLite state
 * database (running all pending migrations), appends an audit log entry,
 * and reports the result to the user.
 *
 * @module commands/init
 */

import { resolve } from 'node:path';

import type { Command } from 'commander';

import {
  appendAuditLog,
  closeDatabase,
  initDatabase,
  initWorkspace,
  type WorkspaceInfo,
} from '@ico/kernel';

import { formatError, formatInfo, formatJSON, formatSuccess } from '../lib/output.js';

// ---------------------------------------------------------------------------
// Core logic (extracted so tests can call it without spawning a process)
// ---------------------------------------------------------------------------

export interface InitOptions {
  path: string;
}

export interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  workspace?: string;
}

export interface InitResult {
  name: string;
  root: string;
  dbPath: string;
  createdAt: string;
}

/**
 * Run the full workspace initialization sequence.
 *
 * @param name    - Workspace name (becomes the root directory name).
 * @param opts    - Command-specific options (parent path, etc.).
 * @param global  - Global CLI options (json, verbose, workspace).
 * @returns       `{ ok: true, value: InitResult }` on success, or
 *                `{ ok: false, error: Error }` on failure.
 */
export function runInit(
  name: string,
  opts: InitOptions,
  global: GlobalOptions,
): { ok: true; value: InitResult } | { ok: false; error: Error } {
  // 1. Initialize workspace directory tree
  const wsResult = initWorkspace(name, opts.path);
  if (!wsResult.ok) {
    return { ok: false, error: wsResult.error };
  }

  const wsInfo: WorkspaceInfo = wsResult.value;

  // 2. Initialize database (runs migrations, idempotent)
  const dbResult = initDatabase(wsInfo.dbPath);
  if (!dbResult.ok) {
    return { ok: false, error: dbResult.error };
  }

  // 3. Close database — we only needed it to apply migrations
  closeDatabase(dbResult.value);

  // 4. Append audit log entry (best-effort; non-fatal if it fails)
  appendAuditLog(wsInfo.root, 'workspace.init', `Workspace "${name}" initialized via ico init`);

  // 5. Emit output
  const result: InitResult = {
    name: wsInfo.name,
    root: wsInfo.root,
    dbPath: wsInfo.dbPath,
    createdAt: wsInfo.createdAt,
  };

  if (global.json === true) {
    process.stdout.write(formatJSON(result) + '\n');
  } else {
    printHumanOutput(result);
  }

  return { ok: true, value: result };
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function printHumanOutput(result: InitResult): void {
  const { name, root, dbPath } = result;

  process.stdout.write('\n');
  process.stdout.write(formatSuccess(`Workspace "${name}" initialized`) + '\n');
  process.stdout.write('\n');
  process.stdout.write(formatInfo(`Location:  ${root}`) + '\n');
  process.stdout.write(formatInfo(`Database:  ${dbPath}`) + '\n');
  process.stdout.write('\n');
  process.stdout.write('  Next steps:\n');
  process.stdout.write(`    ico mount add research-papers /path/to/papers\n`);
  process.stdout.write(`    ico ingest /path/to/file.pdf\n`);
  process.stdout.write(`    ico status\n`);
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `ico init <name>` on the root Commander program.
 *
 * @param program - The root Commander `Command` instance.
 */
export function register(program: Command): void {
  program
    .command('init <name>')
    .description('Initialize a new ICO workspace')
    .option('-p, --path <dir>', 'Parent directory for the workspace', '.')
    .addHelpText(
      'after',
      '\nExamples:\n  $ ico init my-research\n  $ ico init project-kb --path ~/workspaces',
    )
    .action((name: string, opts: InitOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions & InitOptions>();

      // Resolve the parent path against cwd so relative paths work correctly
      const resolvedPath = resolve(process.cwd(), opts.path);
      const initOpts: InitOptions = { path: resolvedPath };
      const global: GlobalOptions = {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      };

      const result = runInit(name, initOpts, global);
      if (!result.ok) {
        process.stderr.write(formatError(result.error.message) + '\n');
        process.exit(1);
      }
    });
}
