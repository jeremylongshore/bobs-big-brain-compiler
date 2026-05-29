/**
 * `ico spool emit [--out <dir>] [--scope wiki|outputs|all] [--dry-run]`
 *
 * Emit compiled L2/L4 artifacts to a spool directory the INTKB curator can
 * ingest via `ingestFromSpool`. See:
 *  - `packages/kernel/src/spool.ts` for the emission implementation.
 *  - `000-docs/034-AT-NTRP-ecosystem-thesis.md` §4 for the architectural argument.
 *  - `000-docs/035-AT-DECR-post-thesis-build-direction-2026-05-23.md` §4.1 for the
 *    Build Item A scope.
 *
 * This command is the operator surface. Enforcement of the data contract
 * lives in the kernel; the CLI is responsible for:
 *  - tenantId resolution (from workspace config; no default)
 *  - --out path safety validation (realpath + prefix-check + symlink lstat)
 *  - dry-run rendering (structure-only — never prints candidate content)
 *  - friendly error mapping
 *
 * @module commands/spool
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { Command } from 'commander';

import {
  closeDatabase,
  dryRunSpool,
  emitSpool,
  initDatabase,
  loadConfig,
  type SpoolEmitScope,
  SpoolError,
} from '@ico/kernel';

import { bold, dim, formatError, formatInfo, formatSuccess, formatWarning } from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpoolEmitOptions {
  out?: string;
  scope?: SpoolEmitScope;
  dryRun?: boolean;
  tenant?: string;
  workspace?: string;
}

interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  workspace?: string;
}

// ---------------------------------------------------------------------------
// Internal: path-safety validation for --out
// ---------------------------------------------------------------------------

interface PathValidationOk {
  ok: true;
  resolved: string;
}
interface PathValidationErr {
  ok: false;
  message: string;
  exitCode: number;
}
type PathValidation = PathValidationOk | PathValidationErr;

/**
 * Validate an `--out` argument against path-traversal / symlink-swap attacks.
 * Resolves the candidate path via `realpath` and asserts it is a prefix of
 * either `workspacePath` or `$TEAMKB_HOME`. Also rejects if any path
 * component is a symlink owned by a user other than the current user.
 *
 * The path does not need to exist yet — the existence-check happens in the
 * kernel layer. We only validate the resolved-prefix property.
 */
function validateOutDir(outRaw: string | undefined, workspacePath: string): PathValidation {
  if (outRaw === undefined) {
    return { ok: true, resolved: resolve(workspacePath, 'spool') };
  }
  const absolute = isAbsolute(outRaw) ? outRaw : resolve(workspacePath, outRaw);

  // Determine allowed roots.
  const teamKbHome = process.env['TEAMKB_HOME'];
  const allowedRoots: string[] = [resolve(workspacePath)];
  if (teamKbHome !== undefined && teamKbHome.trim() !== '') {
    allowedRoots.push(resolve(teamKbHome));
  }

  // Resolve the parent path (deepest existing ancestor) via realpath to
  // collapse symlinks. We do not require the leaf to exist.
  let probe = absolute;
  let resolvedParent: string;
  for (;;) {
    if (existsSync(probe)) {
      try {
        resolvedParent = realpathSync(probe);
        break;
      } catch (e) {
        return {
          ok: false,
          message: `Cannot resolve --out path "${outRaw}": ${e instanceof Error ? e.message : String(e)}`,
          exitCode: 1,
        };
      }
    }
    const next = resolve(probe, '..');
    if (next === probe) {
      // Reached filesystem root without finding an existing ancestor.
      resolvedParent = probe;
      break;
    }
    probe = next;
  }

  // Reconstruct the full resolved path: realpath of the deepest existing
  // ancestor + the remaining unresolved leaf segments (those don't exist
  // yet so they can't be symlinks).
  const tail = absolute.slice(probe.length);
  const resolved = resolve(resolvedParent + tail);

  // Prefix-check against allowed roots.
  const inside = allowedRoots.some((root) => {
    const rootWithSep = root.endsWith('/') ? root : root + '/';
    return resolved === root || resolved.startsWith(rootWithSep);
  });
  if (!inside) {
    return {
      ok: false,
      message: `--out must resolve to a path inside the workspace${
        teamKbHome ? ' or $TEAMKB_HOME' : ''
      }. Resolved: ${resolved}`,
      exitCode: 1,
    };
  }

  // Symlink ownership check: walk path components that exist and refuse if
  // any is a symlink owned by a different user (TOCTOU defence against
  // symlink swap). Skip on platforms without uid.
  const currentUid = process.getuid?.();
  if (currentUid !== undefined) {
    let walk = '/';
    for (const seg of absolute.split('/').filter(Boolean)) {
      walk = resolve(walk, seg);
      if (!existsSync(walk)) break;
      try {
        const st = lstatSync(walk);
        if (st.isSymbolicLink() && st.uid !== currentUid) {
          return {
            ok: false,
            message: `--out path component "${walk}" is a symlink owned by uid ${st.uid} (expected uid ${currentUid}); refusing to write`,
            exitCode: 1,
          };
        }
      } catch {
        // Stat failure on existing path — ignore; the kernel will surface a
        // clearer error on the actual write.
        break;
      }
    }
  }

  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Internal: tenantId resolution
// ---------------------------------------------------------------------------

/**
 * Resolve tenantId from explicit `--tenant` flag, then from workspace
 * config under `spool.tenantId`. Refuse if neither is set — no default
 * fallback to workspace name (CISO BLOCK fix #5). Error message guides
 * the operator to the canonical fix.
 */
function resolveTenantId(
  workspacePath: string,
  flag: string | undefined,
): { ok: true; tenantId: string } | { ok: false; message: string } {
  if (typeof flag === 'string' && flag.trim() !== '') {
    return { ok: true, tenantId: flag.trim() };
  }
  const config = loadConfig(workspacePath);
  const spoolCfg = (config as unknown as Record<string, unknown>)['spool'];
  if (spoolCfg !== null && typeof spoolCfg === 'object') {
    const t = (spoolCfg as Record<string, unknown>)['tenantId'];
    if (typeof t === 'string' && t.trim() !== '') {
      return { ok: true, tenantId: t.trim() };
    }
  }
  return {
    ok: false,
    message:
      'tenantId is required for spool emission to prevent cross-tenant data leakage.\n' +
      '  Either set `spool.tenantId` in .ico/config.json or pass --tenant <id>.\n' +
      '  Example .ico/config.json: { "spool": { "tenantId": "intentional-cognition-os" } }',
  };
}

// ---------------------------------------------------------------------------
// Internal: scope validation
// ---------------------------------------------------------------------------

const VALID_SCOPES: ReadonlyArray<SpoolEmitScope> = ['wiki', 'outputs', 'all'] as const;

function parseScope(raw: string | undefined): SpoolEmitScope | null {
  const v = raw ?? 'wiki';
  return VALID_SCOPES.includes(v as SpoolEmitScope) ? (v as SpoolEmitScope) : null;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Exported for unit testing. Wraps `emitSpool` / `dryRunSpool` from the kernel
 * with operator-side concerns: workspace resolution, tenantId enforcement,
 * --out path-safety, --scope validation, dry-run rendering, and friendly
 * error/exit-code mapping.
 */
export function runSpoolEmit(options: SpoolEmitOptions, command: Command): void {
  const global = command.optsWithGlobals<GlobalOptions>();
  const workspaceFlag = options.workspace ?? global.workspace;
  const ws = resolveWorkspace(workspaceFlag !== undefined ? { workspace: workspaceFlag } : {});
  if (!ws.ok) {
    process.stderr.write(formatError(`Workspace error: ${ws.error.message}\n`));
    process.exit(1);
  }
  const workspacePath = ws.value.root;

  const scope = parseScope(options.scope);
  if (scope === null) {
    process.stderr.write(
      formatError(`Invalid --scope value. Allowed: ${VALID_SCOPES.join(', ')}\n`),
    );
    process.exit(2);
  }

  // tenantId — refuse without explicit configuration.
  const tenant = resolveTenantId(workspacePath, options.tenant);
  if (!tenant.ok) {
    process.stderr.write(formatError(tenant.message + '\n'));
    process.exit(2);
  }

  // --out path safety.
  const pathCheck = validateOutDir(options.out, workspacePath);
  if (!pathCheck.ok) {
    process.stderr.write(formatError(pathCheck.message + '\n'));
    process.exit(pathCheck.exitCode);
  }
  const outDirAbs = pathCheck.resolved;

  // --- Dry-run path: never opens the DB, never writes anything ---
  if (options.dryRun === true) {
    const dry = dryRunSpool(workspacePath, {
      scope,
      tenantId: tenant.tenantId,
      outDir: outDirAbs,
    });
    if (!dry.ok) {
      process.stderr.write(formatError(`Dry-run failed: ${dry.error.message}\n`));
      process.exit(1);
    }
    const { wouldEmit, skipped } = dry.value;
    process.stdout.write(bold(`Dry-run summary (no files written):\n`));
    process.stdout.write(formatInfo(`scope:    ${scope}\n`));
    process.stdout.write(formatInfo(`tenantId: ${tenant.tenantId}\n`));
    process.stdout.write(formatInfo(`outDir:   ${outDirAbs}\n`));
    process.stdout.write(
      formatInfo(`Would emit ${wouldEmit.length} candidate(s); ${skipped.length} skipped.\n`),
    );
    process.stdout.write(`\n`);
    if (wouldEmit.length > 0) {
      process.stdout.write(bold(`Would-emit (structure-only, content body NOT printed):\n`));
      for (const c of wouldEmit) {
        process.stdout.write(
          `  ${dim(c.id)}  [${c.category}]  ${c.title}  ${dim(`(${c.contentBytes} bytes from ${c.sourcePath})`)}\n`,
        );
      }
    }
    if (skipped.length > 0) {
      process.stdout.write(`\n`);
      process.stdout.write(bold(`Skipped:\n`));
      for (const s of skipped) {
        process.stdout.write(`  ${dim(s.path)}  ${s.code}: ${s.detail}\n`);
      }
    }
    process.exit(0);
  }

  // --- Live emit path ---
  const dbResult = initDatabase(ws.value.dbPath);
  if (!dbResult.ok) {
    process.stderr.write(formatError(`Database error: ${dbResult.error.message}\n`));
    process.exit(1);
  }
  const db = dbResult.value;
  try {
    const result = emitSpool(db, workspacePath, {
      scope,
      tenantId: tenant.tenantId,
      outDir: outDirAbs,
    });
    if (!result.ok) {
      const errInstance = result.error;
      let exitCode = 1;
      if (errInstance instanceof SpoolError) {
        if (errInstance.code === 'NO_TENANT_ID') exitCode = 2;
        if (errInstance.code === 'WRITE_FAILED') exitCode = 4;
        if (errInstance.code === 'TRACE_FAILED') exitCode = 5;
      }
      process.stderr.write(formatError(`Spool emit failed: ${errInstance.message}\n`));
      process.exit(exitCode);
    }
    const v = result.value;
    process.stdout.write(
      formatSuccess(`Emitted ${v.emittedCount} candidate(s) to ${v.spoolFile}\n`),
    );
    process.stdout.write(formatInfo(`Manifest:   ${v.manifestFile}\n`));
    process.stdout.write(formatInfo(`Bytes:      ${v.spoolFileBytes}\n`));
    process.stdout.write(formatInfo(`SHA-256:    ${v.spoolFileSha256}\n`));
    if (v.skipped.length > 0) {
      process.stdout.write(`\n`);
      process.stdout.write(formatWarning(`${v.skipped.length} candidate(s) skipped:\n`));
      for (const s of v.skipped) {
        process.stdout.write(`  ${dim(s.path)}  ${s.code}: ${s.detail}\n`);
      }
    }
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  const spool = program
    .command('spool')
    .description('Spool boundary commands (emit to INTKB-compatible spool directory)');

  spool
    .command('emit')
    .description('Emit compiled artifacts to the spool directory for INTKB ingestion')
    .option('--out <dir>', 'Spool output directory (default: <workspace>/spool)')
    .option(
      '--scope <scope>',
      `Which artifacts to emit: ${VALID_SCOPES.join(' | ')} (default: wiki)`,
      'wiki',
    )
    .option('--tenant <id>', 'Tenant identifier (overrides spool.tenantId in config)')
    .option('--dry-run', 'Print what would be emitted, structure only; no writes', false)
    .option('-w, --workspace <path>', 'Workspace path (defaults to ICO_WORKSPACE or cwd)')
    .action((options: SpoolEmitOptions, command: Command) => {
      runSpoolEmit(options, command);
    });
}
