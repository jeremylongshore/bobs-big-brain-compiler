import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { register as registerAsk } from './commands/ask.js';
import { register as registerCompile } from './commands/compile.js';
import { register as registerEval } from './commands/eval.js';
import { register as registerIngest } from './commands/ingest.js';
import { register as registerInit } from './commands/init.js';
import { register as registerInspect } from './commands/inspect.js';
import { register as registerLint } from './commands/lint.js';
import { register as registerMount } from './commands/mount.js';
import { register as registerPromote } from './commands/promote.js';
import { register as registerRecall } from './commands/recall.js';
import { register as registerRender } from './commands/render.js';
import { register as registerResearch } from './commands/research.js';
import { register as registerSpool } from './commands/spool.js';
import { register as registerStatus } from './commands/status.js';
import { register as registerUnpromote } from './commands/unpromote.js';
import { friendlyError } from './lib/friendly-errors.js';

/**
 * Read the CLI's own version from its package.json — the published
 * artefact. The previous implementation imported a hardcoded constant
 * from `@ico/kernel`, which made `ico --version` report the kernel's
 * internal version instead of the released npm package version
 * (E10-B11 release-gate Condition 1).
 *
 * The resolution path is `<dist>/index.js → ../package.json`. The npm
 * tarball ships `dist/` and `package.json` as siblings, so the same
 * relative path resolves correctly in both dev (running from
 * `packages/cli/dist/index.js`) and post-install (running from
 * `<prefix>/dist/index.js`).
 */
function readCliVersion(): string {
  // This runs at module load — BEFORE the process-level error
  // handlers are installed further down. Any uncaught throw here
  // would surface as a raw Node stack trace and bypass the
  // friendly-error path. Wrap in try/catch and emit a single
  // `[ico]`-prefixed message that matches the convention the
  // friendly-error handler uses for everything else (PR #74 review).
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '..', 'package.json');
  try {
    const raw = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    if (typeof raw.version !== 'string') {
      throw new Error(`package.json at ${pkgPath} is missing a string "version" field`);
    }
    return raw.version;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Don't crash with a stack trace — the operator can still use the
    // CLI without a real version string. Log a single line to stderr
    // and fall back to a sentinel so help/version output is sensible.
    process.stderr.write(`[ico] failed to read CLI version: ${msg}\n`);
    return '0.0.0-unknown';
  }
}

export const cliVersion = readCliVersion();

export function buildProgram(): Command {
  const p = new Command();
  p.name('ico')
    .description(
      'Intentional Cognition OS — Compile knowledge for the machine. Distill understanding for the human.\n\n' +
        '  Operating loop:\n' +
        '    ico init → ico mount → ico ingest → ico compile → ico status\n\n' +
        '  Advanced:\n' +
        '    ico ask      Query your compiled knowledge\n' +
        '    ico research  Multi-agent research with episodic workspaces\n' +
        '    ico render    Generate reports, slides, briefings\n' +
        '    ico promote   File artifacts back into the knowledge base',
    )
    .version(cliVersion)
    .option('--workspace <path>', 'Workspace directory')
    .option('--verbose', 'Show debug output')
    .option('--quiet', 'Suppress non-essential output')
    .option('--json', 'Output as JSON');

  registerInit(p);
  registerIngest(p);
  registerMount(p);
  registerCompile(p);
  registerAsk(p);
  registerResearch(p);
  registerRender(p);
  registerLint(p);
  registerRecall(p);
  registerPromote(p);
  registerStatus(p);
  registerSpool(p);
  registerEval(p);
  registerInspect(p);
  registerUnpromote(p);

  return p;
}

// ---------------------------------------------------------------------------
// Top-level process-error handlers (E10-B05)
//
// Goal: the operator never sees a Node stack trace for a known failure
// mode. Uncaught exceptions and unhandled promise rejections are caught
// here, formatted through `friendlyError`, written to stderr with the
// `[ico]` prefix, and the process exits with code 1.
//
// SIGINT: the system relies on the atomic `.tmp + rename` write pattern
// across the kernel + compiler, so a Ctrl-C mid-operation cannot leave
// half-written files. The handler just prints a polite line and exits
// 130 (the conventional Unix code for SIGINT). Children of long-running
// async ops still get their finally-blocks (DB close, rl.close) on
// process exit because Node fires those on normal exit paths.
// ---------------------------------------------------------------------------

/**
 * Decide whether to print a stack trace alongside the friendly message.
 *
 * Two cases warrant the stack:
 *   1. The error was NOT mapped by `friendlyError` (the friendly message is
 *      the verbatim original) — debugging an unknown failure needs the trace.
 *   2. `--verbose` is set on the command line — operator opted in.
 *
 * Known categories (ENOSPC, rate_limit_error, etc.) already give an
 * actionable hint; the stack is noise in the default UI.
 */
function shouldEmitStack(err: unknown, friendly: string): boolean {
  if (!(err instanceof Error) || err.stack === undefined) return false;
  if (process.argv.includes('--verbose')) return true;
  return friendly === err.message;
}

/** Register the process-level error and signal handlers. Idempotent. */
export function installProcessHandlers(): void {
  // `installed` flag prevents double-registration in tests that import the
  // module twice via vitest's worker pool.
  const g = process as unknown as { __icoHandlersInstalled?: boolean };
  if (g.__icoHandlersInstalled === true) return;
  g.__icoHandlersInstalled = true;

  process.on('uncaughtException', (err: unknown) => {
    const friendly = friendlyError(err);
    process.stderr.write(`[ico] uncaught exception: ${friendly}\n`);
    if (shouldEmitStack(err, friendly)) {
      process.stderr.write(`\n${(err as Error).stack ?? ''}\n`);
    }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const friendly = friendlyError(reason);
    process.stderr.write(`[ico] unhandled rejection: ${friendly}\n`);
    if (shouldEmitStack(reason, friendly)) {
      process.stderr.write(`\n${(reason as Error).stack ?? ''}\n`);
    }
    process.exit(1);
  });
  process.on('SIGINT', () => {
    process.stderr.write('\n[ico] interrupted (SIGINT). Exiting.\n');
    // 128 + signal number (SIGINT = 2) is the Unix convention.
    process.exit(130);
  });
}

// Only parse when run directly as the CLI entry point
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/index.js') || process.argv[1].endsWith('/ico'));

if (isMain) {
  installProcessHandlers();
  buildProgram().parse();
}
