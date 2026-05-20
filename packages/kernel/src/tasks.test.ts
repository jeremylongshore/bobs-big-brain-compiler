import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import type { TaskRecord } from './tasks.js';
import { createTask, getTask, listTasks, transitionTask } from './tasks.js';
import { readTraces } from './traces.js';
import { initWorkspace } from './workspace.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspacePath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ico-tasks-'));
  const wsResult = initWorkspace('test', tmpDir);
  if (!wsResult.ok) throw wsResult.error;
  workspacePath = wsResult.value.root;

  const dbResult = initDatabase(wsResult.value.dbPath);
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

describe('createTask — basic record shape', () => {
  it('returns a TaskRecord with status "created", a valid UUID, and timestamps', () => {
    const result = createTask(db, workspacePath, 'Summarise the Turing paper');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const task = result.value;
    expect(task.status).toBe('created');
    expect(task.brief).toBe('Summarise the Turing paper');
    expect(task.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(typeof task.created_at).toBe('string');
    expect(typeof task.updated_at).toBe('string');
    expect(task.completed_at).toBeNull();
    expect(task.archived_at).toBeNull();
    expect(task.workspace_path).toBe(`tasks/tsk-${task.id}`);
  });
});

describe('createTask — directory structure', () => {
  it('creates the five required subdirectories inside the task workspace', () => {
    const result = createTask(db, workspacePath, 'Test dir creation');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const taskRoot = join(workspacePath, 'tasks', `tsk-${result.value.id}`);
    for (const dir of ['evidence', 'notes', 'drafts', 'critique', 'output']) {
      expect(existsSync(join(taskRoot, dir))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// transitionTask — full valid chain
// ---------------------------------------------------------------------------

describe('transitionTask — full valid chain', () => {
  it('transitions a task through every status in order', () => {
    const createResult = createTask(db, workspacePath, 'Full chain test');
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const taskId = createResult.value.id;
    const chain: Array<Parameters<typeof transitionTask>[3]> = [
      'collecting',
      'synthesizing',
      'critiquing',
      'rendering',
      'completed',
      'archived',
    ];

    let current: TaskRecord = createResult.value;
    for (const target of chain) {
      const r = transitionTask(db, workspacePath, taskId, target);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.status).toBe(target);
      current = r.value;
    }

    expect(current.status).toBe('archived');
  });
});

// ---------------------------------------------------------------------------
// transitionTask — illegal transitions
// ---------------------------------------------------------------------------

describe('transitionTask — invalid transitions', () => {
  it('rejects skipping a state (created → synthesizing)', () => {
    const createResult = createTask(db, workspacePath, 'Skip test');
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const r = transitionTask(db, workspacePath, createResult.value.id, 'synthesizing');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/invalid transition/i);
  });

  it('rejects going backwards (completed → collecting)', () => {
    const createResult = createTask(db, workspacePath, 'Backwards test');
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const taskId = createResult.value.id;
    // Advance to completed
    for (const s of [
      'collecting',
      'synthesizing',
      'critiquing',
      'rendering',
      'completed',
    ] as const) {
      const r = transitionTask(db, workspacePath, taskId, s);
      expect(r.ok).toBe(true);
    }

    const backResult = transitionTask(db, workspacePath, taskId, 'collecting');
    expect(backResult.ok).toBe(false);
    if (backResult.ok) return;
    expect(backResult.error.message).toMatch(/invalid transition/i);
  });
});

// ---------------------------------------------------------------------------
// transitionTask — failure branches (E9-B06)
//
// Each forward stage has a sibling `failed_*` edge and a recovery edge back
// to the state it came from. This verifies every failure/recovery pair and
// also that failure states do not allow skipping forward.
// ---------------------------------------------------------------------------

describe('transitionTask — failure branches', () => {
  const cases: ReadonlyArray<{
    path: readonly TaskRecord['status'][];
    failureState: TaskRecord['status'];
    recoveryTarget: TaskRecord['status'];
  }> = [
    { path: [], failureState: 'failed_collecting', recoveryTarget: 'created' },
    { path: ['collecting'], failureState: 'failed_synthesizing', recoveryTarget: 'collecting' },
    {
      path: ['collecting', 'synthesizing'],
      failureState: 'failed_critiquing',
      recoveryTarget: 'synthesizing',
    },
    {
      path: ['collecting', 'synthesizing', 'critiquing'],
      failureState: 'failed_rendering',
      recoveryTarget: 'critiquing',
    },
  ] as const;

  for (const { path, failureState, recoveryTarget } of cases) {
    it(`transitions ${recoveryTarget} → ${failureState} → ${recoveryTarget}`, () => {
      const cr = createTask(db, workspacePath, `Failure branch: ${failureState}`);
      expect(cr.ok).toBe(true);
      if (!cr.ok) return;
      const taskId = cr.value.id;

      // Advance to the state that precedes the failure.
      for (const s of path) {
        const r = transitionTask(db, workspacePath, taskId, s);
        expect(r.ok).toBe(true);
      }

      // Forward edge to the failure state.
      const failR = transitionTask(db, workspacePath, taskId, failureState);
      expect(failR.ok).toBe(true);
      if (!failR.ok) return;
      expect(failR.value.status).toBe(failureState);

      // Recovery edge back to the predecessor state.
      const recoverR = transitionTask(db, workspacePath, taskId, recoveryTarget);
      expect(recoverR.ok).toBe(true);
      if (!recoverR.ok) return;
      expect(recoverR.value.status).toBe(recoveryTarget);
    });
  }

  it('rejects skipping forward from a failure state (failed_collecting → synthesizing)', () => {
    const cr = createTask(db, workspacePath, 'Failure skip test');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    const taskId = cr.value.id;

    const failR = transitionTask(db, workspacePath, taskId, 'failed_collecting');
    expect(failR.ok).toBe(true);

    const skipR = transitionTask(db, workspacePath, taskId, 'synthesizing');
    expect(skipR.ok).toBe(false);
    if (skipR.ok) return;
    expect(skipR.error.message).toMatch(/invalid transition/i);
  });
});

// ---------------------------------------------------------------------------
// transitionTask — timestamp side-effects
// ---------------------------------------------------------------------------

describe('transitionTask — completed_at', () => {
  it('sets completed_at when transitioning to "completed"', () => {
    const cr = createTask(db, workspacePath, 'Completion timestamp');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const taskId = cr.value.id;
    for (const s of [
      'collecting',
      'synthesizing',
      'critiquing',
      'rendering',
      'completed',
    ] as const) {
      transitionTask(db, workspacePath, taskId, s);
    }

    const getResult = getTask(db, taskId);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value?.completed_at).not.toBeNull();
  });
});

describe('transitionTask — archived_at', () => {
  it('sets archived_at when transitioning to "archived"', () => {
    const cr = createTask(db, workspacePath, 'Archive timestamp');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const taskId = cr.value.id;
    for (const s of [
      'collecting',
      'synthesizing',
      'critiquing',
      'rendering',
      'completed',
      'archived',
    ] as const) {
      transitionTask(db, workspacePath, taskId, s);
    }

    const getResult = getTask(db, taskId);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value?.archived_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

describe('getTask', () => {
  it('returns the task record for a known id', () => {
    const cr = createTask(db, workspacePath, 'Retrievable task');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const result = getTask(db, cr.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.id).toBe(cr.value.id);
    expect(result.value?.brief).toBe('Retrievable task');
  });

  it('returns null for a nonexistent id', () => {
    const result = getTask(db, '00000000-0000-4000-8000-000000000000');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listTasks
// ---------------------------------------------------------------------------

describe('listTasks', () => {
  it('returns all tasks when no status filter is supplied', () => {
    createTask(db, workspacePath, 'Task A');
    createTask(db, workspacePath, 'Task B');
    createTask(db, workspacePath, 'Task C');

    const result = listTasks(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
  });

  it('returns only tasks matching the status filter', () => {
    const r1 = createTask(db, workspacePath, 'Filter task 1');
    const r2 = createTask(db, workspacePath, 'Filter task 2');
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // Advance only the first task to 'collecting'
    transitionTask(db, workspacePath, r1.value.id, 'collecting');

    const created = listTasks(db, 'created');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toHaveLength(1);
    expect(created.value[0]?.id).toBe(r2.value.id);

    const collecting = listTasks(db, 'collecting');
    expect(collecting.ok).toBe(true);
    if (!collecting.ok) return;
    expect(collecting.value).toHaveLength(1);
    expect(collecting.value[0]?.id).toBe(r1.value.id);
  });
});

// ---------------------------------------------------------------------------
// Trace events
// ---------------------------------------------------------------------------

describe('trace events', () => {
  it('createTask emits a task.create trace event', () => {
    const cr = createTask(db, workspacePath, 'Trace create test');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const traces = readTraces(db, { eventType: 'task.create' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;
    expect(traces.value).toHaveLength(1);
    expect(traces.value[0]?.event_type).toBe('task.create');
  });

  it('each transitionTask call emits a task.transition trace event', () => {
    const cr = createTask(db, workspacePath, 'Trace transition test');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const taskId = cr.value.id;
    const transitions = ['collecting', 'synthesizing', 'critiquing'] as const;
    for (const s of transitions) {
      transitionTask(db, workspacePath, taskId, s);
    }

    const traces = readTraces(db, { eventType: 'task.transition' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;
    expect(traces.value).toHaveLength(transitions.length);
    for (const record of traces.value) {
      expect(record.event_type).toBe('task.transition');
    }
  });
});
