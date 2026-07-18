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

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { Command } from 'commander';

import {
  closeDatabase,
  dryRunSpool,
  emitSpool,
  initDatabase,
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
  bulk?: boolean;
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
 * Resolve the TeamKB (INTKB) base directory that ICO and INTKB share.
 *
 * This is the write-side half of the ICO → INTKB spool handoff. INTKB's
 * reader resolves its spool dir as `(TEAMKB_BASE_PATH ?? ~/.teamkb)/spool`
 * (see `@qmd-team-intent-kb/common` `getTeamKbBasePath` →
 * `resolveTeamKbPath('spool')`). To make a default `ico spool emit` land in
 * the directory INTKB actually polls — instead of `<workspace>/spool`, which
 * INTKB never reads — ICO must derive the same base.
 *
 * Env precedence:
 *  1. `TEAMKB_BASE_PATH` — INTKB's canonical override (matches its reader).
 *  2. `TEAMKB_HOME` — ICO's pre-existing allowlist root (back-compat).
 *  3. `~/.teamkb` — the shared default when neither is set.
 *
 * Both env names are honoured so an operator who set either one gets a
 * consistent write/read path without further wiring.
 */
function resolveTeamKbBase(): string {
  const basePath = process.env['TEAMKB_BASE_PATH'];
  if (typeof basePath === 'string' && basePath.trim() !== '') {
    return resolve(basePath.trim());
  }
  const teamKbHome = process.env['TEAMKB_HOME'];
  if (typeof teamKbHome === 'string' && teamKbHome.trim() !== '') {
    return resolve(teamKbHome.trim());
  }
  return resolve(join(homedir(), '.teamkb'));
}

/**
 * The default spool output directory — the INTKB-compatible read path.
 * Used when `--out` is omitted so the handoff is wired by default.
 */
function defaultSpoolDir(): string {
  return join(resolveTeamKbBase(), 'spool');
}

/**
 * Validate an `--out` argument against path-traversal / symlink-swap attacks.
 * Resolves the candidate path via `realpath` and asserts it is a prefix of
 * either `workspacePath` or the shared TeamKB base (see `resolveTeamKbBase`).
 * Also rejects if any path component is a symlink owned by a user other than
 * the current user.
 *
 * When `--out` is omitted the default is the INTKB read path
 * (`resolveTeamKbBase()/spool`), wiring the ICO → INTKB handoff out of the box.
 *
 * The path does not need to exist yet — the existence-check happens in the
 * kernel layer. We only validate the resolved-prefix property.
 */
function validateOutDir(outRaw: string | undefined, workspacePath: string): PathValidation {
  // No --out: default to INTKB's read path so the spool handoff is wired
  // out of the box. `<workspace>/spool` was the historical default but INTKB
  // never reads it; emitting there means zero candidates flow without manual
  // operator wiring (see grounding: "ICO spool write path and INTKB spool read
  // path do not match by default").
  if (outRaw === undefined) {
    return { ok: true, resolved: defaultSpoolDir() };
  }
  const absolute = isAbsolute(outRaw) ? outRaw : resolve(workspacePath, outRaw);

  // Determine allowed roots: the workspace, plus the shared TeamKB base so an
  // explicit `--out ~/.teamkb/spool` (or under TEAMKB_BASE_PATH / TEAMKB_HOME)
  // is accepted — the same base the default resolves to.
  const teamKbBase = resolveTeamKbBase();
  const allowedRoots: string[] = [resolve(workspacePath), teamKbBase];

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
      message:
        `--out must resolve to a path inside the workspace or the shared TeamKB base (${teamKbBase}). ` +
        `Resolved: ${resolved}`,
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
  // Read spool.tenantId from the workspace's .ico/config.json — the path the
  // refusal message advertises. loadConfig() is env/.env-based and never read
  // this file, so the documented config was dead and the CLI silently required
  // --tenant despite a valid .ico/config.json (bead intentional-cognition-os-1kc.3).
  try {
    const raw = readFileSync(join(workspacePath, '.ico', 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { spool?: { tenantId?: unknown } };
    const t = parsed.spool?.tenantId;
    if (typeof t === 'string' && t.trim() !== '') {
      return { ok: true, tenantId: t.trim() };
    }
  } catch {
    // Missing / unreadable / invalid config.json — fall through to the refusal.
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
    if (options.bulk === true) {
      process.stdout.write(formatInfo(`mode:     bulk (source=bulk_import, trust=untrusted)\n`));
    }
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
  // The emit step owns creating its output directory. The default
  // (resolveTeamKbBase()/spool) may not exist on a fresh machine or in CI;
  // validateOutDir has already constrained outDirAbs to an allowed root with
  // symlink defences, so creating it here is safe and wires the ICO -> INTKB
  // handoff out of the box.
  try {
    mkdirSync(outDirAbs, { recursive: true });
  } catch (e) {
    process.stderr.write(
      formatError(
        `Cannot create spool output directory "${outDirAbs}": ${e instanceof Error ? e.message : String(e)}\n`,
      ),
    );
    process.exit(1);
  }
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
      bulkImport: options.bulk ?? false,
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
    .option(
      '--out <dir>',
      'Spool output directory (default: the INTKB read path, ' +
        '$TEAMKB_BASE_PATH/spool or ~/.teamkb/spool)',
    )
    .option(
      '--scope <scope>',
      `Which artifacts to emit: ${VALID_SCOPES.join(' | ')} (default: wiki)`,
      'wiki',
    )
    .option('--tenant <id>', 'Tenant identifier (overrides spool.tenantId in config)')
    .option(
      '--bulk',
      'Mark this as a whole-machine / large digestion: every candidate is stamped ' +
        "source 'bulk_import' + trust 'untrusted' so INTKB's policy can gate the flood",
      false,
    )
    .option('--dry-run', 'Print what would be emitted, structure only; no writes', false)
    .option('-w, --workspace <path>', 'Workspace path (defaults to ICO_WORKSPACE or cwd)')
    .action((options: SpoolEmitOptions, command: Command) => {
      runSpoolEmit(options, command);
    });
}
