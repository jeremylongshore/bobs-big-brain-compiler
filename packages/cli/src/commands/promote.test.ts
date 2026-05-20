/**
 * Unit tests for the `ico promote` command (E8-B05).
 *
 * Tests exercise `runPromote` directly without spawning a child process.
 * The kernel's `promoteArtifact` function and workspace resolver are mocked
 * so tests run without real database or filesystem state.
 *
 * @module commands/promote.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('@ico/kernel', async () => {
  const actual = await vi.importActual<typeof import('@ico/kernel')>('@ico/kernel');
  return {
    ...actual,
    initDatabase: vi.fn(() => ({ ok: true, value: {} })),
    closeDatabase: vi.fn(),
    promoteArtifact: vi.fn(),
    // Re-export constants so the module under test can use them
    VALID_PROMOTION_TYPES: actual.VALID_PROMOTION_TYPES,
    PromotionError: actual.PromotionError,
  };
});

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import * as kernelModule from '@ico/kernel';
import { PromotionError } from '@ico/kernel';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { runPromote } from './promote.js';

// ---------------------------------------------------------------------------
// Per-test workspace setup
// ---------------------------------------------------------------------------

let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ico-promote-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: set up workspace mock
// ---------------------------------------------------------------------------

function mockWorkspace(): void {
  mkdirSync(join(tmpBase, '.ico'), { recursive: true });
  writeFileSync(join(tmpBase, '.ico', 'state.db'), '');

  vi.mocked(resolveWorkspace).mockReturnValue({
    ok: true,
    value: { root: tmpBase, dbPath: join(tmpBase, '.ico', 'state.db') },
  });
}

// ---------------------------------------------------------------------------
// --as validation
// ---------------------------------------------------------------------------

describe('runPromote — --as validation', () => {
  it('sets exitCode=2 and writes error when --as is not provided', () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    const stderrMessages: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrMessages.push(String(msg));
      return true;
    });

    runPromote('outputs/reports/my.md', {}, {});

    spy.mockRestore();
    expect(process.exitCode).toBe(2);
    expect(stderrMessages.join('')).toContain('--as <type> is required');

    process.exitCode = originalExitCode as number | undefined;
  });

  it('sets exitCode=2 and writes error when --as has an invalid type', () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    const stderrMessages: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrMessages.push(String(msg));
      return true;
    });

    runPromote('outputs/reports/my.md', { as: 'invalid-type' }, {});

    spy.mockRestore();
    expect(process.exitCode).toBe(2);
    expect(stderrMessages.join('')).toContain('Invalid type');
    expect(stderrMessages.join('')).toContain('invalid-type');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// Workspace resolution failure
// ---------------------------------------------------------------------------

describe('runPromote — workspace resolution failure', () => {
  it('sets exitCode=1 when workspace cannot be resolved', () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: false,
      error: new Error('No workspace found'),
    });

    const stderrMessages: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrMessages.push(String(msg));
      return true;
    });

    runPromote('outputs/reports/my.md', { as: 'topic' }, {});

    spy.mockRestore();
    expect(process.exitCode).toBe(1);
    expect(stderrMessages.join('')).toContain('No workspace found');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// --dry-run
// ---------------------------------------------------------------------------

describe('runPromote — --dry-run', () => {
  it('shows a preview and does not call promoteArtifact', () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    mockWorkspace();

    const stdoutMessages: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
      stdoutMessages.push(String(msg));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runPromote('outputs/reports/my-report.md', { as: 'topic', dryRun: true }, {});

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    // Should NOT have promoted
    expect(kernelModule.promoteArtifact).not.toHaveBeenCalled();
    // Should have shown preview info
    expect(process.exitCode).toBe(0);
    const output = stdoutMessages.join('');
    expect(output).toContain('Dry-run preview');
    expect(output).toContain('my-report.md');
    expect(output).toContain('topic');

    process.exitCode = originalExitCode as number | undefined;
  });

  it('exits cleanly (exitCode 0) after dry-run preview', () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    mockWorkspace();

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runPromote('outputs/reports/my-report.md', { as: 'concept', dryRun: true }, {});

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(process.exitCode).toBe(0);

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// Confirmation gate (no --yes)
// ---------------------------------------------------------------------------

describe('runPromote — without --yes', () => {
  it('shows confirmation requirement and sets exitCode=1 without calling promoteArtifact', () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    mockWorkspace();

    const stdoutMessages: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
      stdoutMessages.push(String(msg));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runPromote('outputs/reports/my-report.md', { as: 'topic' }, {});

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(process.exitCode).toBe(1);
    expect(kernelModule.promoteArtifact).not.toHaveBeenCalled();
    const output = stdoutMessages.join('');
    expect(output).toContain('--yes');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// Successful promotion (with --yes)
// ---------------------------------------------------------------------------

describe('runPromote — successful promotion', () => {
  it('calls promoteArtifact with confirm:true and shows success message', () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    mockWorkspace();

    vi.mocked(kernelModule.promoteArtifact).mockReturnValue({
      ok: true,
      value: {
        promotionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sourcePath: 'outputs/reports/my-report.md',
        targetPath: 'wiki/topics/my-report.md',
        targetType: 'topic',
        sourceHash: 'sha256:abc123',
      },
    });

    const stdoutMessages: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
      stdoutMessages.push(String(msg));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runPromote('outputs/reports/my-report.md', { as: 'topic', yes: true }, {});

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(process.exitCode).toBe(0);
    expect(kernelModule.promoteArtifact).toHaveBeenCalledOnce();
    expect(kernelModule.promoteArtifact).toHaveBeenCalledWith(expect.anything(), tmpBase, {
      sourcePath: 'outputs/reports/my-report.md',
      targetType: 'topic',
      confirm: true,
    });

    const output = stdoutMessages.join('');
    expect(output).toContain('Promoted:');
    expect(output).toContain('wiki/topics/my-report.md');
    expect(output).toContain('ico lint knowledge');

    process.exitCode = originalExitCode as number | undefined;
  });

  it('shows both source and target in the success output', () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    mockWorkspace();

    vi.mocked(kernelModule.promoteArtifact).mockReturnValue({
      ok: true,
      value: {
        promotionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        sourcePath: 'outputs/reports/self-attention.md',
        targetPath: 'wiki/concepts/self-attention.md',
        targetType: 'concept',
        sourceHash: 'sha256:def456',
      },
    });

    const stdoutMessages: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
      stdoutMessages.push(String(msg));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runPromote('outputs/reports/self-attention.md', { as: 'concept', yes: true }, {});

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    const output = stdoutMessages.join('');
    expect(output).toContain('self-attention.md');
    expect(output).toContain('concept');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// PromotionError code → exit code mapping
// ---------------------------------------------------------------------------

describe('runPromote — PromotionError exit code mapping', () => {
  const errorCases: Array<{ code: string; expectedExitCode: number }> = [
    { code: 'INELIGIBLE_PATH', expectedExitCode: 1 },
    { code: 'FILE_NOT_FOUND', expectedExitCode: 1 },
    { code: 'EMPTY_FILE', expectedExitCode: 1 },
    { code: 'MISSING_FRONTMATTER', expectedExitCode: 1 },
    { code: 'INVALID_TYPE', expectedExitCode: 2 },
    { code: 'DRAFT_REJECTED', expectedExitCode: 3 },
    { code: 'EVIDENCE_REJECTED', expectedExitCode: 3 },
    { code: 'NOT_CONFIRMED', expectedExitCode: 3 },
    { code: 'TARGET_EXISTS', expectedExitCode: 4 },
    { code: 'COPY_FAILED', expectedExitCode: 4 },
    { code: 'AUDIT_WRITE_FAILED', expectedExitCode: 5 },
  ];

  for (const { code, expectedExitCode } of errorCases) {
    it(`maps PromotionError(${code}) to exitCode=${expectedExitCode}`, () => {
      const originalExitCode = process.exitCode;
      process.exitCode = 0;

      mockWorkspace();

      vi.mocked(kernelModule.promoteArtifact).mockReturnValue({
        ok: false,
        error: new PromotionError(
          code as import('@ico/kernel').PromotionErrorCode,
          `Simulated ${code}`,
        ),
      });

      const stderrMessages: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
        stderrMessages.push(String(msg));
        return true;
      });
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      runPromote('outputs/reports/test.md', { as: 'topic', yes: true }, {});

      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();

      expect(process.exitCode).toBe(expectedExitCode);
      const errorOutput = stderrMessages.join('');
      expect(errorOutput).toContain(`Simulated ${code}`);

      process.exitCode = originalExitCode as number | undefined;
    });
  }
});

// ---------------------------------------------------------------------------
// All valid promotion types are accepted
// ---------------------------------------------------------------------------

describe('runPromote — all valid promotion types', () => {
  const validTypes = ['topic', 'concept', 'entity', 'reference'] as const;

  for (const type of validTypes) {
    it(`accepts --as ${type}`, () => {
      const originalExitCode = process.exitCode;
      process.exitCode = 0;

      mockWorkspace();

      vi.mocked(kernelModule.promoteArtifact).mockReturnValue({
        ok: true,
        value: {
          promotionId: '00000000-0000-0000-0000-000000000000',
          sourcePath: 'outputs/reports/test.md',
          targetPath: `wiki/${type}s/test.md`,
          targetType: type,
          sourceHash: 'sha256:000',
        },
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      runPromote('outputs/reports/test.md', { as: type, yes: true }, {});

      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();

      expect(process.exitCode).toBe(0);
      expect(kernelModule.promoteArtifact).toHaveBeenCalledWith(
        expect.anything(),
        tmpBase,
        expect.objectContaining({ targetType: type }),
      );

      process.exitCode = originalExitCode as number | undefined;
    });
  }
});
