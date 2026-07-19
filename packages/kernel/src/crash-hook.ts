/**
 * TEST-ONLY fault-injection hook for crash-window testing.
 *
 * `crashPoint(phase)` hard-kills the current process (SIGKILL — no exit
 * handlers, no flushing, exactly like a power loss) when the environment
 * variable `ICO_CRASH_AFTER` equals `phase`. In production the env var is
 * unset and the function is a single string comparison — effectively free.
 *
 * Used by the receipts-precede-visibility integration tests
 * (`tests/integration/promotion-crash.test.ts`) to prove that a crash at
 * any point in the write path leaves the corpus reconcilable: either an
 * orphan `.tmp` file (harmless, swept by `reconcileWorkspace`) or a
 * receipt-without-file (auditable, re-derivable) — never a visible,
 * unreceipted artifact.
 *
 * Keep this module tiny and dependency-free. It must never grow logic.
 */

/** Kill the process if `ICO_CRASH_AFTER` matches `phase`. Test-only. */
export function crashPoint(phase: string): void {
  if (process.env['ICO_CRASH_AFTER'] === phase) {
    process.kill(process.pid, 'SIGKILL');
  }
}
