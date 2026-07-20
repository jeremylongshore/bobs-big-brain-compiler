/**
 * Distiller-output groundedness harness — integration test (l13.9).
 *
 * Exercises scripts/distiller/eval-distiller-output.mjs BOTH as a library
 * (imported scoring primitives) and as the real CLI the nightly wrapper
 * invokes (spawned node process), against a scratch decisions.jsonl +
 * kb-export fixture:
 *
 *   - a grounded candidate (well-formed citation, existing doc, high title
 *     overlap) scores 1;
 *   - a fabricated candidate (title shares no vocabulary with its cited doc)
 *     fails on low-overlap;
 *   - a candidate citing a missing doc fails on missing-source;
 *   - a malformed / traversal citation fails without touching the filesystem;
 *   - missing inputs and absent records SKIP with exit 0 (degrade-not-crash);
 *   - a below-threshold night exits 1 (the regression signal the wrapper logs).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The plain-JS harness ships a sibling .d.mts so these imports are fully typed.
import {
  CITATION_SCHEME,
  CITATION_SCHEME_VERSION,
  citationToRelPath,
  evaluateRecord,
  overlapRatio,
  selectRecordForDate,
} from '../../scripts/distiller/eval-distiller-output.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const harness = resolve(__dirname, '..', '..', 'scripts', 'distiller', 'eval-distiller-output.mjs');

let scratch: string;
let kbExport: string;
let decisionsPath: string;

function runHarness(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [harness, ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeDecisions(records: unknown[]): void {
  writeFileSync(decisionsPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'distiller-eval-'));
  kbExport = join(scratch, 'kb-export');
  mkdirSync(join(kbExport, 'decisions'), { recursive: true });
  mkdirSync(join(kbExport, 'guides'), { recursive: true });
  decisionsPath = join(scratch, 'decisions.jsonl');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('citationToRelPath', () => {
  it('maps a kb-prefixed collection onto its export dir', () => {
    expect(citationToRelPath('qmd://kb-decisions/abc-123.md')).toBe('decisions/abc-123.md');
    expect(citationToRelPath('qmd://kb-guides/x.md')).toBe('guides/x.md');
  });

  it('passes an un-prefixed collection through unchanged', () => {
    expect(citationToRelPath('qmd://curated/x.md')).toBe('curated/x.md');
  });

  it('rejects malformed and traversal citations', () => {
    expect(citationToRelPath('')).toBeNull();
    expect(citationToRelPath('https://kb-decisions/x.md')).toBeNull();
    expect(citationToRelPath('qmd://kb-decisions/../secrets.md')).toBeNull();
    expect(citationToRelPath('qmd://kb-decisions/x.txt')).toBeNull();
    expect(citationToRelPath(undefined)).toBeNull();
  });
});

describe('selectRecordForDate', () => {
  it('iterates ALL lines and keeps only the LAST same-date record (last-wins)', () => {
    const body = [
      JSON.stringify({
        date: '2026-07-18',
        candidates: [{ title: 'first', disposition: 'promoted' }],
      }),
      JSON.stringify({
        date: '2026-07-17',
        candidates: [{ title: 'other-date', disposition: 'promoted' }],
      }),
      JSON.stringify({
        date: '2026-07-18',
        candidates: [{ title: 'SECOND-wins', disposition: 'promoted' }],
      }),
    ].join('\n');
    const { record, matchCount } = selectRecordForDate(body, '2026-07-18');
    expect(matchCount).toBe(2);
    // The FINAL same-date record won, not the first, and not the other-date one.
    expect((record?.candidates as Array<{ title: string }>)[0].title).toBe('SECOND-wins');
  });

  it('returns matchCount 1 for a single record and 0 when none match', () => {
    const body = JSON.stringify({ date: '2026-07-18', candidates: [] });
    expect(selectRecordForDate(body, '2026-07-18').matchCount).toBe(1);
    const none = selectRecordForDate(body, '2099-01-01');
    expect(none.matchCount).toBe(0);
    expect(none.record).toBeNull();
  });

  it('skips corrupt lines without aborting the scan', () => {
    const body = [
      'not json at all {{{',
      JSON.stringify({
        date: '2026-07-18',
        candidates: [{ title: 'kept', disposition: 'promoted' }],
      }),
    ].join('\n');
    const { record, matchCount } = selectRecordForDate(body, '2026-07-18');
    expect(matchCount).toBe(1);
    expect((record?.candidates as Array<{ title: string }>)[0].title).toBe('kept');
  });
});

describe('overlapRatio', () => {
  it('is 1 when every title content-word appears in the source', () => {
    expect(
      overlapRatio('Stryker mutation baseline gate', 'the stryker mutation baseline gate held'),
    ).toBe(1);
  });

  it('is 0 when the title shares no vocabulary with the source', () => {
    expect(
      overlapRatio('quantum blockchain espresso', 'the stryker mutation baseline gate held'),
    ).toBe(0);
  });

  it('is vacuously 1 for a title with no content-words', () => {
    expect(overlapRatio('a an of', 'anything')).toBe(1);
  });
});

describe('evaluateRecord', () => {
  it('scores grounded candidates 1 and discloses per-candidate findings for the rest', () => {
    writeFileSync(
      join(kbExport, 'decisions', 'good.md'),
      '# Decision\nThe retrieval backend stays reranker-first per 044-AT-DECR.\n',
    );
    const record = {
      date: '2026-07-19',
      candidates: [
        {
          title: 'Retrieval backend stays reranker-first per 044-AT-DECR',
          disposition: 'promoted',
          citation: 'qmd://kb-decisions/good.md',
        },
        {
          title: 'Fabricated unrelated espresso migration story',
          disposition: 'promoted',
          citation: 'qmd://kb-decisions/good.md',
        },
        {
          title: 'Cites a doc that does not exist anywhere',
          disposition: 'promoted',
          citation: 'qmd://kb-decisions/ghost.md',
        },
        { title: 'Rejected — must be ignored', disposition: 'rejected', citation: 'nope' },
      ],
    };
    const verdict = evaluateRecord(record, kbExport, { minOverlap: 0.5, minScore: 0.8 });
    expect(verdict.skipped).toBe(false);
    expect(verdict.details.promoted).toBe(3);
    expect(verdict.details.findings.map((f: { check: string }) => f.check)).toEqual([
      'ok',
      'low-overlap',
      'missing-source',
    ]);
    expect(verdict.score).toBeCloseTo(1 / 3);
    expect(verdict.passed).toBe(false);
  });

  it('skips (passing) a record with zero promoted candidates', () => {
    const verdict = evaluateRecord({ date: 'x', candidates: [] }, kbExport, {});
    expect(verdict.skipped).toBe(true);
    expect(verdict.passed).toBe(true);
  });
});

describe('CLI', () => {
  it('exits 0 with a PASS line on a grounded night', () => {
    writeFileSync(
      join(kbExport, 'guides', 'lock.md'),
      'slack_post always exits 0 — never trust it for delivery honesty. The wrapper must check the webhook response itself.\n',
    );
    writeDecisions([
      {
        date: '2026-07-18',
        candidates: [
          {
            title: 'slack_post always exits 0 — never trust it for delivery honesty',
            disposition: 'promoted',
            citation: 'qmd://kb-guides/lock.md',
          },
        ],
      },
    ]);
    const r = runHarness([
      '--decisions',
      decisionsPath,
      '--date',
      '2026-07-18',
      '--kb-export',
      kbExport,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('grounded 1/1');
    expect(r.stdout).toContain('PASS');
    // The summary names the versioned citation contract so a reader can tell
    // "model broke" from "harness broke" from the log alone.
    expect(r.stdout).toContain(`citation format=${CITATION_SCHEME} v${CITATION_SCHEME_VERSION}`);
  });

  it('WARNs (but still scores the last) when a date has more than one record', () => {
    writeFileSync(
      join(kbExport, 'guides', 'lock.md'),
      'the wrapper must check the webhook response itself\n',
    );
    writeDecisions([
      {
        date: '2026-07-18',
        candidates: [
          {
            title: 'superseded earlier run',
            disposition: 'promoted',
            citation: 'qmd://kb-guides/lock.md',
          },
        ],
      },
      {
        date: '2026-07-18',
        candidates: [
          {
            title: 'the wrapper must check the webhook response itself',
            disposition: 'promoted',
            citation: 'qmd://kb-guides/lock.md',
          },
        ],
      },
    ]);
    const r = runHarness([
      '--decisions',
      decisionsPath,
      '--date',
      '2026-07-18',
      '--kb-export',
      kbExport,
    ]);
    expect(r.stdout).toContain('WARN: 2 decisions records for 2026-07-18');
    expect(r.stdout).toContain('grounded 1/1'); // the LAST record was scored
    expect(r.status).toBe(0);
  });

  it('flags a whole-batch citation format drift as a contract break, not a quality regression', () => {
    writeDecisions([
      {
        date: '2026-07-18',
        candidates: [
          {
            title: 'valid title',
            disposition: 'promoted',
            citation: 'https://not-a-qmd-scheme/x.md',
          },
        ],
      },
    ]);
    const r = runHarness([
      '--decisions',
      decisionsPath,
      '--date',
      '2026-07-18',
      '--kb-export',
      kbExport,
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('malformed-citation');
    expect(r.stdout).toContain('CONTRACT drift');
  });

  it('exits 1 on a below-threshold night and discloses each failure', () => {
    writeFileSync(join(kbExport, 'decisions', 'doc.md'), 'entirely different subject matter\n');
    writeDecisions([
      {
        date: '2026-07-18',
        candidates: [
          {
            title: 'Fabricated claim with zero source vocabulary overlap',
            disposition: 'promoted',
            citation: 'qmd://kb-decisions/doc.md',
          },
        ],
      },
    ]);
    const r = runHarness([
      '--decisions',
      decisionsPath,
      '--date',
      '2026-07-18',
      '--kb-export',
      kbExport,
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('low-overlap');
    expect(r.stdout).toContain('FAIL');
  });

  it('skips with exit 0 when the decisions file or the record is absent', () => {
    const missing = runHarness([
      '--decisions',
      join(scratch, 'nope.jsonl'),
      '--date',
      '2026-07-18',
      '--kb-export',
      kbExport,
    ]);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain('SKIP');

    writeDecisions([{ date: '2026-01-01', candidates: [] }]);
    const noRecord = runHarness([
      '--decisions',
      decisionsPath,
      '--date',
      '2026-07-18',
      '--kb-export',
      kbExport,
    ]);
    expect(noRecord.status).toBe(0);
    expect(noRecord.stdout).toContain('SKIP: no decisions record');
  });

  it('exits 2 on bad usage', () => {
    const r = runHarness(['--date', '2026-07-18']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage error');
  });
});
