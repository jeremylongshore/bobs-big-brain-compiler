/**
 * Unit tests for the `ico spool emit` CLI command handler (zp6).
 *
 * Tests exercise `runSpoolEmit` directly, mocking the kernel emitter and the
 * workspace resolver. They cover the operator-side concerns the CLI handler
 * owns: tenantId resolution, --scope validation, --out path-safety,
 * --dry-run / live-emit branching, exit-code mapping. The kernel emitter
 * itself is covered by `packages/kernel/src/spool.test.ts`.
 *
 * @module commands/spool.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('@ico/kernel', async () => {
  const actual = await vi.importActual<typeof import('@ico/kernel')>('@ico/kernel');
  return {
    ...actual,
    initDatabase: vi.fn(() => ({ ok: true, value: {} as never })),
    closeDatabase: vi.fn(),
    emitSpool: vi.fn(),
    dryRunSpool: vi.fn(),
    loadConfig: vi.fn(() => ({})),
    SpoolError: actual.SpoolError,
  };
});

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  closeDatabase,
  dryRunSpool,
  emitSpool,
  initDatabase,
  loadConfig,
  SpoolError,
} from '@ico/kernel';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { runSpoolEmit } from './spool.js';

// ---------------------------------------------------------------------------
// Per-test scaffolding
// ---------------------------------------------------------------------------

let tmpWs: string;
// Explicit MockInstance typing so .mock.calls/.mockRestore() aren't `any`
// — keeps the test scaffolding lint-clean without per-line disables.
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let exitSpy: MockInstance<typeof process.exit>;

beforeEach(() => {
  tmpWs = mkdtempSync(join(tmpdir(), 'ico-spool-cli-test-'));
  mkdirSync(join(tmpWs, '.ico'), { recursive: true });
  writeFileSync(join(tmpWs, '.ico', 'state.db'), '');

  vi.clearAllMocks();

  vi.mocked(resolveWorkspace).mockReturnValue({
    ok: true,
    value: { root: tmpWs, dbPath: join(tmpWs, '.ico', 'state.db') },
  });
  vi.mocked(loadConfig).mockReturnValue({} as never);

  // process.exit must throw — otherwise test execution continues past it and
  // assertions about exit code become unreliable.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpWs, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

/**
 * Build a fake commander Command whose `optsWithGlobals` returns the given
 * global flags. The handler only consumes that one method.
 */
function fakeCommand(globalOpts: Record<string, unknown> = {}): Command {
  return {
    optsWithGlobals: () => globalOpts,
  } as unknown as Command;
}

function expectExit(code: number, fn: () => void): void {
  expect(fn).toThrow(`__exit__:${code}`);
}

function stderrText(): string {
  const calls = stderrSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

function stdoutText(): string {
  const calls = stdoutSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

/**
 * Build a complete `SpoolDryRunSummary` shape with defaults so each test
 * can override just the fields it cares about. Keeps the test bodies
 * focused on the behaviour under exam rather than struct boilerplate.
 */
function makeDryRunSummary(
  partial: Partial<{
    wouldEmit: Array<{
      id: string;
      title: string;
      category: 'architecture' | 'decision' | 'pattern';
      sourcePath: string;
      contentBytes: number;
    }>;
    skipped: Array<{
      path: string;
      code: 'MISSING_TITLE' | 'EMPTY_CONTENT' | 'CONTENT_TOO_LARGE';
      detail: string;
    }>;
  }> = {},
): never {
  return {
    scope: 'wiki' as const,
    tenantId: 't',
    outDir: '/ws/spool',
    wouldEmit: partial.wouldEmit ?? [],
    skipped: partial.skipped ?? [],
  } as never;
}

// ---------------------------------------------------------------------------
// tenantId resolution
// ---------------------------------------------------------------------------

describe('runSpoolEmit — tenantId resolution', () => {
  it('refuses with exit code 2 when no tenantId from flag or config', () => {
    vi.mocked(loadConfig).mockReturnValue({} as never);
    expectExit(2, () => runSpoolEmit({ scope: 'wiki', dryRun: true }, fakeCommand()));
    expect(stderrText()).toMatch(/tenantId is required/);
    expect(stderrText()).toMatch(/--tenant/);
    expect(dryRunSpool).not.toHaveBeenCalled();
  });

  it('uses --tenant flag when provided', () => {
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary(),
    });
    expectExit(0, () =>
      runSpoolEmit({ scope: 'wiki', dryRun: true, tenant: 'flag-tenant' }, fakeCommand()),
    );
    expect(dryRunSpool).toHaveBeenCalledWith(
      tmpWs,
      expect.objectContaining({ tenantId: 'flag-tenant' }),
    );
  });

  it('falls back to spool.tenantId from workspace config when flag absent', () => {
    vi.mocked(loadConfig).mockReturnValue({ spool: { tenantId: 'config-tenant' } } as never);
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary(),
    });
    expectExit(0, () => runSpoolEmit({ scope: 'wiki', dryRun: true }, fakeCommand()));
    expect(dryRunSpool).toHaveBeenCalledWith(
      tmpWs,
      expect.objectContaining({ tenantId: 'config-tenant' }),
    );
  });

  it('flag wins over config when both are present', () => {
    vi.mocked(loadConfig).mockReturnValue({ spool: { tenantId: 'config-tenant' } } as never);
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary(),
    });
    expectExit(0, () =>
      runSpoolEmit({ scope: 'wiki', dryRun: true, tenant: 'flag-tenant' }, fakeCommand()),
    );
    expect(dryRunSpool).toHaveBeenCalledWith(
      tmpWs,
      expect.objectContaining({ tenantId: 'flag-tenant' }),
    );
  });

  it('refuses empty-string tenant flag and falls through to config', () => {
    vi.mocked(loadConfig).mockReturnValue({ spool: { tenantId: 'config-tenant' } } as never);
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary(),
    });
    expectExit(0, () =>
      runSpoolEmit({ scope: 'wiki', dryRun: true, tenant: '   ' }, fakeCommand()),
    );
    expect(dryRunSpool).toHaveBeenCalledWith(
      tmpWs,
      expect.objectContaining({ tenantId: 'config-tenant' }),
    );
  });
});

// ---------------------------------------------------------------------------
// --scope validation
// ---------------------------------------------------------------------------

describe('runSpoolEmit — --scope validation', () => {
  it('rejects invalid --scope with exit code 2', () => {
    expectExit(2, () =>
      runSpoolEmit({ scope: 'bogus' as 'wiki', dryRun: true, tenant: 't' }, fakeCommand()),
    );
    expect(stderrText()).toMatch(/Invalid --scope/);
    expect(stderrText()).toMatch(/wiki/);
    expect(stderrText()).toMatch(/outputs/);
    expect(stderrText()).toMatch(/all/);
  });

  it.each(['wiki', 'outputs', 'all'] as const)('accepts valid --scope value %s', (scope) => {
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary(),
    });
    expectExit(0, () => runSpoolEmit({ scope, dryRun: true, tenant: 't' }, fakeCommand()));
    expect(dryRunSpool).toHaveBeenCalledWith(tmpWs, expect.objectContaining({ scope }));
  });

  it('defaults to wiki when --scope omitted', () => {
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary(),
    });
    expectExit(0, () => runSpoolEmit({ dryRun: true, tenant: 't' }, fakeCommand()));
    expect(dryRunSpool).toHaveBeenCalledWith(tmpWs, expect.objectContaining({ scope: 'wiki' }));
  });
});

// ---------------------------------------------------------------------------
// --out path safety
// ---------------------------------------------------------------------------

describe('runSpoolEmit — --out path safety', () => {
  it('rejects --out that resolves outside the workspace', () => {
    expectExit(1, () =>
      runSpoolEmit(
        { scope: 'wiki', dryRun: true, tenant: 't', out: '/tmp/outside-ws' },
        fakeCommand(),
      ),
    );
    expect(stderrText()).toMatch(/--out must resolve to a path inside the workspace/);
    expect(dryRunSpool).not.toHaveBeenCalled();
  });

  it('accepts --out that resolves under the workspace', () => {
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary(),
    });
    expectExit(0, () =>
      runSpoolEmit(
        { scope: 'wiki', dryRun: true, tenant: 't', out: 'spool/custom' },
        fakeCommand(),
      ),
    );
    expect(dryRunSpool).toHaveBeenCalledWith(
      tmpWs,
      expect.objectContaining({ outDir: join(tmpWs, 'spool/custom') }),
    );
  });

  it('defaults --out to <workspace>/spool when omitted', () => {
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary(),
    });
    expectExit(0, () => runSpoolEmit({ scope: 'wiki', dryRun: true, tenant: 't' }, fakeCommand()));
    expect(dryRunSpool).toHaveBeenCalledWith(
      tmpWs,
      expect.objectContaining({ outDir: join(tmpWs, 'spool') }),
    );
  });
});

// ---------------------------------------------------------------------------
// --dry-run vs live-emit branching
// ---------------------------------------------------------------------------

describe('runSpoolEmit — dry-run branching', () => {
  it('dry-run path never touches the database', () => {
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary(),
    });
    expectExit(0, () => runSpoolEmit({ scope: 'wiki', dryRun: true, tenant: 't' }, fakeCommand()));
    expect(initDatabase).not.toHaveBeenCalled();
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(emitSpool).not.toHaveBeenCalled();
    expect(dryRunSpool).toHaveBeenCalledTimes(1);
  });

  it('dry-run prints summary including would-emit and skipped counts', () => {
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary({
        wouldEmit: [
          {
            id: 'aaaa-bbbb',
            category: 'architecture',
            title: 'A topic',
            contentBytes: 1234,
            sourcePath: 'wiki/topics/a.md',
          },
        ],
        skipped: [{ path: 'wiki/orphan.md', code: 'MISSING_TITLE', detail: 'missing title' }],
      }),
    });
    expectExit(0, () => runSpoolEmit({ scope: 'wiki', dryRun: true, tenant: 't' }, fakeCommand()));
    const out = stdoutText();
    expect(out).toMatch(/Dry-run summary/);
    expect(out).toMatch(/Would emit 1 candidate/);
    expect(out).toMatch(/1 skipped/);
    expect(out).toMatch(/A topic/);
    expect(out).toMatch(/MISSING_TITLE/);
  });

  it('dry-run never prints candidate content body', () => {
    const SECRET = '__SECRET_CONTENT_NOT_FOR_DRYRUN__';
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: true,
      value: makeDryRunSummary({
        wouldEmit: [
          {
            id: 'aaaa-bbbb',
            category: 'architecture',
            title: 'A topic',
            contentBytes: SECRET.length,
            sourcePath: 'wiki/topics/a.md',
          },
        ],
      }),
    });
    expectExit(0, () => runSpoolEmit({ scope: 'wiki', dryRun: true, tenant: 't' }, fakeCommand()));
    expect(stdoutText()).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// Live-emit path: success
// ---------------------------------------------------------------------------

describe('runSpoolEmit — live emit success', () => {
  it('opens DB, calls emitSpool, closes DB, prints success summary', () => {
    vi.mocked(emitSpool).mockReturnValue({
      ok: true,
      value: {
        emittedCount: 3,
        spoolFile: '/ws/spool/spool-2026-05-28T210000Z.jsonl',
        manifestFile: '/ws/spool/spool-2026-05-28T210000Z.jsonl.manifest.json',
        spoolFileBytes: 4096,
        spoolFileSha256: 'deadbeef'.repeat(8),
        skipped: [],
      },
    });
    // Live-emit success path returns normally (no process.exit) — call directly.
    runSpoolEmit({ scope: 'wiki', tenant: 't' }, fakeCommand());
    expect(initDatabase).toHaveBeenCalledTimes(1);
    expect(emitSpool).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);

    const out = stdoutText();
    expect(out).toMatch(/Emitted 3 candidate/);
    expect(out).toMatch(/Manifest:/);
    expect(out).toMatch(/SHA-256:/);
    expect(out).toMatch(/deadbeef/);
  });

  it('closes DB even when emitSpool returns an error', () => {
    vi.mocked(emitSpool).mockReturnValue({
      ok: false,
      error: new SpoolError('write boom', 'WRITE_FAILED'),
    });
    expectExit(4, () => runSpoolEmit({ scope: 'wiki', tenant: 't' }, fakeCommand()));
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('surfaces skipped-candidate warnings on stdout', () => {
    vi.mocked(emitSpool).mockReturnValue({
      ok: true,
      value: {
        emittedCount: 1,
        spoolFile: '/ws/spool/x.jsonl',
        manifestFile: '/ws/spool/x.jsonl.manifest.json',
        spoolFileBytes: 100,
        spoolFileSha256: 'a'.repeat(64),
        skipped: [{ path: 'wiki/orphan.md', code: 'MISSING_TITLE', detail: 'missing title' }],
      },
    });
    // Live-emit success path returns normally (no process.exit) — call directly.
    runSpoolEmit({ scope: 'wiki', tenant: 't' }, fakeCommand());
    const out = stdoutText();
    expect(out).toMatch(/1 candidate\(s\) skipped/);
    expect(out).toMatch(/MISSING_TITLE/);
  });
});

// ---------------------------------------------------------------------------
// Live-emit path: error → exit-code mapping
// ---------------------------------------------------------------------------

describe('runSpoolEmit — SpoolError → exit-code mapping', () => {
  it.each([
    ['NO_TENANT_ID', 2],
    ['WRITE_FAILED', 4],
    ['TRACE_FAILED', 5],
  ] as const)('maps SpoolError code %s to exit code %i', (code, exitCode) => {
    vi.mocked(emitSpool).mockReturnValue({
      ok: false,
      error: new SpoolError(`mock ${code}`, code),
    });
    expectExit(exitCode, () => runSpoolEmit({ scope: 'wiki', tenant: 't' }, fakeCommand()));
    expect(stderrText()).toMatch(new RegExp(`mock ${code}`));
  });

  it('maps unknown SpoolError code to generic exit code 1', () => {
    vi.mocked(emitSpool).mockReturnValue({
      ok: false,
      error: new SpoolError('mock unknown', 'WORKSPACE_NOT_FOUND'),
    });
    expectExit(1, () => runSpoolEmit({ scope: 'wiki', tenant: 't' }, fakeCommand()));
  });

  it('maps dry-run failure to exit code 1', () => {
    vi.mocked(dryRunSpool).mockReturnValue({
      ok: false,
      error: new SpoolError('dry-run boom', 'WORKSPACE_NOT_FOUND'),
    });
    expectExit(1, () => runSpoolEmit({ scope: 'wiki', dryRun: true, tenant: 't' }, fakeCommand()));
    expect(stderrText()).toMatch(/Dry-run failed/);
  });

  it('maps initDatabase failure to exit code 1', () => {
    vi.mocked(initDatabase).mockReturnValue({
      ok: false,
      error: new Error('db init failure'),
    });
    expectExit(1, () => runSpoolEmit({ scope: 'wiki', tenant: 't' }, fakeCommand()));
    expect(stderrText()).toMatch(/Database error/);
    expect(emitSpool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Workspace resolution failure
// ---------------------------------------------------------------------------

describe('runSpoolEmit — workspace resolution failure', () => {
  it('exits 1 with friendly error when workspace cannot be resolved', () => {
    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: false,
      error: { message: 'no workspace here', code: 'WORKSPACE_NOT_FOUND' } as never,
    });
    expectExit(1, () => runSpoolEmit({ scope: 'wiki', tenant: 't' }, fakeCommand()));
    expect(stderrText()).toMatch(/Workspace error/);
    expect(stderrText()).toMatch(/no workspace here/);
  });
});
