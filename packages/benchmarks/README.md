# @ico/benchmarks

Performance benchmarks for `intentional-cognition-os` (E10-B06).

## What this measures

The five operator-visible commands, against the v1 budgets declared in
epic-10:

| Command | Target (moderate corpus) | Status |
|---|---|---|
| `ico ingest <file>` | < 2 s per source | ✅ shipped |
| `ico lint` | < 30 s | ✅ shipped |
| `ico compile <topic>` | < 30 s per topic | ⏳ Claude-gated, next PR |
| `ico ask <question>` | < 10 s per query | ⏳ Claude-gated, next PR |
| `ico render report <topic>` | < 5 s per report | ⏳ Claude-gated, next PR |

"Moderate corpus" = **50 sources, ~500 words each, ≈30 compiled wiki pages**
(25 concepts + 5 topics for the lint scenario).

A separate large-corpus run (500 sources) verifies no operation degrades
beyond 3× moderate-corpus baseline. It lands once the per-command
scenarios are all in place.

## Running

```bash
# From repo root:
pnpm bench

# Or directly:
pnpm --filter @ico/benchmarks bench

# Single scenario (debug):
pnpm --filter @ico/benchmarks exec tsx src/scenarios/ingest.bench.ts
```

Output goes to stdout and to `results/<iso-date>-<git-sha>.json`. The
JSON files are gitignored by default — track specific runs explicitly
when you want a permanent baseline (e.g. before/after an optimisation
PR).

## Methodology

- **Determinism**: corpus generation is seeded. Same seed + same source
  count + same body-words = byte-identical input files. This isolates
  benchmark variance to the system under test.
- **Median over many samples**: per-file timings are reported as
  median across all sources in the corpus. The min/max are also
  recorded so cold-start (first file) and any GC spike are visible
  without distorting the headline number.
- **Batch total**: the sum of per-file samples is reported separately.
  This is the user-visible wait time for a batch import — closer to
  the perceived budget than any single per-file number.
- **No mocking**: real workspace, real SQLite, real markdown
  adapters. Claude-dependent scenarios will gate on
  `ANTHROPIC_API_KEY` when they land.
- **Result format**: every run captures git SHA, Node version,
  platform, and full sample arrays so historical results can be
  re-analysed without re-running.

## Adding a scenario

1. Create `src/scenarios/<name>.bench.ts` exporting:
   - `runXxxScenario(): Promise<{ perFile: BenchResult; batchTotalMs: number; sourceCount: number }>`
   - An optional `main()` for stand-alone debug runs.
2. Import the new scenario in `src/run.ts` and append to the
   `record.scenarios` array.
3. Add a corresponding row to the target table above.
4. Add tests under `src/scenarios/<name>.bench.test.ts` for any
   scenario-specific helpers.

## Targets vs floors

Targets above are aspirational. The release-gate eval in E10-B11 will
encode the actual floor (likely 1.5× target, to absorb CI-machine
variance). A bench run that fails its target is a flag, not a
failure — open a bead, profile, optimise.
