---
title: 'bd-sync rapid-write race — fix + reproduction harness'
filing_code: 036-OD-FIX-bd-sync-rapid-write-race-2026-05-25
date: 2026-05-25
status: closed
parent_bead: intentional-cognition-os-55q.4
license: MIT
---

# bd-sync rapid-write race — fix + reproduction harness

Closes bead `intentional-cognition-os-55q.4`. GitHub `#97`, Plane `ICOS-20`.

## The original symptom

During the 2026-05-23 bead-hygiene reset (`bd-sync link` on 13 child
beads in tight sequence), 7 of 13 beads silently dropped their `GitHub:`
and `Plane:` cross-reference notes. Both Dolt (`bd show`) and
`.beads/issues.jsonl` showed empty notes despite every `bd update`
returning `✓`. Repair required one explicit `bd export` between each
write, no batching.

Bead description hypothesized: Dolt's auto-export to JSONL has a 15-min
minimum interval (per `.beads/config.yaml`); writes that land mid-window
get clobbered when the next `bd` process auto-imports the still-stale
JSONL into its fresh in-memory DB.

## What investigation found

bd 1.0.4 (the current version on this host) **does keep Dolt writes
durable** — `bd show` correctly returns the just-written notes from a
separate bd process. The earlier symptom in bd 1.0.3 (likely a true
Dolt-write race) appears to be **fixed upstream**.

What remains: **JSONL still goes stale** because Dolt's auto-export does
not fire on every write. For tools that consume JSONL directly (CI,
diff inspection, agent context loaders, anything downstream of
`bd export`), the staleness is observable and consequential.

The bead's acceptance criterion (a) — "bd-sync forces a `bd export`
between consecutive `--notes` writes" — is therefore still the right
defense.

## The fix

`~/bin/bd-sync` now calls a new `flush_jsonl()` helper after every
bead-side write. Three call sites: `cmd_link` (line 230), `cmd_note`
(line 245), `cmd_close` (line 286).

The helper walks up from `$PWD` to the nearest `.beads/` directory
(same discovery semantics bd itself uses) and runs `bd export -o
<beads-dir>/issues.jsonl >/dev/null 2>&1 || true`. Cost is ~1s for a
200-bead repo, run once per bead-side write.

```bash
flush_jsonl() {
  local dir="$PWD"
  # Loop guards: empty dir or '.' would make dirname loop forever.
  while [ -n "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "." ]; do
    if [ -d "$dir/.beads" ]; then
      bd export -o "$dir/.beads/issues.jsonl" >/dev/null 2>&1 || true
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 0
}
```

The `|| true` is intentional — `bd export` failures should not abort the
GH/Plane mirror that follows. JSONL staleness is recoverable on the
next write; a failed mirror is harder to detect.

## Reproduction script

`scripts/repro-bd-sync-race.sh` exercises the fix end-to-end:

1. Creates a sandbox repo with `bd init`.
2. Creates `N` test beads (default 10).
3. Calls `bd-sync note <bead> "MARKER-<bead>"` in a tight loop.
4. Verifies every marker is present in **both** the Dolt DB (`bd show`)
   AND `.beads/issues.jsonl`.

Exit `0` on full pass, `1` on any missing marker. Run after any
bd-sync change to catch regression of the JSONL-flush behavior.

```bash
./scripts/repro-bd-sync-race.sh 10    # default
./scripts/repro-bd-sync-race.sh 50    # wider window
```

### Subtle verification pitfall (documented in the script)

The script's v1 used `bd show "$b" | grep -q "MARKER-$b"` and reported
false-positive race triggers. `grep -q` exits early on first match,
which sends SIGPIPE to the upstream `bd show`. With `set -euo
pipefail`, the pipeline's exit code becomes `141` (the rightmost
non-zero), and `if ! pipeline` flips that into a false "missing"
report. The data was actually present.

The v2 verification captures `bd show` output to a variable first, then
greps over the variable — no upstream SIGPIPE, no false report. Keep
this pattern for any future bd-sync repro/regression scripts.

## Why bd-sync lives outside this repo

`~/bin/bd-sync` is a personal cross-project tool — Brave, Kobiton,
INTKB, and ICO all use it. It has no upstream git repo (yet). The fix
lives on disk; this doc captures the diff in version control so the
next host setup can re-apply it.

The follow-up bead `intentional-cognition-os-nhj.1` (already open)
covers "prepare upstream issue for the beads bd update rapid-write race
for Jeremy to review." If that lands upstream in bd itself, the
`flush_jsonl` defense becomes optional.

## Verification at close

```
$ ./scripts/repro-bd-sync-race.sh 15
PASS: 15/15 beads have markers in both DB and JSONL

$ ./scripts/repro-bd-sync-race.sh 20
PASS: 20/20 beads have markers in both DB and JSONL
```

The cmd_close path is exercised in a separate ad-hoc test (every closed
bead's JSONL line shows `"status":"closed"`).

## What was NOT changed

- `bd-sync status` (read-only — no flush needed).
- `bd-sync link`/`note`/`close` GH/Plane mirroring code paths
  (orthogonal to the JSONL race).
- The 15-min auto-export interval in `.beads/config.yaml` (that's a
  bd-level configuration; the per-write flush is upstream of it).
- No bd CLI changes (the fix is purely in bd-sync).
