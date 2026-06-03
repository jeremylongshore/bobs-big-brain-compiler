/**
 * Command-level tests for `ico compile <target>` — drives the registered
 * Commander action end to end with a real temp workspace + mocked compiler +
 * kernel, so the dispatcher and all six pass runners (extract, synthesize,
 * link, contradict, gap, and the `all` sequence) are exercised through the
 * real code path.
 *
 * Complements `compile.test.ts`, which unit-tests `runSummarize` + `isAuthError`
 * directly. Part of bead `intentional-cognition-os-0wy.7` (CLI coverage climb).
 *
 * @module commands/compile.command.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

vi.mock('@ico/compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ico/compiler')>();
  return {
    ...actual,
    createClaudeClient: vi.fn(() => ({}) as never),
    getUncompiledSources: vi.fn(() => ({ ok: true, value: [] })),
    summarizeSource: vi.fn(),
    extractConcepts: vi.fn(),
    synthesizeTopics: vi.fn(),
    addBacklinks: vi.fn(),
    detectContradictions: vi.fn(),
    identifyGaps: vi.fn(),
  };
});

vi.mock('@ico/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ico/kernel')>();
  return {
    ...actual,
    initDatabase: vi.fn(() => ({ ok: true, value: {} as never })),
    closeDatabase: vi.fn(),
    loadConfig: vi.fn(() => ({ apiKey: 'test-key', model: 'claude-sonnet-4-6' })),
    rebuildWikiIndex: vi.fn(() => ({ ok: true, value: undefined })),
    computeFileHash: vi.fn(() => ({ ok: true, value: 'fake-hash' })),
  };
});

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

// Imports after mocks
import {
  addBacklinks,
  detectContradictions,
  extractConcepts,
  getUncompiledSources,
  identifyGaps,
  synthesizeTopics,
} from '@ico/compiler';
import { initDatabase, loadConfig } from '@ico/kernel';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { register } from './compile.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ok = <T>(value: T) => ({ ok: true as const, value });
const errResult = (message: string) => ({ ok: false as const, error: new Error(message) });

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

let exitSpy: MockInstance;
let wsRoot: string;

beforeEach(() => {
  // A real workspace on disk so collectSummaryPaths (real fs) finds summaries.
  wsRoot = mkdtempSync(join(tmpdir(), 'ico-compile-cmd-'));
  mkdirSync(join(wsRoot, 'wiki', 'sources'), { recursive: true });
  writeFileSync(join(wsRoot, 'wiki', 'sources', 'foo.md'), '---\ntitle: Foo\n---\nbody\n', 'utf-8');

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);

  // Baseline happy-path mocks — individual tests override what they need.
  vi.mocked(resolveWorkspace).mockReturnValue(
    ok({ root: wsRoot, dbPath: join(wsRoot, 'state.db') }) as never,
  );
  vi.mocked(initDatabase).mockReturnValue(ok({} as never));
  vi.mocked(loadConfig).mockReturnValue({
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
  } as never);
  vi.mocked(getUncompiledSources).mockReturnValue({ ok: true, value: [] });
  vi.mocked(extractConcepts).mockResolvedValue(ok([]) as never);
  vi.mocked(synthesizeTopics).mockResolvedValue(ok([]) as never);
  vi.mocked(addBacklinks).mockResolvedValue(ok({ pagesUpdated: 0, totalBacklinks: 0 }) as never);
  vi.mocked(detectContradictions).mockResolvedValue(ok([]) as never);
  vi.mocked(identifyGaps).mockResolvedValue(ok([]) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  rmSync(wsRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function runCompile(args: string[]): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;

  const writeOut = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const writeErr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });

  const program = new Command();
  program.name('ico').option('--workspace <path>', 'Workspace directory').exitOverride();
  register(program);

  try {
    await program.parseAsync(['node', 'ico', 'compile', ...args]);
  } catch (e) {
    if (e instanceof ExitError) exitCode = e.code;
    else if (e && typeof e === 'object' && 'exitCode' in e)
      exitCode = (e as { exitCode: number }).exitCode;
    else throw e;
  } finally {
    writeOut.mockRestore();
    writeErr.mockRestore();
  }
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

describe('ico compile — dispatcher', () => {
  it('rejects an unknown target with exit 1', async () => {
    const r = await runCompile(['bogus']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Unknown compile target');
  });

  it('exits 1 when the workspace cannot be resolved', async () => {
    vi.mocked(resolveWorkspace).mockReturnValue(errResult('no workspace') as never);
    const r = await runCompile(['gaps']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('no workspace');
  });

  it('exits 1 when the database cannot be opened', async () => {
    vi.mocked(initDatabase).mockReturnValue(errResult('db locked') as never);
    const r = await runCompile(['gaps']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('db locked');
  });

  it('exits 1 when config load fails for a non-link target', async () => {
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('missing ANTHROPIC_API_KEY');
    });
    const r = await runCompile(['gaps']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('missing ANTHROPIC_API_KEY');
  });

  it('runs the link pass even when config load fails (deterministic, no key)', async () => {
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('no key');
    });
    vi.mocked(addBacklinks).mockResolvedValue(ok({ pagesUpdated: 2, totalBacklinks: 5 }) as never);
    const r = await runCompile(['links']);
    expect(r.exitCode).toBeNull();
    expect(vi.mocked(addBacklinks)).toHaveBeenCalled();
    expect(r.stdout).toContain('Link pass complete');
  });
});

// ---------------------------------------------------------------------------
// Individual pass runners (success + failure)
// ---------------------------------------------------------------------------

describe('ico compile — pass runners', () => {
  it('concepts: success reports pages written', async () => {
    vi.mocked(extractConcepts).mockResolvedValue(ok(['a.md', 'b.md']) as never);
    const r = await runCompile(['concepts']);
    expect(r.exitCode).toBeNull();
    expect(vi.mocked(extractConcepts)).toHaveBeenCalled();
    expect(r.stdout).toContain('Extract pass complete: 2 pages written');
  });

  it('concepts: a compiler error exits 1', async () => {
    vi.mocked(extractConcepts).mockResolvedValue(errResult('extract boom') as never);
    const r = await runCompile(['concepts']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('extract boom');
  });

  it('concepts: no summaries is a clean no-op', async () => {
    rmSync(join(wsRoot, 'wiki', 'sources', 'foo.md'));
    const r = await runCompile(['concepts']);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('No summaries found');
    expect(vi.mocked(extractConcepts)).not.toHaveBeenCalled();
  });

  it('topics: success reports topic pages written', async () => {
    vi.mocked(synthesizeTopics).mockResolvedValue(ok(['t.md']) as never);
    const r = await runCompile(['topics']);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('Synthesize pass complete: 1 topic pages written');
  });

  it('topics: a compiler error exits 1', async () => {
    vi.mocked(synthesizeTopics).mockResolvedValue(errResult('synth boom') as never);
    const r = await runCompile(['topics']);
    expect(r.exitCode).toBe(1);
  });

  it('links: success reports pages + backlinks', async () => {
    vi.mocked(addBacklinks).mockResolvedValue(ok({ pagesUpdated: 3, totalBacklinks: 9 }) as never);
    const r = await runCompile(['links']);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('3 pages updated, 9 backlinks');
  });

  it('links: a compiler error exits 1', async () => {
    vi.mocked(addBacklinks).mockResolvedValue(errResult('link boom') as never);
    const r = await runCompile(['links']);
    expect(r.exitCode).toBe(1);
  });

  it('contradictions: zero found reports the clean message', async () => {
    vi.mocked(detectContradictions).mockResolvedValue(ok([]) as never);
    const r = await runCompile(['contradictions']);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('no contradictions found');
  });

  it('contradictions: some found reports the count', async () => {
    vi.mocked(detectContradictions).mockResolvedValue(ok([{}, {}]) as never);
    const r = await runCompile(['contradictions']);
    expect(r.stdout).toContain('2 contradiction(s) recorded');
  });

  it('contradictions: a compiler error exits 1', async () => {
    vi.mocked(detectContradictions).mockResolvedValue(errResult('contra boom') as never);
    const r = await runCompile(['contradictions']);
    expect(r.exitCode).toBe(1);
  });

  it('gaps: zero found reports the clean message', async () => {
    vi.mocked(identifyGaps).mockResolvedValue(ok([]) as never);
    const r = await runCompile(['gaps']);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('no gaps identified');
  });

  it('gaps: some found reports the count', async () => {
    vi.mocked(identifyGaps).mockResolvedValue(ok([{}, {}, {}]) as never);
    const r = await runCompile(['gaps']);
    expect(r.stdout).toContain('3 open question(s) recorded');
  });

  it('gaps: a compiler error exits 1', async () => {
    vi.mocked(identifyGaps).mockResolvedValue(errResult('gap boom') as never);
    const r = await runCompile(['gaps']);
    expect(r.exitCode).toBe(1);
  });

  it('sources: no uncompiled sources is a clean no-op', async () => {
    vi.mocked(getUncompiledSources).mockReturnValue({ ok: true, value: [] });
    const r = await runCompile(['sources']);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('No uncompiled sources found');
  });
});

// ---------------------------------------------------------------------------
// `all` sequence
// ---------------------------------------------------------------------------

describe('ico compile all', () => {
  it('runs all six passes in order and reports completion', async () => {
    const r = await runCompile(['all']);
    expect(r.exitCode).toBeNull();
    expect(vi.mocked(extractConcepts)).toHaveBeenCalled();
    expect(vi.mocked(synthesizeTopics)).toHaveBeenCalled();
    expect(vi.mocked(addBacklinks)).toHaveBeenCalled();
    expect(vi.mocked(detectContradictions)).toHaveBeenCalled();
    expect(vi.mocked(identifyGaps)).toHaveBeenCalled();
    expect(r.stdout).toContain('All compilation passes complete');
  });
});
