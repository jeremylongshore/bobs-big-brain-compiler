# Status: intentional-cognition-os

> Compile knowledge for the machine. Distill understanding for the human.

**Last Updated:** 2026-05-16
**Release:** v0.15.1
**Phase:** 4 — Hardening + v1.0 (Epic 10 in progress)

---

## Executive Summary

The system is feature-complete for Phase 1 (local-first MVP). Epics 1–9 shipped between 2026-04 and 2026-05; the system now ingests sources, compiles a semantic wiki, runs grounded Q&A with citations, drives multi-agent research, renders durable artifacts, generates flashcards/quizzes with retention scoring, and executes YAML eval specs. Epic 10 (hardening + release gate) is **5 of 12 beads** shipped at the time of writing; remaining work is documented below.

Every meaningful mutation emits a trace event into an append-only JSONL chain (SHA-256 prev-hash links). Every public kernel/compiler API returns `Result<T,Error>` rather than throwing. File writes use the `.tmp + rename` atomic pattern — verified by the disk-failure simulation test (E10-B05).

The CLI publishes as **`intentional-cognition-os`** on npm (workspace renamed in E10-B10); the verification script `scripts/verify-npm-pack.sh` confirms the tarball is shippable.

---

## Capabilities (operator-visible surface)

| Command | What it does | Trace events emitted |
|---|---|---|
| `ico init <name>` | Create workspace (`wiki/`, `tasks/`, `outputs/`, `recall/`, `audit/`, `.ico/state.db`) | audit-log only (`workspace.init`) |
| `ico mount add\|list\|remove` | Manage corpus mount points | `mount.add` / `mount.remove` in audit log |
| `ico ingest <path>` | Ingest PDF, Markdown, web-clip into L1 raw corpus | `ingest` |
| `ico compile sources\|topics\|all` | Six compiler passes: summarize → extract → synthesize → link → contradict → gap | `compilation.start` / `compilation.complete` per pass |
| `ico ask "<question>"` | Retrieval-augmented Q&A with inline citations | `ask.start` / `ask.complete` |
| `ico research "<brief>"` | Collector → Summarizer → Skeptic → Integrator → render | `task.created` + per-stage orchestrator + agent traces |
| `ico research archive <id>` | Archive a completed research task | `task.archived` |
| `ico render report\|slides` | Render L4 artifacts | `render.start` / `render.complete` |
| `ico promote / unpromote` | L4 ↔ L2 promotion | `promotion` |
| `ico lint` | Schema / staleness / uncompiled / orphan checks | `lint.run` / `lint.result` |
| `ico recall generate --topic <name>` | Generate flashcards + quiz from compiled wiki | `recall.generate` |
| `ico recall quiz [--answers-file]` | Interactive (or scripted) quiz with Claude scoring | `recall.quiz` / `recall.result` |
| `ico recall weak [--report]` | Lowest-retention concepts + optional full report | — (read-only) |
| `ico recall export --format anki [--out]` | Anki-importable TSV | — (read-only) |
| `ico eval run [--spec <path>]` | YAML eval specs from `evals/` (retrieval + smoke handlers) | `eval.run` / `eval.result` |
| `ico status` | Workspace summary | — (read-only) |
| `ico inspect <subcommand>` | Subsystem inspector | — (read-only) |

**Coverage matrix and the per-command audit decision** (which read-only commands deliberately don't trace) live in `023-OD-AUDIT-trace-coverage-2026-05-15.md`.

---

## Real metrics (as of 2026-05-16)

### Test suite

```
types     2 files,   13 tests
kernel   23 files,  287 tests
compiler 35 files,  446 tests
cli      22 files,  361 tests
─────────────────────────────
total    82 files, 1107 tests   · all passing
```

Full sweep (`pnpm build && pnpm lint && pnpm typecheck && pnpm test`) takes ~110 s on a moderate dev box.

### Coverage (run via `pnpm test:coverage`)

| Package | Stmts | Branches | Funcs | Lines | E10-B09 Target | Gap |
|---|---:|---:|---:|---:|---:|---:|
| `types/src` | 60.0% | 100.0% | 100% | 60.0% | 100% | The 60% is index.ts re-exports being undercounted; functional coverage is effectively 100%. Address via vitest config tweak in B09. |
| `kernel/src` | **83.2%** | 63.3% | 91.1% | 84.5% | **90%** | ~7pt short. Hotspots: `evals/` (already 86%), `procfs.ts`, `unpromote.ts` branch coverage |
| `compiler/src` | **82.3%** | 63.3% | 100% | 83.3% | **80%** | ✅ above target |
| `cli/src` | **55.9%** | 57.1% | 20.0% | 57.6% | **70%** | ~14pt short. Hotspots: `ask.ts` (0.8% — only Commander wiring tested), `compile.ts` (1.4%), `research.ts` (45%). These rely on a real Claude key for end-to-end; need integration tests that mock at the `ClaudeClient` boundary. |
| **All files** | **77.6%** | **63.0%** | **86.4%** | **79.1%** | — | E10-B09 closes the gap |

### Release history

| Version | Date | Highlight |
|---|---|---|
| v0.15.1 | 2026-05-14 | E9-B12 recall pipeline integration tests — Epic 9 closed |
| v0.15.0 | 2026-05-14 | E9-B11 recall export (Anki TSV) |
| v0.14.0 | 2026-05-14 | E9-B10 retention scoring + `ico recall weak` |
| v0.13.0 | 2026-05-14 | E9-B09 quiz runner + `recall_results` table |
| v0.12.1 | 2026-05-14 | Sweep: dependabot disabled, gitignore .arch/ + beads export |
| v0.12.0 | 2026-05-14 | E9-B08 recall card generator |
| v0.11.x | 2026-05-13/14 | Releases + E9-B07 archival + audit-harness v0.1.0 vendored |
| v0.10.0 | 2026-05-12 | E9-B06 orchestrator |
| v0.9.x | 2026-05 | E9-B01–B05 research pipeline beads |
| v0.8.x | 2026-04 | Epics 7–8 (ask + render + promote) |
| v0.7.x and earlier | 2026-04 | Epics 2–6 (kernel, CLI surface, ingest, compiler) |
| v0.1.3 | 2026-04-06 | Standards Freeze — Epic 1 (docs-only) |

### CI / quality gates

- **CI** (`.github/workflows/ci.yml`): lint, typecheck, test, OSV security scan on every push and PR. Status: green.
- **Release** (`.github/workflows/release.yml`): auto-versions from conventional commits, generates CHANGELOG, cuts GitHub Release. Active.
- **Gemini PR Review**: standalone workflow removed; now runs via the GitHub-native Gemini app (per `e4cab5d`).
- **Audit harness**: `@intentsolutions/audit-harness@0.1.0` vendored at `.audit-harness/`; verify hashes via `scripts/audit-harness verify`. Per the Intent Solutions Testing SOP.

### Beads ledger

```
137 issues total · 125 closed · 11 open · 1 in_progress · 9 ready · 2 blocked
```

Open beads (P0–P1):

| ID | Bead | Priority |
|---|---|---|
| `2rd` | Epic 10 (parent) | P0 |
| `2rd.2` | E10-B02 Compilation Quality Evals | P1 |
| `2rd.3` | E10-B03 Retrieval + Citation Evals | P1 |
| `2rd.6` | E10-B06 Performance Profiling | P1 |
| `2rd.9` | E10-B09 Test Coverage Gap Closure | P1 |
| `2rd.11` | E10-B11 v1.0 Release Gate | P0 (blocks v1) |
| `2rd.12` | E10-B12 v1.0 Release Cut | P0 (blocks v1) |

P2/P3 deferrals: TypeScript 6.x migration, Zod 4.x migration, two re-opened Epic 9 beads marked open in the index but already merged on main (state cleanup pending).

---

## Architecture (steady state)

Six-layer cognition stack with a strict deterministic / probabilistic boundary:

| Layer | Path | Owner |
|---|---|---|
| L1 Raw Corpus | `workspace/raw/` | Kernel (append-only) |
| L2 Semantic Knowledge | `workspace/wiki/` | Compiler passes (recompilable) |
| L3 Episodic Tasks | `workspace/tasks/<id>/` | Compiler agents (Collector → Summarizer → Skeptic → Integrator) |
| L4 Artifacts | `workspace/outputs/` | Render pipeline (promotable to L2) |
| L5 Recall | `workspace/recall/` | Compiler recall module |
| L6 Audit & Policy | `workspace/audit/` | Kernel (append-only, hash-chained) |

**The most important constraint** (per blueprint §4.3) — *the model proposes; the deterministic kernel decides*:

- **Deterministic** (Kernel + SQLite + JSONL): file storage, mount registry, task state, provenance, policy, permissions, audit, promotion rules, eval execution, recall results, retention scoring.
- **Probabilistic** (Compiler + Claude API): summarization, synthesis, concept extraction, contradiction detection, question decomposition, artifact drafting, recall generation, quiz scoring.

The model never directly writes to audit, policy, or promotion tables. Compiler-side functions return `Result<T, Error>` to the kernel; the kernel decides what lands on disk.

---

## Decision log (highlights since standards freeze)

The full decision history lives in `IDEA-CHANGELOG.md`. Selected v1-relevant calls:

- **2026-04-15** — `pnpm audit` retired by npm; switched CI security scan to `google/osv-scanner-action`. Documented in CLAUDE.md (do not reintroduce `pnpm audit`).
- **2026-04-30** — `claude_agent_sdk` dropped in favor of hand-rolling agents on the `ClaudeClient` interface. Kept agents `Result`-typed, deterministically testable with `vi.fn()` mocks, and consistent with existing compiler passes. Applies to all E9 agents and the recall quiz runner.
- **2026-05-02** — SOPS dotenv eval-leak hazard documented (`sops-dotenv-eval-leak-2026-05-02`). Use anchored sed regex when sourcing SOPS-decrypted env.
- **2026-05-14** — Dependabot disabled (`#51`). 10 stale auto-PRs closed. Manual bumps + `/sync-testing-harness` cover the gap; the noise wasn't earning its keep.
- **2026-05-14** — CLI workspace renamed `@ico/cli` → `intentional-cognition-os` for npm publish (E10-B10). Nothing internal depended on the old name.
- **2026-05-15** — Read-only commands (`status`, `inspect`, `recall weak`, `recall export`) deliberately don't emit traces. Documented in `023-OD-AUDIT-trace-coverage-2026-05-15.md` so future contributors don't add traces for the sake of it.
- **2026-05-15** — `friendlyError()` lib in CLI maps Node fs errno + SQLite + Claude API category errors to operator-facing messages. Top-level `installProcessHandlers()` routes uncaught exceptions, unhandled rejections, and SIGINT through it.

---

## Risk assessment (v1.0 readiness)

| Risk | Severity | Mitigation | Status |
|---|---|---|---|
| `cli/src` coverage at 55.9% vs 70% target | Medium | E10-B09 closes ask/compile/research gaps with `ClaudeClient`-boundary mocks | Open (B09) |
| `kernel/src` coverage at 83.2% vs 90% target | Medium | E10-B09 fills branch coverage on `procfs`, `unpromote`, eval handlers | Open (B09) |
| No compilation-quality or retrieval evals yet | Medium | E10-B02 + E10-B03 add suites on top of B01's framework | Open (B02, B03) |
| No perf benchmarks against documented targets | Medium | E10-B06 — 500+ source corpus generator, benchmark recorder | Open (B06) |
| Mount commands don't emit trace events (only audit-log entries) | Low | `mount` event types not yet in `011-AT-TRSC` §6. Audit log suffices; spec amendment is a doc-only follow-up | Documented (`023-OD-AUDIT`) |
| Workspace.init / unpromote events not enumerated in trace spec §6 | Low | Code emits them; spec drift only. Patch §6 doc | Documented |
| Eval batch correlation_id absent | Low | Each spec has its own correlation_id; batch grouping is a B11 nice-to-have | Documented |
| Performance under 500+ source corpus untested | Medium | Until B06 runs, the documented targets (ingest <2s, compile topic <30s, ask <10s, render <5s, lint <30s) are aspirational | Open (B06) |
| TypeScript 6.x / Zod 4.x migrations open | Low | P3 deferrals — non-blocking for v1.0 | Open |
| User journey walkthrough not yet exercised end-to-end | High | E10-B11 verification step: walkthrough from `init` to `recall export` against a real Claude key | Open (B11) |

The single highest-risk gap is **B11's user-journey walkthrough**. Everything else is either covered, documented, or a known deferral. v1.0 should not be cut until the walkthrough succeeds against a real workspace and a real Claude key.

---

## Path to v1.0

```
B02 ─┐
B03 ─┤
B06 ─┼─→ B11 (release gate) ─→ B12 (cut v1.0.0)
B09 ─┘
```

B11 verifies every other Epic 10 bead delivered what it promised. B12 is the version bump + tag + npm publish. Total remaining work: 6 beads.

Estimated effort (operator hours, no padding): B02 ~4h, B03 ~4h, B06 ~6h, B09 ~6h, B11 ~3h, B12 ~1h → **~24 hours of focused work to v1.0.0**.

---

## What is NOT in scope for v1.0

Per the blueprint Phase 2/3 boundaries, the following are explicitly deferred:

- Remote / cloud features (sync server, multi-device workspace) — Phase 3
- Multi-user collaboration / permissions — Phase 4
- Plugin system — Phase 5
- Vector search — deferred per blueprint §3.6 in favor of FTS5 + compilation
- Web UI — Phase 3+
- Claude tool-use / function-calling integration — out of scope; the agent loop is currently the higher-level abstraction

These are not gaps. They are explicit non-goals for the local-first MVP.

---

## Learning stance

The system improves over time at three layers (blueprint §5.6):

| Layer | What | When |
|---|---|---|
| **Schema / config** | Frozen standards docs (008–021), trace schema §6 | Updated only via explicit IDEA-CHANGELOG entry; protected by review |
| **Context refinement** | Operator reads trace JSONL, identifies prompt/ingest patterns producing weak outputs, refines | Per-session — see CLAUDE.md "Trace-based context refinement" |
| **Retention loop** | `recall_results` rows + retention aggregator surface weak concepts; future generation re-targets them | Per-quiz — `ico recall weak --report` |

The substrate is the append-only trace chain. Tampering is detectable (SHA-256 prev_hash); the `audit-chain-intact` smoke eval walks it on every `ico eval run`.
