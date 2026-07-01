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
 * SAME advisory lock by spawning `flock -w <wait> -x <lock> cat`: `flock`
 * acquires `LOCK_EX` and holds it while `cat` blocks on an open stdin pipe; the
 * lock releases the instant we close that pipe (on callback completion). Because
 * it is the identical advisory lock on the identical path, it mutually excludes
 * the shell writers correctly.
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

  // Acquire: `flock -w <wait> -x <lock> cat`. `flock` holds LOCK_EX while `cat`
  // blocks reading its stdin; closing that stdin releases the lock.
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
      holder = spawnFn('flock', ['-w', String(waitSeconds), '-x', lockPath, 'cat'], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch (e) {
      finish(err(e instanceof Error ? e : new Error(String(e))));
      return;
    }

    let acquired = false;

    // If `flock` exits BEFORE we run the callback, it timed out waiting → the
    // lock was contended. `flock` exits 1 on wait-timeout; `cat` would exit 0
    // only after we close stdin (which we only do post-callback). So an early
    // close means "could not acquire".
    holder.on('close', () => {
      if (!acquired) {
        // Contended — `flock` timed out waiting (exits before we run the
        // callback). Skip-graceful: resolve ran=false, no error.
        finish(ok({ ran: false, locked: true }));
      }
      // else: normal release after the callback finished; nothing to do.
    });
    holder.on('error', (e) => {
      finish(err(e instanceof Error ? e : new Error(String(e))));
    });

    // `flock` acquires the lock immediately before exec'ing `cat`, so once the
    // child is spawned and its stdin pipe is writable we treat the lock as held.
    // Guard against the race above via the `acquired` flag + a microtask defer
    // so a synchronous early-close (timeout) is observed first.
    const runCritical = async (): Promise<void> => {
      acquired = true;
      try {
        const value = await fn();
        finish(ok({ ran: true, locked: true, value }));
      } catch (e) {
        finish(err(e instanceof Error ? e : new Error(String(e))));
      } finally {
        // Release the lock: close `cat`'s stdin so it exits and `flock` unlocks.
        try {
          holder.stdin?.end();
        } catch {
          /* holder may already be gone; release is best-effort */
        }
      }
    };

    // Defer one macrotask so a wait-timeout `close` (which fires ~immediately on
    // contention) is seen before we mark acquired. Keeps the two outcomes
    // deterministic without polling.
    setTimeout(() => {
      if (!settled && holder.exitCode === null) {
        void runCritical();
      }
    }, 0);
  });
}
