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

---

## 2026-05-21 — session 1: bank authored, ecosystem mapped (run pending)

**Target**: `intent-eval-core` (in `~/000-projects/intent-eval-platform/`)
**Question bank**: `dogfood/question-banks/intent-eval-core-v1.yaml`
**Run id**: pending — no Claude calls made this session

### What I did

Authored the 5 Q/A pairs in the bank. Every `expected_substring` was
manually verified to exist in the target's source (intent-eval-core's
CLAUDE.md, README.md, and 000-docs/{001..005}) before writing. The
bank parses; the schema matches `references/question-bank-spec.md`.

Did NOT execute the run. That ships in session 2 once we've reviewed
the bank together and confirmed the questions are right.

### What I learned about the target

intent-eval-core is much more than I realized. It's the **canonical
contracts kernel** for a 5-repo Apache 2.0 platform:

- `intent-eval-core` — TS types + JSON Schemas + Zod validators for
  the 13 platform entities. **No runtime, no execution, no judges.**
- `intent-eval-lab` — methodology + Blueprints A/B/C + Canonical Glossary
- `audit-harness` — deterministic gates (escape-scan, crap, arch, etc.)
- `j-rig-skill-binary-eval` — behavioral eval + rollout-gate decision logic
- `intent-rollout-gate` — thin GitHub Action shell

They converge on a shared **Evidence Bundle** schema. Governance is
explicit (DR-010 council session 4 lock; Blueprints A/B/C are NORMATIVE).
This is the ecosystem coupling we discussed in earlier sessions —
**not via shared code, but via shared documentation taxonomy and
binding decision records.**

The bank's 5 questions probe role-separation, the 13-entity count, the
gate-result/v1 § 7 source, license rationale, and the source-of-truth
hierarchy. If ICO answers all 5 correctly with verified citations, it's
real signal that ICO can navigate cross-repo authority chains.

### Doc-filing connection (the operator asked me to investigate)

Surveyed the abbreviation system (Document Filing Standard v4.3) across
12+ Intent Solutions repos. **The taxonomy IS the ecosystem coupling
layer.** Aggregate usage of the top 15 codes:

| Code    | Uses | Meaning                              |
| ------- | ---- | ------------------------------------ |
| AA-AACR | 61   | After-Action Critical Review         |
| DR-GUID | 37   | Documentation Guide                  |
| RA-REPT | 32   | Report                               |
| MS-DRFT | 32   | Miscellaneous Draft                  |
| RA-AUDT | 23   | Audit Report                         |
| AT-ARCH | 17   | Architecture                         |
| DR-SOPS | 16   | SOP                                  |
| PP-PLAN | 12   | Plan                                 |
| LS-STAT | 12   | Status                               |
| RA-ANLY | 10   | Analysis                             |
| DR-REFF | 9    | Reference                            |
| AA-AUDT | 9    | After-Action Audit                   |
| AT-DECR | 6    | Decision Record (binding governance) |
| AT-DSGN | 7    | Design                               |
| OD-RELS | 7    | Release operations                   |

That's a real shared dialect. Every cited source in our v1 bank
follows the `NNN-CC-ABCD-...` convention. ICO will see filenames that
encode what kind of document each is — `AT-ARCH` is architecture,
`AT-STND` is standards, `AA-AACR` is an AAR.

### Recommendations on doc-filing

**Don't update doc-filing for the dog-food work right now.** The v4.3
taxonomy already fits — every dog-food artifact maps to an existing
category:

| Dog-food artifact                       | Maps to doc-filing as      |
| --------------------------------------- | -------------------------- |
| `dogfood/JOURNAL.md` session entries    | AA-AACR (per-session AAR)  |
| `dogfood/runs/<run-id>/summary.md`      | RA-REPT (per-run report)   |
| `dogfood/runs/<run-id>/metrics.json`    | DD-DATA (machine-readable) |
| `dogfood/runs/<run-id>/friction.jsonl`  | RA-AUDT (audit findings)   |
| `dogfood/progress.md` (the trend table) | DD-DATA + LS-STAT hybrid   |
| `dogfood/question-banks/*.yaml`         | DR-STND (engineered spec)  |

If dog-food artifacts ever migrate into a project's `000-docs/`, the
mapping is clean. For now, the `dogfood/` directory is its own home,
which keeps the working surface uncluttered.

**Two small doc-filing nits worth filing as P3 if/when convenient
(NOT blocking dog-food):**

1. `claude-code-plugins` uses `BA-ANLS` (4 docs) — `BA` is not in the
   v4.3 spec. Either add `BA` (Business Analysis?) or migrate those
   files to `BL-ANLS` (Business & Legal) or `RA-ANLY` (Report Analysis).
2. The doc-filing skill's reference at
   `~/.claude/skills/doc-filing/references/000-DR-STND-document-filing-system.md`
   could surface the cross-repo ecosystem coupling pattern explicitly.
   Right now the standard is presented as a per-repo organization
   convention; the real value is the ecosystem-wide shared dialect.

The real win is **this is the kind of insight ICO should surface from
its own compiled wiki.** If ICO can read across 12 repos' 000-docs and
notice the BA-ANLS oddity, that's the cognition layer working as
intended. v0.5+ ecosystem mode is the place to test this.

### Bugs filed

None. Nothing ran.

### Next session priorities

- Run the bank against intent-eval-core via the skill
- Watch for: (a) does ICO cite the right `NNN-CC-ABCD-...` filenames
  exactly, (b) does it follow the inherits-from chain on Q03, (c) does
  it preserve order on Q05's hierarchy
- File friction as beads with `doc_category` enrichment if useful
- Decide whether v0.2 of the bank adds Q06-Q10 or moves to a different
  target (intent-eval-lab is a strong candidate — much larger corpus)

---

## 2026-05-21 — session 2: first real run hit ICO retrieval gap (5/5 no-knowledge)

**Target**: `intent-eval-core` (in `~/000-projects/intent-eval-platform/`)
**Question bank**: `dogfood/question-banks/intent-eval-core-v1.yaml`
**Run id**: `2026-05-22T0056Z-intent-eval-core-v1` (UTC date because the run crossed midnight)

### Headline

**5 questions asked, 5 hit ICO's "no compiled knowledge found" fallback.**
Zero Claude API calls made on the asks (fallback is pre-Claude). The compile
ran successfully against 19 source files (132k tokens, $0.50–0.70 actual)
producing 19 source pages + 6 concept pages + 2 topic pages + 5
contradictions + 4 gaps. Wiki populated.

verify-rate: **0%** — but read this carefully: 0% because there were no
citations to verify, not because ICO cited wrong sources. The actual
finding is that ICO never engaged the wiki at all.

### What we found

ICO's `analyzeQuestion` (the FTS5-based retrieval step that picks
candidate wiki pages for an `ask` query) is **too narrow**:

| Test                                                                                                             | Result                                             |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Manual short query: "What is intent-eval-core?"                                                                  | ✅ Engaged. 13k tokens, 10 citations, rich answer. |
| Bank Q01: "What is intent-eval-core's role inside the Intent Eval Platform, and what does it explicitly not do?" | ❌ No compiled knowledge found                     |
| Bank Q02: "How many canonical platform entities does intent-eval-core define?"                                   | ❌ No compiled knowledge found                     |
| Bank Q03-Q05: similar sophisticated phrasing                                                                     | ❌ No compiled knowledge found                     |

Same workspace, same compiled wiki. Only the question phrasing changed.
Compound multi-clause questions, dashed identifiers, and synonymous
vocabulary all fail to match. The retrieval requires near-literal
keyword presence in the FTS5 index.

Filed as bead **`intentional-cognition-os-fmo`** (P1 — bug). Suspected
fix surface: `packages/compiler/src/ask/analyze.ts`. Options laid out
in the bead.

### What worked

The dog-food infrastructure itself caught all of this cleanly:

- Pre-flight checks (ico installed, ANTHROPIC_API_KEY present, target
  exists, bank parses)
- Budget estimate ($1.83 upper, ~$0.60 actual — well within calibration)
- All 4 prior run.sh bugs from the previous attempt are fixed and have
  regression tests
- ICO's `--json` flag now emits structured JSON on both the happy path
  AND the no-knowledge fallback path (fixed this session)
- friction.jsonl captured the no-knowledge response as a real signal
- Per-question receipts JSONL produced
- Render-summary collapsed friction by (stage, message); progress.md
  appended cleanly

### Bugs filed

- **intentional-cognition-os-fmo (P1)** — ICO analyzeQuestion retrieval
  too narrow. 5/5 hand-authored questions hit no-knowledge fallback
  even though the compiled wiki has the answers.

### Bugs fixed this session

In `plugin/skills/ico-your-internals/scripts/run.sh`:

1. TARGET_SLUG was eating `basename`'s trailing newline → trailing dash.
   Fix: pipe through `printf '%s'` first. Regression test in
   `tests/test_run_sh.sh` test 2.
2. WS path didn't match where `ico init <name> --path <parent>` actually
   creates the workspace. Fix: `WS="$CACHE_ROOT/$TARGET_SLUG"`.
   Regression test 5.
3. `--workspace` and `--json` are GLOBAL flags on `ico`, must come
   BEFORE the subcommand. Fix: rewrote all subprocess calls. Regression
   tests 3 + 6.
4. `ico compile` doesn't accept "all" — takes one of
   `sources|concepts|topics|links|contradictions|gaps`. Fix: loop the
   six passes in order. Regression test 4.

In `packages/cli/src/commands/ask.ts`: 5. `--json` flag was being silently ignored on the happy path. Fix:
added explicit JSON output branch before the pretty surface.
Vitest covers in `ask.test.ts`. 6. `--json` flag was ALSO silently ignored on the no-knowledge fallback
path. Fix: `printNoKnowledgeFallback` now takes a `asJson` param.

### What the dog-food session ACTUALLY proved

This is the most important paragraph in this entry. Five questions
authored against a real corpus, all hand-verified to have ground-truth
answers in the source, came back with **zero** retrievable knowledge.
Without the dog-food loop we wouldn't have seen this. The OPS bugs
(run.sh + ask.ts --json) would have shipped because they were silent;
the retrieval gap would have shipped because no one asks ICO their own
questions against their own docs. v0.1 dog-food session 2 found a P1
ICO bug in ~30 minutes of operator time.

### Next session priorities

- Fix `fmo` (ICO retrieval gap). Either loosen analyzeQuestion's FTS5
  query, strip dashes/punctuation before tokenizing, or add a broaden
  fallback when direct match returns empty.
- Re-run the v1 bank against the (then-fixed) ICO. Compare verify-rate
  to this session's 0% baseline — expect 60%+.
- If retrieval is still too narrow on Q03-Q05 (the cross-doc synthesis
  questions), consider whether the bank should be split into a "v1
  simple" and "v1 synthesis" tier so we get gradient signal rather
  than binary pass/fail.
