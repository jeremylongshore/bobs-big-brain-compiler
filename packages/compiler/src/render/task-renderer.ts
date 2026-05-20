/**
 * Task output gatherer for the ICO compiler (E8-B07).
 *
 * Reads output files from a completed task workspace so they can be fed into
 * report or slide renderers. Only tasks that have reached `completed` status
 * (signalled by a `status.json` file or the presence of an `output/` directory)
 * are eligible.
 *
 * Never throws — all error paths return err(Error).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import matter from 'gray-matter';

import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single output document from a completed task workspace. */
export interface TaskOutputSource {
  /** Document title from frontmatter, or basename when frontmatter is absent. */
  title: string;
  /** Full markdown content of the file (frontmatter stripped). */
  content: string;
  /** Workspace-relative path to the source file. */
  path: string;
}

/**
 * Aggregated output from a completed task workspace, ready for rendering.
 */
export interface TaskOutput {
  /** Task identifier (the directory name under `workspace/tasks/`). */
  taskId: string;
  /** Task title — first output file's title, or the taskId as fallback. */
  title: string;
  /** Ordered list of output documents gathered from `output/`. */
  sources: TaskOutputSource[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine the status of a task from its workspace directory.
 *
 * Two signals are checked in order:
 *   1. `status.json` — if present, the `status` field must equal `"completed"`.
 *   2. Presence of `output/` directory — treated as minimum completion signal
 *      when no `status.json` exists.
 *
 * Returns `'completed'` when eligible, or an error message string otherwise.
 */
function resolveTaskStatus(taskDir: string): { eligible: boolean; reason: string } {
  const statusFile = join(taskDir, 'status.json');

  if (existsSync(statusFile)) {
    let raw: string;
    try {
      raw = readFileSync(statusFile, 'utf-8');
    } catch {
      return { eligible: false, reason: 'Cannot read status.json' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { eligible: false, reason: 'status.json is not valid JSON' };
    }

    const status =
      parsed !== null && typeof parsed === 'object' && 'status' in parsed
        ? (parsed as Record<string, unknown>)['status']
        : undefined;

    if (status !== 'completed') {
      return {
        eligible: false,
        reason: `Task status is "${String(status)}", not "completed"`,
      };
    }

    return { eligible: true, reason: 'completed' };
  }

  // No status.json — fall back to checking for an output/ directory.
  const outputDir = join(taskDir, 'output');
  if (existsSync(outputDir)) {
    return { eligible: true, reason: 'output directory exists' };
  }

  return {
    eligible: false,
    reason: 'Task has no status.json and no output/ directory',
  };
}

/**
 * Extract a display title from gray-matter parsed data.
 * Falls back to the file basename (without extension) when no `title` field
 * is present or when the value is not a non-empty string.
 */
function extractTitle(data: Record<string, unknown>, filePath: string): string {
  const frontmatterTitle = data['title'];
  if (typeof frontmatterTitle === 'string' && frontmatterTitle.trim() !== '') {
    return frontmatterTitle.trim();
  }
  // Use filename without extension as fallback.
  const base = basename(filePath);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Gather output files from a completed task workspace.
 *
 * Steps:
 *   1. Verify that `workspace/tasks/<taskId>/` exists.
 *   2. Check task completion eligibility (status.json or output/ directory).
 *   3. Read all `.md` files from `workspace/tasks/<taskId>/output/`.
 *   4. Parse each file's frontmatter for `title`; use the filename as fallback.
 *   5. Return a {@link TaskOutput} with all sources.
 *
 * @param workspacePath - Absolute path to the workspace root.
 * @param taskId        - Task identifier (directory name under `workspace/tasks/`).
 * @returns `ok(TaskOutput)` on success, or `err(Error)` if the task is
 *          non-existent, ineligible, or produces no output files.
 */
export function gatherTaskOutput(workspacePath: string, taskId: string): Result<TaskOutput, Error> {
  const taskDir = join(workspacePath, 'tasks', taskId);

  // Step 1: Task directory must exist.
  if (!existsSync(taskDir)) {
    return err(new Error(`Task directory not found: tasks/${taskId}`));
  }

  // Step 2: Task must be completed.
  const statusCheck = resolveTaskStatus(taskDir);
  if (!statusCheck.eligible) {
    return err(new Error(`Task "${taskId}" is not eligible for rendering: ${statusCheck.reason}`));
  }

  // Step 3: Output directory must exist.
  const outputDir = join(taskDir, 'output');
  if (!existsSync(outputDir)) {
    return err(new Error(`Task "${taskId}" has no output/ directory`));
  }

  // Step 4: Collect all .md files from output/.
  let entries: string[];
  try {
    entries = (readdirSync(outputDir) as unknown as string[]).filter((f) => f.endsWith('.md'));
  } catch (e) {
    return err(
      new Error(
        `Cannot read output directory for task "${taskId}": ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  if (entries.length === 0) {
    return err(new Error(`Task "${taskId}" output/ directory contains no .md files`));
  }

  // Step 5: Parse each file.
  const sources: TaskOutputSource[] = [];

  for (const entry of entries.sort()) {
    const filePath = join(outputDir, entry);
    const relPath = `tasks/${taskId}/output/${entry}`;

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (e) {
      return err(
        new Error(
          `Cannot read output file "${relPath}": ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch (e) {
      return err(
        new Error(
          `Cannot parse frontmatter in "${relPath}": ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }

    const title = extractTitle(parsed.data as Record<string, unknown>, entry);

    sources.push({
      title,
      content: parsed.content,
      path: relPath,
    });
  }

  // Derive the deck/report title from the first source.
  const title = sources[0]?.title ?? taskId;

  return ok({ taskId, title, sources });
}
