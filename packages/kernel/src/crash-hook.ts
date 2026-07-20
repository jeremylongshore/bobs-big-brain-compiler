/**
 * TEST-ONLY fault-injection hook for crash-window testing.
 *
 * `crashPoint(phase)` hard-kills the current process (SIGKILL — no exit
 * handlers, no flushing, exactly like a power loss) when BOTH:
 *   1. `NODE_ENV === 'test'`, AND
 *   2. the `ICO_CRASH_AFTER` env var equals `phase`.
 *
 * Defense in depth: the env var alone is deliberately NOT enough. A stray
 * `ICO_CRASH_AFTER` in a production shell (copied from a test invocation,
 * leaked through CI, baked into a service unit) must never be able to kill
 * a live promotion mid-write. Outside test builds the hook warns once on
 * stderr and does nothing.
 *
 * Used by the receipts-precede-visibility integration tests
 * (`tests/integration/promotion-crash.test.ts`) to prove that a crash at
 * any point in the write path leaves the corpus reconcilable: either an
 * orphan `.tmp` file (harmless, swept by `reconcileWorkspace`) or a
 * receipt-without-file (auditable, re-derivable) — never a visible,
 * unreceipted artifact.
 *
 * NOT exported from the kernel barrel (packages/kernel/src/index.ts) —
 * writers that need it (promotion.ts) import directly from this module, so
 * the hook never becomes public API surface.
 *
 * Keep this module tiny and dependency-free. It must never grow logic.
 */

let warnedOutsideTest = false;

/**
 * Kill the process if `ICO_CRASH_AFTER` matches `phase` AND this is a test
 * build (`NODE_ENV === 'test'`). Outside test builds: warn once, no-op.
 */
export function crashPoint(phase: string): void {
  if (process.env['ICO_CRASH_AFTER'] !== phase) {
    return;
  }
  if (process.env['NODE_ENV'] !== 'test') {
    if (!warnedOutsideTest) {
      warnedOutsideTest = true;
      process.stderr.write('[ico] crash hook ignored outside test (NODE_ENV !== "test")\n');
    }
    return;
  }
  process.kill(process.pid, 'SIGKILL');
}
