/**
 * Unit tests for the `ico audit verify` CLI command handler (bvf).
 *
 * Tests exercise `runAuditVerify` directly, mocking the kernel verifier
 * (`verifyAuditChain`) and the workspace resolver. They cover the
 * operator-side concerns the CLI handler owns: workspace resolution,
 * exit-code semantics (0/1/2), --json envelope shaping, named per-break
 * detail in tampered-chain output. The kernel verifier itself is covered
 * by `packages/kernel/src/audit-verify.test.ts`.
 *
 * Per bvf acceptance: clean chain → exit 0; tampered chain → exit
 * non-zero with the offending event index named.
 *
 * @module commands/audit.test
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
    verifyAuditChain: vi.fn(),
  };
});

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { verifyAuditChain } from '@ico/kernel';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { runAuditVerify } from './audit.js';

// ---------------------------------------------------------------------------
// Per-test scaffolding
// ---------------------------------------------------------------------------

let tmpWs: string;
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  tmpWs = mkdtempSync(join(tmpdir(), 'ico-audit-cli-test-'));
  mkdirSync(join(tmpWs, '.ico'), { recursive: true });
  writeFileSync(join(tmpWs, '.ico', 'state.db'), '');

  vi.clearAllMocks();

  vi.mocked(resolveWorkspace).mockReturnValue({
    ok: true,
    value: { root: tmpWs, dbPath: join(tmpWs, '.ico', 'state.db') },
  });

  // The handler uses `process.exitCode = N; return` rather than process.exit,
  // so each test must save and restore process.exitCode rather than expecting
  // a throw. Matches the convention in packages/cli/src/commands/audit.ts.
  originalExitCode = process.exitCode;
  process.exitCode = 0;

  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpWs, { recursive: true, force: true });
  process.exitCode = originalExitCode;
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function fakeCommand(globalOpts: Record<string, unknown> = {}): Command {
  return {
    optsWithGlobals: () => globalOpts,
  } as unknown as Command;
}

function stdoutText(): string {
  const calls = stdoutSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

function stderrText(): string {
  const calls = stderrSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

// ---------------------------------------------------------------------------
// Clean chain — exit code 0
// ---------------------------------------------------------------------------

describe('runAuditVerify — clean chain', () => {
  it('exits 0 with "audit chain OK" stdout when no breaks detected', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: { filesScanned: 3, totalEvents: 42, cleanFiles: 3, breaks: [] },
    });
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(0);
    expect(stdoutText()).toMatch(/audit chain OK/);
    expect(stdoutText()).toMatch(/Files scanned: 3/);
    expect(stdoutText()).toMatch(/Total events:\s+42/);
    expect(stdoutText()).toMatch(/Clean files:\s+3/);
  });

  it('exits 0 even on an empty workspace (zero files scanned)', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: { filesScanned: 0, totalEvents: 0, cleanFiles: 0, breaks: [] },
    });
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(0);
    expect(stdoutText()).toMatch(/audit chain OK/);
  });
});

// ---------------------------------------------------------------------------
// Tampered chain — exit code 2 with offending event index NAMED
// ---------------------------------------------------------------------------

describe('runAuditVerify — tampered chain', () => {
  it('exits 2 when one break is detected', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: {
        filesScanned: 1,
        totalEvents: 5,
        cleanFiles: 0,
        breaks: [
          {
            file: '2026-05-24.jsonl',
            lineIndex: 2,
            expectedPrevHash: 'a'.repeat(64),
            actualPrevHash: 'b'.repeat(64),
            excerpt: '{"event_id":"deadbeef","prev_hash":"bbbb..."}',
          },
        ],
      },
    });
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(2);
  });

  it('names the offending file + line index in stderr', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: {
        filesScanned: 1,
        totalEvents: 5,
        cleanFiles: 0,
        breaks: [
          {
            file: '2026-05-24.jsonl',
            lineIndex: 2,
            expectedPrevHash: 'a'.repeat(64),
            actualPrevHash: 'b'.repeat(64),
            excerpt: '{"event_id":"deadbeef"}',
          },
        ],
      },
    });
    runAuditVerify({}, fakeCommand());
    const err = stderrText();
    expect(err).toMatch(/AUDIT_TAMPERED/);
    expect(err).toMatch(/2026-05-24\.jsonl/);
    expect(err).toMatch(/line 2/);
    expect(err).toMatch(/expected prev_hash=a{64}/);
    expect(err).toMatch(/got b{64}/);
    expect(err).toMatch(/deadbeef/); // excerpt of the offending event
  });

  it('lists every break when multiple are detected', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: {
        filesScanned: 2,
        totalEvents: 10,
        cleanFiles: 0,
        breaks: [
          {
            file: '2026-05-23.jsonl',
            lineIndex: 1,
            expectedPrevHash: 'a'.repeat(64),
            actualPrevHash: null,
            excerpt: 'GARBAGE_LINE',
          },
          {
            file: '2026-05-24.jsonl',
            lineIndex: 4,
            expectedPrevHash: 'c'.repeat(64),
            actualPrevHash: 'd'.repeat(64),
            excerpt: '{"event_id":"tamper"}',
          },
        ],
      },
    });
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(2);
    const err = stderrText();
    expect(err).toMatch(/2 chain break\(s\) detected/);
    expect(err).toMatch(/2026-05-23\.jsonl line 1/);
    expect(err).toMatch(/2026-05-24\.jsonl line 4/);
    expect(err).toMatch(/GARBAGE_LINE/);
    expect(err).toMatch(/tamper/);
  });

  it('handles a null actualPrevHash (unparseable line) cleanly', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: {
        filesScanned: 1,
        totalEvents: 1,
        cleanFiles: 0,
        breaks: [
          {
            file: '2026-05-24.jsonl',
            lineIndex: 1,
            expectedPrevHash: 'a'.repeat(64),
            actualPrevHash: null,
            excerpt: 'NOT_JSON_GARBAGE',
          },
        ],
      },
    });
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(2);
    expect(stderrText()).toMatch(/got null/);
  });
});

// ---------------------------------------------------------------------------
// --json output mode
// ---------------------------------------------------------------------------

describe('runAuditVerify — --json output', () => {
  it('emits a parseable JSON envelope on clean chain (exit 0)', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: { filesScanned: 2, totalEvents: 7, cleanFiles: 2, breaks: [] },
    });
    runAuditVerify({ json: true }, fakeCommand());
    expect(process.exitCode).toBe(0);
    const out = stdoutText().trim();
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['filesScanned']).toBe(2);
    expect(parsed['totalEvents']).toBe(7);
    expect(parsed['cleanFiles']).toBe(2);
    expect(parsed['breaks']).toEqual([]);
    // Formatted human output must NOT appear in --json mode.
    expect(out).not.toMatch(/audit chain OK/);
  });

  it('emits a parseable JSON envelope on tampered chain (exit 2)', () => {
    const breakDetail = {
      file: '2026-05-24.jsonl',
      lineIndex: 2,
      expectedPrevHash: 'a'.repeat(64),
      actualPrevHash: 'b'.repeat(64),
      excerpt: '{"event_id":"deadbeef"}',
    };
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: {
        filesScanned: 1,
        totalEvents: 5,
        cleanFiles: 0,
        breaks: [breakDetail],
      },
    });
    runAuditVerify({ json: true }, fakeCommand());
    expect(process.exitCode).toBe(2);
    const out = stdoutText().trim();
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['breaks']).toEqual([breakDetail]);
    // Formatted human stderr output must NOT appear in --json mode.
    expect(stderrText()).toBe('');
  });

  it('accepts --json passed via the global commander options', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: { filesScanned: 0, totalEvents: 0, cleanFiles: 0, breaks: [] },
    });
    runAuditVerify({}, fakeCommand({ json: true }));
    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('runAuditVerify — error paths', () => {
  it('exits 1 with "Workspace error" on workspace resolution failure', () => {
    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: false,
      error: { message: 'no workspace here', code: 'WORKSPACE_NOT_FOUND' } as never,
    });
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toMatch(/Workspace error/);
    expect(stderrText()).toMatch(/no workspace here/);
    expect(verifyAuditChain).not.toHaveBeenCalled();
  });

  it('exits 1 on kernel verifier failure (filesystem error)', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: false,
      error: new Error('EACCES on audit/traces/'),
    });
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toMatch(/audit verify failed/);
    expect(stderrText()).toMatch(/EACCES/);
  });

  it('--json mode emits structured error envelopes on workspace failure', () => {
    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: false,
      error: { message: 'no workspace here', code: 'WORKSPACE_NOT_FOUND' } as never,
    });
    runAuditVerify({ json: true }, fakeCommand());
    expect(process.exitCode).toBe(1);
    const out = stdoutText().trim();
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['error']).toMatch(/no workspace here/);
    expect(parsed['code']).toBe('WORKSPACE_ERROR');
    expect(stderrText()).toBe('');
  });

  it('--json mode emits structured error envelopes on verifier failure', () => {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: false,
      error: new Error('disk read failed'),
    });
    runAuditVerify({ json: true }, fakeCommand());
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['error']).toMatch(/disk read failed/);
    expect(parsed['code']).toBe('VERIFY_FAILED');
  });
});
