/**
 * Tests for the top-level process-error handlers in `index.ts`
 * (`installProcessHandlers` + the `shouldEmitStack` decision it embeds).
 *
 * Strategy: install the handlers, capture the listener functions we added
 * (diffing process listeners before/after), and invoke them *directly* with
 * `process.exit` + `process.stderr.write` mocked — no real `process.emit`, so
 * vitest's own handlers are never disturbed. Listeners + the install guard are
 * cleaned up after each test.
 *
 * Part of bead `intentional-cognition-os-0wy.7` (CLI coverage climb — branch
 * coverage on the entry module).
 *
 * @module index.handlers.test
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { installProcessHandlers } from './index.js';

type Listener = (...args: unknown[]) => void;
const EVENTS = ['uncaughtException', 'unhandledRejection', 'SIGINT'] as const;
type EventName = (typeof EVENTS)[number];

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const GUARD = '__icoHandlersInstalled';
function clearGuard(): void {
  delete (process as unknown as Record<string, unknown>)[GUARD];
}

let before: Record<EventName, Listener[]>;
let exitSpy: MockInstance;
let stderrSpy: MockInstance;
let stderr: string;
let origArgv: string[];

beforeEach(() => {
  origArgv = process.argv;
  clearGuard();
  before = { uncaughtException: [], unhandledRejection: [], SIGINT: [] };
  for (const ev of EVENTS) before[ev] = process.listeners(ev) as Listener[];

  stderr = '';
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  // Remove only the listeners we added; leave vitest's intact.
  for (const ev of EVENTS) {
    for (const l of process.listeners(ev) as Listener[]) {
      if (!before[ev].includes(l)) process.removeListener(ev, l);
    }
  }
  clearGuard();
  exitSpy.mockRestore();
  stderrSpy.mockRestore();
  process.argv = origArgv;
});

/** Install handlers and return the listener we added for each event. */
function capture(): Record<EventName, Listener> {
  installProcessHandlers();
  const out = {} as Record<EventName, Listener>;
  for (const ev of EVENTS) {
    const added = (process.listeners(ev) as Listener[]).filter((l) => !before[ev].includes(l));
    out[ev] = added[added.length - 1]!;
  }
  return out;
}

function expectExit(code: number, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExitError) {
      expect(e.code).toBe(code);
      return;
    }
    throw e;
  }
  throw new Error(`expected process.exit(${code}) but it was not called`);
}

describe('installProcessHandlers', () => {
  it('is idempotent — a second call registers no new listeners', () => {
    installProcessHandlers();
    const counts = EVENTS.map((ev) => process.listeners(ev).length);
    installProcessHandlers(); // guard short-circuits
    const counts2 = EVENTS.map((ev) => process.listeners(ev).length);
    expect(counts2).toEqual(counts);
  });

  it('uncaughtException: prints a friendly [ico] line, exits 1, and emits the stack for an unmapped error', () => {
    const h = capture();
    expectExit(1, () => h.uncaughtException(new Error('boom')));
    expect(stderr).toContain('[ico] uncaught exception:');
    expect(stderr).toContain('boom');
    // unmapped → friendly === message → stack emitted
    expect(stderr).toMatch(/\n\s+at /);
  });

  it('unhandledRejection: a non-Error reason exits 1 with no stack', () => {
    const h = capture();
    expectExit(1, () => h.unhandledRejection('plain string reason'));
    expect(stderr).toContain('[ico] unhandled rejection:');
    expect(stderr).toContain('plain string reason');
    expect(stderr).not.toMatch(/\n\s+at /); // not an Error → no stack
  });

  it('uncaughtException: a mapped error suppresses the stack (friendly differs from message)', () => {
    const h = capture();
    expectExit(1, () => h.uncaughtException(new Error('database is locked')));
    expect(stderr).toContain('Workspace database is locked');
    expect(stderr).not.toMatch(/\n\s+at /); // mapped + no --verbose → no stack
  });

  it('uncaughtException: --verbose forces the stack even for a mapped error', () => {
    process.argv = [...origArgv, '--verbose'];
    const h = capture();
    expectExit(1, () => h.uncaughtException(new Error('database is locked')));
    expect(stderr).toContain('Workspace database is locked');
    expect(stderr).toMatch(/\n\s+at /); // --verbose → stack
  });

  it('SIGINT: prints the interrupt line and exits 130', () => {
    const h = capture();
    expectExit(130, () => h.SIGINT());
    expect(stderr).toContain('interrupted');
  });
});
