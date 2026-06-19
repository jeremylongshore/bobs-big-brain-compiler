/**
 * Command-level tests for `ico status` — drives the registered Commander
 * action over a real workspace, covering the four output branches (default /
 * --json / --sources / --sources --json) that the direct unit tests in
 * status.test.ts don't reach.
 *
 * Part of bead `intentional-cognition-os-0wy.7` (CLI coverage climb).
 *
 * @module commands/status.command.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { closeDatabase, initDatabase, initWorkspace } from '@ico/kernel';

import { register } from './status.js';

let base: string;
let wsRoot: string;
let logSpy: MockInstance;
let logged: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ico-status-cmd-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  wsRoot = ws.value.root;
  const db = initDatabase(ws.value.dbPath);
  if (!db.ok) throw db.error;
  closeDatabase(db.value);

  logged = '';
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logged += a.map(String).join(' ') + '\n';
  });
});
afterEach(() => {
  logSpy.mockRestore();
  rmSync(base, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function runStatus(args: string[]): Promise<string> {
  const program = new Command();
  program
    .name('ico')
    .option('--workspace <path>', 'Workspace directory')
    .option('--json', 'JSON output')
    .exitOverride();
  register(program);
  await program.parseAsync(['node', 'ico', '--workspace', wsRoot, 'status', ...args]);
  return logged;
}

describe('ico status — command action', () => {
  it('default mode renders the human status report', async () => {
    const out = await runStatus([]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.toLowerCase()).toMatch(/source|task|workspace|status/);
  });

  it('--json emits JSON', async () => {
    const out = await runStatus(['--json']);
    expect(out).toContain('{');
    expect(out).toMatch(/"\w+":/);
  });

  it('--sources renders the sources table', async () => {
    const out = await runStatus(['--sources']);
    expect(out.length).toBeGreaterThan(0);
  });

  it('--sources --json emits JSON for the sources list', async () => {
    const out = await runStatus(['--sources', '--json']);
    expect(out).toMatch(/\[|\{/);
  });
});
