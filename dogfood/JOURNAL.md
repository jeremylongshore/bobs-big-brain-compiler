# Dog-food journal

One entry per session. Append-only — never edit prior entries; if a prior
claim is wrong, correct it in a new entry and reference the old one.

Format per entry:

> ## YYYY-MM-DD — session N: <one-line summary>
>
> **Target**: which project/corpus
> **Question bank**: which YAML, which version
> **Run id**: the `runs/<run-id>/` directory
>
> What I tried.
>
> What I learned. (verify-rate, friction, surprises)
>
> Bugs filed to `intentional-cognition-os` beads:
>
> - bead-id: short description
>
> Next session priorities:
>
> - …

---

## 2026-05-20 — session 0: bootstrap (no runs yet)

**Target**: none yet — scaffolding only
**Question bank**: none yet
**Run id**: none

Set up the dog-food trail per the public/private split:

- `dogfood/` for narrative + question banks + sanitized per-run summaries
- `~/.cache/ico-your-internals/` for raw receipts + workspaces + per-call cost

Wired the directory layout, this journal, the progress.md skeleton, the
plugin scaffold at `plugin/skills/ico-your-internals/`, and the
`.gitignore` rule that blocks any workspace from leaking into the repo.

Decided the v0.1 target is `intent-eval-core` (only 19 .md files, 6 docs —
smallest coherent corpus in the intent-eval ecosystem). Will hand-author
5 Q/A pairs against it for the first real run. Citation-verify rate +
expected-substring match are the v0.1 signal.

OTEL spans deferred per operator call (`intent-eval-lab` not ready to
consume them yet). v0.1 reads ICO's own trace JSONL via
`workspace/audit/traces/*.jsonl` for correlation-id tracking — no new
instrumentation.

No bugs filed. No runs to evaluate.

Next session priorities:

- Hand-author `dogfood/question-banks/intent-eval-core-v1.yaml` (5 Q/A
  with known correct answers + expected source citations)
- Execute the first real run via `plugin/skills/ico-your-internals/`
- Eyeball receipts; commit the sanitized run artifacts; append the
  first row to `progress.md`
- File any friction as beads on this repo
