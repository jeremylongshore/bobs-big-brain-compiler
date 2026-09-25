/**
 * CLI-facing wrapper around the kernel's cooperative brain writer lock.
 *
 * Commands use this helper only around live mutation paths. Read-only previews
 * and confirmation gates stay outside the lock. Contention is represented as a
 * typed error so callers can report a retryable result without mutating state.
 */

import { withWriteLock } from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

import { formatWarning } from './output.js';

export interface BrainWriteLockOutcome<T> {
  value: T;
  locked: boolean;
}

/** Retryable error returned when another cooperative writer owns the lock. */
export class BrainWriteLockBusyError extends Error {
  readonly code = 'ICO_WRITE_LOCK_BUSY';

  constructor() {
    super('Another brain writer holds the write lock — retry the command.');
    this.name = 'BrainWriteLockBusyError';
  }
}

/**
 * Run a callback under the canonical kernel lock and flatten its lock result.
 *
 * The kernel deliberately runs in degraded mode when `flock` is unavailable;
 * callers receive `locked: false` so they can surface that warning. A timeout
 * is converted into {@link BrainWriteLockBusyError} and never invokes `fn`.
 */
export async function withBrainWriteLock<T>(
  fn: () => Promise<T> | T,
): Promise<Result<BrainWriteLockOutcome<T>, Error>> {
  const lockResult = await withWriteLock(fn);
  if (!lockResult.ok) return lockResult;
  if (!lockResult.value.ran) return err(new BrainWriteLockBusyError());

  return ok({
    value: lockResult.value.value as T,
    locked: lockResult.value.locked,
  });
}

/** Surface the kernel's explicit degraded-lock signal without corrupting JSON stdout. */
export function warnIfWriteLockDegraded(json = false): void {
  const message =
    'flock not on PATH — ran WITHOUT the brain writer lock (concurrent writers could skew the brain).';
  (json ? process.stderr : process.stdout).write(formatWarning(message) + '\n');
}

export function isBrainWriteLockBusyError(error: Error): error is BrainWriteLockBusyError {
  return error instanceof BrainWriteLockBusyError;
}
