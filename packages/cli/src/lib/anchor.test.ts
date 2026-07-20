/**
 * Tests for the operator-side anchoring helpers (l13.8): anchor-file
 * resolution precedence and the best-effort post-compile hook. The kernel
 * append/verify logic is covered by packages/kernel/src/audit-anchor.test.ts;
 * the git commit is exercised only via a mock (no real repo in unit tests).
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

vi.mock('@ico/kernel', async () => {
  const actual = await vi.importActual<typeof import('@ico/kernel')>('@ico/kernel');
  return { ...actual, appendIcoAnchor: vi.fn() };
});

import { appendIcoAnchor } from '@ico/kernel';

import { anchorAfterCompile, resolveAnchorFile } from './anchor.js';

const OLD_ENV = process.env['ICO_ANCHOR_FILE'];
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['ICO_ANCHOR_FILE'];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  if (OLD_ENV === undefined) delete process.env['ICO_ANCHOR_FILE'];
  else process.env['ICO_ANCHOR_FILE'] = OLD_ENV;
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe('resolveAnchorFile', () => {
  it('prefers the explicit flag over the env var', () => {
    process.env['ICO_ANCHOR_FILE'] = '/env/path.jsonl';
    expect(resolveAnchorFile('/flag/path.jsonl')).toBe('/flag/path.jsonl');
  });

  it('falls back to ICO_ANCHOR_FILE when no flag is given', () => {
    process.env['ICO_ANCHOR_FILE'] = '/env/path.jsonl';
    expect(resolveAnchorFile()).toBe('/env/path.jsonl');
  });

  it('returns undefined when neither is set', () => {
    expect(resolveAnchorFile()).toBeUndefined();
    expect(resolveAnchorFile('   ')).toBeUndefined();
  });
});

describe('anchorAfterCompile', () => {
  it('is a no-op when anchoring is not configured', () => {
    anchorAfterCompile('/ws');
    expect(appendIcoAnchor).not.toHaveBeenCalled();
  });

  it('warns (never throws) when the append fails', () => {
    process.env['ICO_ANCHOR_FILE'] = '/anchors.jsonl';
    vi.mocked(appendIcoAnchor).mockReturnValue({ ok: false, error: new Error('boom') });
    expect(() => anchorAfterCompile('/ws')).not.toThrow();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('reports the no-op path when the head is unchanged', () => {
    process.env['ICO_ANCHOR_FILE'] = '/anchors.jsonl';
    vi.mocked(appendIcoAnchor).mockReturnValue({
      ok: true,
      value: {
        record: {
          schemaVersion: 1,
          anchoredAt: 'x',
          workspaceId: 'ws',
          totalEvents: 1,
          chainHead: 'h',
          prevAnchorHash: null,
          anchorHash: 'a',
        },
        appended: false,
      },
    });
    anchorAfterCompile('/ws');
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/unchanged/);
  });
});
