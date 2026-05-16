/**
 * `ico mount` command — manage corpus mount points.
 *
 * Subcommands:
 *   ico mount add <name> <path>   Register a new mount point
 *   ico mount list                List all registered mounts
 *   ico mount remove <name>       Remove a mount by name
 */

import { resolve } from 'node:path';

import type { Command } from 'commander';

import {
  appendAuditLog,
  closeDatabase,
  getMountByName,
  initDatabase,
  listMounts,
  registerMount,
  removeMount,
} from '@ico/kernel';

import {
  formatError,
  formatInfo,
  formatJSON,
  formatSuccess,
  formatTable,
} from '../lib/output.js';

// ---------------------------------------------------------------------------
// Workspace resolution (temporary — replaced by B08 workspace discovery)
// ---------------------------------------------------------------------------

/**
 * Derive the path to `state.db` from the `--workspace` global option or the
 * current working directory.
 *
 * @param globalOpts - Parsed global options from the root Commander program.
 * @returns Absolute path to the SQLite database file.
 */
function resolveWorkspaceDb(globalOpts: { workspace?: string }): string {
  const wsPath = globalOpts.workspace ?? '.';
  return resolve(wsPath, '.ico', 'state.db');
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/**
 * Handle `ico mount add <name> <path>`.
 *
 * Resolves the path to an absolute filesystem location, opens the workspace
 * database, calls `registerMount`, and prints the result.
 */
function handleAdd(
  name: string,
  mountPath: string,
  globalOpts: { workspace?: string; json?: boolean },
): void {
  const dbPath = resolveWorkspaceDb(globalOpts);
  const dbResult = initDatabase(dbPath);

  if (!dbResult.ok) {
    console.error(formatError(`Failed to open database: ${dbResult.error.message}`));
    process.exit(1);
  }

  const db = dbResult.value;

  try {
    const absolutePath = resolve(mountPath);
    const result = registerMount(db, name, absolutePath);

    if (!result.ok) {
      console.error(formatError(result.error.message));
      process.exit(1);
    }

    const mount = result.value;
    // Close B04's gap — mount commands now leave an audit footprint.
    appendAuditLog(
      resolve(globalOpts.workspace ?? '.'),
      'mount.add',
      `Registered mount "${mount.name}" → ${mount.path}`,
    );

    if (globalOpts.json) {
      console.log(formatJSON(mount));
    } else {
      console.log(formatSuccess(`Mount "${mount.name}" registered`));
      console.log(formatInfo(`  id:   ${mount.id}`));
      console.log(formatInfo(`  path: ${mount.path}`));
    }
  } finally {
    closeDatabase(db);
  }
}

/**
 * Handle `ico mount list`.
 *
 * Opens the workspace database, calls `listMounts`, and displays results as
 * a table (or JSON when `--json` is set).
 */
function handleList(globalOpts: { workspace?: string; json?: boolean }): void {
  const dbPath = resolveWorkspaceDb(globalOpts);
  const dbResult = initDatabase(dbPath);

  if (!dbResult.ok) {
    console.error(formatError(`Failed to open database: ${dbResult.error.message}`));
    process.exit(1);
  }

  const db = dbResult.value;

  try {
    const result = listMounts(db);

    if (!result.ok) {
      console.error(formatError(result.error.message));
      process.exit(1);
    }

    const mounts = result.value;

    if (globalOpts.json) {
      console.log(formatJSON(mounts));
      return;
    }

    if (mounts.length === 0) {
      console.log(formatInfo('No mounts registered.'));
      return;
    }

    const rows = mounts.map((m) => [
      m.name,
      m.path,
      new Date(m.created_at).toLocaleString(),
    ]);

    console.log(formatTable(['Name', 'Path', 'Created'], rows));
  } finally {
    closeDatabase(db);
  }
}

/**
 * Handle `ico mount remove <name>`.
 *
 * Looks up the mount by name, then removes it by id.
 */
function handleRemove(
  name: string,
  globalOpts: { workspace?: string; json?: boolean },
): void {
  const dbPath = resolveWorkspaceDb(globalOpts);
  const dbResult = initDatabase(dbPath);

  if (!dbResult.ok) {
    console.error(formatError(`Failed to open database: ${dbResult.error.message}`));
    process.exit(1);
  }

  const db = dbResult.value;

  try {
    const lookupResult = getMountByName(db, name);

    if (!lookupResult.ok) {
      console.error(formatError(lookupResult.error.message));
      process.exit(1);
    }

    const mount = lookupResult.value;

    if (!mount) {
      console.error(formatError(`No mount found with name "${name}"`));
      process.exit(1);
    }

    const removeResult = removeMount(db, mount.id);

    if (!removeResult.ok) {
      console.error(formatError(removeResult.error.message));
      process.exit(1);
    }

    appendAuditLog(
      resolve(globalOpts.workspace ?? '.'),
      'mount.remove',
      `Removed mount "${name}" (id=${mount.id})`,
    );

    if (globalOpts.json) {
      console.log(formatJSON({ removed: true, name, id: mount.id }));
    } else {
      console.log(formatSuccess(`Mount "${name}" removed`));
    }
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/**
 * Register `ico mount` and its subcommands onto the root Commander program.
 *
 * @param program - The root Commander Command instance.
 */
export function register(program: Command): void {
  const mount = program
    .command('mount')
    .description('Manage corpus mount points')
    .addHelpText('after', '\nExamples:\n  $ ico mount add papers ~/research/papers\n  $ ico mount list\n  $ ico mount remove papers');

  mount
    .command('add <name> <path>')
    .description('Add a mount point')
    .action((name: string, mountPath: string) => {
      const globalOpts = program.opts<{ workspace?: string; json?: boolean }>();
      handleAdd(name, mountPath, globalOpts);
    });

  mount
    .command('list')
    .description('List all mount points')
    .action(() => {
      const globalOpts = program.opts<{ workspace?: string; json?: boolean }>();
      handleList(globalOpts);
    });

  mount
    .command('remove <name>')
    .description('Remove a mount by name')
    .action((name: string) => {
      const globalOpts = program.opts<{ workspace?: string; json?: boolean }>();
      handleRemove(name, globalOpts);
    });
}
