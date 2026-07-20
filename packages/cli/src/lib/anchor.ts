/**
 * Operator-side helpers for external chain-head anchoring (l13.8).
 *
 * The kernel owns the anchor log (`appendIcoAnchor` / `verifyIcoAnchors`);
 * this module owns the operator concerns: resolving WHERE the anchor file
 * lives and committing the append into the witnessing git repo.
 *
 * Resolution is explicit-only: an anchor file inside the workspace on the
 * same disk witnesses nothing by itself, so ICO never invents a default
 * location. The operator points `ICO_ANCHOR_FILE` (or `--anchor-file`) at a
 * file inside an externally-pushed git repo — the intended deployment is
 * `~/.teamkb/audit/ico-anchors.jsonl`, the same witnessed repo that already
 * holds INTKB's `anchors.jsonl`, so the ICO chain inherits its
 * force-push-protected remote.
 *
 * @module lib/anchor
 */

import { execFileSync } from 'node:child_process';
import { basename, dirname } from 'node:path';

import { appendIcoAnchor } from '@ico/kernel';

import { formatInfo, formatWarning } from './output.js';

/**
 * Resolve the anchor file: explicit flag first, then the `ICO_ANCHOR_FILE`
 * environment variable. `undefined` = anchoring not configured.
 */
export function resolveAnchorFile(flagValue?: string): string | undefined {
  if (flagValue !== undefined && flagValue.trim() !== '') return flagValue;
  const env = process.env['ICO_ANCHOR_FILE'];
  return env !== undefined && env.trim() !== '' ? env : undefined;
}

/** Outcome of a git commit attempt on the anchor file. */
export interface AnchorCommitOutcome {
  committed: boolean;
  detail: string;
}

/**
 * Best-effort `git add + commit` of the anchor file in its containing repo.
 * Never throws: anchoring is evidence hygiene, and the compile that produced
 * the events must not fail because the witnessing repo hiccuped. The PUSH is
 * deliberately left to the repo's own sync (cron / operator) — a network
 * dependency inside the compile path would be a new failure mode.
 */
export function commitAnchorFile(anchorPath: string): AnchorCommitOutcome {
  const dir = dirname(anchorPath);
  try {
    const inside = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (inside !== 'true') {
      return {
        committed: false,
        detail: `${dir} is not a git work tree — anchor appended but not committed`,
      };
    }
    execFileSync('git', ['-C', dir, 'add', '--', anchorPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync(
      'git',
      ['-C', dir, 'commit', '-m', `ico: anchor compile-trace chain head (${basename(anchorPath)})`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { committed: true, detail: 'anchor committed to the witnessing repo' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // "nothing to commit" after a no-op append is a benign outcome.
    if (message.includes('nothing to commit')) {
      return { committed: false, detail: 'nothing to commit (anchor unchanged)' };
    }
    return { committed: false, detail: `git commit failed: ${message}` };
  }
}

/**
 * Post-compile anchoring hook: when `ICO_ANCHOR_FILE` is configured, append
 * the current chain head to the anchor log and commit it into the witnessing
 * repo. Best-effort by design — failures WARN and never fail the compile
 * (the trace events themselves are already durable; anchoring strengthens
 * their evidence, it does not gate them).
 */
export function anchorAfterCompile(workspacePath: string): void {
  const anchorPath = resolveAnchorFile();
  if (anchorPath === undefined) return;

  const result = appendIcoAnchor(workspacePath, anchorPath);
  if (!result.ok) {
    process.stderr.write(
      formatWarning(`Anchor append failed (compile unaffected): ${result.error.message}`) + '\n',
    );
    return;
  }
  if (!result.value.appended) {
    process.stdout.write(formatInfo('Chain head unchanged — anchor already witnessed.') + '\n');
    return;
  }
  const commit = commitAnchorFile(anchorPath);
  process.stdout.write(
    formatInfo(
      `Anchored compile-trace chain head (${result.value.record.totalEvents} events) → ${anchorPath}` +
        (commit.committed ? ' [committed]' : ` [${commit.detail}]`),
    ) + '\n',
  );
}
