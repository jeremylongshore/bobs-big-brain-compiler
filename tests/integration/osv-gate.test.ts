import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// The CI Security Audit job lets osv-scanner 2.x write JSON and gates on this
// script, because 2.x has no severity flag. These tests prove the gate can
// actually fail (real pre-remediation report) and pass (post-remediation).

const root = resolve(__dirname, '..', '..');
const gate = join(root, 'scripts', 'osv-gate.mjs');
const fixture = (name: string): string => join(root, 'tests', 'fixtures', 'osv', name);

function run(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [gate, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

function tmpJson(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'osv-gate-')), 'report.json');
  writeFileSync(p, content);
  return p;
}

const group = (score: string, id = 'GHSA-test'): string =>
  JSON.stringify({
    results: [
      {
        packages: [
          {
            package: { name: 'pkg', version: '1.0.0' },
            groups: [{ ids: [id], max_severity: score }],
          },
        ],
      },
    ],
  });

describe('scripts/osv-gate.mjs', () => {
  it('fails on the real pre-remediation report (HIGH findings present)', () => {
    const r = run([fixture('pre-remediation.json')]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('28 at/above 7');
    expect(r.out).toContain('fast-uri');
  });

  it('passes on the post-remediation report (only sub-HIGH findings remain)', () => {
    const r = run([fixture('post-remediation.json')]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('0 at/above 7');
  });

  it('passes on a report with no results', () => {
    expect(run([fixture('clean.json')]).status).toBe(0);
  });

  it('treats exactly 7.0 as blocking and 6.9 as passing', () => {
    expect(run([tmpJson(group('7.0'))]).status).toBe(1);
    expect(run([tmpJson(group('6.9'))]).status).toBe(0);
  });

  it('honours --min-score', () => {
    expect(run([tmpJson(group('9.0')), '--min-score=9.5']).status).toBe(0);
    expect(run([tmpJson(group('9.0')), '--min-score=9.0']).status).toBe(1);
  });

  it('warns about unscored advisories without failing', () => {
    const r = run([tmpJson(group(''))]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('no CVSS score');
  });

  it('exits 2 (not 0) when the report is missing, malformed or not an osv report', () => {
    expect(run([join(tmpdir(), 'does-not-exist-osv.json')]).status).toBe(2);
    expect(run([tmpJson('not json')]).status).toBe(2);
    expect(run([tmpJson('{"error":"unknown flag"}')]).status).toBe(2);
    expect(run([]).status).toBe(2);
  });
});
