/**
 * `ico promote <path> --as <type>` — Promote an artifact from
 * `workspace/outputs/` into `workspace/wiki/` as compiled knowledge (E8-B05).
 *
 * Usage:
 *   ico promote <path> --as <type>           Promote artifact to wiki
 *   ico promote <path> --as <type> --yes     Skip confirmation message
 *   ico promote <path> --as <type> --dry-run Preview only, no changes
 *
 * Enforcement is delegated entirely to `promoteArtifact()` in the kernel.
 * This command is responsible for:
 *   - Workspace/DB setup and teardown
 *   - Rendering a dry-run preview
 *   - Requiring --yes for live promotions
 *   - Mapping `PromotionError` codes to appropriate exit codes
 *   - Writing a trace event on success (trace is also written inside kernel)
 *
 * @module commands/promote
 */

import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import {
  closeDatabase,
  initDatabase,
  promoteArtifact,
  PromotionError,
  type PromotionType,
  VALID_PROMOTION_TYPES,
} from '@ico/kernel';

import {
  bold,
  dim,
  formatError,
  formatInfo,
  formatKeyValue,
  formatSuccess,
  formatWarning,
} from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PromoteOptions {
  as?: string;
  yes?: boolean;
  dryRun?: boolean;
  workspace?: string;
}

interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  workspace?: string;
}

// ---------------------------------------------------------------------------
// Error-code → exit-code mapping
// ---------------------------------------------------------------------------

/**
 * Maps each `PromotionErrorCode` to the process exit code that `ico promote`
 * should set when the promotion fails with that code.
 *
 * Exit-code semantics:
 *   1 — eligibility or I/O failures (bad path, missing file, empty file, etc.)
 *   2 — invalid input (unrecognised targetType)
 *   3 — policy rejection (draft, evidence, or unconfirmed)
 *   4 — target collision or copy failure
 *   5 — audit-trail write failure (promotion happened but audit incomplete)
 */
const EXIT_CODE_MAP: Record<string, number> = {
  INELIGIBLE_PATH: 1,
  FILE_NOT_FOUND: 1,
  EMPTY_FILE: 1,
  MISSING_FRONTMATTER: 1,
  INVALID_TYPE: 2,
  DRAFT_REJECTED: 3,
  EVIDENCE_REJECTED: 3,
  NOT_CONFIRMED: 3,
  TARGET_EXISTS: 4,
  COPY_FAILED: 4,
  AUDIT_WRITE_FAILED: 5,
};

// ---------------------------------------------------------------------------
// Target-path preview (dry-run helper)
// ---------------------------------------------------------------------------

/**
 * Compute the expected target wiki path for a given source path and type
 * without actually performing the promotion.
 *
 * This duplicates a small portion of the kernel's slug logic so that dry-run
 * can show the user exactly where the file would land.
 */
function computeTargetPreview(
  sourcePath: string,
  targetType: PromotionType,
  workspacePath: string,
): string {
  const subdirMap: Record<PromotionType, string> = {
    topic: 'wiki/topics',
    concept: 'wiki/concepts',
    entity: 'wiki/entities',
    reference: 'wiki/sources',
  };

  // Extract the stem (filename without extension) as a rough slug preview.
  const abs = resolve(workspacePath, sourcePath);
  const stem =
    abs
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? 'artifact';
  const slug = stem
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return join(subdirMap[targetType], `${slug}.md`);
}

// ---------------------------------------------------------------------------
// Core promote logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Execute the promote pipeline.
 *
 * @param sourcePath - Path to the artifact (workspace-relative or absolute).
 * @param opts       - Command-level options (as, yes, dryRun, workspace).
 * @param globalOpts - Global CLI flags (json, verbose, workspace).
 */
export function runPromote(
  sourcePath: string,
  opts: PromoteOptions,
  globalOpts: GlobalOptions,
): void {
  // -------------------------------------------------------------------------
  // 1. Validate --as flag
  // -------------------------------------------------------------------------
  const targetTypeRaw = opts.as;

  if (targetTypeRaw === undefined || targetTypeRaw.trim() === '') {
    process.stderr.write(
      formatError(`--as <type> is required. Valid types: ${VALID_PROMOTION_TYPES.join(', ')}`) +
        '\n',
    );
    process.exitCode = 2;
    return;
  }

  const targetType = targetTypeRaw.trim() as PromotionType;

  if (!(VALID_PROMOTION_TYPES as readonly string[]).includes(targetType)) {
    process.stderr.write(
      formatError(
        `Invalid type "${targetType}". Valid types: ${VALID_PROMOTION_TYPES.join(', ')}`,
      ) + '\n',
    );
    process.exitCode = 2;
    return;
  }

  // -------------------------------------------------------------------------
  // 2. Resolve workspace
  // -------------------------------------------------------------------------
  const wsOverride = opts.workspace ?? globalOpts.workspace;
  const wsResult = resolveWorkspace(wsOverride !== undefined ? { workspace: wsOverride } : {});

  if (!wsResult.ok) {
    process.stderr.write(formatError(wsResult.error.message) + '\n');
    process.exitCode = 1;
    return;
  }

  const { root: wsPath, dbPath } = wsResult.value;

  // -------------------------------------------------------------------------
  // 3. Dry-run: show preview and exit
  // -------------------------------------------------------------------------
  if (opts.dryRun === true) {
    const targetPreview = computeTargetPreview(sourcePath, targetType, wsPath);

    process.stdout.write('\n');
    process.stdout.write(formatInfo('Dry-run preview (no changes will be made)') + '\n\n');
    process.stdout.write(
      formatKeyValue([
        ['Source', sourcePath],
        ['Target type', targetType],
        ['Target path', targetPreview],
        ['Workspace', wsPath],
      ]) + '\n',
    );
    process.stdout.write('\n');
    process.stdout.write(
      dim(`Run without --dry-run and with --yes to execute the promotion.`) + '\n',
    );
    process.stdout.write('\n');
    return;
  }

  // -------------------------------------------------------------------------
  // 4. Require --yes for live promotions
  // -------------------------------------------------------------------------
  if (opts.yes !== true) {
    const targetPreview = computeTargetPreview(sourcePath, targetType, wsPath);

    process.stdout.write('\n');
    process.stdout.write(formatWarning('Confirmation required') + '\n\n');
    process.stdout.write(
      formatKeyValue([
        ['Source', sourcePath],
        ['Target type', targetType],
        ['Target path', targetPreview],
      ]) + '\n',
    );
    process.stdout.write('\n');
    process.stdout.write(
      formatInfo('Use --yes to confirm promotion, or --dry-run to preview.') + '\n',
    );
    process.stdout.write('\n');
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------------------------------
  // 5. Open database
  // -------------------------------------------------------------------------
  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) {
    process.stderr.write(formatError(`Database error: ${dbResult.error.message}`) + '\n');
    process.exitCode = 1;
    return;
  }

  const db = dbResult.value;

  try {
    // -----------------------------------------------------------------------
    // 6. Call promoteArtifact
    // -----------------------------------------------------------------------
    const result = promoteArtifact(db, wsPath, {
      sourcePath,
      targetType,
      confirm: true,
    });

    if (!result.ok) {
      const promotionErr = result.error;

      let exitCode = 1;
      if (promotionErr instanceof PromotionError) {
        exitCode = EXIT_CODE_MAP[promotionErr.code] ?? 1;
      }

      process.stderr.write(formatError(promotionErr.message) + '\n');

      if (promotionErr instanceof PromotionError) {
        process.stderr.write(dim(`  Error code: ${promotionErr.code}`) + '\n');
      }

      process.exitCode = exitCode;
      return;
    }

    const { sourcePath: resolvedSource, targetPath, targetType: promotedType } = result.value;

    // -----------------------------------------------------------------------
    // 7. Display success
    // -----------------------------------------------------------------------
    process.stdout.write('\n');
    process.stdout.write(
      formatSuccess(`Promoted: ${bold(resolvedSource)} → ${bold(targetPath)}`) + '\n',
    );
    process.stdout.write('\n');
    process.stdout.write(
      formatKeyValue([
        ['Type', promotedType],
        ['Target', targetPath],
      ]) + '\n',
    );
    process.stdout.write('\n');
    process.stdout.write(
      dim(`Tip: Run \`ico lint knowledge\` to verify the promoted page.`) + '\n',
    );
    process.stdout.write('\n');
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `ico promote <path>` on the root Commander program.
 *
 * @param program - The root Commander `Command` instance.
 */
export function register(program: Command): void {
  program
    .command('promote <path>')
    .description('Promote an artifact from outputs/ into the compiled knowledge base')
    .requiredOption('--as <type>', `Target knowledge type (${VALID_PROMOTION_TYPES.join(' | ')})`)
    .option('--yes', 'Skip confirmation and execute immediately')
    .option('--dry-run', 'Preview what would happen without making changes')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ ico promote outputs/reports/my-report.md --as topic',
        '  $ ico promote outputs/reports/my-report.md --as topic --yes',
        '  $ ico promote outputs/reports/my-report.md --as concept --dry-run',
      ].join('\n'),
    )
    .action((path: string, opts: PromoteOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      runPromote(path, opts, {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      });
    });
}
