/**
 * Unit tests for the `ico compile` command — specifically the bug `u0j` fix
 * that makes runSummarize fail loudly on auth errors and all-source failures
 * instead of silently exiting 0 with empty wiki dirs.
 *
 * Failure semantics (Gemini review, PR #154): a pass no longer calls
 * `process.exit` mid-run — it THROWS a `CompilePassError` carrying the intended
 * exit code, so the CLI action handler can close the database before exit.
 * These tests assert on the thrown error + its `.exitCode` rather than a mocked
 * `process.exit`.
 *
 * Tests exercise `runSummarize` directly with mocked kernel + compiler deps.
 * The kernel modules and `summarizeSource` are mocked at the @ico/* package
 * boundary; readFileSync and rebuildWikiIndex side-effects are stubbed.
 *
 * @module commands/compile.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('@ico/compiler', async () => {
  const actual = await vi.importActual<typeof import('@ico/compiler')>('@ico/compiler');
  return {
    ...actual,
    summarizeSource: vi.fn(),
    getUncompiledSources: vi.fn(),
    createClaudeClient: vi.fn(() => ({}) as never),
  };
});

vi.mock('@ico/kernel', async () => {
  const actual = await vi.importActual<typeof import('@ico/kernel')>('@ico/kernel');
  return {
    ...actual,
    rebuildWikiIndex: vi.fn(),
    computeFileHash: vi.fn(() => ({ ok: true, value: 'fake-hash' })),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { getUncompiledSources, summarizeSource } from '@ico/compiler';

import { type CompileContext, CompilePassError, isAuthError, runSummarize } from './compile.js';

// ---------------------------------------------------------------------------
// Per-test scaffolding
// ---------------------------------------------------------------------------

let tmpWs: string;
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let exitSpy: MockInstance<typeof process.exit>;

beforeEach(() => {
  tmpWs = mkdtempSync(join(tmpdir(), 'ico-compile-test-'));
  mkdirSync(join(tmpWs, 'raw'), { recursive: true });

  vi.clearAllMocks();

  // A pass must NOT call process.exit (that would bypass the action handler's
  // DB cleanup). This spy throws if it is ever called, so any accidental
  // process.exit surfaces as a hard test failure rather than a silent regression.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0}) must not be called from a pass`);
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

function stderrText(): string {
  const calls = stderrSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

function stdoutText(): string {
  const calls = stdoutSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

/**
 * Build a minimal CompileContext for runSummarize. The mocked deps make
 * `db` and `client` unused, but TypeScript requires the shape.
 */
function makeCtx(): CompileContext {
  return {
    workspacePath: tmpWs,
    dbPath: join(tmpWs, '.ico', 'state.db'),
    db: {} as never,
    client: {} as never,
    model: 'claude-sonnet-4-6',
  };
}

/**
 * Stub a source file on disk under the workspace so readFileSync inside
 * runSummarize succeeds for the source path the test injects.
 */
function writeSource(relPath: string, content: string): void {
  const abs = join(tmpWs, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/**
 * Assert the pass fails by THROWING a CompilePassError carrying `code` — and
 * that it never called process.exit (which would strand the DB open). Invokes
 * `fn` exactly once so callers can still assert mock call counts afterward. The
 * name is retained from the pre-#154 process.exit era; the contract is a throw.
 */
async function expectExit(code: number, fn: () => Promise<void>): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(CompilePassError);
  expect((thrown as CompilePassError).exitCode).toBe(code);
  expect(exitSpy).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// isAuthError helper
// ---------------------------------------------------------------------------

describe('isAuthError', () => {
  it.each([
    'Claude API authentication_error (HTTP 401): Invalid API key',
    'Claude API permission_error (HTTP 403): forbidden',
    'invalid_api_key error received',
    'something HTTP 401 something',
  ])('detects auth error in: %s', (msg) => {
    expect(isAuthError(msg)).toBe(true);
  });

  it.each([
    'Claude API rate_limit_error (HTTP 429): too many requests',
    'Claude API server_error (HTTP 503): bad gateway',
    'Network error: ETIMEDOUT',
    'plain text without any auth markers',
  ])('does NOT flag non-auth errors: %s', (msg) => {
    expect(isAuthError(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runSummarize — auth error fast-fail (the load-bearing u0j fix)
// ---------------------------------------------------------------------------

describe('runSummarize — auth error fast-fail (u0j)', () => {
  it('exits 2 on the FIRST source failing with an authentication error', async () => {
    vi.mocked(getUncompiledSources).mockReturnValue({
      ok: true,
      value: [
        { id: 's1', path: 'raw/a.md' } as never,
        { id: 's2', path: 'raw/b.md' } as never,
        { id: 's3', path: 'raw/c.md' } as never,
      ],
    });
    writeSource('raw/a.md', 'body a');
    writeSource('raw/b.md', 'body b');
    writeSource('raw/c.md', 'body c');

    vi.mocked(summarizeSource).mockResolvedValue({
      ok: false,
      error: new Error('Claude API authentication_error (HTTP 401): Invalid API key'),
    });

    await expectExit(2, async () => runSummarize(makeCtx()));

    // Only ONE call — fast-fail prevents burning through every source with
    // the same auth error.
    expect(summarizeSource).toHaveBeenCalledTimes(1);
    expect(stderrText()).toMatch(/authentication failed/i);
    expect(stderrText()).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('exits 2 on permission_error (403) same as 401', async () => {
    vi.mocked(getUncompiledSources).mockReturnValue({
      ok: true,
      value: [{ id: 's1', path: 'raw/a.md' } as never],
    });
    writeSource('raw/a.md', 'body');

    vi.mocked(summarizeSource).mockResolvedValue({
      ok: false,
      error: new Error('Claude API permission_error (HTTP 403): forbidden'),
    });

    await expectExit(2, async () => runSummarize(makeCtx()));
  });
});

// ---------------------------------------------------------------------------
// runSummarize — all-failed sentinel
// ---------------------------------------------------------------------------

describe('runSummarize — all-failed sentinel', () => {
  it('exits 1 when every source fails for non-auth reasons', async () => {
    vi.mocked(getUncompiledSources).mockReturnValue({
      ok: true,
      value: [{ id: 's1', path: 'raw/a.md' } as never, { id: 's2', path: 'raw/b.md' } as never],
    });
    writeSource('raw/a.md', 'body a');
    writeSource('raw/b.md', 'body b');

    // Both fail with non-auth errors → fall-through to end-of-loop sentinel.
    vi.mocked(summarizeSource).mockResolvedValue({
      ok: false,
      error: new Error('Claude API server_error (HTTP 503): bad gateway'),
    });

    await expectExit(1, async () => runSummarize(makeCtx()));

    // Both sources attempted — no fast-fail because not an auth error.
    expect(summarizeSource).toHaveBeenCalledTimes(2);
    expect(stderrText()).toMatch(/ALL 2 source\(s\) failed/);
    expect(stderrText()).toMatch(/Workspace produced no compiled output/);
  });

  it('exits 1 even with a single source if it fails non-auth', async () => {
    vi.mocked(getUncompiledSources).mockReturnValue({
      ok: true,
      value: [{ id: 's1', path: 'raw/a.md' } as never],
    });
    writeSource('raw/a.md', 'body');

    vi.mocked(summarizeSource).mockResolvedValue({
      ok: false,
      error: new Error('Network error: ETIMEDOUT'),
    });

    await expectExit(1, async () => runSummarize(makeCtx()));
  });
});

// ---------------------------------------------------------------------------
// runSummarize — preserved behavior (no regression)
// ---------------------------------------------------------------------------

describe('runSummarize — preserved success / partial-success paths', () => {
  it('completes normally (no throw) when at least one source compiles', async () => {
    vi.mocked(getUncompiledSources).mockReturnValue({
      ok: true,
      value: [{ id: 's1', path: 'raw/a.md' } as never, { id: 's2', path: 'raw/b.md' } as never],
    });
    writeSource('raw/a.md', 'body a');
    writeSource('raw/b.md', 'body b');

    vi.mocked(summarizeSource)
      .mockResolvedValueOnce({
        ok: true,
        value: { outputPath: 'wiki/sources/a.md', tokensUsed: 100 } as never,
      })
      .mockResolvedValueOnce({
        ok: false,
        error: new Error('Network error: ETIMEDOUT'),
      });

    await runSummarize(makeCtx());

    // 1 compiled + 1 failed → partial success, no exit.
    expect(stdoutText()).toMatch(/1 compiled, 0 skipped \(validation\), 1 failed/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('returns normally with a warning when zero uncompiled sources exist', async () => {
    vi.mocked(getUncompiledSources).mockReturnValue({ ok: true, value: [] });

    await runSummarize(makeCtx());

    expect(stdoutText()).toMatch(/No uncompiled sources found/);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(summarizeSource).not.toHaveBeenCalled();
  });

  it('exits 1 when getUncompiledSources fails', async () => {
    vi.mocked(getUncompiledSources).mockReturnValue({
      ok: false,
      error: new Error('DB read failed'),
    });

    await expectExit(1, async () => runSummarize(makeCtx()));
    expect(stderrText()).toMatch(/Failed to list sources/);
    expect(stderrText()).toMatch(/DB read failed/);
  });
});
