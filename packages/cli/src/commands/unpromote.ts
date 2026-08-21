/**
 * `ico unpromote <path>` — Reverse a promotion, removing a page from the wiki.
 *
 * Looks up the promotions record for the given workspace-relative path,
 * deletes the file, removes the DB record, writes a trace event and audit
 * log entry, then rebuilds the wiki index.
 *
 * Supports `--dry-run` to preview without making changes, and `--yes` to
 * skip the confirmation prompt.
 *
 * @module commands/unpromote
 */

import { resolve } from 'node:path';

import type { Command } from 'commander';

import { closeDatabase, initDatabase, unpromoteArtifact } from '@ico/kernel';

import {
  formatError,
  formatInfo,
  formatJSON,
  formatSuccess,
  formatWarning,
} from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';
import {
  isBrainWriteLockBusyError,
  warnIfWriteLockDegraded,
  withBrainWriteLock,
} from '../lib/write-lock.js';

// ---------------------------------------------------------------------------
// Core logic (extracted so tests can call it without spawning a process)
// ---------------------------------------------------------------------------

export interface UnpromoteCommandOptions {
  dryRun?: boolean;
  yes?: boolean;
}

export interface UnpromoteCommandGlobal {
  workspace?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface UnpromoteCommandResult {
  targetPath: string;
  sourcePath: string;
  targetType: string;
  dryRun: boolean;
}

/**
 * Run the unpromote command logic.
 *
 * Resolves the workspace, opens the DB, calls `unpromoteArtifact`, formats
 * output, and closes the DB in a finally block.
 *
 * @param targetPath - Workspace-relative path of the promoted page to remove.
 * @param opts       - Command-specific options.
 * @param global     - Global CLI options.
 * @returns `{ ok: true, value }` on success, or `{ ok: false, error }` on failure.
 */
export async function runUnpromote(
  targetPath: string,
  opts: UnpromoteCommandOptions,
  global: UnpromoteCommandGlobal,
): Promise<{ ok: true; value: UnpromoteCommandResult } | { ok: false; error: Error }> {
  // 1. Resolve workspace
  const wsResult = resolveWorkspace(
    global.workspace !== undefined ? { workspace: global.workspace } : {},
  );
  if (!wsResult.ok) {
    return { ok: false, error: wsResult.error };
  }

  const { root: workspacePath, dbPath } = wsResult.value;
  const dryRun = opts.dryRun === true;
  const yes = opts.yes === true;

  // 2. Dry run: read-only preview, deliberately outside the writer lock.
  if (dryRun) {
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) return { ok: false, error: dbResult.error };

    const db = dbResult.value;
    try {
      const previewResult = unpromoteArtifact(db, workspacePath, {
        targetPath,
        dryRun: true,
      });

      if (!previewResult.ok) {
        return { ok: false, error: previewResult.error };
      }

      const { sourcePath: src, targetType: type } = previewResult.value;

      if (global.json === true) {
        process.stdout.write(formatJSON(previewResult.value) + '\n');
      } else {
        process.stdout.write('\n');
        process.stdout.write(formatInfo('Dry run — no changes will be made') + '\n');
        process.stdout.write('\n');
        process.stdout.write(`  Target:  ${targetPath}\n`);
        process.stdout.write(`  Source:  ${src}\n`);
        process.stdout.write(`  Type:    ${type}\n`);
        process.stdout.write('\n');
        process.stdout.write('  Run with --yes to confirm removal.\n');
        process.stdout.write('\n');
      }

      return { ok: true, value: previewResult.value };
    } finally {
      closeDatabase(db);
    }
  }

  // 3. Require --yes confirmation before opening a writer connection.
  if (!yes) {
    if (global.json !== true) {
      process.stdout.write('\n');
      process.stdout.write(
        formatWarning(`This will permanently remove ${targetPath} from the wiki.`) + '\n',
      );
      process.stdout.write('\n');
      process.stdout.write('  Use --dry-run to preview, or --yes to confirm.\n');
      process.stdout.write('\n');
    }
    return {
      ok: false,
      error: new Error('Confirmation required. Use --yes to proceed.'),
    };
  }

  // 4. Execute the DB + filesystem mutation under the shared writer lock.
  const lockResult = await withBrainWriteLock(() => {
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) return { ok: false as const, error: dbResult.error };

    const db = dbResult.value;
    try {
      return unpromoteArtifact(db, workspacePath, { targetPath });
    } finally {
      closeDatabase(db);
    }
  });

  if (!lockResult.ok) {
    return { ok: false, error: lockResult.error };
  }
  if (!lockResult.value.locked) warnIfWriteLockDegraded(global.json === true);

  const unpromoteResult = lockResult.value.value;
  if (!unpromoteResult.ok) {
    return { ok: false, error: unpromoteResult.error };
  }

  const { sourcePath, targetType } = unpromoteResult.value;

  if (global.json === true) {
    process.stdout.write(formatJSON(unpromoteResult.value) + '\n');
  } else {
    process.stdout.write('\n');
    process.stdout.write(formatSuccess(`Removed ${targetPath} from the wiki`) + '\n');
    process.stdout.write('\n');
    process.stdout.write(formatInfo(`Source:  ${sourcePath}`) + '\n');
    process.stdout.write(formatInfo(`Type:    ${targetType}`) + '\n');
    process.stdout.write('\n');
  }

  return { ok: true, value: unpromoteResult.value };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `ico unpromote <path>` on the root Commander program.
 *
 * @param program - The root Commander `Command` instance.
 */
export function register(program: Command): void {
  program
    .command('unpromote <path>')
    .description('Reverse a promotion — remove a page from the wiki')
    .option('--dry-run', 'Preview without making changes')
    .option('--yes', 'Skip confirmation')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  $ ico unpromote wiki/topics/my-topic.md --dry-run\n' +
        '  $ ico unpromote wiki/topics/my-topic.md --yes',
    )
    .action(async (targetPath: string, opts: UnpromoteCommandOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<UnpromoteCommandGlobal & UnpromoteCommandOptions>();

      const global: UnpromoteCommandGlobal = {
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
      };

      // Resolve relative target path against workspace root when a workspace is
      // explicitly provided; otherwise treat as-is (workspace-relative).
      const resolvedTarget = resolve(targetPath) === targetPath ? targetPath : targetPath; // already workspace-relative

      const result = await runUnpromote(resolvedTarget, opts, global);

      if (!result.ok) {
        const isConfirmError = result.error.message.includes('Confirmation required');
        if (!isConfirmError) {
          process.stderr.write(formatError(result.error.message) + '\n');
        }
        process.exitCode = isBrainWriteLockBusyError(result.error) ? 4 : 1;
        return;
      }
    });
}
