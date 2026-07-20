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
    // Extended surfaces (l13.7) default to clean so the chain-only exit-code
    // tests below isolate the chain contribution. The kernel verifier itself
    // is covered by packages/kernel/src/audit-surfaces.test.ts.
    verifyAuditSurfaces: vi.fn(() => ({
      ok: true,
      value: {
        indexedTraceFiles: 0,
        indexedEvents: 0,
        unindexedTraceFiles: 0,
        unindexedEvents: 0,
        provenanceFiles: 0,
        provenanceRecords: 0,
        provenanceTraceEvents: 0,
        unreceiptedProvenance: 0,
        spoolFilesChecked: 0,
        spoolManifestsChecked: 0,
        logMd: { present: false, lines: 0, convenienceOnly: true },
        breaks: [],
      },
    })),
    verifyIcoAnchors: vi.fn(() => ({
      ok: true,
      value: { anchorCount: 0, anchorBreaks: [], ok: true },
    })),
    appendIcoAnchor: vi.fn(() => ({
      ok: true,
      value: { record: {}, appended: false },
    })),
    reconcileWorkspace: vi.fn(),
    initDatabase: vi.fn(() => ({ ok: true, value: {} as never })),
    closeDatabase: vi.fn(),
  };
});

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  appendIcoAnchor,
  closeDatabase,
  initDatabase,
  reconcileWorkspace,
  verifyAuditChain,
  verifyAuditSurfaces,
  verifyIcoAnchors,
} from '@ico/kernel';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { runAuditAnchor, runAuditReconcile, runAuditVerify } from './audit.js';

// Silence the anchor-lib git commit path in the anchor-command tests.
vi.mock('../lib/anchor.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/anchor.js')>('../lib/anchor.js');
  return { ...actual, commitAnchorFile: vi.fn(() => ({ committed: false, detail: 'test' })) };
});

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
      value: {
        filesScanned: 3,
        totalEvents: 42,
        cleanFiles: 3,
        breaks: [],
        linkedBoundaries: 0,
        legacyBoundaries: 0,
      },
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
      value: {
        filesScanned: 0,
        totalEvents: 0,
        cleanFiles: 0,
        breaks: [],
        linkedBoundaries: 0,
        legacyBoundaries: 0,
      },
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
        linkedBoundaries: 0,
        legacyBoundaries: 0,
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
        linkedBoundaries: 0,
        legacyBoundaries: 0,
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
        linkedBoundaries: 0,
        legacyBoundaries: 0,
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
    expect(err).toMatch(/2 break\(s\) detected/);
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
        linkedBoundaries: 0,
        legacyBoundaries: 0,
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
      value: {
        filesScanned: 2,
        totalEvents: 7,
        cleanFiles: 2,
        breaks: [],
        linkedBoundaries: 0,
        legacyBoundaries: 0,
      },
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
        linkedBoundaries: 0,
        legacyBoundaries: 0,
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
      value: {
        filesScanned: 0,
        totalEvents: 0,
        cleanFiles: 0,
        breaks: [],
        linkedBoundaries: 0,
        legacyBoundaries: 0,
      },
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

// ---------------------------------------------------------------------------
// runAuditReconcile — quarantine-by-move floor (G1)
// ---------------------------------------------------------------------------

describe('runAuditReconcile', () => {
  it('exits 0 when the corpus is already consistent', () => {
    vi.mocked(reconcileWorkspace).mockReturnValue({
      ok: true,
      value: { scanned: 4, quarantined: [], tmpSwept: [] },
    });
    runAuditReconcile({}, fakeCommand());
    expect(process.exitCode).toBe(0);
    expect(stdoutText()).toMatch(/corpus consistent/);
    expect(stdoutText()).toMatch(/Pages scanned: 4/);
    expect(initDatabase).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('exits 2 and names every moved file when pages were quarantined', () => {
    vi.mocked(reconcileWorkspace).mockReturnValue({
      ok: true,
      value: {
        scanned: 5,
        quarantined: [
          {
            path: 'wiki/topics/orphan.md',
            quarantinedTo: 'quarantine/wiki/topics/orphan.md',
            reason: 'visible page has no matching compilations/promotions receipt row',
          },
        ],
        tmpSwept: [
          {
            path: 'wiki/topics/crashed.md.tmp',
            quarantinedTo: 'quarantine/wiki/topics/crashed.md.tmp',
            reason: 'stale tmp file (older than 3600000ms) — crash orphan',
          },
        ],
      },
    });
    runAuditReconcile({}, fakeCommand());
    expect(process.exitCode).toBe(2);
    const err = stderrText();
    expect(err).toMatch(
      /RECONCILED: 1 unreceipted page\(s\) quarantined, 1 stale tmp file\(s\) swept/,
    );
    expect(err).toMatch(/wiki\/topics\/orphan\.md/);
    expect(err).toMatch(/wiki\/topics\/crashed\.md\.tmp/);
    expect(err).toMatch(/Nothing was deleted/);
  });

  it('exits 1 when the kernel reconciler fails', () => {
    vi.mocked(reconcileWorkspace).mockReturnValue({
      ok: false,
      error: new Error('rename blew up'),
    });
    runAuditReconcile({}, fakeCommand());
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toMatch(/audit reconcile failed: rename blew up/);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('--json emits a machine-readable envelope with the moved entries', () => {
    vi.mocked(reconcileWorkspace).mockReturnValue({
      ok: true,
      value: {
        scanned: 2,
        quarantined: [
          {
            path: 'wiki/topics/orphan.md',
            quarantinedTo: 'quarantine/wiki/topics/orphan.md',
            reason: 'visible page has no matching compilations/promotions receipt row',
          },
        ],
        tmpSwept: [],
      },
    });
    runAuditReconcile({ json: true }, fakeCommand());
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['scanned']).toBe(2);
    expect(Array.isArray(parsed['quarantined'])).toBe(true);
    expect(stderrText()).toBe('');
  });

  it('forwards --tmp-max-age-ms to the kernel reconciler', () => {
    vi.mocked(reconcileWorkspace).mockReturnValue({
      ok: true,
      value: { scanned: 0, quarantined: [], tmpSwept: [] },
    });
    runAuditReconcile({ tmpMaxAgeMs: '0' }, fakeCommand());
    expect(reconcileWorkspace).toHaveBeenCalledWith(expect.anything(), tmpWs, { tmpMaxAgeMs: 0 });
  });
});

// ---------------------------------------------------------------------------
// Extended surfaces + anchors aggregation (l13.7 / l13.8)
// ---------------------------------------------------------------------------

describe('runAuditVerify — extended surfaces', () => {
  function cleanChain(): void {
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: {
        filesScanned: 1,
        totalEvents: 3,
        cleanFiles: 1,
        breaks: [],
        linkedBoundaries: 0,
        legacyBoundaries: 0,
      },
    });
  }

  it('exits 2 when a surface break exists even though the chain is clean', () => {
    cleanChain();
    vi.mocked(verifyAuditSurfaces).mockReturnValueOnce({
      ok: true,
      value: {
        indexedTraceFiles: 1,
        indexedEvents: 3,
        unindexedTraceFiles: 0,
        unindexedEvents: 0,
        provenanceFiles: 0,
        provenanceRecords: 0,
        provenanceTraceEvents: 0,
        unreceiptedProvenance: 0,
        spoolFilesChecked: 0,
        spoolManifestsChecked: 0,
        logMd: { present: false, lines: 0, convenienceOnly: true },
        breaks: [
          {
            surface: 'trace-index',
            code: 'TRACE_FILE_MISSING',
            file: '2026-05-24.jsonl',
            detail: 'gone from disk',
          },
        ],
      },
    });
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(2);
    expect(stderrText()).toMatch(/TRACE_FILE_MISSING/);
  });

  it('--chain-only skips the DB surfaces + anchors and stays exit 0', () => {
    cleanChain();
    runAuditVerify({ chainOnly: true }, fakeCommand());
    expect(process.exitCode).toBe(0);
    expect(vi.mocked(verifyAuditSurfaces)).not.toHaveBeenCalled();
    expect(vi.mocked(initDatabase)).not.toHaveBeenCalled();
  });

  it('includes surfaces + anchors keys in the --json envelope', () => {
    cleanChain();
    runAuditVerify({ json: true }, fakeCommand());
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed).toHaveProperty('surfaces');
    expect(parsed).toHaveProperty('anchors');
    expect(parsed['ok']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Anchor configuration states (HIGH #1) — the three distinct outcomes
// ---------------------------------------------------------------------------

describe('runAuditVerify — anchor configuration states', () => {
  const OLD_ENV = process.env['ICO_ANCHOR_FILE'];
  beforeEach(() => {
    delete process.env['ICO_ANCHOR_FILE'];
    vi.mocked(verifyAuditChain).mockReturnValue({
      ok: true,
      value: {
        filesScanned: 1,
        totalEvents: 3,
        cleanFiles: 1,
        breaks: [],
        linkedBoundaries: 0,
        legacyBoundaries: 0,
      },
    });
  });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env['ICO_ANCHOR_FILE'];
    else process.env['ICO_ANCHOR_FILE'] = OLD_ENV;
  });

  it('UNCONFIGURED: clean chain stays exit 0 and prints the "set the var" hint', () => {
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(0);
    expect(stdoutText()).toMatch(/No external anchor log configured/);
    // The hint tells the operator to SET the var (they have not).
    expect(stdoutText()).toMatch(/set ICO_ANCHOR_FILE/);
  });

  it('CONFIGURED-BUT-MISSING: exits non-zero with a DISTINCT message, not the "set it" hint', () => {
    const missing = join(tmpWs, 'does-not-exist', 'ico-anchors.jsonl');
    runAuditVerify({ anchorFile: missing }, fakeCommand());
    // Non-zero so an unattended CI run cannot read a misconfigured anchor as clean.
    expect(process.exitCode).toBe(2);
    const err = stderrText();
    expect(err).toMatch(/ANCHOR_NOT_FOUND/);
    expect(err).toMatch(/configured but not found/);
    expect(err).toContain(missing);
    // It must NOT tell the operator to set what they already set, and must NOT
    // silently pass as a clean chain.
    expect(stdoutText()).not.toMatch(/set ICO_ANCHOR_FILE/);
    expect(vi.mocked(verifyIcoAnchors)).not.toHaveBeenCalled();
  });

  it('CONFIGURED-BUT-MISSING via ICO_ANCHOR_FILE env also fails', () => {
    process.env['ICO_ANCHOR_FILE'] = join(tmpWs, 'nope.jsonl');
    runAuditVerify({}, fakeCommand());
    expect(process.exitCode).toBe(2);
    expect(stderrText()).toMatch(/ANCHOR_NOT_FOUND/);
  });

  it('CONFIGURED-BUT-MISSING surfaces in the --json envelope', () => {
    runAuditVerify({ json: true, anchorFile: join(tmpWs, 'absent', 'a.jsonl') }, fakeCommand());
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['anchorConfiguredButMissing']).toBe(true);
    expect(process.exitCode).toBe(2);
  });
});

describe('runAuditAnchor', () => {
  const OLD_ENV = process.env['ICO_ANCHOR_FILE'];
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env['ICO_ANCHOR_FILE'];
    else process.env['ICO_ANCHOR_FILE'] = OLD_ENV;
  });

  it('errors (exit 1) when no anchor file is configured', () => {
    delete process.env['ICO_ANCHOR_FILE'];
    runAuditAnchor({}, fakeCommand());
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toMatch(/No anchor file configured/);
  });

  it('appends and reports success when a --anchor-file is given', () => {
    vi.mocked(appendIcoAnchor).mockReturnValueOnce({
      ok: true,
      value: {
        record: {
          schemaVersion: 1,
          anchoredAt: '2026-07-20T00:00:00.000Z',
          workspaceId: 'ws',
          totalEvents: 7,
          chainHead: 'abcdef0123456789',
          prevAnchorHash: null,
          anchorHash: 'deadbeef',
        },
        appended: true,
      },
    });
    runAuditAnchor({ anchorFile: join(tmpWs, 'ico-anchors.jsonl'), commit: false }, fakeCommand());
    expect(process.exitCode).toBe(0);
    expect(stdoutText()).toMatch(/Anchored 7 event/);
  });

  it('reports the no-op path when the head is unchanged', () => {
    vi.mocked(appendIcoAnchor).mockReturnValueOnce({
      ok: true,
      value: {
        record: {
          schemaVersion: 1,
          anchoredAt: '2026-07-20T00:00:00.000Z',
          workspaceId: 'ws',
          totalEvents: 7,
          chainHead: 'abc',
          prevAnchorHash: null,
          anchorHash: 'x',
        },
        appended: false,
      },
    });
    runAuditAnchor({ anchorFile: join(tmpWs, 'ico-anchors.jsonl') }, fakeCommand());
    expect(process.exitCode).toBe(0);
    expect(stdoutText()).toMatch(/unchanged/);
  });
});
