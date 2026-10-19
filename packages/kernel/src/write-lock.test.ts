/**
 * Tests for the ~/.teamkb single-writer lock (e06.5 reuse of e06.12 flock / R13).
 *
 * The lock serialises the on-push incremental compile against the nightly
 * compile + backup. Most tests inject a fake `spawn` so we exercise each
 * outcome (acquired-and-ran, contended-skip-graceful, flock failure,
 * flock-missing-degraded) deterministically. The `real flock` suite then holds
 * an actual lock from another process, because a fake cannot prove exclusion.
 */

import { spawn, type spawn as SpawnFn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveLockPath, withWriteLock } from './write-lock.js';

// ---------------------------------------------------------------------------
// Fake child-process plumbing
// ---------------------------------------------------------------------------

/** A minimal fake of the ChildProcess surface withWriteLock touches. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  stdin = { end: vi.fn() };
  stdout = new EventEmitter();
}

/**
 * Build a fake `spawn` that returns scripted children per invocation.
 *
 * The helper spawns `flock --version` (the probe) first when `flockAvailable`
 * is not injected, then the holder `flock -E 75 -w N -x LOCK sh -c …`. Our
 * tests inject `flockAvailable` so only the holder spawn happens — one child
 * per call.
 */
function makeSpawn(behavior: 'acquire' | 'contended' | 'fail'): {
  spawnFn: typeof SpawnFn;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const spawnFn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    if (behavior === 'acquire') {
      // flock holds the lock, so the holder shell prints the signal.
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('locked')));
    } else {
      // The wait expired (75) or flock failed (1) without ever printing.
      const code = behavior === 'contended' ? 75 : 1;
      child.exitCode = code;
      queueMicrotask(() => child.emit('close', code));
    }
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

  it('refuses to run in degraded mode when requireLock is true', async () => {
    const fn = vi.fn(() => 'should-not-run');
    const result = await withWriteLock(fn, {
      flockAvailable: false,
      requireLock: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/flock is required/i);
    expect(fn).not.toHaveBeenCalled();
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
    // The holder signals acquisition from inside flock, then blocks in cat.
    expect(spawnFn).toHaveBeenCalledWith(
      'flock',
      [
        '-E',
        '75',
        '-w',
        '10',
        '-x',
        '/tmp/does-not-need-to-exist/.write.lock',
        'sh',
        '-c',
        'command -v cat >/dev/null && printf locked && exec cat',
      ],
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

  it('reports a flock failure as an error, never as contention', async () => {
    const { spawnFn } = makeSpawn('fail');
    const fn = vi.fn(() => 'should-not-run');
    const result = await withWriteLock(fn, {
      flockAvailable: true,
      spawnFn,
      lockPath: '/tmp/x/.write.lock',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/flock exited with code 1 before acquiring/);
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
      expect.arrayContaining(['-w', '3', '-x', '/tmp/x/.write.lock']),
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

const hasFlock = spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasFlock)('withWriteLock with a real flock', () => {
  let dir: string;
  let lockPath: string;
  let holder: ReturnType<typeof spawn> | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ico-write-lock-'));
    lockPath = join(dir, '.write.lock');
  });

  afterEach(async () => {
    // Wait for the holder to exit so it cannot touch the directory mid-delete.
    const exiting = holder;
    holder = undefined;
    if (exiting !== undefined && exiting.exitCode === null && exiting.signalCode === null) {
      await new Promise<void>((resolve) => {
        exiting.once('close', () => resolve());
        exiting.stdin?.end();
      });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Hold the lock from another process, resolving once it is really held. */
  const holdLock = (): Promise<void> =>
    new Promise((resolve, reject) => {
      // Closing its stdin ends `cat`, the last process holding the lock.
      holder = spawn('flock', ['-x', lockPath, 'sh', '-c', 'printf held; exec cat'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      holder.stdout?.once('data', () => resolve());
      holder.once('error', reject);
    });

  it('does not run the critical section while another process holds the lock', async () => {
    await holdLock();
    const fn = vi.fn(() => 'should-not-run');
    const started = Date.now();
    const result = await withWriteLock(fn, { lockPath, waitSeconds: 1, requireLock: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ ran: false, locked: true });
    expect(fn).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('runs only after the other holder releases', async () => {
    await holdLock();
    let releasedAt = 0;
    setTimeout(() => {
      releasedAt = Date.now();
      holder?.stdin?.end();
    }, 300);
    let ranAt = 0;
    const result = await withWriteLock(
      () => {
        ranAt = Date.now();
        return 'ran';
      },
      { lockPath, waitSeconds: 5, requireLock: true },
    );
    expect(result.ok && result.value.ran).toBe(true);
    expect(releasedAt).toBeGreaterThan(0);
    expect(ranAt).toBeGreaterThanOrEqual(releasedAt);
  });

  it('releases the lock after the critical section so the next writer acquires', async () => {
    const first = await withWriteLock(() => 1, { lockPath, waitSeconds: 1, requireLock: true });
    const second = await withWriteLock(() => 2, { lockPath, waitSeconds: 1, requireLock: true });
    expect(first.ok && first.value.value).toBe(1);
    expect(second.ok && second.value.value).toBe(2);
  });
});
