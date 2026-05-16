/**
 * Unit and integration tests for the `ico research` command (E9-B01).
 *
 * Unit tests mock `@ico/kernel` and `workspace-resolver.js` following the
 * promote.test.ts pattern. Integration tests use real temp directories with
 * actual kernel calls via `vi.importActual`.
 *
 * @module commands/research.test
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — top-level so vitest can hoist them correctly
// ---------------------------------------------------------------------------

vi.mock('@ico/kernel', async () => {
  const actual = await vi.importActual<typeof import('@ico/kernel')>('@ico/kernel');
  return {
    ...actual,
    initDatabase: vi.fn(() => ({ ok: true, value: {} })),
    closeDatabase: vi.fn(),
    createTask: vi.fn(),
    archiveTask: vi.fn(),
    appendAuditLog: vi.fn(() => ({ ok: true, value: undefined })),
  };
});

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import * as kernelModule from '@ico/kernel';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { runArchive, runResearch } from './research.js';

// ===========================================================================
// UNIT TESTS (mocked kernel)
// ===========================================================================

let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ico-research-unit-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: set up workspace mock with task directory
// ---------------------------------------------------------------------------

function mockWorkspace(): void {
  mkdirSync(join(tmpBase, '.ico'), { recursive: true });
  writeFileSync(join(tmpBase, '.ico', 'state.db'), '');

  vi.mocked(resolveWorkspace).mockReturnValue({
    ok: true,
    value: { root: tmpBase, dbPath: join(tmpBase, '.ico', 'state.db') },
  });
}

function mockCreateTask(taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'): void {
  const taskPath = `tasks/tsk-${taskId}`;
  // Create the task directory so writeFileSync succeeds
  mkdirSync(join(tmpBase, taskPath), { recursive: true });

  vi.mocked(kernelModule.createTask).mockReturnValue({
    ok: true,
    value: {
      id: taskId,
      brief: 'Test research brief',
      status: 'created',
      created_at: '2026-04-08T12:00:00.000Z',
      updated_at: '2026-04-08T12:00:00.000Z',
      completed_at: null,
      archived_at: null,
      workspace_path: taskPath,
    },
  });
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe('runResearch — result shape', () => {
  it('returns correct ResearchResult shape on success', () => {
    mockWorkspace();
    mockCreateTask();

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const result = runResearch('How does attention scale?', {});

    stdoutSpy.mockRestore();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({
      taskId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      brief: 'How does attention scale?',
      status: 'created',
      workspacePath: 'tasks/tsk-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      createdAt: '2026-04-08T12:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// brief.md writing
// ---------------------------------------------------------------------------

describe('runResearch — brief.md', () => {
  it('writes brief.md with frontmatter containing task_id', () => {
    mockWorkspace();
    mockCreateTask();

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    runResearch('Summarise the Turing paper', {});

    stdoutSpy.mockRestore();

    const briefPath = join(tmpBase, 'tasks/tsk-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'brief.md');
    expect(existsSync(briefPath)).toBe(true);

    const content = readFileSync(briefPath, 'utf-8');
    expect(content).toContain('task_id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(content).toContain('created_at: 2026-04-08T12:00:00.000Z');
    expect(content).toContain('status: created');
    expect(content).toContain('Summarise the Turing paper');
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe('runResearch — audit log', () => {
  it('calls appendAuditLog with research.create', () => {
    mockWorkspace();
    mockCreateTask();

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    runResearch('Test brief', {});

    stdoutSpy.mockRestore();

    expect(kernelModule.appendAuditLog).toHaveBeenCalledOnce();
    expect(kernelModule.appendAuditLog).toHaveBeenCalledWith(
      tmpBase,
      'research.create',
      expect.stringContaining('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    );
  });
});

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

describe('runResearch — human output', () => {
  it('includes task ID and workspace path', () => {
    mockWorkspace();
    mockCreateTask();

    const stdoutMessages: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
      stdoutMessages.push(String(msg));
      return true;
    });

    runResearch('Test brief', {});

    stdoutSpy.mockRestore();

    const output = stdoutMessages.join('');
    expect(output).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(output).toContain('tasks/tsk-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(output).toContain('Research task created');
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe('runResearch — JSON output', () => {
  it('emits valid JSON with correct fields', () => {
    mockWorkspace();
    mockCreateTask();

    const stdoutMessages: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
      stdoutMessages.push(String(msg));
      return true;
    });

    runResearch('Test brief', { json: true });

    stdoutSpy.mockRestore();

    const raw = stdoutMessages.join('');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['taskId']).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(parsed['brief']).toBe('Test brief');
    expect(parsed['status']).toBe('created');
    expect(parsed['workspacePath']).toBe('tasks/tsk-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(parsed['createdAt']).toBe('2026-04-08T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('runResearch — error paths', () => {
  it('returns error when workspace resolution fails', () => {
    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: false,
      error: new Error('No workspace found'),
    });

    const result = runResearch('Test brief', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('No workspace found');
  });

  it('returns error when createTask fails', () => {
    mockWorkspace();

    vi.mocked(kernelModule.createTask).mockReturnValue({
      ok: false,
      error: new Error('SQLite constraint violation'),
    });

    const result = runResearch('Test brief', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('SQLite constraint violation');
  });
});

// ---------------------------------------------------------------------------
// Database cleanup
// ---------------------------------------------------------------------------

describe('runResearch — database cleanup', () => {
  it('closes database in finally (even on error)', () => {
    mockWorkspace();

    vi.mocked(kernelModule.createTask).mockReturnValue({
      ok: false,
      error: new Error('task creation failed'),
    });

    runResearch('Test brief', {});

    expect(kernelModule.closeDatabase).toHaveBeenCalledOnce();
  });

  it('closes database on success path', () => {
    mockWorkspace();
    mockCreateTask();

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    runResearch('Test brief', {});

    stdoutSpy.mockRestore();

    expect(kernelModule.closeDatabase).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// INTEGRATION TESTS (real temp dirs, real kernel via importActual)
// ===========================================================================

describe('runResearch — integration tests', () => {
  let realKernel: Awaited<ReturnType<typeof vi.importActual<typeof import('@ico/kernel')>>>;

  let tmpDir: string;
  let workspacePath: string;
  let dbPath: string;

  beforeEach(async () => {
    realKernel = await vi.importActual<typeof import('@ico/kernel')>('@ico/kernel');

    tmpDir = mkdtempSync(join(tmpdir(), 'ico-research-integ-'));

    const wsResult = realKernel.initWorkspace('test-research', tmpDir);
    if (!wsResult.ok) throw wsResult.error;
    workspacePath = wsResult.value.root;
    dbPath = wsResult.value.dbPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates directory structure via createTask', () => {
    const dbResult = realKernel.initDatabase(dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const db = dbResult.value;

    try {
      const taskResult = realKernel.createTask(db, workspacePath, 'Integration test brief');
      expect(taskResult.ok).toBe(true);
      if (!taskResult.ok) return;

      const task = taskResult.value;
      const taskDir = join(workspacePath, task.workspace_path);

      expect(existsSync(join(taskDir, 'evidence'))).toBe(true);
      expect(existsSync(join(taskDir, 'notes'))).toBe(true);
      expect(existsSync(join(taskDir, 'drafts'))).toBe(true);
      expect(existsSync(join(taskDir, 'critique'))).toBe(true);
      expect(existsSync(join(taskDir, 'output'))).toBe(true);
    } finally {
      realKernel.closeDatabase(db);
    }
  });

  it('SQLite record has status created', () => {
    const dbResult = realKernel.initDatabase(dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const db = dbResult.value;

    try {
      const taskResult = realKernel.createTask(db, workspacePath, 'Status check brief');
      expect(taskResult.ok).toBe(true);
      if (!taskResult.ok) return;

      const getResult = realKernel.getTask(db, taskResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).not.toBeNull();
      expect(getResult.value!.status).toBe('created');
    } finally {
      realKernel.closeDatabase(db);
    }
  });

  it('brief.md exists with correct content after manual write', () => {
    const dbResult = realKernel.initDatabase(dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const db = dbResult.value;

    try {
      const taskResult = realKernel.createTask(db, workspacePath, 'Brief content test');
      expect(taskResult.ok).toBe(true);
      if (!taskResult.ok) return;

      const task = taskResult.value;
      const briefPath = join(workspacePath, task.workspace_path, 'brief.md');

      const briefContent = [
        '---',
        `task_id: ${task.id}`,
        `created_at: ${task.created_at}`,
        `status: ${task.status}`,
        '---',
        '',
        'Brief content test',
        '',
      ].join('\n');
      writeFileSync(briefPath, briefContent, 'utf-8');

      expect(existsSync(briefPath)).toBe(true);
      const content = readFileSync(briefPath, 'utf-8');
      expect(content).toContain(`task_id: ${task.id}`);
      expect(content).toContain('Brief content test');
    } finally {
      realKernel.closeDatabase(db);
    }
  });

  it('trace event written for task.create', () => {
    const dbResult = realKernel.initDatabase(dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const db = dbResult.value;

    try {
      const taskResult = realKernel.createTask(db, workspacePath, 'Trace test brief');
      expect(taskResult.ok).toBe(true);
      if (!taskResult.ok) return;

      const traces = realKernel.readTraces(db, { eventType: 'task.create' });
      expect(traces.ok).toBe(true);
      if (!traces.ok) return;

      expect(traces.value.length).toBeGreaterThanOrEqual(1);
      expect(traces.value[0]!.event_type).toBe('task.create');
    } finally {
      realKernel.closeDatabase(db);
    }
  });

  it('audit log contains research.create entry', () => {
    const dbResult = realKernel.initDatabase(dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const db = dbResult.value;

    try {
      const taskResult = realKernel.createTask(db, workspacePath, 'Audit log test');
      expect(taskResult.ok).toBe(true);
      if (!taskResult.ok) return;

      realKernel.appendAuditLog(
        workspacePath,
        'research.create',
        `Created research task ${taskResult.value.id}: "Audit log test"`,
      );

      const auditLog = readFileSync(join(workspacePath, 'audit', 'log.md'), 'utf-8');
      expect(auditLog).toContain('research.create');
      expect(auditLog).toContain(taskResult.value.id);
    } finally {
      realKernel.closeDatabase(db);
    }
  });
});

// ===========================================================================
// runArchive (E10-B09 — coverage closure)
// ===========================================================================

describe('runArchive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockWs(): void {
    mkdirSync(join(tmpBase, '.ico'), { recursive: true });
    writeFileSync(join(tmpBase, '.ico', 'state.db'), '');
    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: true,
      value: { root: tmpBase, dbPath: join(tmpBase, '.ico', 'state.db') },
    });
  }

  function mockArchiveOk(taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'): void {
    vi.mocked(kernelModule.archiveTask).mockReturnValue({
      ok: true,
      value: {
        taskId,
        status: 'archived',
        archivedAt: '2026-05-16T12:00:00.000Z',
        workspacePath: `tasks/tsk-${taskId}`,
      },
    });
  }

  it('returns ResearchArchiveResult on success', () => {
    mockWs();
    mockArchiveOk('11111111-2222-3333-4444-555555555555');
    const r = runArchive('11111111-2222-3333-4444-555555555555', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('archived');
    expect(r.value.taskId).toBe('11111111-2222-3333-4444-555555555555');
    expect(r.value.workspacePath).toMatch(/^tasks\/tsk-/);
    expect(r.value.archivedAt).toMatch(/^\d{4}-/);
  });

  it('emits JSON output when --json is passed', () => {
    mockWs();
    mockArchiveOk();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runArchive('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { json: true });
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('"taskId"');
    expect(joined).toContain('"status": "archived"');
    writeSpy.mockRestore();
  });

  it('emits the human summary when --json is not passed', () => {
    mockWs();
    mockArchiveOk();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runArchive('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {});
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('Research task archived');
    expect(joined).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(joined).toContain('Status:');
    writeSpy.mockRestore();
  });

  it('returns workspace-resolver errors verbatim', () => {
    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: false,
      error: new Error('No workspace found'),
    });
    const r = runArchive('id', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('No workspace found');
  });

  it('returns initDatabase errors verbatim', () => {
    mockWs();
    vi.mocked(kernelModule.initDatabase).mockReturnValueOnce({
      ok: false,
      error: new Error('DB unreachable'),
    });
    const r = runArchive('id', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('DB unreachable');
  });

  it('returns archiveTask errors verbatim', () => {
    mockWs();
    vi.mocked(kernelModule.archiveTask).mockReturnValue({
      ok: false,
      error: new Error('Task not found'),
    });
    const r = runArchive('nonexistent', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Task not found');
  });

  it('closes the database on success', () => {
    mockWs();
    mockArchiveOk();
    runArchive('id', {});
    expect(kernelModule.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('closes the database on archiveTask error', () => {
    mockWs();
    vi.mocked(kernelModule.archiveTask).mockReturnValue({
      ok: false,
      error: new Error('boom'),
    });
    runArchive('id', {});
    expect(kernelModule.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('forwards --workspace to the resolver', () => {
    mockWs();
    mockArchiveOk();
    runArchive('id', { workspace: '/some/path' });
    const call = vi.mocked(resolveWorkspace).mock.calls[0]![0];
    expect(call).toMatchObject({ workspace: '/some/path' });
  });
});
