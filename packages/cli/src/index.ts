import { Command } from 'commander';

import { version } from '@ico/kernel';

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
import { register as registerStatus } from './commands/status.js';
import { register as registerUnpromote } from './commands/unpromote.js';
import { friendlyError } from './lib/friendly-errors.js';

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
    .version(version)
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

/** Register the process-level error and signal handlers. Idempotent. */
export function installProcessHandlers(): void {
  // `installed` flag prevents double-registration in tests that import the
  // module twice via vitest's worker pool.
  const g = process as unknown as { __icoHandlersInstalled?: boolean };
  if (g.__icoHandlersInstalled === true) return;
  g.__icoHandlersInstalled = true;

  process.on('uncaughtException', (err: unknown) => {
    process.stderr.write(`[ico] uncaught exception: ${friendlyError(err)}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`[ico] unhandled rejection: ${friendlyError(reason)}\n`);
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
