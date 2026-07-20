/**
 * End-to-end CLI smoke for the receipts-precede-visibility floor (G1) —
 * drives the REAL `ico` binary (packages/cli/dist) through the exact
 * sequence the PR evidence cites:
 *
 *   scratch workspace → hand-planted orphan wiki page →
 *   `ico audit reconcile` exits 2 with a per-file report →
 *   the file sits under quarantine/ (moved, never deleted) →
 *   a second reconcile exits 0 (corpus consistent) →
 *   `ico audit verify` passes and the audit.reconcile receipt is on disk.
 *
 * Pre-requisite: the CLI package must be built (`pnpm build`) — the
 * beforeAll throws a clear error otherwise.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDistEntry = resolve(__dirname, '..', '..', 'packages', 'cli', 'dist', 'index.js');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  const r = spawnSync(process.execPath, [cliDistEntry, ...args], {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('CLI smoke — ico audit reconcile quarantines a laundered page end-to-end', () => {
  let tmpRoot: string;
  let ws: string;

  beforeAll(() => {
    if (!existsSync(cliDistEntry)) {
      throw new Error(
        `CLI dist not found at ${cliDistEntry}. Run \`pnpm build\` before this test.`,
      );
    }
  });

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ico-cli-smoke-'));
    const init = runCli(['init', 'smoke', '--path', tmpRoot]);
    expect(init.status).toBe(0);
    ws = join(tmpRoot, 'smoke');
    expect(existsSync(join(ws, 'wiki', 'topics'))).toBe(true);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('quarantine → exit 2 → consistent re-run → exit 0 → verify shows the receipt', () => {
    // Hand-plant a visible wiki page with no receipt row — exactly the
    // residue the OLD (pre-G1) write ordering could leave after a crash.
    const orphanRel = join('wiki', 'topics', 'laundered.md');
    writeFileSync(join(ws, orphanRel), '---\ntitle: Laundered Page\n---\nunreceipted\n', 'utf-8');

    // 1. Reconcile: exit 2, per-file report, nothing deleted.
    const first = runCli(['audit', 'reconcile', '-w', ws]);
    expect(first.status).toBe(2);
    expect(first.stderr).toMatch(/RECONCILED: 1 unreceipted page\(s\) quarantined/);
    expect(first.stderr).toMatch(/wiki\/topics\/laundered\.md/);
    expect(first.stderr).toMatch(/Nothing was deleted/);

    // 2. The page moved (byte-identical) under quarantine/, out of wiki/.
    expect(existsSync(join(ws, orphanRel))).toBe(false);
    const quarantinedAbs = join(ws, 'quarantine', orphanRel);
    expect(existsSync(quarantinedAbs)).toBe(true);
    expect(readFileSync(quarantinedAbs, 'utf-8')).toContain('unreceipted');

    // 3. Second reconcile: corpus consistent, exit 0 (JSON envelope too).
    const second = runCli(['audit', 'reconcile', '-w', ws, '--json']);
    expect(second.status).toBe(0);
    const envelope = JSON.parse(second.stdout.trim()) as Record<string, unknown>;
    expect(envelope['ok']).toBe(true);
    expect(envelope['quarantined']).toEqual([]);

    // 4. The reconciliation itself is receipted: audit verify walks clean
    //    and the audit.reconcile event is in the day's trace JSONL.
    const verify = runCli(['audit', 'verify', '-w', ws, '--json']);
    expect(verify.status).toBe(0);
    const verifyEnvelope = JSON.parse(verify.stdout.trim()) as Record<string, unknown>;
    expect(verifyEnvelope['ok']).toBe(true);
    expect(verifyEnvelope['totalEvents']).toBeGreaterThanOrEqual(1);

    const today = new Date().toISOString().slice(0, 10);
    const traceFile = join(ws, 'audit', 'traces', `${today}.jsonl`);
    expect(existsSync(traceFile)).toBe(true);
    expect(readFileSync(traceFile, 'utf-8')).toMatch(/"event_type":"audit\.reconcile"/);
  }, 60_000);
});
