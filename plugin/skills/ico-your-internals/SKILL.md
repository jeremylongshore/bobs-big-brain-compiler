---
name: ico-your-internals
description: Runs Bob's Big Brain Compiler against an existing Markdown corpus, asks a versioned question bank, verifies citations against bounded source files, and renders a redacted evidence bundle. Use when dog-fooding ICO, testing retrieval quality, measuring paraphrase robustness, or producing public-safe proof artifacts. Trigger with "dog-food ICO", "analyze my system with ICO", "verify ICO citations", or "/ico-your-internals".
version: 0.3.0
author: Jeremy Longshore <jeremy@intentsolutions.io>
license: Apache-2.0
model: inherit
effort: medium
argument-hint: '--target PATH --bank BANK.yaml [--paraphrases primary|all] [--repo-root PATH]'
allowed-tools: Bash(ico:*), Bash(bash:*), Bash(python3:*), AskUserQuestion
tags:
  - dogfood
  - citation-verification
  - knowledge-compilation
  - evaluation
  - audit-trail
compatibility: Requires Claude Code or an Agent Skills host with equivalent shell and file tools, Python 3.10+, jq, Bob's Big Brain Compiler CLI 1.22.0+, and ANTHROPIC_API_KEY for paid runs. Dry runs need neither the ICO CLI nor API credentials.
---

# Dog-food Bob's Big Brain Compiler

## Overview

Measure whether the `ico` pipeline produces source-grounded answers on a real
Markdown corpus. Keep raw answers, paths, and grep evidence in a local cache;
publish only the allowlisted, redacted rollup produced by the bundled renderer.

## Boundaries

- Treat source documents under the target as read-only. ICO stores its mounted
  workspace under `~/.cache/ico-your-internals/runs/RUN_ID/`.
- A full run writes only to that cache. Rendering is a separate, explicit write
  to `REPO_ROOT/dogfood/` and may be the same repository as the target.
- Never commit raw receipts, verification evidence, budget data, or the private
  manifest. They can contain source excerpts, credentials, or absolute paths.
- Never auto-commit. The operator reviews the rendered artifacts first.
- Never make a paid API call before showing the estimate. Above $0.50, obtain
  explicit approval with `AskUserQuestion`; the script independently enforces
  this boundary.

## Prerequisites

For a paid run, verify `ico --version` is at least 1.22.0 and confirm that
`ANTHROPIC_API_KEY` is set without printing its value. If the CLI is absent,
tell the operator to review and run `npm install -g intentional-cognition-os`;
do not silently install global software.

Require:

- an existing target directory containing at least one eligible `.md` file;
- a question bank accepted by `scripts/bank.py` (see
  `references/question-bank-spec.md`);
- Python 3.10+ and `jq` on `PATH`.

## Workflow

### 1. Resolve inputs

Resolve the target, bank, optional publication repository, and paraphrase mode.
Use `primary` by default. Use `all` only when the operator wants the additional
cost and phrasing-sensitivity signal.

### 2. Run the write-free estimate

Resolve this skill's installed directory as `SKILL_DIR`, then run:

```bash
bash "$SKILL_DIR/scripts/run.sh" \
  --target TARGET_PATH \
  --bank BANK_PATH \
  --repo-root REPO_ROOT \
  --paraphrases primary \
  --dry
```

`--dry` performs no writes, makes no Claude calls, and does not require the ICO
CLI or an API key. Report `asks_planned`, `total_tokens_est`, `dollar_est`, and
the generated run id.

### 3. Enforce budget consent

- At or below $0.50, proceed without an approval flag.
- Above $0.50, show the estimate and use `AskUserQuestion` to request approval.
- If declined, stop. If approved, add `--approve-budget` to the full run.

Without that flag, `run.sh` exits 4 before any write or API call when the
estimate exceeds $0.50.

### 4. Run compilation and questions

Repeat the command without `--dry`, adding `--approve-budget` only when the
operator approved it. The orchestrator:

1. creates the cache workspace and private manifest;
2. mounts and ingests eligible Markdown files;
3. runs `sources`, `concepts`, `topics`, `links`, `contradictions`, and `gaps`;
4. asks the selected question-bank prompts; and
5. writes local receipts and friction records.

If a compile pass fails, stop before the question loop. Per-question ask errors
are recorded locally and the remaining prompts continue.

### 5. Verify citations locally

Use the returned run id:

```bash
python3 "$SKILL_DIR/scripts/verify.py" RUN_ID
```

The verifier accepts only citation paths contained by the target or cached
workspace, including after symlink resolution. It records:

- `VERIFIED`: source exists and at least one expected substring matches;
- `CHALLENGED`: source exists but expected evidence is absent; or
- `UNVERIFIED`: citation is missing, malformed, rejected, or outside bounds.

### 6. Render public-safe artifacts

Confirm the intended publication root before this write, then run:

```bash
python3 "$SKILL_DIR/scripts/render-summary.py" RUN_ID --repo-root REPO_ROOT
```

The renderer allowlists manifest fields, replaces private paths, redacts common
credential shapes in friction messages, omits raw answers and grep evidence,
and writes under `REPO_ROOT/dogfood/`.

### 7. Report and hand off

Report the citation verify rate and paraphrase robustness side by side; never
combine them. Include local-cache and public-artifact locations, token usage,
and actionable friction. Suggest a Beads issue for substantive compiler bugs.
Leave all commit decisions to the operator.

## Outputs

Local-only under `~/.cache/ico-your-internals/runs/RUN_ID/`:

- `budget.json` and `manifest.json`;
- `workspace/` and compiler traces;
- `receipts.jsonl` with answers and citations;
- `verifications.jsonl` and `verify-summary.json`; and
- `friction.jsonl` with unsanitized diagnostic details.

Public-safe under `REPO_ROOT/dogfood/` after rendering:

- `runs/RUN_ID/summary.md`;
- `runs/RUN_ID/metrics.json`;
- `runs/RUN_ID/friction.jsonl`;
- `runs/RUN_ID/manifest.json`; and
- one appended row in `progress.md`.

See `references/receipt-schema.md` for exact field contracts.

## Error handling

`run.sh` exits 1 for runtime/preflight failures, 2 for invalid arguments, 3 for
target or bank validation failures, and 4 when budget approval is required.
Never work around exit 4 by adding the flag without the operator's approval.

An empty receipts file or a run that ends before verification is inconclusive,
not a passing result. A high verify rate only measures the declared question
bank and substrings; it is not proof that the corpus or compiler is complete.

## Examples

Use `--paraphrases primary` for the least-expensive baseline. Use
`--paraphrases all` only after the dry-run estimate when comparing whether each
intent remains grounded across alternate phrasings. To re-check an existing run
without another API call, rerun `verify.py RUN_ID`, then render again only after
confirming the publication root.

## Resources

- `references/question-bank-spec.md` — canonical bank versions and validation
- `references/budget-math.md` — estimate assumptions and consent threshold
- `references/receipt-schema.md` — private and public artifact contracts
- `scripts/run.sh` — guarded orchestration
- `scripts/verify.py` — bounded deterministic evidence verification
- `scripts/render-summary.py` — allowlisted public rendering
- `scripts/tests/run-all.sh` — offline regression suite
