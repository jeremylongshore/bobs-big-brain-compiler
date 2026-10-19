/**
 * Single-writer lock over the live brain directory (bead
 * `compile-then-govern-e06.5` reusing the e06.12 flock; risk 010-AT-RISK R13;
 * umbrella #27).
 *
 * All `~/.teamkb` writers — the nightly `/teamkb-compile`, `teamkb-backup.sh`,
 * and now the e06.5 on-push incremental compile — must serialise on ONE
 * exclusive advisory lock at `${TEAMKB_HOME}/.write.lock`. `govern`'s durable
 * write spans SQLite + file export + qmd index + the anchor git commit
 * NON-atomically, so two overlapping compiles (or a compile racing the backup
 * snapshot) can skew the brain across artifacts (R13).
 *
 * The shell writers take the lock with `flock -w <wait> -x "$LOCK" …`
 * (util-linux `flock(1)`, advisory `LOCK_EX`). To serialise against them from
 * Node — which has no built-in `flock(2)` binding — this helper acquires the
 * SAME advisory lock by spawning
 * `flock -E 75 -w <wait> -x <lock> sh -c 'command -v cat … && printf locked && exec cat'`. `flock`
 * runs the command only once it holds `LOCK_EX`, so the `locked` byte on stdout
 * is the acquisition signal: the callback never starts before it arrives. `cat`
 * then holds the lock while it blocks on an open stdin pipe, and the lock
 * releases the instant we close that pipe (on callback completion). Because it
 * is the identical advisory lock on the identical path, it mutually excludes the
 * shell writers. Exit code 75 means the wait expired; any other exit before the
 * signal is a lock failure, not contention.
 *
 * Contract (mirrors the shell wrapper, `~/bin/teamkb-compile-daily.sh`):
 *   - EXCLUSIVE lock.
 *   - SHORT WAIT (`waitSeconds`, default 10s) — never block forever.
 *   - SKIP-GRACEFUL on contention: if another writer holds the lock past the
 *     wait, {@link withWriteLock} resolves `ok({ ran: false, … })` rather than
 *     erroring. A deferred compile is expected, not an incident — the caller
 *     logs and exits 0.
 *   - If `flock` is not on PATH, the helper runs the callback WITHOUT a lock and
 *     flags `locked: false` (mirrors the shell's degraded-mode warning) so the
 *     caller can surface the same warning rather than silently racing.
 *
 * Never throws — all failure paths resolve `err(Error)`; contention resolves
 * `ok({ ran: false })`.
 *
 * @module write-lock
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link withWriteLock}. */
export interface WriteLockOptions {
  /**
   * Absolute path to the lock file. Defaults to
   * `${TEAMKB_LOCK}` ?? `${TEAMKB_HOME}/.write.lock` ?? `~/.teamkb/.write.lock`
   * — byte-identical to the shell wrappers' resolution.
   */
  lockPath?: string;
  /** Max seconds to wait for the lock before skipping. Default 10 (as shell). */
  waitSeconds?: number;
  /**
   * Injected spawner for tests (defaults to `child_process.spawn`). Lets a test
   * simulate "lock held" / "flock missing" without a real filesystem lock.
   */
  spawnFn?: typeof spawn;
  /** Whether `flock` is available. Defaults to a real PATH probe. Injectable for tests. */
  flockAvailable?: boolean;
  /**
   * Refuse to run when `flock` is unavailable instead of entering degraded
   * mode. Scheduled maintenance uses this because ingest + compile is one
   * logical transaction and must never race another brain writer.
   */
  requireLock?: boolean;
}

/** Outcome of a {@link withWriteLock} attempt. */
export interface WriteLockResult<T> {
  /** Did the callback run? `false` only when the lock was contended (skip-graceful). */
  ran: boolean;
  /** Was an actual advisory lock held while running? `false` in flock-missing degraded mode. */
  locked: boolean;
  /** The callback's return value, present iff `ran === true`. */
  value?: T;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** `flock -E` exit code for "the wait expired while another writer held the lock". */
const FLOCK_TIMEOUT_EXIT = 75;
/** Printed by the holder only after `flock` holds the lock. */
const ACQUIRED_SIGNAL = 'locked';

/** Resolve the canonical lock path, matching the shell wrappers exactly. */
export function resolveLockPath(explicit?: string): string {
  if (explicit != null && explicit !== '') return explicit;
  const envLock = process.env['TEAMKB_LOCK'];
  if (envLock != null && envLock !== '') return envLock;
  const teamkbHome = process.env['TEAMKB_HOME'] ?? join(homedir(), '.teamkb');
  return join(teamkbHome, '.write.lock');
}

/** Best-effort probe: is `flock` runnable? Sync, cheap, no throw. */
function probeFlock(spawnFn: typeof spawn): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawnFn('flock', ['--version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `fn` while holding the exclusive brain write-lock, serialising against
 * every other `~/.teamkb` writer (nightly compile, backup).
 *
 * @param fn      - The critical section. Runs only if the lock is acquired (or
 *                  in flock-missing degraded mode).
 * @param options - Lock path / wait / injected spawner overrides.
 * @returns `ok({ ran: true, locked, value })` when it ran, `ok({ ran: false })`
 *          when the lock was contended (skip-graceful), or `err` on a spawn or
 *          callback failure.
 */
export async function withWriteLock<T>(
  fn: () => Promise<T> | T,
  options?: WriteLockOptions,
): Promise<Result<WriteLockResult<T>, Error>> {
  const spawnFn = options?.spawnFn ?? spawn;
  const waitSeconds = options?.waitSeconds ?? 10;
  const lockPath = resolveLockPath(options?.lockPath);

  const available = options?.flockAvailable ?? (await probeFlock(spawnFn).catch(() => false));

  // Degraded mode: no flock on PATH — run without the lock, flag it so the
  // caller can emit the same warning the shell wrapper does.
  if (!available) {
    if (options?.requireLock === true) {
      return err(new Error('flock is required for this operation but is not available on PATH'));
    }
    try {
      const value = await fn();
      return ok({ ran: true, locked: false, value });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // Ensure the lock file's directory exists (mirrors `mkdir -p "$TEAMKB_HOME"`).
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Acquire: flock runs the shell only once it holds LOCK_EX; the shell
  // prints the acquisition signal and then `cat` blocks on its stdin. Closing
  // that stdin releases the lock.
  return new Promise<Result<WriteLockResult<T>, Error>>((resolve) => {
    let settled = false;
    const finish = (r: Result<WriteLockResult<T>, Error>): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    let holder: ReturnType<typeof spawn>;
    try {
      holder = spawnFn(
        'flock',
        [
          '-E',
          String(FLOCK_TIMEOUT_EXIT),
          '-w',
          String(waitSeconds),
          '-x',
          lockPath,
          'sh',
          '-c',
          // Signal only once `cat` is known runnable: if the exec could fail after
          // the signal, the shell would exit and release the lock mid-callback.
          `command -v cat >/dev/null && printf ${ACQUIRED_SIGNAL} && exec cat`,
        ],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );
    } catch (e) {
      finish(err(e instanceof Error ? e : new Error(String(e))));
      return;
    }

    let acquired = false;
    const release = (): void => {
      // Close `cat`'s stdin so it exits and `flock` unlocks.
      try {
        holder.stdin?.end();
      } catch {
        /* holder may already be gone; release is best-effort */
      }
    };

    const runCritical = async (): Promise<void> => {
      try {
        const value = await fn();
        finish(ok({ ran: true, locked: true, value }));
      } catch (e) {
        finish(err(e instanceof Error ? e : new Error(String(e))));
      } finally {
        release();
      }
    };

    holder.stdout?.once('data', () => {
      if (acquired || settled) return;
      acquired = true;
      void runCritical();
    });

    // An exit before the acquisition signal means the lock was never held.
    holder.on('close', (code: number | null) => {
      if (acquired) return; // normal release after the callback finished
      if (code === FLOCK_TIMEOUT_EXIT) {
        // Contended: another writer held the lock for the whole wait.
        // Skip-graceful: resolve ran=false, no error.
        finish(ok({ ran: false, locked: true }));
        return;
      }
      finish(err(new Error(`flock exited with code ${String(code)} before acquiring ${lockPath}`)));
    });
    holder.on('error', (e) => {
      if (!acquired) release();
      finish(err(e instanceof Error ? e : new Error(String(e))));
    });
  });
}
