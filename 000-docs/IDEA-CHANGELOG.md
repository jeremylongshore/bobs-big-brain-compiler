# Idea Changelog

All notable idea and architecture changes for the Intentional Cognition OS master blueprint will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version numbers follow the blueprint version, not the software release.

## [Unreleased]

### Added

- **Ecosystem thesis paper** (2026-05-23). `000-docs/034-AT-NTRP-ecosystem-thesis.md` — peer-reviewed, Semantic-Scholar-grounded paper "Compile, Then Govern: A Two-Layer Local-First Architecture for Team Institutional Memory." Working hypothesis: ICO + INTKB are a downstream-coupled local-first knowledge stack that becomes industry-defining when teams adopt "compile then govern" as the standard for institutional memory; the compilation/governance split is the new abstraction; everything else (search, retrieval, presentation) is pluggable. Authored via the `/academic-pipeline` discipline; reviewed by `fact-checker` and `article-consistency-checker` subagents prior to land. 6,156 words, 9 grounded external citations (Sumers et al. 2023 / Park et al. 2023 / Packer et al. 2023 / Lewis et al. 2020 / Bai et al. 2022 / Zou et al. 2025 / Chang & Geng 2025 / Karpicke & Roediger 2007 / Astorga-Vargas et al. 2017). Byte-identical copy lands in `qmd-team-intent-kb/000-docs/034-AT-NTRP-ecosystem-thesis.md`. Cross-repo epic `intentional-cognition-os-ziz` ↔ `qmd-team-intent-kb-oaa`. Phase 5 of the plan convenes the executive council on this paper's findings; the resulting Decision Record will be filed as `035-AT-DECR-post-thesis-build-direction-2026-05-23.md` in both repos.

### Changed

- **Bead naming convention shifted to plain English** (2026-05-22). The `E{N}-B{NN}` title prefix from 014-OD-BEAD v1.0.0 and the `epic:N` / `type:X` label conventions are retired for all new beads. Titles are full sentences describing the work; labels are 1–3 plain-English topic words; parent epics are full sentences naming the cluster. The six v0.2-era beads with autogen-only titles (`er2`, `ytq`, `7xp`, `p6w`, `nwh`, `x5r`) were retitled or superseded as part of bringing the convention into force. 014-OD-BEAD remains historically valid for the original ~133 beads. Canonical write-up: [033-OD-BEAD-conventions-post-v1-addendum.md](033-OD-BEAD-conventions-post-v1-addendum.md). Global mirror in `~/.claude/CLAUDE.md` § "Bead naming — plain English only".

## [Standards Freeze v1] — 2026-04-06

### Added

- **Standards Freeze v1** — Epic 1 (Canonical Design Pack) complete. 14 standards documents frozen for Phase 1 (docs 008–021). All cross-references verified. CLAUDE.md updated with Standards Reference section. Any changes to frozen standards require an entry in this changelog and review of all dependent documents.

### Standards Documents Delivered

- 008-AT-GLOS: Canonical Glossary and Terminology Lock
- 009-AT-FMSC: Frontmatter Schemas for All 7 Compiled Page Types
- 010-AT-DBSC: SQLite Schema with Full DDL and Migration Strategy
- 011-AT-TRSC: JSONL Trace Event Schema and Envelope Format
- 012-AT-WPOL: Workspace Directory Policy
- 013-AT-CODE: TypeScript Coding Standards and Package Conventions
- 014-OD-BEAD: Bead Workflow and Epic Execution Conventions
- 015-AT-TEST: Testing Strategy and Fixture Workspace Design
- 016-OD-CICD: CI/CD Pipeline Upgrade Specification
- 017-AT-PRMP: Prompt Template Standards for Compiler Passes
- 018-AT-PROM: Promotion Rules and Policy Enforcement Specification
- 019-OD-TMPL: ADR and AAR Templates
- 020-AT-DIAG: Architecture Diagram Prompt Pack
- 021-AT-SECV: v1 Scope Constraints and Security Standards

---

### Added

- **Competitive landscape research** — Validated ICO thesis against 2026 market: Karpathy's "LLM Knowledge Bases" confirms compilation category, "deterministic core + agentic shell" is industry consensus, RAG fatigue drives market toward compilation, EU/CA/CO AI Acts (mid-2026) require audit trails (ICO's L6 is a moat). Competitive matrix shows ICO is the only project with all 8 differentiators (compilation, semantic FS, deterministic control, provenance, multi-agent research, recall, CLI-first, local-first) across Karpathy, qmd, Onyx, Mem0, and Fabric.
- **qmd integration candidate** — qmd v2.1.0 (April 5, 2026; 18.2K stars) identified as preferred retrieval upgrade path for E7. Hybrid search (BM25 + vector + reranking), fully local, already has MCP server. Six reusable patterns noted: Zod schema as dependency root, `Result<T,E>` error pattern, repository classes over better-sqlite3, policy pipeline (short-circuit on failure), lifecycle state machine with typed transitions, `createTestDatabase()` for in-memory testing.
- **7 future scenario analyses** — Strategic guidance for: (1) Karpathy open-sourcing his KB (70% Q2-Q3 2026 — positioning pivot to governance), (2) Claude native persistent memory (40% Q3 2026 — ICO is compiled knowledge, not session memory), (3) MCP as universal agent protocol (80%, already happening — kernel API must be MCP-wrappable), (4) vector search becomes mandatory (50% — adapter pattern in E7-B01), (5) AI provenance legally required (90% by Q4 2026 — L6 traces are legal compliance, not debugging), (6) knowledge compiler category gets crowded (30% 2027 — moat is deterministic kernel + provenance chain), (7) model costs drop 10x (60% Q4 2026 — shift from incremental to full recompilation).
- **8 strategic bead annotations** — Competitive and scenario-derived notes attached to E1-B03 (trace compliance), E1-B04 (Obsidian compat), E1-B15 (MCP + positioning), E3-B11 (MCP-wrappable API), E6-B01 (token-efficient calling), E6-B09 (full recompile mode), E7-B01 (search adapter pattern + qmd), E10-B04 (compliance gate).

### Decision Notes

- ICO's moat ordering: (1) deterministic control plane (hardest to replicate), (2) provenance chain (painful to retrofit), (3) multi-agent research (complex orchestration), (4) recall/retention (nobody else is thinking about this). Compilation itself is reproducible and NOT the moat.
- Positioning strategy if Karpathy releases: "Karpathy's tool compiles knowledge. ICO governs it." Ship E1-E6 before he releases to be the production-grade version.
- MCP integration is a v1.1 deliverable, not v1. But the v1 kernel API (E3-B11) must be clean enough to wrap without modification. This is a design constraint on v1, not new scope.
- Search adapter pattern in E7-B01 is the key architectural decision for extensibility. FTS5 ships as default (zero dependencies). qmd is the upgrade path (proven at 18.2K stars). The interface is the contract, not the implementation.
- EU AI Act enforcement (August 2026) makes E10-B04 (trace audit) a compliance gate equivalent to the release gate (E10-B11). This is not a quality nice-to-have.

- **10-epic execution plan** — 114 beads decomposed across 10 epics covering the full project from current repo state (zero application code) to v1 trajectory. Epic reference docs created under `000-docs/epics/`. Beads registered in repo-local Beads system with parent-child hierarchy, dependencies, priorities, and labels. Execution plan summary at `000-docs/EXECUTION-PLAN-10-EPICS.md`.
- **Epic reference docs** — `000-docs/epics/epic-{01..10}.md`, each containing objective, scope, bead list with dependencies and verification criteria, exit criteria, and risks/watch items.
- **3 additional Epic 1 beads** — Canonical Glossary (E1-B00), ADR/AAR Templates (E1-B13), Architecture Diagram Prompt Pack (E1-B14). Brings Epic 1 from 12 to 15 beads and total from 111 to 114.
- **Package structure decision** — Adopted `packages/` prefix for pnpm workspace convention (packages/kernel, packages/cli, packages/compiler, packages/types) over root-level directories.
- **6-auditor plan review** — Architecture, security, risk/dependency, test strategy, product management, and doc consistency audits across all 10 epics. 53 findings (8 critical, 14 high, 19 medium, 12 low) all addressed. 3 new beads added (E1-B15 security+scope, E4-B11 trace inspection, E8-B11 unpromote). ~75 cross-epic bead dependencies wired. Security hardening woven into existing beads. Total beads: 114 → 117.
- **Entity page compiler pass** — Entity extraction added to E6-B03 (Extract pass) scope. Blueprint lists entity as a compiled page type but had no compiler pass producing it.
- **Task lifecycle expanded** — 7 states (created, collecting, synthesizing, critiquing, rendering, completed, archived) reconciled across blueprint, tech spec, and E3-B07.
- **Builder agent role absorbed** — Blueprint Section 8.2 defines 5 agent roles. Epic 9 implements 4 (Collector, Summarizer, Skeptic, Integrator). Builder role fulfilled by piping Integrator output through E8 render pipeline.

### Decision Notes

- Epic 1 (Canonical Design Pack) is the recommended starting point. Every later epic references standards from Epic 1. Beads B00-B07, B13, B14 have no internal dependencies and can be parallelized.
- The critical path traces the core operating loop: schema → types → state → ingest → compile → search → ask → render → research → release. This is 11 beads deep across all 10 epics.
- The `packages/` directory structure was chosen over root-level `cli/`, `kernel/`, `compiler/` to follow standard pnpm workspace monorepo conventions. The tech spec's file structure section should be updated in Epic 1 or Epic 2 to match.

## [2.2.0] - 2026-04-05

### Added

- **Three-layer learning model** (Section 5.6) — Defines how the system improves over time at three layers: context (configurable knowledge and instructions), harness (runtime behavior), and model (foundation weights). Each layer has different cost, inspectability, and iteration velocity. This is an architectural principle, not a new subsystem.
- **Traces as learning substrate** — Made explicit that L6 traces are not just for debugging. They are the shared evidence base for context refinement, harness improvement, and any future model adaptation. Listed the relevant trace types that feed each learning layer.
- **Adjacent OSS pattern references** — Brief mention of LangGraph, Letta, Langfuse/Opik, Continue, OpenHands, and SOUL.md as ecosystem validation of the three-layer approach. Framed as reference points, not dependencies.

### Changed

- **Project learning stance made explicit** — v1-v2.1 implied the system could improve but never stated how or in what order. v2.2 commits: context learning is first-class now (Phases 1-4), harness learning is trace/eval-driven and deferred (Phase 3+), model adaptation is explicitly not near-term scope.
- **Governance framing extended** — The existing audit-first and schema-contract principles now connect to the learning model: context updates are governed by the schema contract, harness changes go through code review, model adaptation requires stable evidence, and the control plane is never a learning surface.

### Decision Notes

- Context was chosen as the primary learning layer because it is the cheapest, most inspectable, and fastest to iterate. This matches how the system is already designed — `CLAUDE.md`, frontmatter schemas, and the compiled wiki are all context that shapes agent behavior without code changes.
- The three-layer framing resolves a latent ambiguity: v2.1 said the system has traces and evals but didn't say what they were _for_ beyond debugging. Now the answer is explicit — they feed learning at all three layers, in order of increasing cost and decreasing frequency.
- The OSS references are deliberately brief. The blueprint should not read as dependent on any of these projects. They validate the architectural direction — durable execution, persistent memory, trace infrastructure, repo-native config, explicit context files — without implying integration.
- This section does not add new build scope to Phases 1-2. Context learning happens naturally through operator curation. Harness learning requires Phase 3+ trace accumulation before it becomes actionable.

## [2.1.0] - 2026-04-04

### Added

- **Schema & agent contract layer** (Section 5.4) — Promoted from implicit assumption to explicit architecture. The agent operates under a schema contract composed of `CLAUDE.md`, frontmatter conventions, file policies, lifecycle rules, and compilation schemas. The schema is versioned, linted, and evolves with the repo. This is an architectural layer, not documentation.
- **Operational control files** (Section 5.5) — Added `workspace/wiki/index.md` (compiled knowledge catalog, auto-rebuilt on compilation) and `workspace/audit/log.md` (chronological operation digest). These are plain markdown files for operator visibility — they complement structured audit traces, not replace them.
- **MVP operating assumptions** (Section 14.2) — Made scale and infrastructure assumptions explicit: tens to low hundreds of source documents, full-text search over compiled markdown, local filesystem + SQLite only, no vector database required. These hold through Phases 1-4.

### Changed

- **Ingest posture** — Changed from implicitly automatable to explicitly human-in-the-loop by default. Default ingest is source-by-source: operator selects, reviews summary output, approves compilation. Batch ingest exists as a later capability, not the primary mode. Reflected in operating loop table, new ingest-posture paragraph (Section 2), and MVP assumptions.
- **Obsidian role** — Clarified from "Obsidian-compatible output" to a deliberate posture: Obsidian is a preferred local inspection surface (graph view, backlinks, metadata querying are useful), but the architecture is frontend-agnostic and must not depend on Obsidian-specific behavior. Standard markdown with YAML frontmatter is the output contract.
- **Thesis paragraph** — Added sentence establishing that the agent operates under a schema contract, not freely.
- **"What This Is Not" section** — Updated Obsidian line to reflect the inspection-surface-not-dependency posture.
- **MVP scope** — Added schema conformance to lint checks, added `index.md` and `log.md` to deliverables, added "Batch ingest as default mode" to explicitly deferred list.
- **Workspace layout** — Added `wiki/index.md` and `audit/log.md` to the directory tree.

### Decision Notes

- The schema contract layer was always implicit in how the system was designed to work — `CLAUDE.md` governs agent behavior, frontmatter conventions govern page structure. V2.1 makes this explicit because it is load-bearing architecture, not optional decoration.
- `index.md` and `log.md` are deliberately plain markdown, not database views or generated dashboards. The operator should be able to `cat` them.
- Human-in-the-loop ingest is a quality decision, not a technical limitation. The system can batch-process, but the operator should not trust batch output until they have validated single-source output quality on their specific corpus.
- Obsidian remains the strongest local viewer for this kind of output. The clarification prevents architectural decisions from coupling to it (e.g., relying on Obsidian plugins for features that should be in the core system).

## [2.0.0] - 2026-04-02

### Added

- **Data classification taxonomy** — every piece of data in the system is now classified as exactly one of: canonical, compiled, ephemeral, durable, adaptive, or audit. V1 had layers but no explicit classification rules for what lives where and why.
- **Compiler passes defined** — the compiler is now specified as six named passes (Summarize, Extract, Synthesize, Link, Contradict, Gap) with defined inputs and outputs. V1 said "the system compiles" but never defined what compilation actually does.
- **Staleness model** — compiled pages are now explicitly stale when source hashes change, new matching sources arrive, or dependent pages are recompiled. V1 mentioned "linting" but had no staleness definition.
- **Compilation triggers** — each CLI command maps to specific compiler passes. V1 listed CLI commands but didn't connect them to compilation behavior.
- **Promotion rules** — seven explicit rules governing how outputs move from L4 back to L2, including the rule that automatic promotion is never allowed. V1 mentioned promotion repeatedly but never defined the rules.
- **Task lifecycle state machine** — research tasks now have a defined lifecycle: created → collecting → synthesizing → critiquing → rendering → completed → archived. V1 described multi-agent research but had no lifecycle model.
- **Recall feedback loop** — quiz results now update retention scores per concept, driving adaptive generation. V1 listed recall features but didn't specify how feedback flows back.

### Changed

- **Document structure** — reduced from 22 sections to 16 by merging redundant content. V1 had separate sections for core functions (Section 4), mental model (Section 7), UX flows (Section 8), and artifact philosophy (Section 12) that all described the same concepts. These are now consolidated.
- **Operating loop** — canonicalized as `ingest → compile → reason → render → refine` and stated once. V1 had three variant versions of the loop scattered across the document ("ingest → compile → reason → render → refine", "ingest → compile → reason → render → test → refine", and "ingest → compile → reason → render → test recall → refine → promote").
- **Terminology** — standardized throughout. "Semantic Knowledge Layer" is now the only name for L2 (V1 alternated between "compiled wiki", "semantic memory", and "semantic knowledge layer"). "Episodic Tasks" is the only name for L3 (V1 used "research workspaces", "task workspaces", and "episodic research" interchangeably).
- **Layer descriptions** — each layer now specifies storage location, mutability model, and data classification. V1 described layers with examples and responsibilities but not lifecycle behavior.
- **Deterministic/probabilistic boundary** — reframed from a philosophical principle to an architectural constraint with a concrete rule: "The model proposes content. The deterministic system owns state, provenance, policy, and lifecycle." V1 stated the principle but left it abstract.
- **Tech stack** — presented as a single table with rationale column instead of two separate "rough draft" sections (local vs remote). V1 hedged everything as "rough draft"; V2 commits to decisions for Phases 1-4 and explicitly defers remote-specific choices.
- **CLI section** — consolidated into a single command reference table. V1 had CLI examples scattered across Sections 4, 8, and 17.
- **Phase plan** — compressed from prose descriptions to a single table with phase name and scope. V1 had a separate section describing each phase in paragraph form that largely restated the PRD.

### Removed

- **Section 7: Mental Model** — "ICO is a hybrid of a filesystem, a compiler, a research environment..." This analogy list added nothing actionable. The thesis and architecture sections already communicate the product identity.
- **Section 8: User Experience Model** — the six "flows" (ingest, compile, ask, render, promote, refine) were a restatement of Section 4's five core functions with slightly more detail. The information now lives in the operating loop definition and the compiler/promotion/research sections.
- **Section 10: Machine vs Human Knowledge** — the distinction between machine-facing and human-facing knowledge is real but was underdeveloped as a standalone section. It is now integrated into the Recall Model (Section 9) where it has concrete implementation context.
- **Section 12: Artifact Philosophy** — "questions should add up" and "outputs should be file-based and inspectable" are true but restated what the architecture already specifies. Removed as standalone section; the L4 layer definition covers artifact behavior.
- **Section 13: Recall and Second-Brain Evolution** — speculative Phase 4+ content that was mostly aspirational. The concrete recall model in Section 9 replaces it.
- **"Rough draft" hedging throughout** — V1 labeled both architecture sections as "rough drafts" and used language like "should eventually support" and "could also use." V2 commits to decisions and explicitly defers what isn't decided yet.
- **Repeated loop statements** — V1 stated the operating loop in Sections 2, 4, 7, 8, 13, and 22. V2 states it once in Section 2 and references it.

### Fixed

- **Loop inconsistency** — V1 had three different versions of the operating loop. V2 canonicalizes it as five stages: ingest → compile → reason → render → refine. "Test" is part of refine (via `ico lint` and `ico recall`). "Promote" is part of refine (via `ico promote`).
- **Layer mutability ambiguity** — V1 didn't specify whether layers were append-only, mutable, or recompilable. V2 defines mutability for each layer: L1 and L6 are append-only, L2 is recompilable, L3 is ephemeral, L4 is permanent, L5 is adaptive.
- **Promotion without rules** — V1 mentioned promotion ~8 times without ever defining what it means or when it's appropriate. V2 defines seven explicit rules and three anti-patterns.
- **Compiler without passes** — V1 said "the system compiles" but never defined the compilation process. V2 specifies six named passes with inputs, outputs, and triggers.
- **Research tasks without lifecycle** — V1 described multi-agent research conceptually but had no state machine or completion criteria. V2 defines a task lifecycle with explicit transitions.
- **Terminology drift** — V1 used 2-3 names for each major concept. V2 enforces one canonical name per concept used consistently throughout.

## [1.0.0] - 2026-04-02

### Added

- Initial master blueprint with 22 sections
- Core thesis: "Compile knowledge for the machine. Distill understanding for the human."
- Six-layer architecture (Raw Corpus, Semantic Knowledge, Episodic Tasks, Artifacts, Recall, Audit & Policy)
- Deterministic vs probabilistic boundary concept
- Three product surfaces: local, remote, repo-native
- CLI shape with `ico` command vocabulary
- Workspace layout with layered directories
- Multi-agent research pattern with role-based agents
- Five-phase development plan
- "What this is not" guardrails
- MVP definition
- Local and remote architecture sketches

### Decision Notes

- Chose TypeScript + Node.js for Claude SDK compatibility and type safety
- Chose SQLite for local-first state with zero infrastructure
- Chose markdown-first retrieval over vector DB to keep early phases simple
- Chose "compiler" metaphor to distinguish from retrieval-only systems
- Chose `ico` as CLI name for brevity and product coherence
