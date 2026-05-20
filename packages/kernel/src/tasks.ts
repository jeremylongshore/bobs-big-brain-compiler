/**
 * Task state machine for the ICO kernel (L3 Episodic Tasks).
 *
 * Manages the lifecycle of research tasks through a strict, linear state
 * machine: created → collecting → synthesizing → critiquing → rendering →
 * completed → archived. No state may be skipped or reversed.
 *
 * All functions return `Result<T, Error>` — never throw.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';

import type { TaskStatus } from '@ico/types';
import { err, ok, type Result } from '@ico/types';

import { writeTrace } from './traces.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A fully hydrated row from the `tasks` SQLite table, including all nullable
 * timestamp columns.
 */
export interface TaskRecord {
  id: string;
  brief: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
  workspace_path: string;
}

// ---------------------------------------------------------------------------
// State machine definition
// ---------------------------------------------------------------------------

/**
 * Maps each status to the set of valid next statuses.
 *
 * Happy path (one successor): created → collecting → synthesizing →
 * critiquing → rendering → completed → archived.
 *
 * Failure branches (E9-B06): each forward edge has a sibling `failed_*`
 * edge that the orchestrator takes when an agent returns err(...) during
 * its stage. A failure state maps back to the state it came from, so the
 * operator can re-run just the failed stage without re-doing earlier work:
 *
 *   created          → collecting | failed_collecting
 *   collecting       → synthesizing | failed_synthesizing
 *   synthesizing     → critiquing | failed_critiquing
 *   critiquing       → rendering | failed_rendering
 *   failed_collecting   → created          (retry collector)
 *   failed_synthesizing → collecting       (retry summarizer)
 *   failed_critiquing   → synthesizing     (retry skeptic)
 *   failed_rendering    → critiquing       (retry integrator)
 */
const VALID_TRANSITIONS: Record<string, readonly string[]> = {
  created: ['collecting', 'failed_collecting'],
  collecting: ['synthesizing', 'failed_synthesizing'],
  synthesizing: ['critiquing', 'failed_critiquing'],
  critiquing: ['rendering', 'failed_rendering'],
  rendering: ['completed'],
  completed: ['archived'],
  failed_collecting: ['created'],
  failed_synthesizing: ['collecting'],
  failed_critiquing: ['synthesizing'],
  failed_rendering: ['critiquing'],
};

/**
 * Subdirectories to create inside each task workspace root.
 * Paths are relative to the task root (`tasks/tsk-<id>/`).
 */
const TASK_DIRS: readonly string[] = ['evidence', 'notes', 'drafts', 'critique', 'output'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current time as an ISO 8601 UTC string.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Reads a task row from the database by `id`.
 * Returns `null` when no row exists for the given id.
 */
function selectTask(db: Database, id: string): TaskRecord | null {
  return (
    db
      .prepare<[string], TaskRecord>(
        `SELECT id, brief, status, created_at, updated_at, completed_at, archived_at, workspace_path
       FROM tasks
       WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a new task in the `created` state.
 *
 * 1. Generates a UUID and derives `workspace_path` as `tasks/tsk-<id>`.
 * 2. Creates the task directory tree under `${workspacePath}/tasks/tsk-<id>/`.
 * 3. Inserts the task row into SQLite.
 * 4. Writes a `task.create` trace event.
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param brief         - Short description of the research question or goal.
 * @returns `ok(TaskRecord)` on success, or `err(Error)` on any failure.
 */
export function createTask(
  db: Database,
  workspacePath: string,
  brief: string,
): Result<TaskRecord, Error> {
  try {
    const id = randomUUID();
    const now = nowIso();
    const taskRelPath = `tasks/tsk-${id}`;
    const taskAbsPath = join(workspacePath, taskRelPath);

    // Create the task subdirectory structure.
    for (const dir of TASK_DIRS) {
      mkdirSync(join(taskAbsPath, dir), { recursive: true });
    }

    // Insert the task row.
    db.prepare<[string, string, string, string, string], void>(
      `INSERT INTO tasks (id, brief, status, created_at, updated_at, workspace_path)
       VALUES (?, ?, 'created', ?, ?, ?)`,
    ).run(id, brief, now, now, taskRelPath);

    // Write a trace event (best-effort — we propagate failures).
    const traceResult = writeTrace(db, workspacePath, 'task.create', {
      taskId: id,
      brief,
      status: 'created',
    });
    if (!traceResult.ok) {
      return err(traceResult.error);
    }

    const record = selectTask(db, id);
    if (record === null) {
      return err(new Error(`Failed to re-read task ${id} after insert`));
    }

    return ok(record);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Advances a task to `targetStatus` if the transition is legal.
 *
 * Validation rules:
 * - The task must exist.
 * - `targetStatus` must be the direct successor of the current status per
 *   `VALID_TRANSITIONS`. No skipping, no reversal.
 *
 * Side-effects:
 * - `updated_at` is always refreshed.
 * - `completed_at` is set when transitioning to `'completed'`.
 * - `archived_at` is set when transitioning to `'archived'`.
 * - A `task.transition` trace event is written.
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param taskId        - UUID of the task to transition.
 * @param targetStatus  - The desired next status.
 * @returns `ok(TaskRecord)` reflecting the new state, or `err(Error)`.
 */
export function transitionTask(
  db: Database,
  workspacePath: string,
  taskId: string,
  targetStatus: TaskStatus,
): Result<TaskRecord, Error> {
  try {
    const existing = selectTask(db, taskId);
    if (existing === null) {
      return err(new Error(`Task not found: ${taskId}`));
    }

    const currentStatus = existing.status;
    const allowed = VALID_TRANSITIONS[currentStatus];

    if (allowed === undefined || !allowed.includes(targetStatus)) {
      const expected =
        allowed === undefined || allowed.length === 0 ? '(terminal)' : allowed.join(' | ');
      return err(
        new Error(
          `Invalid transition: '${currentStatus}' → '${targetStatus}'. ` +
            `Expected next status: '${expected}'.`,
        ),
      );
    }

    const now = nowIso();
    const completedAt = targetStatus === 'completed' ? now : existing.completed_at;
    const archivedAt = targetStatus === 'archived' ? now : existing.archived_at;

    db.prepare<[string, string, string | null, string | null, string], void>(
      `UPDATE tasks
       SET status = ?, updated_at = ?, completed_at = ?, archived_at = ?
       WHERE id = ?`,
    ).run(targetStatus, now, completedAt, archivedAt, taskId);

    const traceResult = writeTrace(db, workspacePath, 'task.transition', {
      taskId,
      from: currentStatus,
      to: targetStatus,
    });
    if (!traceResult.ok) {
      return err(traceResult.error);
    }

    const updated = selectTask(db, taskId);
    if (updated === null) {
      return err(new Error(`Failed to re-read task ${taskId} after update`));
    }

    return ok(updated);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Retrieves a single task by its UUID.
 *
 * @param db     - Open better-sqlite3 database with migrations applied.
 * @param taskId - UUID of the task to retrieve.
 * @returns `ok(TaskRecord)` if found, `ok(null)` if not found, or `err(Error)`.
 */
export function getTask(db: Database, taskId: string): Result<TaskRecord | null, Error> {
  try {
    return ok(selectTask(db, taskId));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Lists all tasks, optionally filtered to a specific status.
 *
 * Results are ordered by `created_at` ascending.
 *
 * @param db     - Open better-sqlite3 database with migrations applied.
 * @param status - When provided, only tasks with this status are returned.
 * @returns `ok(TaskRecord[])` or `err(Error)`.
 */
export function listTasks(db: Database, status?: TaskStatus): Result<TaskRecord[], Error> {
  try {
    if (status !== undefined) {
      const rows = db
        .prepare<[string], TaskRecord>(
          `SELECT id, brief, status, created_at, updated_at, completed_at, archived_at, workspace_path
           FROM tasks
           WHERE status = ?
           ORDER BY created_at ASC`,
        )
        .all(status);
      return ok(rows);
    }

    const rows = db
      .prepare<[], TaskRecord>(
        `SELECT id, brief, status, created_at, updated_at, completed_at, archived_at, workspace_path
         FROM tasks
         ORDER BY created_at ASC`,
      )
      .all();
    return ok(rows);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
