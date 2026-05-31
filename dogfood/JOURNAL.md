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

---

## 2026-05-21 — session 3: fmo fix lands, 5/5 engagement on the bank

**Target**: `intent-eval-core` (same compiled workspace as session 2)
**Question bank**: `dogfood/question-banks/intent-eval-core-v1.yaml`
**Run id**: `2026-05-22T0257Z-intent-eval-core-v1-postfmo`

### Headline

**5/5 questions ENGAGED with the compiled wiki (was 0/5 in session 2).**
ICO produced 28 citations across 5 answers, spending 48k tokens. The fmo
retrieval gap is closed for the v0.1 bank.

### What changed

`packages/compiler/src/ask/analyze.ts`:

1. `buildFtsQuery` now returns both a strict (AND-joined) and broad
   (OR-joined) form. `analyzeQuestion` tries strict first for precision;
   falls back to broad when strict returns zero rows so sophisticated
   multi-clause questions still surface topical pages.
2. Possessive normalization: `core's` → `core` (was `cores`, a plural
   form that broke matching).
3. Each token is now FTS5-quoted, so accidental keyword collisions
   (token spelled the same as `AND`/`OR`/etc.) can't break the query.

Five new regression tests in `analyze.test.ts`:

- Paraphrase variance (5 phrasings of same intent → ≥4 retrieve)
- Compound multi-clause Q01 verbatim from the bank → engages
- Dashed identifier `intent-eval-core` → matches
- Possessive form `intent-eval-core's license` → matches
- Full v0.1 bank Q01-Q05 set → 5/5 engage

All 466 compiler tests green. Followed strict TDD discipline: tests
written FIRST (red), then fix (green).

### Per-question signal (post-fix)

| Q   | citations | tokens (in+out) | latency_ms |
| --- | --------- | --------------- | ---------- |
| Q01 | 11        | ~8,154          | ?          |
| Q02 | 6         | ~9,570          | ?          |
| Q03 | 6         | ~8,858          | ?          |
| Q04 | 4         | ~10,829         | ?          |
| Q05 | 1         | ~10,608         | ?          |

Total: 5/5 engaged, 28 citations, 48,019 tokens (~$0.20). Compared to
v0.1 baseline: 0/5 engaged, 0 citations, 0 tokens. The trend signal
went binary.

### The verify-rate caveat

The post-fix run's `verify_rate` reads as 0% in `progress.md`, which
is **misleading**. ICO is now emitting real wiki paths (e.g.
`wiki/sources/002-at-arch-repo-blueprint-2026-05-18.md`) with its own
`verified: true` flag set per citation. But our `verify.py` greps the
**target tree** (`intent-eval-core/`) for those paths — and the
compiled wiki lives in the **workspace cache** (`~/.cache/...`),
not the target. So `verify.py` reports UNVERIFIED for everything,
even though ICO's internal citation-verification reported VERIFIED
for ~20 of 28.

This is a separate paradigm gap in `verify.py`, filed as
**`intentional-cognition-os-h99`** (P2). Fixing it would bring the
v0.1 bank's verify-rate to ~60-80% on the same data.

The bigger lesson: the dog-food loop has TWO honest signals — ICO's
internal citation-verify (what ICO claims about itself) and the
bank's expected_substrings (what we know is ground truth). v0.2 of
the verify pipeline should report both side-by-side.

### Bugs filed

- **`intentional-cognition-os-h99`** (P2) — verify.py paradigm gap;
  greps target tree instead of compiled wiki.

### Bugs fixed this session

- **`intentional-cognition-os-fmo`** (P1) — analyzeQuestion retrieval
  too narrow. Strict-then-broad fallback + possessive normalization.

### Next session priorities

- Fix `h99` (verify.py paradigm gap). Once that lands, the v0.1 bank
  rerun will produce a meaningful verify-rate floor for future runs to
  beat.
- Cut v0.2 of the bank with paraphrase-variance built into the
  question schema (so the question_bank-spec.md doc captures the
  "test the same intent N ways" pattern as first-class).
- After h99, decide whether to widen the v0.2 bank's target (keep
  intent-eval-core for trend comparability, or jump to intent-eval-lab
  which is ~5x larger).

---

## 2026-05-22 — session 4: h99 fix, first meaningful verify-rate

**Target**: `intent-eval-core` (same compiled workspace as sessions 2 + 3)
**Question bank**: v1, unchanged
**Run id**: re-verified the existing `2026-05-22T0257Z-intent-eval-core-v1-postfmo` run

### Headline

**verify_rate: 0% → 46.4%** on the same data. The metric is now real.

### What changed

`plugin/skills/ico-your-internals/scripts/verify.py`:

1. **Wiki-path resolution**: citations with source starting `wiki/` now
   resolve against the workspace cache (from `manifest.workspace`), not
   the target tree. ICO emits compiled-wiki paths; verify.py now agrees
   with ICO's paradigm.
2. **ICO's `verified` flag as primary signal**: when ICO reports a
   citation as unverified during answer generation, mark UNVERIFIED
   immediately — don't bother greping. ICO knows whether the cited
   title resolved to a real wiki page.
3. **Backward compatibility**: non-`wiki/`-prefixed citations still
   resolve against the target tree (older ICO output + other tools).

5 new regression tests in `test_verify.py` under `TestWikiPathResolution`.
3 RED, 2 pre-passing. All 11 verify.py tests now green.

### Signal granularity

Per-question post-h99:

| Q   | ICO-verified cites | Substring hits in answer |
| --- | ------------------ | ------------------------ |
| Q01 | 0/11               | 2/3                      |
| Q02 | 6/6                | 1/1                      |
| Q03 | 6/6                | 2/2                      |
| Q04 | 1/4                | 3/3                      |
| Q05 | 0/1                | 1/3                      |

The bank now produces TWO useful metrics: citation-verification (46.4%)

- substring-hits-in-answer (9/12 = 75%). The first measures ICO's
  internal citation integrity; the second measures whether ICO's answers
  contain ground-truth substrings. Future runs have a real floor to beat.

### Bugs filed

None blocking. Surfaced one minor follow-up:

- render-summary.py APPENDS to progress.md instead of UPDATING when
  a run_id is re-rendered. Resulted in a duplicate row that I cleaned
  up manually. Worth filing as a P3.

### Bugs fixed this session

- **`intentional-cognition-os-h99`** (P2) — verify.py paradigm gap.

### Next session priorities

- Either: file the render-summary duplicate-row bead (small P3) +
  decide on v0.2 of the bank
- OR: skip ahead to v0.2 — add paraphrase variance to the bank schema
  per the question-bank-spec, get more granular signal

---

## 2026-05-22 — session 5: v0.2 schema lands (paraphrase variance) — code shipped, real-API run pending

**Target**: `intent-eval-core` (unchanged from sessions 2–4)
**Question bank**: `intent-eval-core-v2.yaml` (NEW — 5 intents × 5 paraphrases). v1 stays untouched per ADR-031.
**Run id**: pending — placeholder until the post-PR-review acceptance run lands.

### What changed

The v0.2 work introduces phrasing-sensitivity as a first-class probe. After
sessions 2–4 surfaced two real bugs (fmo + h99) on the v0.1 5-question bank,
the next class of bugs to find is phrasing-brittleness — does ICO still
engage when the same intent is asked differently? Unknown until measured.

Four commits land on `feat/dogfood-v0.2-paraphrases`:

1. `bank.py` schema library + ADRs 029–032. Backward-compatible — v1 banks
   load as "one synthetic primary paraphrase per intent, style=legacy".
2. `paraphrase_robustness` metric in `verify.py`. Reported side-by-side with
   `verify_rate` per ADR-030, never composited.
3. `ask-loop.py` extraction + `--paraphrases primary|all` flag in `run.sh`.
   Default `primary` mode preserves v0.1 cost shape ($0.20/run).
4. Docs (question-bank-spec, receipt-schema, progress.md schema) +
   production `intent-eval-core-v2.yaml`.

Cumulative script test count: 61 (15 budget + 21 run_sh + 17 verify + 6 bank

- 2 render-summary).

### Acceptance run (pending — placeholder)

The real-API run goes after PR review:

```
plugin/skills/ico-your-internals/scripts/run.sh \
    --target ~/000-projects/intent-eval-platform/intent-eval-core \
    --bank dogfood/question-banks/intent-eval-core-v2.yaml \
    --paraphrases all
```

Cost estimate: ~$1 (5 intents × 5 paraphrases × ~4k tokens). Gates:

- `paraphrase_robustness ≥ 60%` — if 5/5 phrasings of every intent
  hit no-knowledge, fmo regressed.
- `verify_rate ≥ 30%` — regression gate against the 46.4% post-h99 baseline.

This entry gets a real-numbers commit once the acceptance run completes.

### Bugs filed this session

- `intentional-cognition-os-nwh` (P3) — CI gap: plugin scripts (.sh / .py)
  have no shellcheck / ruff coverage.
- `intentional-cognition-os-x5r` (P3) — Test coverage audit: identify obvious
  test gaps across the repo.

### Bugs fixed this session

None — this is feature work, not a bug fix cycle.

### Next session priorities

- Run the acceptance test (~$1, ~5 min runtime).
- Inspect any new paraphrase styles that systematically fail.
- File beads for any fmo-family or new-paradigm bugs surfaced by the v2 bank.
- Possibly: start a v0.3 design conversation around per-paraphrase
  `expected_substrings` overrides and `citation_jaccard_across_paraphrases`.

---

## 2026-05-31 — demo-e2e: first full-green proof-of-work run (real key)

**Target**: the in-repo sample corpus (`dogfood/experiments/compile-vs-rag/corpus`, 5 docs)
**Question bank**: n/a — this is the cross-repo `scripts/demo-e2e.sh` proof-of-work
demo (ICO → INTKB → qmd → audit), not a question-bank dog-food session.
**Run id**: `runs/demo-2026-05-31T194258Z/`

### Headline

First time the whole **Compile-Then-Govern** chain runs full-green with a real
`ANTHROPIC_API_KEY` — all 7 stages pass, every link carrying real content
end-to-end. Prior runs were structurally green but stages 1–2 produced empty
content under a placeholder key (ICO bead `u0j` makes that fail loud now), so
stages 3–6 had nothing to carry. This is the run that closes the thesis §6.2
honesty note: the wire is no longer "partial."

### Per-stage result

| stage | what                                      | result | time   |
| ----- | ----------------------------------------- | ------ | ------ |
| 1     | ico init + mount + ingest                 | pass   | 3.4s   |
| 2     | ico compile (6 passes, live Claude)       | pass   | 358.4s |
| 3     | ico spool emit                            | pass   | 1.0s   |
| 4     | INTKB curator-cli (ingest→policy→promote) | pass   | 0.5s   |
| 5     | INTKB export → qmd index                  | pass   | 1.8s   |
| 6     | qmd search returns citation               | pass   | 0.6s   |
| 7     | ico audit verify (hash chain)             | pass   | 1.0s   |

### What the chain actually carried

- **Compile** turned 5 corpus docs into real semantic knowledge (6 passes).
- **Curator**: 21 candidates ingested → **21 promoted, 0 rejected, 0 flagged,
  0 duplicates, 0 tampered**. Every promotion went through the policy pipeline
  (`outcome: approved`).
- **Export**: 21 curated memories materialized into the kb-export markdown tree.
- **qmd search**: returned **20 citations**, e.g.
  `qmd://kb-demo-demo-e2e/guides/2daed212-15fd-4005-97f1-4c0fd5116dcf.md`.
- **Audit verify**: 61 hash-chain events across 1 trace file, **0 breaks**.

### Isolation

The demo ran under its own per-run `XDG_CACHE_HOME` + `XDG_CONFIG_HOME`; the
operator's real `~/.config/qmd/index.yml` shows **0** kb-demo entries afterward.
Both XDG vars are load-bearing — the cache var alone would leak `collection add`
entries into the global registry.

### Key source

`ANTHROPIC_API_KEY` decrypted in-process from `intent-eval-platform/intent-eval-lab/.env.sops`
via the operator's age key — never written to disk or printed. ICO's compiler
speaks the Anthropic Messages API; the Groq/NVIDIA keys in that same SOPS file
are OpenAI-format endpoints and do not drive ICO.

### Relationship to e3q

This demo proves the FLOW by driving qmd directly. The production edge-daemon
`qmd-adapter` was independently hardened to qmd 2.0.1 the same day
(`qmd-team-intent-kb` PR #159, ADR 037-AT-DSGN, bead `e3q` closed) — that fix is
proven by its own real-qmd integration test, separate from this demo.

### Bugs filed

None — clean full-green run.

### Next session priorities

- Wire this run into the nightly CI smoke (the demo's stated secondary purpose)
  so any regression of a link in the chain is caught.
- Consider a demo variant that drives stages 5–6 through the now-fixed
  `edge-daemon run-once` adapter path (vs direct qmd) as a stronger production
  proof.
