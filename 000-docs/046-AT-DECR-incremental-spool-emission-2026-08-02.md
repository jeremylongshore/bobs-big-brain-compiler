# Decision Record — Incremental spool emission and bounded rebuilds

**Date:** 2026-08-02

**Status:** Ratified by implementation on `feat/ico-l13-3-incremental-spool`

**Bead:** `intentional-cognition-os-l13.3`
**GitHub:** `bobs-big-brain-compiler#189`

## Decision

`ico spool emit` is incremental by default. The compiler records the last
successful emission for each compiled page in the workspace state database and
skips a page when its body hash, tenant, and emission mode are unchanged.

An operator may request a deliberate rebuild with `--full`. Every run remains
bounded by a default ceiling of 5,000 candidates. A larger run must state its
limit explicitly with `--max-candidates <count>`; exceeding the limit fails
before a spool file is written and emits a `spool.emit.refused` trace.

The existing `--bulk` flag remains the explicit whole-machine digestion mode.
It stamps `bulk_import` / `untrusted` and is part of the watermark key, so
switching between normal and bulk modes cannot silently reuse the other mode's
receipt.

## Why this is the right boundary

The 2026-07-16 whole-machine run re-emitted the entire wiki — 17,165
candidates and 51.7 MB — because discovery had no per-page emission history.
The downstream ID dedupe prevented duplicate rows, but it still spent I/O and
governance work on an avoidable full replay. A hard limit makes the failure
visible; a state-DB watermark makes the normal path cheap and repeatable.

This is a producer-side guard. It does not replace INTKB policy evaluation,
manifest verification, or candidate deduplication. The state record is written
only after the spool file and completion trace succeed; if state recording
fails, the emission is treated as unsuccessful for future incremental runs and
will be safely retried.

## Operator contract

| Invocation                                                          | Behavior                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ico spool emit --tenant <id>`                                      | Incremental; unchanged pages are skipped; max 5,000 candidates |
| `ico spool emit --tenant <id> --dry-run`                            | Preview using the same state-DB watermark and ceiling          |
| `ico spool emit --tenant <id> --full --max-candidates 20000`        | Explicit full rebuild with a declared budget                   |
| `ico spool emit --tenant <id> --bulk --full --max-candidates 20000` | Explicit whole-machine low-trust rebuild                       |

`--full` is not a way around the ceiling. The operator must name the expected
run size, which leaves an auditable command-line decision and a bounded blast
radius.

## Data model

Migration `005-add-spool-emissions.sql` adds `spool_emissions`, keyed by the
workspace-relative page path. Each row records the body SHA-256, tenant, bulk
mode, scope, completion timestamp, and spool filename. A changed body or a
changed tenant/mode replaces the row only after a successful emission.

## Verification

- Kernel tests cover incremental no-op behavior, deterministic IDs under
  `--full`, mode changes, the emission ceiling, and database-backed dry-run
  parity.
- CLI tests cover the new watermark-aware dry-run database handle and preserve
  the existing path, tenant, and exit-code contracts.
- The full repository gates remain required before merge: build, typecheck,
  lint, format check, and the complete test suite.
