---
name: ico-your-internals
description: "Dog-food intentional-cognition-os against the operator's own system. Discovers a target — a folder of markdown docs, a project, or an ecosystem — creates an isolated ICO workspace outside the target tree, ingests and compiles its docs, runs a hand-authored question bank against it, verifies each citation by deterministic source-grep, and produces a structured receipts trail with receipts, verifications, friction logs, and a sanitized summary. Sanitized per-run summaries are written into the target repo's dogfood directory; raw answer content and workspace stay in the user cache. Use when validating ICO works on real corpora, generating dog-food proof artifacts, or surfacing ICO bugs to file as beads. Trigger with /ico-your-internals, dog-food ICO, analyze my system with ICO."
version: 0.1.0
author: Jeremy Longshore <jeremy@intentsolutions.io>
license: Apache-2.0
model: inherit
effort: medium
argument-hint: '--target <path> --bank <bank.yaml> [--dry | --probe <run-id>]'
allowed-tools: Read, Grep, Bash(ico:*), Bash(node:*), Bash(jq:*), Bash(find:*), Bash(ls:*), Bash(cat:*), Bash(mkdir:*), Bash(cp:*), Bash(bash:*), Bash(python3:*), Bash(git:*), AskUserQuestion
tags:
  - dogfood
  - rag
  - citation-verification
  - knowledge-compilation
  - audit-trail
compatibility: |
  Requires Claude Code, intentional-cognition-os installed globally via npm install -g intentional-cognition-os, an ANTHROPIC_API_KEY environment variable, plus python3 and jq on PATH. The target repo should have a dogfood directory with question-banks subfolder.
---

# ico-your-internals — dog-food ICO against your own system

**Invocation**: "/ico-your-internals" · "dog-food ICO" · "analyze my system with ICO" · "run a dog-food session against <target>".

The operator-facing skill that exercises `intentional-cognition-os` end-to-end against a real corpus and produces a structured receipts trail. v0.1 covers single-target runs against a hand-authored question bank with deterministic citation verification.

## Overview

This skill answers one question: **does ICO actually work on real corpora?** It exercises the full ICO pipeline (init → mount → ingest → compile → ask) against a doc-heavy target the operator points it at, then verifies every citation ICO produces against the source it claims via deterministic substring grep. The output is a structured receipts trail — committed sanitized rollups for proof-of-use, plus local-only raw answers for forensic inspection.

The skill is the kernel of a build-in-public dog-food loop. Every run produces one number (citation-verify rate) that goes into `dogfood/progress.md` and trends over time. Friction in ICO itself surfaces as `friction.jsonl` entries that become bead candidates on the ICO repo.

What this skill does NOT do:

- Build new corpora (it only runs ICO against existing markdown documentation)
- Auto-commit results (operator decides what lands in the repo)
- Make any Claude API call without an explicit budget estimate and operator confirmation above the $0.50 threshold

## Prerequisites

Before invoking:

1. **ICO installed**: `npm install -g intentional-cognition-os`. Verify with `ico --version` returning a real semver string (≥ 1.1.2 recommended).
2. **Anthropic credentials**: `ANTHROPIC_API_KEY` exported in the shell environment.
3. **POSIX tooling**: `python3` (≥ 3.10) and `jq` on PATH. Standard bash, find, awk are assumed.
4. **A target**: an absolute path to a project or doc directory with at least one `.md` file. The target is mounted read-only — the skill never writes inside it.
5. **A question bank**: a YAML file matching the schema in `references/question-bank-spec.md`. For session-0 scaffolds the bank must have non-empty `questions` — empty banks halt the skill.
6. **Optional**: the target repo has a `dogfood/` directory (created when running against the ICO repo itself). When absent, sanitized rollups land alongside the cache and the operator manually moves them.

## Hard rules — do not violate

1. **Never write inside the target tree.** The target is mounted read-only. All ICO writes go to `~/.cache/ico-your-internals/runs/<run-id>/workspace/`.
2. **Never commit raw answer content or source-grep evidence.** Those live local-only in `~/.cache/`. Only sanitized per-run summaries (`summary.md`, `metrics.json`, `friction.jsonl`) get copied back into the repo's `dogfood/runs/<run-id>/`.
3. **Always show a token-budget estimate before any Claude API call.** Use `AskUserQuestion` to confirm proceed when estimated cost > $0.50. No surprise bills.
4. **Never `cd` or run mutating git commands inside the target tree.** Read-only is the contract.
5. **Idempotent re-runs.** Same target + same question bank + already-compiled workspace → re-use the workspace; only the Q/A loop runs. Cheap second runs.
6. **The skill never auto-commits.** It writes files; the operator runs `git add && git commit` when they're satisfied with the receipts.

## v0.1 surface

| Mode       | Trigger                                                        | Behavior                                                                        |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Default    | `/ico-your-internals --target <path> --bank <bank.yaml>`       | Full run: discover → compile → ask → verify → render                            |
| Probe-only | `/ico-your-internals --probe <run-id>`                         | Re-run the verify step on an already-completed run (cheap; no new Claude calls) |
| Dry        | `/ico-your-internals --dry --target <path> --bank <bank.yaml>` | Plan + token-budget estimate; no Claude calls, no writes                        |

v0.2+ adds: survey-and-pick mode (auto-rank candidates), auto-generated question banks from CLAUDE.md headings, cross-project ecosystem runs.

## Instructions

### Step 1 — Preflight

1. Verify `ico --version` succeeds. If not, surface clearly: "Install with `npm install -g intentional-cognition-os` first."
2. Verify `ANTHROPIC_API_KEY` is set. If absent, halt with a clear message.
3. Verify the target path exists and contains either `.md` files or `CLAUDE.md` (i.e. is a real doc-bearing project).
4. Verify the question bank YAML exists and parses. If empty (e.g. session-0 scaffold), halt with: "Bank has no questions. Author them first per the schema in the YAML."

### Step 2 — Resolve run id and workspace

```
RUN_ID="$(date -u +%Y-%m-%dT%H%MZ)-$(basename <target>)-$(yq .version <bank>)"
WORKSPACE="$HOME/.cache/ico-your-internals/runs/$RUN_ID/workspace"
PUBLIC_DIR="<repo-root>/dogfood/runs/$RUN_ID"
```

Create both. The `$WORKSPACE` is where ICO writes. The `$PUBLIC_DIR` is where the sanitized rollup will land for `git add`.

### Step 3 — Token-budget estimate

Use `scripts/estimate-budget.sh` (or inline math): rough word count of the target's `.md` files × 1.3 (tokens-per-word) × (compile passes ≈ 6) → upper-bound input tokens. Add per-question token budget × question count. Multiply by current Claude pricing to dollar-estimate.

If estimate > $0.50, prompt the operator via `AskUserQuestion` before proceeding.

### Step 4 — Ingest + compile

```
ico init "$RUN_ID" --path ~/.cache/ico-your-internals/runs/$RUN_ID
ico mount add target <target-path> --workspace <workspace> --read-only
ico ingest <target-path> --workspace <workspace>
ico compile all --workspace <workspace>
```

If `compile` fails or returns non-zero, capture the error to `friction.jsonl` and halt — surface the failure to the operator before running the Q/A loop. There's no point asking questions of a broken workspace.

### Step 5 — Ask loop

For each question in the bank:

1. Generate `q_id` and `correlation_id`.
2. Run `ico ask "<question>" --workspace <workspace> --json` and capture the answer JSON.
3. Parse out: answer text, citations array, trace correlation id, tokens in/out, latency.
4. Append one line to `receipts.jsonl` with the full record.

Use `scripts/run.sh` for the actual orchestration — it handles JSON parsing and error capture.

### Step 6 — Verify

Run `scripts/verify.py <run-id>`. For each citation in each receipt:

- Resolve the cited source filename relative to the target.
- Grep the source for each `expected_substring` from the question bank entry. If found → VERIFIED + record the matching line.
- If the citation file doesn't exist → UNVERIFIED with reason "cited source missing."
- If file exists but substring not found → CHALLENGED with reason "evidence absent."

Append one line per (question, citation) to `verifications.jsonl`.

### Step 7 — Render

Run `scripts/render-summary.py <run-id>` to produce:

- `~/.cache/ico-your-internals/runs/<run-id>/summary.md` (full, contains raw answer text — stays local)
- `<repo>/dogfood/runs/<run-id>/summary.md` (sanitized — counts, verify-rate, friction-list; no raw answer content)
- `<repo>/dogfood/runs/<run-id>/metrics.json` (machine-readable counts)
- Append one row to `<repo>/dogfood/progress.md`

### Step 8 — Report and hand off

Show the operator:

- Verify-rate (the headline number)
- Where the local-only artifacts live (so they can grep raw receipts if curious)
- Where the public-safe artifacts landed (so they can `git add` if satisfied)
- Any friction surfaced — with explicit "consider filing as bead" prompts for substantive bugs

Do NOT commit. The operator decides.

## Output

Every successful run produces two parallel artifact sets:

**Local-only** (in `~/.cache/ico-your-internals/runs/<run-id>/`):

| File                  | What's in it                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `workspace/`          | The full ICO workspace — compiled wiki, audit traces, source manifest                             |
| `receipts.jsonl`      | One line per question with the full answer text, citations, trace correlation id, tokens, latency |
| `verifications.jsonl` | One line per citation with verdict (VERIFIED/CHALLENGED/UNVERIFIED), grep evidence, line numbers  |
| `cost.jsonl`          | Per-API-call token + dollar ledger                                                                |
| `summary.md`          | Full run summary including raw answer excerpts (for forensic inspection)                          |
| `manifest.json`       | Run metadata: target path, ICO version, bank version, timestamps                                  |

**Committed sanitized** (in `<repo>/dogfood/runs/<run-id>/`):

| File             | What's in it                                                 |
| ---------------- | ------------------------------------------------------------ |
| `summary.md`     | Counts + verify-rate + friction list — no raw answer content |
| `metrics.json`   | Machine-readable per-run rollup with per-question breakdowns |
| `friction.jsonl` | Bug/error/timeout records — bead candidates                  |
| `manifest.json`  | Same as local copy                                           |

The skill also appends one row to `<repo>/dogfood/progress.md` with the headline metrics (run id, target, citations, verified, verify_rate, tokens, friction count).

Full record contract: `references/receipt-schema.md`. Key shapes:

**receipts.jsonl** (local only):

```json
{"run_id":"...","q_id":"Q01","question":"...","answer":"...","citations":[...],"trace_correlation_id":"...","tokens_in":1240,"tokens_out":187,"latency_ms":4218,"model":"claude-sonnet-4-6","timestamp":"..."}
```

**verifications.jsonl** (local only):

```json
{
  "run_id": "...",
  "q_id": "Q01",
  "citation_idx": 0,
  "claim_substring": "...",
  "cited_source": "...",
  "verdict": "VERIFIED",
  "evidence_grep": "L42: ...",
  "score": 1.0
}
```

**friction.jsonl** (public-safe):

```json
{
  "run_id": "...",
  "stage": "compile",
  "severity": "error",
  "message": "...",
  "exit_code": 1,
  "recommend_bead": true
}
```

## Error Handling

The skill is designed to fail loudly and recoverably. Every failure mode either halts cleanly with a clear message or captures the error to `friction.jsonl` as a bead candidate.

| Failure mode                                            | Stage     | Detection                             | Recovery                                                                                 |
| ------------------------------------------------------- | --------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| ICO not installed                                       | preflight | `command -v ico` returns non-zero     | Halt with: "Install with `npm install -g intentional-cognition-os` first."               |
| `ANTHROPIC_API_KEY` unset                               | preflight | env check                             | Halt with clear message                                                                  |
| Target path missing or not a directory                  | preflight | `[ -d "$TARGET" ]`                    | Halt; do not create the workspace                                                        |
| Question bank empty (session-0 scaffold)                | preflight | YAML parse + `questions` length check | Halt with: "Bank has no questions. Author them per schema."                              |
| Budget estimate exceeds threshold                       | budget    | `estimate-budget.sh` > $0.50          | `AskUserQuestion` prompt; abort cleanly on decline                                       |
| `ico init` fails                                        | init      | non-zero exit                         | Append friction entry; halt before any Claude calls                                      |
| `ico mount add` fails                                   | mount     | non-zero exit                         | Append friction entry; halt                                                              |
| `ico ingest` fails                                      | ingest    | non-zero exit                         | Capture stderr to friction entry; halt                                                   |
| `ico compile` fails                                     | compile   | non-zero exit                         | Capture stderr to friction entry; halt — no point asking questions of a broken workspace |
| `ico ask` times out (>180s)                             | ask       | Python subprocess timeout             | Friction entry; continue to next question                                                |
| `ico ask` returns non-JSON stdout                       | ask       | json.JSONDecodeError                  | Friction entry; continue to next question                                                |
| Cited source not found in target tree                   | verify    | filesystem check after prune          | Verdict UNVERIFIED; continue                                                             |
| Cited source exists but no `expected_substring` matched | verify    | grep miss                             | Verdict CHALLENGED; continue                                                             |
| Workspace already exists (re-run)                       | init      | directory present                     | Idempotent re-use — only the Q/A loop runs, no recompile                                 |

Every friction entry with `recommend_bead: true` is a bug-discovery signal. Triage them into beads on the `intentional-cognition-os` repo. Re-running a failed run with no Claude calls is cheap via `--probe <run-id>` (verify step only).

## Examples

**v0.1 first real run** — against `intent-eval-core`:

```bash
# 1. From the intentional-cognition-os repo root:
plugin/skills/ico-your-internals/scripts/run.sh \
    --target ~/000-projects/intent-eval-platform/intent-eval-core \
    --bank dogfood/question-banks/intent-eval-core-v1.yaml

# 2. After receipts written, verify citations:
plugin/skills/ico-your-internals/scripts/verify.py \
    2026-05-21T0300Z-intent-eval-core-v1

# 3. Render sanitized rollup into dogfood/runs/<run-id>/:
plugin/skills/ico-your-internals/scripts/render-summary.py \
    2026-05-21T0300Z-intent-eval-core-v1 --repo-root .

# 4. Inspect the trend signal:
cat dogfood/progress.md

# 5. If receipts look good, commit:
git add dogfood/runs/2026-05-21T0300Z-intent-eval-core-v1/ \
        dogfood/progress.md dogfood/JOURNAL.md
git commit -m "dogfood: first run against intent-eval-core"
```

**Dry-run budget estimate** before paying any tokens:

```bash
plugin/skills/ico-your-internals/scripts/run.sh \
    --target ~/000-projects/qmd-team-intent-kb \
    --bank dogfood/question-banks/qmd-team-intent-kb-v1.yaml \
    --dry
# Prints: {"md_files": 213, "words": 48000, "total_tokens_est": 374400, "dollar_est": "2.02"}
# Operator decides whether to proceed.
```

**Re-verify** an already-completed run after fixing a question bank:

```bash
# Edit dogfood/question-banks/intent-eval-core-v1.yaml — adjust expected_substrings
plugin/skills/ico-your-internals/scripts/verify.py \
    2026-05-21T0300Z-intent-eval-core-v1
plugin/skills/ico-your-internals/scripts/render-summary.py \
    2026-05-21T0300Z-intent-eval-core-v1 --repo-root .
# No new Claude calls — verify is pure local grep against captured receipts.
```

**Invoke via Claude Code skill registration** (after plugin install):

```
/ico-your-internals --target ~/000-projects/intent-eval-platform/intent-eval-core --bank dogfood/question-banks/intent-eval-core-v1.yaml
```

## What does and doesn't count as a "good" run

A run is **good** when:

- Compile completed without errors
- ≥ 80% of citations VERIFIED
- Every hand-authored question's `expected_substrings` appear in the answer

A run is **bad** when any of those fail. Bad runs are valuable — they produce the friction.jsonl entries that become beads on this repo.

A run is **inconclusive** when ICO errors out before producing receipts. That's pure friction; file a bead with the trace correlation id.

## Resources

- `references/receipt-schema.md` — full JSONL record contract
- `references/budget-math.md` — token-cost estimation
- `references/question-bank-spec.md` — how to author a question bank
- `scripts/run.sh` — orchestrator
- `scripts/verify.py` — citation verification
- `scripts/render-summary.py` — JSONL → markdown + metrics
- `scripts/estimate-budget.sh` — pre-flight cost estimation
- ICO repo's `dogfood/` — where the public-safe artifacts live
- ICO repo's `evals/` — for related Eval framework (not directly used by this skill but conceptually parallel)
