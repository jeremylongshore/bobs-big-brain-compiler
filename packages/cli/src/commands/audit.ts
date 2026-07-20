/**
 * `ico audit verify` — walk the audit-trail hash chain and report breaks.
 * `ico audit reconcile` — quarantine visible pages that lack receipts.
 *
 * Per the CISO seat in 035-AT-DECR §2.5(1): the audit JSONL is tamper-evident
 * by construction (each event carries `prev_hash` = SHA-256 of the previous
 * line) but there was no verification code anywhere before this command.
 * Without a verifier the chain's tamper-evidence is theoretical.
 *
 * `verify` exit codes:
 *   0 — chain intact (zero breaks reported)
 *   1 — filesystem error
 *   2 — chain has one or more breaks (`AUDIT_TAMPERED`)
 *
 * `reconcile` exit codes:
 *   0 — corpus already consistent (nothing moved)
 *   1 — workspace/database/filesystem error
 *   2 — one or more files were quarantined (operator should review
 *       `quarantine/` — nothing was deleted)
 *
 * @module commands/audit
 */

import type { Command } from 'commander';

import { closeDatabase, initDatabase, reconcileWorkspace, verifyAuditChain } from '@ico/kernel';

import { bold, dim, formatError, formatInfo, formatSuccess } from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

interface AuditVerifyOptions {
  workspace?: string;
  json?: boolean;
}

interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  workspace?: string;
}

/**
 * Exported for unit testing. Wraps `verifyAuditChain` from the kernel
 * with operator-side concerns: workspace resolution, --json output
 * shaping, friendly error mapping, and exit-code semantics.
 */
export function runAuditVerify(options: AuditVerifyOptions, command: Command): void {
  // Convention check: use `process.exitCode = N; return` rather than
  // `process.exit(N)` so tests can invoke this handler directly without
  // tearing the test runner down. Matches packages/cli/src/commands/promote.ts.
  const global = command.optsWithGlobals<GlobalOptions>();
  // --json on the subcommand wins over the global --json (so an operator
  // can run a non-json global session and still ask audit verify for
  // machine-readable output explicitly).
  const wantJson = options.json === true || global.json === true;
  const wsFlag = options.workspace ?? global.workspace;
  const ws = resolveWorkspace(wsFlag !== undefined ? { workspace: wsFlag } : {});
  if (!ws.ok) {
    if (wantJson) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: ws.error.message, code: 'WORKSPACE_ERROR' }) + '\n',
      );
    } else {
      process.stderr.write(formatError(`Workspace error: ${ws.error.message}\n`));
    }
    process.exitCode = 1;
    return;
  }
  const result = verifyAuditChain(ws.value.root);
  if (!result.ok) {
    if (wantJson) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: result.error.message, code: 'VERIFY_FAILED' }) + '\n',
      );
    } else {
      process.stderr.write(formatError(`audit verify failed: ${result.error.message}\n`));
    }
    process.exitCode = 1;
    return;
  }
  const v = result.value;
  if (wantJson) {
    // Machine-readable envelope: orchestrators (e.g. scripts/demo-e2e.sh
    // stage 7) consume this and surface per-break detail without parsing
    // human-formatted stderr. Exit code semantics unchanged.
    process.stdout.write(
      JSON.stringify({
        ok: v.breaks.length === 0,
        filesScanned: v.filesScanned,
        totalEvents: v.totalEvents,
        cleanFiles: v.cleanFiles,
        breaks: v.breaks,
        linkedBoundaries: v.linkedBoundaries,
        legacyBoundaries: v.legacyBoundaries,
      }) + '\n',
    );
    process.exitCode = v.breaks.length === 0 ? 0 : 2;
    return;
  }
  if (v.breaks.length === 0) {
    process.stdout.write(formatSuccess(`audit chain OK\n`));
    process.stdout.write(formatInfo(`Files scanned: ${v.filesScanned}\n`));
    process.stdout.write(formatInfo(`Total events:  ${v.totalEvents}\n`));
    process.stdout.write(formatInfo(`Clean files:   ${v.cleanFiles}\n`));
    process.stdout.write(formatInfo(`Linked day boundaries: ${v.linkedBoundaries}\n`));
    if (v.legacyBoundaries > 0) {
      // Carried exception, not a failure: day files written before cross-day
      // chaining shipped start with prev_hash null. Reported for honesty —
      // never rewritten.
      process.stdout.write(
        formatInfo(`Legacy (pre-chaining) day boundaries: ${v.legacyBoundaries}\n`),
      );
    }
    process.exitCode = 0;
    return;
  }
  process.stderr.write(formatError(`AUDIT_TAMPERED: ${v.breaks.length} chain break(s) detected\n`));
  process.stderr.write(
    bold(`Files scanned: ${v.filesScanned}; total events: ${v.totalEvents}\n\n`),
  );
  for (const b of v.breaks) {
    process.stderr.write(
      `  ${b.file} line ${b.lineIndex}: expected prev_hash=${b.expectedPrevHash ?? 'null'}, got ${b.actualPrevHash ?? 'null'}\n`,
    );
    process.stderr.write(`    ${dim(b.excerpt)}\n`);
  }
  process.exitCode = 2;
}

interface AuditReconcileOptions {
  workspace?: string;
  json?: boolean;
  tmpMaxAgeMs?: string;
}

/**
 * Exported for unit testing. Wraps `reconcileWorkspace` from the kernel:
 * any visible wiki page with no matching promotions/compilations receipt
 * row is MOVED (never deleted) to `quarantine/<original-rel-path>`, and
 * stale `.tmp` crash-orphans are swept. Exit code 2 signals "something was
 * quarantined" so orchestration (cron, spool pre-step) can alert.
 */
export function runAuditReconcile(options: AuditReconcileOptions, command: Command): void {
  const global = command.optsWithGlobals<GlobalOptions>();
  const wantJson = options.json === true || global.json === true;
  const wsFlag = options.workspace ?? global.workspace;
  const ws = resolveWorkspace(wsFlag !== undefined ? { workspace: wsFlag } : {});
  if (!ws.ok) {
    if (wantJson) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: ws.error.message, code: 'WORKSPACE_ERROR' }) + '\n',
      );
    } else {
      process.stderr.write(formatError(`Workspace error: ${ws.error.message}\n`));
    }
    process.exitCode = 1;
    return;
  }

  const dbResult = initDatabase(ws.value.dbPath);
  if (!dbResult.ok) {
    if (wantJson) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: dbResult.error.message, code: 'DB_ERROR' }) + '\n',
      );
    } else {
      process.stderr.write(formatError(`Database error: ${dbResult.error.message}\n`));
    }
    process.exitCode = 1;
    return;
  }
  const db = dbResult.value;

  let result;
  try {
    const tmpMaxAgeMs =
      options.tmpMaxAgeMs !== undefined ? Number.parseInt(options.tmpMaxAgeMs, 10) : undefined;
    result = reconcileWorkspace(
      db,
      ws.value.root,
      tmpMaxAgeMs !== undefined && !Number.isNaN(tmpMaxAgeMs) ? { tmpMaxAgeMs } : undefined,
    );
  } finally {
    closeDatabase(db);
  }

  if (!result.ok) {
    if (wantJson) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: result.error.message, code: 'RECONCILE_FAILED' }) + '\n',
      );
    } else {
      process.stderr.write(formatError(`audit reconcile failed: ${result.error.message}\n`));
    }
    process.exitCode = 1;
    return;
  }

  const r = result.value;
  const moved = r.quarantined.length + r.tmpSwept.length;
  if (wantJson) {
    process.stdout.write(
      JSON.stringify({
        ok: moved === 0,
        scanned: r.scanned,
        quarantined: r.quarantined,
        tmpSwept: r.tmpSwept,
      }) + '\n',
    );
    process.exitCode = moved === 0 ? 0 : 2;
    return;
  }

  if (moved === 0) {
    process.stdout.write(formatSuccess(`corpus consistent — nothing to quarantine\n`));
    process.stdout.write(formatInfo(`Pages scanned: ${r.scanned}\n`));
    process.exitCode = 0;
    return;
  }

  process.stderr.write(
    formatError(
      `RECONCILED: ${r.quarantined.length} unreceipted page(s) quarantined, ${r.tmpSwept.length} stale tmp file(s) swept\n`,
    ),
  );
  process.stderr.write(bold(`Pages scanned: ${r.scanned}\n\n`));
  for (const q of r.quarantined) {
    process.stderr.write(`  ${q.path} → ${q.quarantinedTo}\n`);
    process.stderr.write(`    ${dim(q.reason)}\n`);
  }
  for (const t of r.tmpSwept) {
    process.stderr.write(`  ${t.path} → ${t.quarantinedTo}\n`);
    process.stderr.write(`    ${dim(t.reason)}\n`);
  }
  process.stderr.write(dim(`\nNothing was deleted — review quarantine/ and restore or discard.\n`));
  process.exitCode = 2;
}

export function register(program: Command): void {
  const audit = program.command('audit').description('Audit-trail integrity commands');
  audit
    .command('verify')
    .description('Walk the audit JSONL hash chain and exit 2 if AUDIT_TAMPERED')
    .option('-w, --workspace <path>', 'Workspace path (defaults to ICO_WORKSPACE or cwd)')
    .option('--json', 'Emit a machine-readable JSON envelope to stdout (no formatted output)')
    .action((options: AuditVerifyOptions, command: Command) => {
      runAuditVerify(options, command);
    });
  audit
    .command('reconcile')
    .description(
      'Quarantine (never delete) visible wiki pages lacking receipts and sweep stale .tmp crash orphans; exit 2 if anything moved',
    )
    .option('-w, --workspace <path>', 'Workspace path (defaults to ICO_WORKSPACE or cwd)')
    .option('--json', 'Emit a machine-readable JSON envelope to stdout (no formatted output)')
    .option(
      '--tmp-max-age-ms <ms>',
      'Minimum age before a .tmp file is considered a crash orphan (default 3600000)',
    )
    .action((options: AuditReconcileOptions, command: Command) => {
      runAuditReconcile(options, command);
    });
}
