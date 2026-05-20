# ADR and AAR Templates

> Decide once, document why. Review once, improve next time.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Architecture Decision Record (ADR) Template

ADRs capture significant technical decisions with their context and consequences. One decision per file. Write them when the decision is made, not after.

**File naming:** `adr/NNN-title-slug.md` (e.g., `adr/001-use-sqlite-for-state.md`)

**Valid statuses:** Proposed, Accepted, Deprecated, Superseded by ADR-NNN

### 1.1 Template

```markdown
# ADR-NNN: Title of Decision

**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNN
**Date:** YYYY-MM-DD

## Context

What is the issue? What forces are at play? What constraints exist?
State facts. Do not argue for a solution here.

## Decision

What is the change that we are proposing or have agreed to?
State the decision in active voice: "We will use X" or "We will not do Y."

## Consequences

### Positive

- Benefit one
- Benefit two

### Negative

- Tradeoff one
- Tradeoff two

### Neutral

- Side effect that is neither good nor bad

## Related ADRs

- ADR-NNN: Title (relationship — e.g., "supersedes", "depends on", "related to")
```

### 1.2 Example: Use SQLite for Deterministic State

```markdown
# ADR-001: Use SQLite for Deterministic State

**Status:** Accepted
**Date:** 2026-04-02

## Context

ICO requires a local state store for the kernel's deterministic control plane — mount registry, task state machines, promotion rules, and audit metadata. The store must work offline, require zero infrastructure, support concurrent reads, and survive process crashes without data loss.

Options considered:

1. **SQLite via better-sqlite3** — synchronous, zero-config, single-file, battle-tested.
2. **LevelDB** — fast key-value, but no SQL, limited query flexibility.
3. **Plain JSON files** — zero dependencies, but no atomicity, no concurrent safety, schema enforcement is manual.
4. **PostgreSQL** — full RDBMS, but requires a running server, violates local-first constraint.

## Decision

We will use SQLite via the `better-sqlite3` Node.js binding for all deterministic state. The database file lives at `workspace/.state/ico.db`. All schema migrations are forward-only SQL files executed by the kernel at startup.

## Consequences

### Positive

- Zero infrastructure — single file, no server process
- ACID transactions protect state integrity across crashes
- SQL enables flexible queries over mount registry, task state, and audit metadata
- `better-sqlite3` is synchronous, which simplifies the deterministic control plane (no async state races)

### Negative

- Single-writer constraint limits future multi-process architectures
- Binary file is not human-readable (unlike JSON or JSONL)
- Adds a native dependency (`better-sqlite3` requires node-gyp build)

### Neutral

- JSONL remains the format for append-only audit traces (Layer 6) — SQLite handles structured state, JSONL handles sequential logs

## Related ADRs

- None yet (first ADR)
```

---

## 2. After-Action Review (AAR) Template

AARs capture what happened during a bounded effort — an epic, a sprint, a production incident, a failed deploy. Write them within 48 hours of completion while memory is fresh.

**File naming:** `aar/YYYY-MM-DD-title-slug.md` (e.g., `aar/2026-04-06-epic-1-standards-sprint.md`)

### 2.1 Template

```markdown
# AAR: Title of Review

**Date:** YYYY-MM-DD
**Epic/Bead Reference:** Epic N / BZ-NNN (or N/A)

## What Happened

Objective summary of the effort. What was the goal? What was the scope?
What was the actual outcome? State facts, not opinions.

## What Went Well

- Thing that worked
- Thing that worked

## What Went Wrong

- Thing that failed or caused friction
- Thing that failed or caused friction

## Root Causes

- Why did the failures happen? Trace back to systemic causes, not individual blame.

## Action Items

| #   | Action                           | Owner | Deadline   |
| --- | -------------------------------- | ----- | ---------- |
| 1   | Description of corrective action | Name  | YYYY-MM-DD |
| 2   | Description of corrective action | Name  | YYYY-MM-DD |

## Lessons Learned

- Reusable insight that applies beyond this specific effort.
```

### 2.2 Example: Epic 1 Standards Sprint

```markdown
# AAR: Epic 1 Standards Sprint

**Date:** 2026-04-06
**Epic/Bead Reference:** Epic 1 / E1-B01 through E1-B15

## What Happened

Epic 1 established the canonical design pack for ICO: master blueprint, architecture doc, technical spec, PRD, user journey, glossary, execution plan, CI/CD pipelines, and operational templates. The goal was to freeze all foundational documentation before writing application code. All 15 beads were closed within the sprint window.

## What Went Well

- Blueprint v2.2 stabilized the schema contract and learning model before any code existed
- Doc-filing v4 naming convention eliminated ambiguity in document discovery
- Beads tracking provided clear progress visibility across 15 deliverables
- Competitive research in the blueprint grounded design decisions in market reality

## What Went Wrong

- Early blueprint drafts mixed architectural decisions with product requirements, requiring a rewrite to separate concerns
- The execution plan underwent three revisions as scope became clearer, burning time on re-sequencing
- Some doc cross-references were stale after the v2 rewrite and had to be manually reconciled

## Root Causes

- Attempting to write architecture and product docs simultaneously led to blurred boundaries — these should be drafted sequentially (PRD first, then architecture)
- Execution plan instability was caused by defining beads before the blueprint was frozen — plan should follow blueprint freeze, not run in parallel

## Action Items

| #   | Action                                                            | Owner  | Deadline   |
| --- | ----------------------------------------------------------------- | ------ | ---------- |
| 1   | Add a doc consistency check to the CI pipeline                    | Jeremy | 2026-04-13 |
| 2   | Establish a rule: freeze blueprint before drafting execution plan | Jeremy | 2026-04-07 |
| 3   | Run cross-reference lint on all 000-docs before Epic 2 starts     | Jeremy | 2026-04-08 |

## Lessons Learned

- Freeze the authoritative document before producing downstream artifacts. Parallel drafting creates rework.
- Beads provide recovery after compaction but also serve as a forcing function for scope discipline — define the bead, do the bead, close the bead.
```

---

## 3. Usage Guidelines

1. **Create the directories** when you write the first record: `mkdir -p adr aar` at the repo root.
2. **ADRs are immutable once accepted.** To reverse a decision, write a new ADR that supersedes the old one and update the old ADR's status to "Superseded by ADR-NNN."
3. **AARs are written once and never edited.** If new information surfaces, write a follow-up AAR referencing the original.
4. **Keep both short.** If an ADR exceeds one printed page, the decision is probably too broad — split it. If an AAR exceeds two pages, the scope was too large — break future efforts into smaller reviewable chunks.
5. **Link from beads.** When closing a bead that involved an architectural decision, reference the ADR number in the close reason.
