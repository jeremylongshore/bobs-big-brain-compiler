/**
 * Tests for the cognitive procfs module.
 *
 * Tests cover computed status views, memory maps, markdown rendering,
 * and on-disk materialization.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeMemoryMap,
  computeTaskStatus,
  materializeStatus,
  type MemoryMapSection,
  renderMemoryMapMarkdown,
  renderTaskStatusMarkdown,
  type TaskStatusView,
} from './procfs.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { createTask, transitionTask } from './tasks.js';
import { initWorkspace } from './workspace.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspacePath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ico-procfs-'));
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
// computeTaskStatus
// ---------------------------------------------------------------------------

describe('computeTaskStatus', () => {
  it('returns status for a newly created task', () => {
    const cr = createTask(db, workspacePath, 'Test procfs status');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const result = computeTaskStatus(db, workspacePath, cr.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const view = result.value;
    expect(view.task_id).toBe(cr.value.id);
    expect(view.workspace_path).toBe(cr.value.workspace_path);
    expect(view.phase).toBe('created');
    expect(view.brief).toBe('Test procfs status');
    expect(view.evidence_count).toBe(0);
    expect(view.notes_count).toBe(0);
    expect(view.drafts_count).toBe(0);
    expect(view.output_count).toBe(0);
    expect(typeof view.age_hours).toBe('number');
    expect(view.age_hours).toBeGreaterThanOrEqual(0);
  });

  it('reflects the current phase after transitions', () => {
    const cr = createTask(db, workspacePath, 'Transition test');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    transitionTask(db, workspacePath, cr.value.id, 'collecting');
    transitionTask(db, workspacePath, cr.value.id, 'synthesizing');

    const result = computeTaskStatus(db, workspacePath, cr.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.phase).toBe('synthesizing');
    expect(result.value.transitions).toBeGreaterThan(0);
  });

  it('counts evidence files when present', () => {
    const cr = createTask(db, workspacePath, 'Evidence count test');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const evidenceDir = join(workspacePath, cr.value.workspace_path, 'evidence');
    writeFileSync(join(evidenceDir, 'paper-1.md'), '# Paper 1\n', 'utf-8');
    writeFileSync(join(evidenceDir, 'paper-2.md'), '# Paper 2\n', 'utf-8');

    const result = computeTaskStatus(db, workspacePath, cr.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.evidence_count).toBe(2);
  });

  it('returns error for nonexistent task', () => {
    const result = computeTaskStatus(db, workspacePath, '00000000-0000-4000-8000-000000000000');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// renderTaskStatusMarkdown
// ---------------------------------------------------------------------------

describe('renderTaskStatusMarkdown', () => {
  it('produces valid markdown with YAML frontmatter', () => {
    const view: TaskStatusView = {
      task_id: 'abc-123',
      workspace_path: 'tasks/tsk-abc-123',
      phase: 'collecting',
      brief: 'How does attention scale?',
      created_at: '2026-04-09T12:00:00.000Z',
      updated_at: '2026-04-09T14:00:00.000Z',
      age_hours: 2,
      transitions: 1,
      evidence_count: 3,
      notes_count: 1,
      drafts_count: 0,
      output_count: 0,
    };

    const md = renderTaskStatusMarkdown(view);

    expect(md).toContain('---');
    expect(md).toContain('task_id: "abc-123"');
    expect(md).toContain('phase: "collecting"');
    expect(md).toContain('# Task Status');
    expect(md).toContain('**Phase:** collecting');
    expect(md).toContain('**Brief:** How does attention scale?');
    expect(md).toContain('Evidence: 3 files');
    expect(md).toContain('Notes: 1 files');
    expect(md).toContain('Drafts: 0 files');
  });

  it('escapes double quotes in brief', () => {
    const view: TaskStatusView = {
      task_id: 'def-456',
      workspace_path: 'tasks/tsk-def-456',
      phase: 'created',
      brief: 'What does "scaling" mean?',
      created_at: '2026-04-09T12:00:00.000Z',
      updated_at: '2026-04-09T12:00:00.000Z',
      age_hours: 0,
      transitions: 0,
      evidence_count: 0,
      notes_count: 0,
      drafts_count: 0,
      output_count: 0,
    };

    const md = renderTaskStatusMarkdown(view);
    expect(md).toContain('brief: "What does \\"scaling\\" mean?"');
  });
});

// ---------------------------------------------------------------------------
// computeMemoryMap
// ---------------------------------------------------------------------------

describe('computeMemoryMap', () => {
  it('returns empty sections for a fresh task', () => {
    const cr = createTask(db, workspacePath, 'Memory map test');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const result = computeMemoryMap(workspacePath, cr.value.workspace_path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(5);
    for (const section of result.value) {
      expect(section.file_count).toBe(0);
      expect(section.files).toEqual([]);
    }
  });

  it('counts files in populated directories', () => {
    const cr = createTask(db, workspacePath, 'Populated memory map');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const taskDir = join(workspacePath, cr.value.workspace_path);
    writeFileSync(join(taskDir, 'evidence', 'src-1.md'), 'data', 'utf-8');
    writeFileSync(join(taskDir, 'evidence', 'src-2.md'), 'data', 'utf-8');
    writeFileSync(join(taskDir, 'notes', 'observation.md'), 'notes', 'utf-8');

    const result = computeMemoryMap(workspacePath, cr.value.workspace_path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const evidenceSection = result.value.find((s) => s.name === 'evidence');
    expect(evidenceSection?.file_count).toBe(2);
    expect(evidenceSection?.files).toContain('src-1.md');
    expect(evidenceSection?.files).toContain('src-2.md');

    const notesSection = result.value.find((s) => s.name === 'notes');
    expect(notesSection?.file_count).toBe(1);
  });

  it('section names match task subdirectories', () => {
    const cr = createTask(db, workspacePath, 'Section names');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const result = computeMemoryMap(workspacePath, cr.value.workspace_path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.map((s) => s.name);
    expect(names).toEqual(['evidence', 'notes', 'drafts', 'critique', 'output']);
  });
});

// ---------------------------------------------------------------------------
// renderMemoryMapMarkdown
// ---------------------------------------------------------------------------

describe('renderMemoryMapMarkdown', () => {
  it('renders section headers with file counts', () => {
    const sections: MemoryMapSection[] = [
      { name: 'evidence', file_count: 2, files: ['a.md', 'b.md'] },
      { name: 'notes', file_count: 0, files: [] },
    ];

    const md = renderMemoryMapMarkdown(sections);

    expect(md).toContain('# Memory Map');
    expect(md).toContain('## evidence/ (2 files)');
    expect(md).toContain('- a.md');
    expect(md).toContain('- b.md');
    expect(md).toContain('## notes/ (0 files)');
  });
});

// ---------------------------------------------------------------------------
// materializeStatus
// ---------------------------------------------------------------------------

describe('materializeStatus', () => {
  it('creates _proc/status.md on disk', () => {
    const cr = createTask(db, workspacePath, 'Materialize test');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const result = materializeStatus(db, workspacePath, cr.value.id, cr.value.workspace_path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const filePath = result.value;
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Task Status');
    expect(content).toContain('phase: "created"');
    expect(content).toContain('Materialize test');
  });

  it('overwrites existing status on re-materialization', () => {
    const cr = createTask(db, workspacePath, 'Re-materialize test');
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    // First materialization
    materializeStatus(db, workspacePath, cr.value.id, cr.value.workspace_path);

    // Transition and re-materialize
    transitionTask(db, workspacePath, cr.value.id, 'collecting');
    const result = materializeStatus(db, workspacePath, cr.value.id, cr.value.workspace_path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const content = readFileSync(result.value, 'utf-8');
    expect(content).toContain('phase: "collecting"');
  });

  it('returns error for nonexistent task', () => {
    const result = materializeStatus(
      db,
      workspacePath,
      '00000000-0000-4000-8000-000000000000',
      'tasks/tsk-nonexistent',
    );
    expect(result.ok).toBe(false);
  });
});
