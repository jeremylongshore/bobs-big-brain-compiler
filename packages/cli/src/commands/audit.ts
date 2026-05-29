/**
 * `ico audit verify` — walk the audit-trail hash chain and report breaks.
 *
 * Per the CISO seat in 035-AT-DECR §2.5(1): the audit JSONL is tamper-evident
 * by construction (each event carries `prev_hash` = SHA-256 of the previous
 * line) but there was no verification code anywhere before this command.
 * Without a verifier the chain's tamper-evidence is theoretical.
 *
 * Exit codes:
 *   0 — chain intact (zero breaks reported)
 *   1 — filesystem error
 *   2 — chain has one or more breaks (`AUDIT_TAMPERED`)
 *
 * @module commands/audit
 */

import type { Command } from 'commander';

import { verifyAuditChain } from '@ico/kernel';

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
}
