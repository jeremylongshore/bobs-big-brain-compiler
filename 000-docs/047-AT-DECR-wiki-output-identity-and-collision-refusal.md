# Wiki output identity and collision refusal

**Date:** 2026-10-25

**Status:** Implementation decision for `intentional-cognition-os-l13.12`; release and live migration are separate.

## Decision

New outputs from summarize, extract, synthesize, contradict and gap use a readable
stem plus the full SHA-256 of the UTF-8 JSON tuple
`["ico-wiki-output-v1", kind, logicalId]`. Summary identity is the actual source ID;
derived identity is the existing stable page ID. The body is not a filename input.
The readable stem is at most 64 ASCII characters; `+` and `#` have explicit
`-plus-` and `-hash-` encodings. Different identities that flatten to the same
readable slug therefore receive different target paths. Kind participates in the
filename hash; the hash is a discriminator, not proof of content authenticity.

Derived-page comparison preserves `+` and `#` before deduplication. `C++`, `C#`
and `C` remain separate titles. Existing case, whitespace and other punctuation
normalization remains. The stable page UUID algorithm and namespace are unchanged;
operator-bearing titles can receive a different UUID because their comparison key
changes. This is an above-spool page-identity correction. The canonical candidate
UUID-v5 derivation, separators, body hashing and spool schema are unchanged.

## Ownership and repeated compilation

Before a temporary output write, each pass checks existing compilation records
for that path and the existing file's initial identity/type header. Conflicting,
missing or ambiguous ownership is refused, including symlink/nonregular leaves.
Summary headers use the caller's actual source ID. A normal summary rerun reuses
the existing exact source/type/path compilation row ID and updates only compilation
time, stale status, model and token metadata. It does not replace audit history.

Derived IDs currently share a namespace across kinds. If an existing compilation
ID belongs to another kind, the pass refuses before staging a file; typed filenames
alone do not solve that database constraint. Introducing kind-specific page UUIDs
would need the separate continuity decision tracked in `l13.24`, including
kind-aware deduplication before shared-response titles can collapse. Existing trace-before-visibility and
provenance recording remain in place. These checks are consistency controls under
the existing single-writer contract, not an atomic lock or same-user sandbox.

## Links and diagnostics

Backlink and orphan checks first resolve an exact unique filename stem. Otherwise,
they accept only a unique normalized title alias, preserving `+` and `#`. Duplicate
stems and ambiguous title aliases remain unresolved. Piped display labels do not
participate in identity. Alias extraction supports simple scalar titles in the
initial fenced header; unsupported YAML syntax is not a general title index.

`ico lint` adds `outputPaths` to its JSON result and a human report line. It reports
duplicate path groups as `conflicting-identities` when distinct known source or
stable typed page identities are present. Historical batch/random-ID rows without
proven identity are reported separately as `unverifiable-legacy`; the tool does
not infer different pages from row count alone. Retained rows can expose a
historical collision, but lint cannot reconstruct a body already overwritten.
Recovery requires independently retained source/receipt evidence and explicitly
reviewed recompilation or migration. Both diagnostic classes require operator attention
and contribute to the issue count and existing lint trace. Lint never repairs or
rewrites compilation records.

## Compatibility and recovery

This change does not rename, delete, rewrite or recompile stored pages, live
corpora, emission watermarks or audit history. On a later explicit compilation,
new paths can coexist with legacy files; this PR does not retire those old files.
An identical source/page identity and unchanged readable label yield the same path
across body edits. Renaming a source path or changing a derived comparison key can
change the readable filename or identity; filenames are not globally invariant
under those changes.

The existing emitter derives candidates from workspace/path/body. Newly named or
changed pages can therefore create new candidate identities even though that
algorithm is unchanged. Do not present this as automatic downstream supersession
or lineage repair. Governed lineage and migration remain in `l13.6`; existing
legacy outputs require a separately reviewed continuity plan before live rebuilds.

Rollback is a normal source revert before deployment. A revert does not remove
outputs from an explicit compilation already performed; preserve those receipts
and plan any retirement separately. No history rewrite or bulk cleanup is part
of this implementation.

## Verification contract

Real temporary workspaces and databases exercise same-basename summaries,
`A+B` versus `AB` outputs, `C++`/`C#`/`C` comparison, stable reruns, conflicting
file/database ownership and cross-kind ID refusal. Refusal checks inspect files,
database records and receipt sidecars. Link/orphan controls cover suffixed paths,
operator titles, exact targets and ambiguous aliases; lint controls cover known
collisions, ordinary reruns and ambiguous legacy rows.

The PR must identify actual scoped and full owning-gate results and configured
reviews. Test source is not execution evidence, and local fixtures do not establish
live migration, release readiness, deployment or production acceptance.
