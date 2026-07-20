# Decision: wiki/ is receipted knowledge, outputs/ is render scratch

**Doc:** 041-AT-DECR · **Date:** 2026-07-19 · **Track:** GSB Wave-2 G5 (umbrella blueprint
`019-PP-PLAN` § G5) · **Status:** Decided — records the boundary PR #176 embodied.

The blueprint's G5 asked: does `wiki/` need sole-writer enforcement, or is it explicitly
pre-admission scratch space? PR #176 answered by shipping the enforcement, so this record
states the decision rather than opening one: **`wiki/` is receipted knowledge, not scratch.**
`outputs/` is the scratch tier. The two directories now have different visibility semantics,
and contributors must not blur them.

## 1. The decision

### wiki/ — receipted, reconcile-gated, quarantine on violation

The six compiled-page directories

```text
wiki/sources  wiki/concepts  wiki/entities
wiki/topics   wiki/contradictions  wiki/open-questions
```

(`GATED_WIKI_DIRS` in `packages/kernel/src/reconcile.ts`, in enforced three-place lockstep
with `spool.ts`'s `WIKI_DIRS` and `promotion.ts`'s `TYPE_DIRECTORY_MAP`) hold **only content
that carries a receipt row** — a match in `compilations.output_path` ∪
`promotions.target_path`. Enforcement is two-sided:

- **Before visibility:** every compile pass and every promotion writes tmp → *all receipts
  durable* (DB row, trace, audit JSONL, log) → rename-into-place. A page cannot become visible
  ahead of its receipt (the G1 floor, PR #176).
- **After the fact:** `reconcileWorkspace` / `ico audit reconcile` walks the gated dirs and
  **quarantines** (moves to `quarantine/<original-relative-path>`, never deletes) any visible
  `.md` with no matching receipt row, plus stale `.tmp` crash orphans. The reconciliation is
  itself receipted via an `audit.reconcile` trace. `ico spool emit` runs this reconcile as a
  **default-on pre-emit gate** (`--no-reconcile` is a forensic-runs-only opt-out), so
  `emitSpool` can only ever ingest receipted pages — a quarantined file is simply no longer in
  `wiki/` to be read.

Quarantine-by-move was chosen over delete-on-detect because quarantine is reversible evidence
and deletion destroys it; the receipt-without-file crash direction was chosen over
file-without-receipt because a dangling receipt is auditable and re-derivable, while an
unreceipted visible page would launder ungoverned model output straight into the corpus.

### outputs/ — render scratch, NOT receipt-gated today

`outputs/{reports,slides}/` is where the render layer writes reports and slide decks. **Renders
carry no receipt row** — no DB table keys rendered artifacts by path — so `outputs/` is:

- **tmp-swept**: the reconciler sweeps stale `.tmp` crash orphans there (same > 1 h age gate as
  wiki), but
- **not receipt-gated**: visible files in `outputs/` are never quarantined for lacking a
  receipt, because with no receipt schema for renders the gate would quarantine every
  legitimate deck.

The knowledge that renders draw *from* is still governed: outputs remain gated at the L4→L2
boundary by the promotion engine — a render can only be built over already-receipted material.
What is unreceipted is the rendered artifact itself.

## 2. The deferred follow-up: receipting renders

Extending the receipt gate to `outputs/` requires a schema migration first — a table (or
extension of `compilations`) keying rendered artifacts by path — and only then can the
reconciler gate the directory. This is a **documented deferral, not an oversight**, deferred
because: (a) shipping the G1 floor could not wait on a render-receipt schema design; (b)
gating without the schema would quarantine every legitimate output (a pure false-positive
gate); (c) the governance exposure is bounded — renders are derived presentation over
already-promoted content, and nothing in `outputs/` feeds back into the spool or the corpus.
When receipting lands, `outputs/` graduates to the same reconcile gate as `wiki/`.

## 3. What a contributor may write where

| Directory | Direct writes (human or script) | Who may write |
| --- | --- | --- |
| `wiki/*` (the six gated dirs) | **Nothing. Ever.** | Only the receipted writers: the compile passes and the promotion engine, via tmp → receipts → rename |
| `outputs/{reports,slides}` | Tolerated (scratch), but unreceipted and reconcile-invisible | The render layer; humans at their own risk |
| `quarantine/` | Read/triage only — restore a file by re-deriving it through a receipted writer, not by moving it back | The reconciler moves things in; humans review |
| `brain/raw/` (corpus) | Normal ingest surface | Ingest paths (out of scope here; see `005-AT-SPEC`) |

A file hand-placed into a gated `wiki/` directory is not deleted and not silently accepted: it
sits until the next reconcile (at latest, the next `ico spool emit`) and is then moved to
`quarantine/` with a receipted trace of the move. If you believe content belongs in the wiki,
put it through the front door — ingest it into the corpus and let a compile pass or promotion
emit it with receipts.

## 4. References

- Enforcement: `packages/kernel/src/reconcile.ts` (header comment states both boundaries),
  `packages/kernel/src/promotion.ts`, `packages/cli/src/commands/{audit.ts,spool.ts}`.
- Shipped in: PR #176 (receipts-precede-visibility floor G1 + reconcile + pre-emit gate).
- Crash/lock context: `040-AT-ARCH-writer-model-many-processes-one-logical-writer.md`.
- Blueprint ask: umbrella `000-docs/019-PP-PLAN-master-blueprint-epics-and-beads.md` § G5
  (`extends: intentional-cognition-os-l13.2/l13.4`, serves O2, cite: Hickey seam).
