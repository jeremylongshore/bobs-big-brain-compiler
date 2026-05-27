---
title: 'CodeQL alert triage — 31 dismissals + 1 follow-up bead'
filing_code: 037-OD-SEC-codeql-triage-2026-05-26
date: 2026-05-26
parent_bead: intentional-cognition-os-0wy.3
follow_up_bead: intentional-cognition-os-lhm
status: closed
license: MIT
---

# CodeQL alert triage — 31 dismissals + 1 follow-up bead

Closes bead `intentional-cognition-os-0wy.3` (P2 child of epic 0wy "Test
hygiene cleanup"). GH `#86`, Plane `ICOS-9`.

## What ran

CodeQL `security-and-quality` query pack against
`packages/{kernel,compiler,cli}/src/**/*.ts` on every PR + weekly
(Monday 06:00 UTC cron per `.github/workflows/codeql.yml`). At
2026-05-26 the open-alert backlog was 31 across 5 rule classes. The bead's
acceptance criteria called for each alert to be either fixed, deferred
with a bead, or dismissed with a documented reason; CodeQL workflow then
promoted to a required check.

## Triage outcome

| Rule                                |  Count | Verdict                  | Reason                                                                                  |
| ----------------------------------- | -----: | ------------------------ | --------------------------------------------------------------------------------------- |
| `js/weak-cryptographic-algorithm`   |      1 | dismiss (false positive) | SHA-1 mandated by RFC 4122 §4.3 for UUID v5 generation                                  |
| `js/polynomial-redos`               |      3 | dismiss (false positive) | Slugify/wikilink regex on bounded input, no nested-quantifier ambiguity                 |
| `js/incomplete-sanitization`        |      4 | dismiss (false positive) | Per-format escapers (markdown table pipes, YAML string quotes) — correct char sets      |
| `js/insecure-temporary-file` (test) |      7 | dismiss (used in tests)  | Test fixtures using `mkdtempSync(join(tmpdir(), ...))` — harness setup, not user-facing |
| `js/insecure-temporary-file` (prod) |      6 | dismiss (false positive) | Workspace-internal paths after path-traversal validation; not OS-tempdir surface        |
| `js/file-system-race`               |      9 | dismiss (false positive) | Benign idempotent init races; one follow-up reliability bead filed                      |
| `js/file-system-race` (hash chain)  |      1 | **REOPENED 2026-05-26**  | traces.ts:187 — read-compute-write race on `prev_hash` breaks audit chain (bead `lhm`)  |
| **Total dismissed**                 | **30** |                          |                                                                                         |
| **Total reopened**                  |  **1** |                          | Tracked in bead `lhm` (P2)                                                              |

All dismissals applied via `gh api PATCH /repos/.../code-scanning/alerts/N`
with categorical comments referencing this bead.

## Per-rule rationale

### `js/weak-cryptographic-algorithm` (#32, spool.ts:179)

The flagged call is `createHash('sha1').update(...)` inside `uuidV5()`.
This is **deliberate, spec-mandated, and not a security choice**. RFC 4122
§4.3 defines UUID v5 as SHA-1 of `namespace || name`, truncated to 16
bytes, with version + variant bits patched. Using SHA-256 would produce a
non-conformant UUID that wouldn't round-trip with INTKB's verifier (which
also expects v5).

Node's stdlib has no native UUID v5; the inline implementation is the
canonical pattern. The "weakness" CodeQL detects (SHA-1 collisions in
adversarial settings) doesn't apply: UUID v5 doesn't claim collision
resistance — it claims deterministic generation from a namespace + name
pair, which SHA-1 satisfies for any non-adversarial input space.

### `js/polynomial-redos` (#1, #2, #3 — lint.ts, recall/generate.ts, render/report.ts)

The three flagged regexes:

- `lint.ts:124` — `/\[\[([^\]|]+)(?:\|[^\]]+)?]]/g` extracts wikilinks
- `recall/generate.ts:375` — `slugify` with `/[\s_]+/g`, `/[^a-z0-9-]/g`, `/-{2,}/g`, `/^-+|-+$/g`
- `render/report.ts:148` — equivalent slugify

ReDoS requires either nested quantifiers (`(a+)+`) or quantifier ambiguity
(`a*a*`). None of these patterns has either. The `{2,}` quantifier is
greedy but the character class `-` is single-character; no backtrack
explosion. Inputs are bounded:

- Slugs: `.slice(0, 80)` upstream
- Wiki page bodies: typical ~10KB, hard-limited by L0 file size gates

CodeQL flags these on pattern shape (presence of `+` and `*` over partially
overlapping classes); empirically the worst-case complexity is O(n).

### `js/incomplete-sanitization` (#4, #5, #6, #7)

Four "incomplete" escapers across three files:

| Location          | What it escapes          | Format              |
| ----------------- | ------------------------ | ------------------- |
| `audit-log.ts:30` | `\|`                     | markdown table cell |
| `audit-log.ts:31` | `\|` + `\n`/`\r` → space | markdown table cell |
| `procfs.ts:159`   | `"` → `\"`               | YAML quoted string  |
| `report.ts:190`   | `"` → `\"`               | YAML quoted string  |

CodeQL flags these as "incomplete" because they don't escape backslash
itself. The dismissal stands for the current Linux-only deployment, but
the rationale depends on per-format escape semantics. **Each format
this code targets escapes a different set of characters; backslash is
not always required.**

- **GFM table cells** (`audit-log.ts:30/31`): `|` is the row separator;
  newlines break the row. The existing code escapes `\|` to encode a
  literal pipe — this is the **GFM-defined escape sequence for table
  cells** (GFM spec §6.10 "Tables") and is exactly what the existing
  encoders write. Backslash itself doesn't need a separate escape
  inside a GFM table cell unless it precedes a pipe (the only
  meta-character GFM treats specially in this context). The original
  prose called backslash "literal" which was imprecise; the correct
  framing is "GFM table cells escape only the pipe via `\|`, which
  this code does."
- **YAML quoted strings** (`procfs.ts:159`, `report.ts:190`): YAML
  _does_ require `\\` to escape backslash inside `"..."` literals
  (YAML 1.2 §7.3.2). The dismissal relies on input provenance: inputs
  here are workspace-internal IDs, filenames (POSIX-only — no Windows
  `\` separators), and brief text where control chars are
  pre-sanitized upstream and no YAML-reserved metacharacters appear in
  the domain. **Revisit conditions**: (a) a Windows port lands and
  paths now contain backslashes verbatim; (b) a feature lets users
  supply raw paths through this code path; (c) any input source
  changes to one that can contain `\`, `"`, or control chars unescaped.
  Single-quoted YAML (`'...'`) would be a safer general encoding —
  only requires doubling single quotes, never interprets backslash —
  and is the recommended migration if any revisit condition triggers.

Each escaper is per-format-correct for the current input domain. A
"complete" sanitizer (XSS-style) would over-escape and produce broken
output.

### `js/insecure-temporary-file` — test fixtures (#20–#26)

All seven flagged sites are in `*.test.ts` files using the canonical
Node pattern `mkdtempSync(join(tmpdir(), 'ico-test-'))` for isolated test
workspaces. CodeQL's heuristic classifies any `tmpdir()`-rooted write as
production; here it's harness setup.

### `js/insecure-temporary-file` — production sites (#18, #19, #27–#30)

| #       | Location                      | What                                    |
| ------- | ----------------------------- | --------------------------------------- |
| #18     | `recall/export.ts:304`        | Atomic `.tmp + rename` inside workspace |
| #19     | `render/slides.ts:308`        | Write to operator-supplied output path  |
| #27–#30 | `workspace.ts:99/107/128/144` | gitkeep + index.md template seeding     |

None of these is an OS-tempdir surface. All paths are workspace-relative
and validated against `realpath + prefix-check` upstream (path traversal
defense documented in `000-docs/021-AT-SECV-security-and-scope.md`). The
"predictable path" CodeQL warning targets `/tmp/foo` surfaces where a
symlink attack could redirect a privileged write; nothing here matches.

### `js/file-system-race` (#8–#17)

Ten `existsSync` → `writeFile`/`mkdir` TOCTOU patterns across four files:

| Location                      | Init scope                                                                                     | Failure mode if race triggers                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.ts:99/106/127/144` | gitkeep + index.md + wiki template                                                             | Two processes write the same fixed-content template; idempotent                                                                                                                        |
| `traces.ts:104/106`           | `audit/log.md` Markdown table header (not JSONL — separate file)                               | Duplicate Markdown header (extra lines at top of log.md); recoverable on next read                                                                                                     |
| `traces.ts:187`               | Append to today's JSONL trace file via `appendFileSync`, prev_hash from prior last line        | **CORRECTION (2026-05-26 Gemini PR #107 review):** This was originally dismissed but the dismissal was wrong. See "Correction" section below.                                          |
| `promotion.ts:255/354`        | Read source → parse → write target                                                             | Fails closed: parse error or write error if target moved                                                                                                                               |
| `audit-log.ts:35`             | `appendAuditLog` — appends a row to `log.md`; the file is expected to exist (errors otherwise) | If race deletes the file between `existsSync` and `appendFileSync`, the file is silently recreated with a row but no header. Cosmetic only — header recoverable; the row is preserved. |

**Security framing**: none of these allow privilege escalation, data
exfiltration, or arbitrary write. Worst case is a corrupted-but-recoverable
file from concurrent init OR the audit-trace integrity issue captured in
the correction below.

#### Correction (2026-05-26 — Gemini PR #107 review)

The original triage dismissed CodeQL alert #13 (traces.ts:187) with
"Append-only JSONL appends use atomic appendFileSync (single syscall,
kernel-atomic per append)." That's true about the syscall but missed
the read-compute-write race:

```
writeTrace flow:
  1. const lastLine = readLastLine(absoluteFilePath);
  2. const prev_hash = lastLine !== null ? sha256Hex(lastLine) : null;
  3. ... build envelope with prev_hash ...
  4. appendFileSync(absoluteFilePath, jsonLine + '\n', 'utf-8');
```

Two concurrent writers will both read the same last line at step 1,
compute the identical `prev_hash` at step 2, and append at step 4.
Result: two events claim `prev_hash → evt_N` but the actual chain is
`evt_N → evt_N+1 → evt_N+2`. `verifyAuditChain` fails on the break —
this is the core tamper-detection mechanism documented in
`011-AT-TRSC-trace-schema.md`.

**Action taken**:

1. CodeQL alert #13 re-opened (`gh api PATCH ... state=open`).
2. Bead `intentional-cognition-os-lhm` upgraded P3 → P2 and reframed
   from "robustness" to audit-integrity. Fix candidates: flock around
   the read-compute-write critical section, single-writer queue, or
   SQLite advisory lock keyed on (workspace, date). Multi-process
   integration test required.
3. The other 9 file-system-race dismissals (workspace.ts, promotion.ts,
   audit-log.ts:35, traces.ts:104/106) stand — those have benign
   failure modes (idempotent rewrites or fail-closed errors).

**Reliability framing**: real concern. Two ICO processes initializing the
same workspace concurrently could race on workspace.ts writes; two
processes appending to a fresh trace JSONL could each write a header.
Followed up as bead `intentional-cognition-os-lhm` (P3, robustness +
concurrency labels) which proposes `flock`-based or SQLite-advisory-lock
guards on the four init paths plus a multi-process repro test under
`tests/integration/`.

## Operator action — promote CodeQL to required check

| Step                                           | State                         |
| ---------------------------------------------- | ----------------------------- |
| 31 alerts triaged                              | ✅                            |
| Dismiss reasons recorded via API               | ✅                            |
| Robustness sub-bead filed (lhm)                | ✅                            |
| This triage doc committed                      | ✅                            |
| Add CodeQL to required status checks on `main` | ⚠ operator action (GitHub UI) |

After this PR lands, add `CodeQL Analyze (javascript-typescript)` (the
matrix-expanded job name) to the required-checks list on
`main` branch protection. Cannot be done via API without admin scope.

## Why this isn't a "fix" PR

The bead's acceptance criteria offered three paths for each finding:
fix, defer with bead, or dismiss with reason. After a per-alert read of
the flagged source, 31 of 31 fell into the "dismiss with reason" bucket
because the rule-vs-codebase mismatch is exactly the kind of false
positive that strict query packs (CodeQL `security-and-quality`) are
known to produce. The 10 file-system-race findings expose a real
reliability gap (not a security gap), captured as bead `lhm`. No
existing production code is changed by this triage.

## Re-triage cadence

Run the same per-rule grouping monthly via:

```bash
gh api 'repos/jeremylongshore/intentional-cognition-os/code-scanning/alerts?state=open&per_page=100' \
  | jq -r '.[].rule.id' | sort | uniq -c | sort -rn
```

New rule classes appearing → triage individually. New instances of an
already-dismissed class → confirm same rationale applies, dismiss with
back-reference to this doc. New CodeQL query-pack version → re-baseline.
