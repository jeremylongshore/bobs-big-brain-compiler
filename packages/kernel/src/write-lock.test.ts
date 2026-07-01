/**
 * Tests for the ~/.teamkb single-writer lock (e06.5 reuse of e06.12 flock / R13).
 *
 * The lock serialises the on-push incremental compile against the nightly
 * compile + backup. These tests inject a fake `spawn` so we exercise the three
 * outcomes — acquired-and-ran, contended-skip-graceful, flock-missing-degraded —
 * deterministically, without a real filesystem lock or the `flock` binary.
 */

import type { spawn as SpawnFn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveLockPath, withWriteLock } from './write-lock.js';

// ---------------------------------------------------------------------------
// Fake child-process plumbing
// ---------------------------------------------------------------------------

/** A minimal fake of the ChildProcess surface withWriteLock touches. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  stdin = { end: vi.fn() };
}

/**
 * Build a fake `spawn` that returns scripted children per invocation.
 *
 * The helper spawns `flock --version` (the probe) first when `flockAvailable`
 * is not injected, then the holder `flock -w N -x LOCK cat`. Our tests inject
 * `flockAvailable` so only the holder spawn happens — one child per call.
 */
function makeSpawn(behavior: 'acquire' | 'contended'): {
  spawnFn: typeof SpawnFn;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const spawnFn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    if (behavior === 'contended') {
      // Simulate `flock` timing out: the holder process closes almost
      // immediately (before the deferred critical section runs).
      child.exitCode = 1;
      queueMicrotask(() => child.emit('close', 1));
    }
    // 'acquire': the child stays alive (exitCode null) until stdin.end() is
    // called by the helper, at which point we emit close.
    return child;
  });
  // The fake only implements the surface withWriteLock touches; cast through
  // unknown to the real spawn signature for the injected-spawner parameter.
  return { spawnFn: spawnFn as unknown as typeof SpawnFn, children };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('resolveLockPath', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('honors TEAMKB_LOCK first', () => {
    process.env['TEAMKB_LOCK'] = '/custom/.write.lock';
    expect(resolveLockPath()).toBe('/custom/.write.lock');
  });

  it('falls back to TEAMKB_HOME/.write.lock', () => {
    delete process.env['TEAMKB_LOCK'];
    process.env['TEAMKB_HOME'] = '/brain';
    expect(resolveLockPath()).toBe('/brain/.write.lock');
  });

  it('an explicit path overrides the environment', () => {
    process.env['TEAMKB_LOCK'] = '/env/.write.lock';
    expect(resolveLockPath('/explicit/.write.lock')).toBe('/explicit/.write.lock');
  });
});

describe('withWriteLock', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the critical section WITHOUT a lock in flock-missing degraded mode', async () => {
    const fn = vi.fn(() => 'ran');
    const result = await withWriteLock(fn, { flockAvailable: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ran).toBe(true);
    expect(result.value.locked).toBe(false);
    expect(result.value.value).toBe('ran');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('acquires the lock, runs fn, and releases by closing the holder stdin', async () => {
    const { spawnFn, children } = makeSpawn('acquire');
    const fn = vi.fn(() => 42);

    const result = await withWriteLock(fn, {
      flockAvailable: true,
      spawnFn,
      lockPath: '/tmp/does-not-need-to-exist/.write.lock',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ran).toBe(true);
    expect(result.value.locked).toBe(true);
    expect(result.value.value).toBe(42);
    // Released the lock by ending the holder's stdin (→ `cat` exits → unlock).
    expect(children[0]?.stdin.end).toHaveBeenCalledOnce();
    // The holder was spawned as `flock -w <n> -x <lock> cat`.
    expect(spawnFn).toHaveBeenCalledWith(
      'flock',
      ['-w', '10', '-x', '/tmp/does-not-need-to-exist/.write.lock', 'cat'],
      expect.anything(),
    );
  });

  it('SKIPS gracefully (ran=false, no error) when another writer holds the lock', async () => {
    const { spawnFn } = makeSpawn('contended');
    const fn = vi.fn(() => 'should-not-run');

    const result = await withWriteLock(fn, {
      flockAvailable: true,
      spawnFn,
      lockPath: '/tmp/does-not-need-to-exist/.write.lock',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Skip-graceful: the callback never ran, and this is NOT an error.
    expect(result.value.ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('honors a custom wait timeout in the flock invocation', async () => {
    const { spawnFn } = makeSpawn('acquire');
    await withWriteLock(() => undefined, {
      flockAvailable: true,
      spawnFn,
      waitSeconds: 3,
      lockPath: '/tmp/x/.write.lock',
    });
    expect(spawnFn).toHaveBeenCalledWith(
      'flock',
      ['-w', '3', '-x', '/tmp/x/.write.lock', 'cat'],
      expect.anything(),
    );
  });

  it('propagates a callback error as err (lock still released)', async () => {
    const { spawnFn, children } = makeSpawn('acquire');
    const result = await withWriteLock(
      (): number => {
        throw new Error('boom');
      },
      { flockAvailable: true, spawnFn, lockPath: '/tmp/x/.write.lock' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('boom');
    // Even on error the lock is released.
    expect(children[0]?.stdin.end).toHaveBeenCalledOnce();
  });
});
