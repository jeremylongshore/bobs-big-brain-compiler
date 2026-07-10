---
title: 'ISEDC Decision Record — Build/No-Build: social-trend feeder + front-of-pipe quality gate'
code: AT-DECR
date: 2026-06-24
acting_head_of_board: Jeremy Longshore (final ratification); Claude convening + synthesizing
council_size: 7
seats: [CTO, GC, CMO, CFO, CSO, CISO, VP-DevRel]
decisions_logged: 2
status: decided (unanimous; awaiting Jeremy's ratification)
inputs: ['intentional-cognition-os/000-docs/038-AT-EVAL-cc-workflow-tools.md']
session: '~/.claude/skills/exec-decision-council/sessions/2026-06-24-build-no-build-v0r-feeder-and-front-gate/session.jsonl'
beads:
  [
    intentional-cognition-os-v0r,
    intentional-cognition-os-v0r.1,
    intentional-cognition-os-v0r.2,
    qmd-team-intent-kb-ebz,
  ]
---

# ISEDC Decision Record — Build/No-Build: social-trend feeder + front-of-pipe quality gate

## 1. Mission of this record

Two build recommendations queued (deferred) by the `v0r` eval (`038-AT-EVAL-cc-workflow-tools.md`)
needed a build / no-build / defer call. A 7-seat adversarial council ruled on each; this record
preserves every seat's verbatim position and the synthesis, so a future reader can reconstruct why
the decision landed where it did. The session JSONL (path in frontmatter) is the rich source of truth;
this markdown is derived.

## 2. Why a council, not a single review

Item A (a feeder that pipes untrusted internet text into the govern-by-receipts corpus) has an
**asymmetric, partially-irreversible failure mode**: a poisoned item promoted into the hash-chained
store produces a _high-integrity receipt for a lie_, inverting the one axis the brand owns. That
asymmetry is exactly what the ISEDC pattern exists for. (All 7 seats independently named Item A as
the most costly to get wrong.)

## 3. Synthesis lenses (applied by every seat)

1. **Thesis** — the model proposes, the deterministic system owns durable state ⇒ a feeder MUST be govern-gated, never trusted.
2. **Sole-prop bandwidth** — every build competes with shipping the core product + the Anthropic cohort/enterprise work.
3. **Receipts are the wedge** — does this sharpen or dilute the "govern + receipts" differentiator?
4. **Reversibility** — one-way door vs measure-and-adjust.

## 4. The questions

| ID                 | Question                                                                                                                                                                                                                                    | Why costly                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **A — feeder**     | BUILD/NO-BUILD/DEFER a `last30days`-style **gated** social/current-trend ingest feeder for ICO (lift `signals.py`/`dedupe.py`; route ALL signal through INTKB governance). Effort S–M. Risk: corpus-poisoning. Beads `v0r.1` + INTKB `ebz`. | A poisoned promotion is notarized by the receipt chain — unrecoverable; inverts the wedge. |
| **B — front-gate** | BUILD/NO-BUILD/DEFER a `superpowers`-style front-of-pipe quality gate: spec→TDD **two-stage review** (S) + optional brainstorm→spec **HARD-GATE** (M). Bead `v0r.2`.                                                                        | Reversible (prompt discipline); low blast radius.                                          |

## 5. Council composition

CTO (technical durability) · GC (IP/consent/provenance) · CMO (positioning/narrative) · CFO (bandwidth/opportunity-cost) · CSO (standards/ecosystem posture) · CISO (threat model/attestation) · VP-DevRel (developer adoption signal). Full value systems: the `exec-decision-council` skill roster.

## 6. Item A — the social-trend feeder

**VOTE: DEFER 6 · BUILD-conditional 1 (GC, conditioned on the same gate-first preconditions) · NO-BUILD 0.**
Net: **NO-BUILD the collector now; the prerequisite is to BUILD + red-team the INTKB govern gate (`ebz`) first.** Unanimous on _gate-before-collector_. Sequence strictly **after** Item B.

### Verbatim seat positions (condensed to verdict + core argument + tension; full text in the JSONL `output_file` refs)

- **CTO — DEFER.** "Build the feeder before the gate is hardened and you have inverted the thesis: untrusted signal reaching durable state through a gate you're writing concurrently. The §6.3 mitigations describe a governance subsystem that does not yet exist and has never been red-teamed. The S–M estimate is for the _collector_; the gate is the M-to-L unbeaded work that protects the brand." Tension: clashes with CMO/VP-DevRel ("fills a real gap, ship now"); aligned with CISO.
- **GC — BUILD (gated), strictly after the consent/provenance gate.** "The build is the _gate_, not the collector." Bound conditions (or dissent): (1) MIT `THIRD-PARTY-NOTICES` crediting `last30days` @ pinned SHA travels with the lifted code; (2) `raw/untrusted/` quarantine with explicit recorded promotion, provenance a hard schema field; (3) PII/source-quote minimization (citation+minimal snippet over full reproduction; redact usernames at ingest); (4) NO partner/cohort material through the feeder. "Reproducing third-party/PII content into a hash-chained append-only corpus makes it evidentiarily permanent."
- **CMO — DEFER (sequence after B + after `ico audit verify` is publicly demonstrable).** "A govern-gated social feeder is the single most on-brand build — untrusted-in/governed-out dramatizes the wedge — BUT reversibility is asymmetric: one astroturf item reaching the compiled wiki retracts the thesis (a documented lie on the one axis we own). Build the gate as a marketable safety property; don't ship the headline before the proof."
- **CFO — DEFER (bead stays cold).** "A gap is not a need — zero cohort/enterprise/client signal asks the brain to know last week's trends. The collector lifts cheap (S) but the quarantine/promotion/injection gating is the real unscoped cost, spent hardening against a risk we volunteered. Un-defer trigger: a named cohort member/client logs a specific recall miss twice, traceably. The scarce resource is Jeremy's hours; a cheap build that doesn't serve the revenue/credibility engine is the most expensive thing on the board."
- **CSO — DEFER (gate first, feeder second — never reverse).** "Once a social-sourced claim reaches compiled wiki + a receipt, that receipt is a permanent first-production-signature — `ico audit verify` faithfully attests a poisoned claim forever. Engagement-as-popularity contaminating an authority store is the empty-signed-surface/cargo-cult failure. No social-sourced item gets a wiki receipt until the discount-floor + promotion gate are _code, not policy_."
- **CISO — DEFER (build-gated; 5 controls as preconditions, no partial credit).** "Today's injection defense is a synthesis-layer comment wrapper — **forgery cost ZERO**; nothing in the DATA layer enforces the data/instruction boundary. A poisoned promotion produces a high-integrity receipt for a lie." Preconditions: (1) quarantine `raw/untrusted/` only; (2) **data-not-instruction fencing at the DATA layer**, not the prompt; (3) provenance hard-pin, engagement = discount knob never authority weight; (4) **adversarial red-team eval gate** (labeled injection/astroturf corpus must fail-closed, 0 promotions) — turns forgery cost from 0 to nonzero; (5) human-in-loop promotion.
- **VP-DevRel — DEFER (build-conditional; gate-as-demo).** "Developers don't want a Reddit scraper (`last30days` has 31k stars) — they want 'my governed brain stays current and I can _see the receipt_ for why a trend entered.' The gating IS the demo. But if a dev's first try poisons their wiki, the governance brand shipped the exact failure it sells. Sequence: backup/DR (already done) → quarantine+promotion gate → feeder last."

### DECISION A (synthesis)

**NO-BUILD the collector now. The prerequisite work is to BUILD + red-team the INTKB govern gate (`ebz`) first.** The collector (`v0r.1`) is deferred behind the union of the seats' binding constraints:

1. Quarantine tier — ingest lands in `raw/untrusted/` only; never a direct path to compiled wiki.
2. **Data-not-instruction fencing at the data layer** (not just the synthesis prompt — current forgery cost is zero).
3. Provenance hard-pin — URL/source/timestamp/engagement immutably bound; engagement is a _discount knob_, never an authority weight.
4. **Adversarial red-team eval that must fail-closed (0 promotions)** before the feeder ships.
5. Human-in-loop L4→L2 promotion (no autonomous untrusted→durable path).
6. MIT `THIRD-PARTY-NOTICES` + SHA-pin on the `signals.py`/`dedupe.py` lift.
7. PII / source-quote minimization at ingest.
8. No partner/cohort material through the feeder (public-internet only).

**Un-defer trigger (CFO):** a named cohort member or client logs a specific recall-miss the brain should have caught from current signal — twice, traceably. **Sequencing:** strictly after Item B.

## 7. Item B — the front-of-pipe quality gate

**VOTE: BUILD the S two-stage review 7 · DEFER the M brainstorm→spec front-gate 7 · NO-BUILD 0. Unanimous.**

### Verbatim seat positions (condensed)

- **CTO — BUILD (S only).** "The cleanest BUILD on the table — reversible, near-zero blast radius, and the 'verify implementation == spec, nothing extra' check is exactly the scope-creep catch our harness lacks." DEFER the M front-gate (overlaps `/exec-decision-council` + plan mode) pending a non-overlap design.
- **GC — BUILD (S).** "Build it immediately — the record (spec) must equal the artifact (code). Carry MIT attribution on any lifted prompt text."
- **CMO — BUILD (first).** "Same thesis one altitude up: govern our own code outputs before governing the world's inputs. The cheap reversible rehearsal that earns the right to ship A." Keep it the _spec==implementation_ assertion only.
- **CFO — BUILD (S only).** "The rare item where the build serves the revenue engine instead of competing with it — leverage on the one operator's output. Defer the M front-gate behind a real trigger (a logged spec-drift miss); a solo operator won't sustain ceremony."
- **CSO — BUILD.** "Durable mechanics, not fashion — in-toto predicate discipline applied to code review; superpowers' adoption is genuine community-temperature. Defer the front-gate; don't claim a slot council+plan-mode own."
- **CISO — BUILD.** "Low threat surface, additive, reversible — pure governance upside. But the lifted prompt is itself a supply-chain artifact: **SHA-pin + review-before-lift**."
- **VP-DevRel — BUILD (S).** "Lifting a beloved 220k-star MIT pattern _with honest 'built on obra/superpowers' attribution_ is DevRel gold — the community rewards lineage, punishes silent reinvention. Keep attribution informal/human. Three front-gates = bureaucracy a solo dev abandons; defer the M."

### DECISION B (synthesis)

**BUILD the S-effort two-stage spec-then-quality review** (enforced ordering + distrust-the-self-report; the implementation==spec front-gate `@intentsolutions/audit-harness` lacks, complementing it at the front of the pipe) as a prompt-template skill / `implement-tests` handoff step. **DEFER the M brainstorm→spec HARD-GATE** (it re-litigates `/exec-decision-council` + plan mode; un-defer only on a logged spec-drift miss). Carry an honest, **informal** "built on `obra/superpowers`" MIT attribution; **SHA-pin + review** the lifted prompt text as a supply-chain artifact.

## 8. Cross-cutting themes

- **Most-costly-to-get-wrong: Item A — 7 of 7 seats.** The decision to deliberate slowest, and the council unanimously says _do not rush it_. The receipt does not protect you here — it _notarizes the mistake_.
- **The shared discriminator (CFO + VP-DevRel):** "whose throughput does this serve?" B's S-slice serves the sole operator shipping the revenue engine; A serves an unrequested capability while _adding_ a risk surface to the product's own differentiator.
- **The underweighted axis (CISO):** both items are _ingests_ — A ingests untrusted data, B ingests untrusted _code_ (prompt text). Both lifts get SHA-pinned + reviewed; no lift without provenance.
- **Adversarial integrity:** genuine dissent surfaced (GC's conditional-BUILD on A; CMO's "most on-brand build" enthusiasm tempered by sequencing) — not consensus theater. The dissent resolved into _binding preconditions_, not suppression.

## 9. Implementation directives

| Item                       | Decision                       | Owner           | Bead                     | Next action                                                                                                                                                                               |
| -------------------------- | ------------------------------ | --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B (S two-stage review)** | **BUILD now**                  | Jeremy / Claude | `v0r.2`                  | Implement as a prompt-template skill (spec→quality two-stage review, distrust-the-self-report, implementation==spec); informal `obra/superpowers` attribution; SHA-pin the lifted prompt. |
| **B (M front-gate)**       | **DEFER**                      | —               | (sub of `v0r.2`)         | Un-defer only on a logged spec-drift miss + a council/plan-mode non-overlap design.                                                                                                       |
| **A (govern gate `ebz`)**  | **BUILD FIRST (prerequisite)** | Jeremy          | `qmd-team-intent-kb-ebz` | Build + red-team the INTKB quarantine/promotion/data-layer-injection-defense per the 8 binding constraints; fail-closed eval gate.                                                        |
| **A (collector `v0r.1`)**  | **NO-BUILD / DEFER**           | —               | `v0r.1`                  | Build only after `ebz` clears the red-team eval AND the CFO demand-signal trigger fires.                                                                                                  |

## 10. Reusable pattern

Convened via the `exec-decision-council` skill (7-seat ISEDC). See that SKILL.md.

## 11. Acting head of board

The council is **unanimous** on both items (Item A's lone conditional-BUILD aligns with the DEFER preconditions). **Final ratification is Jeremy's.** Claude convened + synthesized; no minority position required overriding — the dissent resolved into the binding precondition stack recorded above.

## 12. References + provenance

- Source eval: `intentional-cognition-os/000-docs/038-AT-EVAL-cc-workflow-tools.md`
- Session JSONL (rich source of truth, verbatim per-seat output files): see frontmatter `session`.
- Tools (pinned): `obra/superpowers`, `garrytan/gstack`, `mvanhorn/last30days-skill` — all MIT (see 038-AT-EVAL §3 for SHAs).
