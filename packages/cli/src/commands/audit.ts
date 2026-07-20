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

import { existsSync } from 'node:fs';

import type { Command } from 'commander';

import {
  appendIcoAnchor,
  type AuditSurfacesResult,
  closeDatabase,
  type IcoAnchorVerifyResult,
  initDatabase,
  reconcileWorkspace,
  verifyAuditChain,
  verifyAuditSurfaces,
  verifyIcoAnchors,
} from '@ico/kernel';

import { commitAnchorFile, resolveAnchorFile } from '../lib/anchor.js';
import { bold, dim, formatError, formatInfo, formatSuccess, formatWarning } from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

interface AuditVerifyOptions {
  workspace?: string;
  json?: boolean;
  /** Restrict to the original per-day hash-chain walk (no DB, no surfaces). */
  chainOnly?: boolean;
  /** Anchor log to cross-check (overrides ICO_ANCHOR_FILE). */
  anchorFile?: string;
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

  // -----------------------------------------------------------------
  // Extended surfaces (l13.7) + external-anchor cross-check (l13.8).
  // --chain-only preserves the original DB-free fast path.
  // -----------------------------------------------------------------
  let surfaces: AuditSurfacesResult | null = null;
  let anchors: IcoAnchorVerifyResult | null = null;
  let anchorFileUsed: string | null = null;
  if (options.chainOnly !== true) {
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
    let surfacesResult;
    try {
      surfacesResult = verifyAuditSurfaces(dbResult.value, ws.value.root);
    } finally {
      closeDatabase(dbResult.value);
    }
    if (!surfacesResult.ok) {
      if (wantJson) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            error: surfacesResult.error.message,
            code: 'VERIFY_FAILED',
          }) + '\n',
        );
      } else {
        process.stderr.write(
          formatError(`audit surfaces verify failed: ${surfacesResult.error.message}\n`),
        );
      }
      process.exitCode = 1;
      return;
    }
    surfaces = surfacesResult.value;

    const anchorPath = resolveAnchorFile(options.anchorFile);
    if (anchorPath !== undefined && existsSync(anchorPath)) {
      anchorFileUsed = anchorPath;
      const anchorResult = verifyIcoAnchors(ws.value.root, anchorPath);
      if (!anchorResult.ok) {
        if (wantJson) {
          process.stdout.write(
            JSON.stringify({
              ok: false,
              error: anchorResult.error.message,
              code: 'VERIFY_FAILED',
            }) + '\n',
          );
        } else {
          process.stderr.write(
            formatError(`anchor verify failed: ${anchorResult.error.message}\n`),
          );
        }
        process.exitCode = 1;
        return;
      }
      anchors = anchorResult.value;
    }
  }

  const chainBreaks = v.breaks.length;
  const surfaceBreaks = surfaces?.breaks.length ?? 0;
  const anchorBreaks = anchors?.anchorBreaks.length ?? 0;
  const totalBreaks = chainBreaks + surfaceBreaks + anchorBreaks;

  if (wantJson) {
    // Machine-readable envelope: orchestrators (e.g. scripts/demo-e2e.sh
    // stage 7) consume this and surface per-break detail without parsing
    // human-formatted stderr. Existing top-level chain fields are preserved;
    // `surfaces` / `anchors` extend the envelope (null when skipped).
    process.stdout.write(
      JSON.stringify({
        ok: totalBreaks === 0,
        filesScanned: v.filesScanned,
        totalEvents: v.totalEvents,
        cleanFiles: v.cleanFiles,
        breaks: v.breaks,
        linkedBoundaries: v.linkedBoundaries,
        legacyBoundaries: v.legacyBoundaries,
        surfaces,
        anchors: anchors !== null ? { ...anchors, anchorFile: anchorFileUsed } : null,
      }) + '\n',
    );
    process.exitCode = totalBreaks === 0 ? 0 : 2;
    return;
  }
  if (totalBreaks === 0) {
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
    if (surfaces !== null) {
      process.stdout.write(
        formatInfo(
          `Trace index: ${surfaces.indexedEvents} event(s) across ${surfaces.indexedTraceFiles} file(s) — consistent\n`,
        ),
      );
      process.stdout.write(
        formatInfo(
          `Provenance sidecars: ${surfaces.provenanceRecords} record(s) vs ${surfaces.provenanceTraceEvents} chained event(s)\n`,
        ),
      );
      process.stdout.write(
        formatInfo(
          `Spool manifests: ${surfaces.spoolManifestsChecked} checked over ${surfaces.spoolFilesChecked} spool file(s)\n`,
        ),
      );
      if (surfaces.unreceiptedProvenance > 0 || surfaces.unindexedEvents > 0) {
        // Carried exceptions — reported, never rewritten, never breaks.
        process.stdout.write(
          formatInfo(
            `Carried exceptions: ${surfaces.unreceiptedProvenance} unreceipted provenance record(s), ${surfaces.unindexedEvents} unindexed trace event(s)\n`,
          ),
        );
      }
      process.stdout.write(
        formatInfo(
          `log.md: ${surfaces.logMd.present ? `${surfaces.logMd.lines} line(s)` : 'absent'} — convenience view only, outside the tamper-evident surface\n`,
        ),
      );
    }
    if (anchors !== null) {
      process.stdout.write(
        formatInfo(
          `External anchors: ${anchors.anchorCount} anchor(s) in ${anchorFileUsed ?? ''} — consistent\n`,
        ),
      );
    } else if (options.chainOnly !== true) {
      process.stdout.write(
        formatWarning(
          `No external anchor log configured (set ICO_ANCHOR_FILE or pass --anchor-file) — rewrite detection is limited to in-file chains.\n`,
        ),
      );
    }
    process.exitCode = 0;
    return;
  }
  process.stderr.write(formatError(`AUDIT_TAMPERED: ${totalBreaks} break(s) detected\n`));
  process.stderr.write(
    bold(`Files scanned: ${v.filesScanned}; total events: ${v.totalEvents}\n\n`),
  );
  for (const b of v.breaks) {
    process.stderr.write(
      `  ${b.file} line ${b.lineIndex}: expected prev_hash=${b.expectedPrevHash ?? 'null'}, got ${b.actualPrevHash ?? 'null'}\n`,
    );
    process.stderr.write(`    ${dim(b.excerpt)}\n`);
  }
  for (const b of surfaces?.breaks ?? []) {
    process.stderr.write(`  [${b.surface}] ${b.code} ${b.file}: ${b.detail}\n`);
  }
  for (const b of anchors?.anchorBreaks ?? []) {
    process.stderr.write(`  [anchor] ${b.reason} at index ${b.index}: ${b.detail}\n`);
  }
  process.exitCode = 2;
}

interface AuditAnchorOptions {
  workspace?: string;
  json?: boolean;
  anchorFile?: string;
  commit?: boolean;
}

/**
 * Exported for unit testing. `ico audit anchor` — append the current
 * compile-trace chain head to the external anchor log (l13.8) and commit it
 * into the witnessing git repo (skip with --no-commit). Anchoring is
 * explicit-only: with no --anchor-file and no ICO_ANCHOR_FILE this errors
 * rather than inventing an unwitnessed local default.
 */
export function runAuditAnchor(options: AuditAnchorOptions, command: Command): void {
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

  const anchorPath = resolveAnchorFile(options.anchorFile);
  if (anchorPath === undefined) {
    const msg =
      'No anchor file configured. Pass --anchor-file <path> or set ICO_ANCHOR_FILE — point it at a file inside an externally-pushed git repo (e.g. the witnessed ~/.teamkb/audit repo).';
    if (wantJson) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: msg, code: 'NO_ANCHOR_FILE' }) + '\n',
      );
    } else {
      process.stderr.write(formatError(msg + '\n'));
    }
    process.exitCode = 1;
    return;
  }

  const result = appendIcoAnchor(ws.value.root, anchorPath);
  if (!result.ok) {
    if (wantJson) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: result.error.message, code: 'ANCHOR_FAILED' }) + '\n',
      );
    } else {
      process.stderr.write(formatError(`audit anchor failed: ${result.error.message}\n`));
    }
    process.exitCode = 1;
    return;
  }

  const { record, appended } = result.value;
  const commitOutcome = appended && options.commit !== false ? commitAnchorFile(anchorPath) : null;

  if (wantJson) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        appended,
        anchorFile: anchorPath,
        record,
        committed: commitOutcome?.committed ?? false,
        commitDetail: commitOutcome?.detail ?? null,
      }) + '\n',
    );
    process.exitCode = 0;
    return;
  }
  if (!appended) {
    process.stdout.write(
      formatInfo(
        `Chain head unchanged since the last anchor (${record.totalEvents} events) — nothing to witness.\n`,
      ),
    );
    process.exitCode = 0;
    return;
  }
  process.stdout.write(
    formatSuccess(
      `Anchored ${record.totalEvents} event(s), head ${record.chainHead.slice(0, 12)}… → ${anchorPath}\n`,
    ),
  );
  if (commitOutcome !== null) {
    process.stdout.write(
      (commitOutcome.committed ? formatSuccess : formatInfo)(`${commitOutcome.detail}\n`),
    );
  }
  process.exitCode = 0;
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
    .description(
      'Walk the audit JSONL hash chain, cross-check the SQLite trace index, provenance sidecars, spool manifests, and any external anchor log; exit 2 if AUDIT_TAMPERED',
    )
    .option('-w, --workspace <path>', 'Workspace path (defaults to ICO_WORKSPACE or cwd)')
    .option('--json', 'Emit a machine-readable JSON envelope to stdout (no formatted output)')
    .option('--chain-only', 'Only walk the per-day hash chains (skip DB, surfaces, and anchors)')
    .option(
      '--anchor-file <path>',
      'External anchor log to cross-check (defaults to ICO_ANCHOR_FILE when set)',
    )
    .action((options: AuditVerifyOptions, command: Command) => {
      runAuditVerify(options, command);
    });
  audit
    .command('anchor')
    .description(
      'Append the compile-trace chain head to the external anchor log and git-commit it in the witnessing repo (l13.8)',
    )
    .option('-w, --workspace <path>', 'Workspace path (defaults to ICO_WORKSPACE or cwd)')
    .option('--json', 'Emit a machine-readable JSON envelope to stdout (no formatted output)')
    .option(
      '--anchor-file <path>',
      'Anchor log path (defaults to ICO_ANCHOR_FILE; required one way or the other)',
    )
    .option('--no-commit', 'Append the anchor without git-committing the witnessing repo')
    .action((options: AuditAnchorOptions, command: Command) => {
      runAuditAnchor(options, command);
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
