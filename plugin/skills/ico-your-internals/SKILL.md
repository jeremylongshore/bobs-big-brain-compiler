---
name: ico-your-internals
description: "Dog-food intentional-cognition-os against the operator's own system. Discovers a target (a folder of markdown docs / a project / an ecosystem), creates an isolated ICO workspace outside the target tree, ingests + compiles, runs a hand-authored question bank against it, verifies each citation by deterministic source-grep, and produces a structured receipts trail (receipts.jsonl + verifications.jsonl + friction.jsonl + summary.md). Sanitized per-run summaries are written into the target repo's `dogfood/` directory; raw answer content + workspace stay in ~/.cache/. Use when validating ICO works on real corpora, generating dog-food proof artifacts, or surfacing ICO bugs to file as beads."
version: 0.1.0
author: Jeremy Longshore <jeremy@intentsolutions.io>
license: MIT
model: inherit
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(ico:*), Bash(node:*), Bash(jq:*), Bash(find:*), Bash(ls:*), Bash(cat:*), Bash(mkdir:*), Bash(cp:*), Bash(rsync:*), Bash(bash:*), Bash(python3:*), Bash(git:*), AskUserQuestion
tags:
  - dogfood
  - rag
  - citation-verification
  - knowledge-compilation
  - audit-trail
compatibility: |
  Requires:
    - Claude Code
    - intentional-cognition-os installed globally (npm install -g intentional-cognition-os)
    - ANTHROPIC_API_KEY in env
    - python3 + jq + standard POSIX shell
  Optional:
    - The target repo has a `dogfood/` directory with question-banks/ — recommended.
---

# ico-your-internals — dog-food ICO against your own system

**Invocation**: "/ico-your-internals" · "dog-food ICO" · "analyze my system with ICO" · "run a dog-food session against <target>".

The operator-facing skill that exercises `intentional-cognition-os` end-to-end against a real corpus and produces a structured receipts trail. v0.1 covers single-target runs against a hand-authored question bank with deterministic citation verification.

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

## Schema of the JSONL outputs

See `references/receipt-schema.md` for the full record contract. Key shapes:

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
