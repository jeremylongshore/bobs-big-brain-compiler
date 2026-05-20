/**
 * Research task archival (E9-B07).
 *
 * `archiveTask()` transitions a completed research task to `archived`.
 * The full task directory (evidence/, notes/, drafts/, critique/, output/)
 * is preserved for audit purposes — no files are deleted. The task is
 * simply flagged as archived in SQLite and excluded from active status
 * counts.
 *
 * Only tasks in `completed` status may be archived. All other statuses
 * are rejected with a descriptive error.
 *
 * All functions return `Result<T, Error>` — never throw.
 *
 * @module archive
 */

import { err, ok, type Result } from '@ico/types';

// Direct module imports (not via './index.js' barrel) to avoid a
// kernel/src/index.ts → kernel/src/archive.ts → kernel/src/index.ts
// circular dependency that the dependency-cruiser arch gate forbids.
import { appendAuditLog } from './audit-log.js';
import { type Database } from './state.js';
import { getTask, type TaskRecord, transitionTask } from './tasks.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of a successful archival. */
export interface ArchiveResult {
  taskId: string;
  /** Always `'archived'` on success. */
  status: 'archived';
  /** ISO 8601 timestamp when the task was archived. */
  archivedAt: string;
  /** Workspace-relative path to the preserved task directory. */
  workspacePath: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Archive a completed research task.
 *
 * Preconditions:
 * - Task must exist.
 * - Task must be in `completed` status.
 *
 * Behaviour:
 * 1. Loads the task and validates its status.
 * 2. Transitions `completed` → `archived` via the kernel state machine
 *    (which sets `archived_at` and emits a `task.transition` trace).
 * 3. Appends an audit log entry.
 * 4. Returns the archived task metadata.
 *
 * The task directory is deliberately preserved intact — archival is a
 * status change, not a deletion.
 */
export function archiveTask(
  db: Database,
  workspacePath: string,
  taskId: string,
): Result<ArchiveResult, Error> {
  // 1. Load and validate.
  const taskResult = getTask(db, taskId);
  if (!taskResult.ok) return err(taskResult.error);
  if (taskResult.value === null) {
    return err(new Error(`Task not found: ${taskId}`));
  }

  const task: TaskRecord = taskResult.value;
  if (task.status !== 'completed') {
    return err(
      new Error(
        `Cannot archive task ${taskId}: status is '${task.status}', expected 'completed'. ` +
          `Only completed tasks may be archived.`,
      ),
    );
  }

  // 2. Transition (sets archived_at, emits task.transition trace).
  const transitionResult = transitionTask(db, workspacePath, taskId, 'archived');
  if (!transitionResult.ok) return err(transitionResult.error);

  const archived = transitionResult.value;

  // 3. Audit log.
  appendAuditLog(
    workspacePath,
    'task.archive',
    `Archived research task ${taskId} (workspace: ${archived.workspace_path})`,
  );

  return ok({
    taskId,
    status: 'archived',
    archivedAt: archived.archived_at!,
    workspacePath: archived.workspace_path,
  });
}
