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
}

interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  workspace?: string;
}

function verifyHandler(options: AuditVerifyOptions, command: Command): void {
  // Convention check: use `process.exitCode = N; return` rather than
  // `process.exit(N)` so tests can invoke this handler directly without
  // tearing the test runner down. Matches packages/cli/src/commands/promote.ts.
  const global = command.optsWithGlobals<GlobalOptions>();
  const wsFlag = options.workspace ?? global.workspace;
  const ws = resolveWorkspace(wsFlag !== undefined ? { workspace: wsFlag } : {});
  if (!ws.ok) {
    process.stderr.write(formatError(`Workspace error: ${ws.error.message}\n`));
    process.exitCode = 1;
    return;
  }
  const result = verifyAuditChain(ws.value.root);
  if (!result.ok) {
    process.stderr.write(formatError(`audit verify failed: ${result.error.message}\n`));
    process.exitCode = 1;
    return;
  }
  const v = result.value;
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
    .action((options: AuditVerifyOptions, command: Command) => {
      verifyHandler(options, command);
    });
}
