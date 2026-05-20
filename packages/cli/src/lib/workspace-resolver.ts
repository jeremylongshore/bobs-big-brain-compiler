/**
 * Workspace resolution for the ico CLI.
 *
 * Resolves the workspace root and derived paths using a priority-ordered
 * strategy:
 *   1. `--workspace` flag  (options.workspace)
 *   2. `ICO_WORKSPACE` environment variable
 *   3. Upward directory discovery from cwd (max 10 levels)
 *   4. Error — no workspace found
 *
 * All functions are pure and never throw — they always return a Result.
 *
 * @module workspace-resolver
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Resolved workspace location with derived paths. */
export interface WorkspaceLocation {
  /** Absolute path to the workspace root directory. */
  root: string;
  /** Absolute path to the SQLite state file (.ico/state.db). */
  dbPath: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of directory levels to traverse during upward discovery. */
const MAX_LEVELS = 10;

/** Relative path from any workspace root to the state database. */
const DB_RELATIVE = join('.ico', 'state.db');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a WorkspaceLocation from a confirmed workspace root.
 */
function makeLocation(root: string): WorkspaceLocation {
  return { root, dbPath: join(root, DB_RELATIVE) };
}

/**
 * Check whether `candidate` contains a valid `.ico/state.db` file.
 */
function hasStateDb(candidate: string): boolean {
  return existsSync(join(candidate, DB_RELATIVE));
}

/**
 * Walk upward from `startDir`, returning the first ancestor directory that
 * contains `.ico/state.db`, or `null` if none is found within `maxLevels`.
 */
function discoverUpward(startDir: string, maxLevels: number): string | null {
  let current = startDir;

  for (let level = 0; level < maxLevels; level++) {
    if (hasStateDb(current)) {
      return current;
    }

    const parent = dirname(current);

    // Reached the filesystem root — stop before an infinite loop.
    if (parent === current || parse(current).root === current) {
      break;
    }

    current = parent;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace location using the priority-ordered strategy.
 *
 * @param options.workspace - Path supplied via the `--workspace` CLI flag.
 * @param options.cwd       - Override the current working directory used for
 *                            upward discovery. Defaults to `process.cwd()`.
 *                            Useful for testing without `process.chdir()`.
 * @returns A `Result` wrapping the resolved `WorkspaceLocation`, or an
 *          `Error` describing why resolution failed.
 */
export function resolveWorkspace(options?: {
  workspace?: string;
  cwd?: string;
}): Result<WorkspaceLocation, Error> {
  // 1. --workspace flag
  if (options?.workspace !== undefined && options.workspace !== '') {
    const root = resolve(options.workspace);
    if (hasStateDb(root)) {
      return ok(makeLocation(root));
    }
    return err(new Error(`No workspace found at ${root}`));
  }

  // 2. ICO_WORKSPACE environment variable
  const envPath = process.env['ICO_WORKSPACE'];
  if (envPath !== undefined && envPath !== '') {
    const root = resolve(envPath);
    if (hasStateDb(root)) {
      return ok(makeLocation(root));
    }
    return err(new Error(`No workspace found at ${root}`));
  }

  // 3. Upward directory discovery
  const startDir = options?.cwd !== undefined ? resolve(options.cwd) : process.cwd();
  const found = discoverUpward(startDir, MAX_LEVELS);
  if (found !== null) {
    return ok(makeLocation(found));
  }

  // 4. Nothing found
  return err(
    new Error(
      "No workspace found. Run 'ico init <name>' to create one, or use --workspace to specify a path.",
    ),
  );
}
