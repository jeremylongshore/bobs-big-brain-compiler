# Decision: re-ingest invalidates derived pages and mount timestamps are success receipts

**Doc:** 044-AT-DECR · **Date:** 2026-08-02 · **Status:** Proposed in l13.17 / GitHub #200

## Decision

ICO keeps source rows append-only. When a file at an existing workspace-relative
path changes, ingest creates a new source row and then marks every compilation
that depends on superseded versions stale:

- direct pages through `compilations.source_id`;
- cross-source pages through `compilation_sources`.

The update counts only rows transitioning from `stale = 0` to `stale = 1` and
runs transactionally. An unchanged hash remains an idempotent no-op and does not
advance a mount timestamp or invalidate any compilation.

## Mount provenance

If the input file is inside a registered mount, ingest selects the longest
path-boundary match. The accepted source row receives that mount's `mount_id`.
After source registration and stale-dependency invalidation succeed, ingest
updates `mounts.last_indexed_at`. A path outside all mounts remains valid and
has a nullable `mount_id`.

This makes `last_indexed_at` a success receipt rather than a claim that a mount
was merely configured. A missing or concurrently removed mount fails the
freshness update instead of reporting a false index time.

## Legacy compatibility

Older compilations may have no `compilation_sources` rows. Incremental compile
continues to use its conservative cross-source sweep for those rows; the new
durable stale flag improves the queue signal without weakening the existing
fail-toward-freshness behavior.

## Evidence

- Kernel tests cover longest containing-mount resolution, path boundaries, and
  timestamp writes.
- Compiler tests cover direct and junction-dependent invalidation and the
  first-ingest/already-stale zero-count cases.
- CLI tests cover unchanged re-ingest no-op behavior, changed re-ingest stale
  propagation, and mount provenance/timestamp persistence.
