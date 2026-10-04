#!/usr/bin/env node
// Severity gate for osv-scanner JSON output.
//
// osv-scanner 2.x has no severity flag (`--fail-on-vuln` and `--min-severity`
// were removed and are rejected as unknown flags), and it exits 1 on ANY
// finding. CI therefore lets the scanner write JSON and this script decides
// pass/fail: it exits 1 when any vulnerability group carries a CVSS score at or
// above the threshold (default 7.0 = HIGH), and exits 2 when the report is
// missing or malformed, so a scanner that never ran cannot read as a pass.
//
// Usage: node scripts/osv-gate.mjs <osv-report.json> [--min-score=7.0]

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MIN_SCORE = 7.0;

/**
 * @param {unknown} report parsed osv-scanner `--format=json` output
 * @param {number} minScore
 * @returns {{ blocking: object[], belowThreshold: number, unscored: object[], packages: number }}
 */
export function evaluate(report, minScore = DEFAULT_MIN_SCORE) {
  if (report === null || typeof report !== 'object' || !Array.isArray(report.results)) {
    throw new Error('not an osv-scanner JSON report (missing "results" array)');
  }
  const blocking = [];
  const unscored = [];
  let belowThreshold = 0;
  let packages = 0;
  for (const result of report.results) {
    for (const pkg of result.packages ?? []) {
      packages += 1;
      for (const group of pkg.groups ?? []) {
        const score = Number.parseFloat(group.max_severity);
        const row = {
          name: pkg.package?.name,
          version: pkg.package?.version,
          id: group.ids?.[0],
          score: Number.isNaN(score) ? null : score,
        };
        if (row.score === null) unscored.push(row);
        else if (row.score >= minScore) blocking.push(row);
        else belowThreshold += 1;
      }
    }
  }
  return { blocking, belowThreshold, unscored, packages };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  const flag = argv.find((a) => a.startsWith('--min-score='));
  const minScore = flag ? Number.parseFloat(flag.split('=')[1]) : DEFAULT_MIN_SCORE;
  if (!file || Number.isNaN(minScore)) {
    console.error('usage: osv-gate.mjs <osv-report.json> [--min-score=7.0]');
    return 2;
  }
  let outcome;
  try {
    outcome = evaluate(JSON.parse(readFileSync(file, 'utf8')), minScore);
  } catch (err) {
    console.error(`osv-gate: cannot use report ${file}: ${err.message}`);
    return 2;
  }
  for (const r of outcome.unscored) {
    console.warn(
      `::warning::osv-gate: ${r.name}@${r.version} ${r.id} has no CVSS score (not gated)`,
    );
  }
  for (const r of outcome.blocking) {
    console.error(
      `::error::osv-gate: ${r.name}@${r.version} ${r.id} CVSS ${r.score} >= ${minScore}`,
    );
  }
  console.log(
    `osv-gate: ${outcome.blocking.length} at/above ${minScore}, ` +
      `${outcome.belowThreshold} below, ${outcome.unscored.length} unscored`,
  );
  return outcome.blocking.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
