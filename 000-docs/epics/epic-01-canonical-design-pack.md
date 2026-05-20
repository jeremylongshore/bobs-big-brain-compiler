# Epic 1: Canonical Design Pack, Standards, and Execution Templates

**Objective:** Lock the repo canon before implementation fans out. Every later epic references these artifacts for schema definitions, coding conventions, bead workflow, and quality standards.

**Why it exists:** Without frozen standards, parallel implementation sessions will produce inconsistent schemas, conventions, and quality levels. Epic 1 front-loads all design decisions so that Epics 2-10 can execute without revisiting foundational choices.

**What it unlocks:** All subsequent epics. Nothing proceeds until standards are frozen.

**Dependencies:** None (root epic)

**Phase:** 0.5 (pre-implementation)

---

## Scope

### Included

- Frontmatter schemas for all 7 compiled page types (including entity)
- SQLite schema with full DDL and migration strategy
- JSONL trace event schema and envelope format
- Workspace directory policy and naming conventions
- TypeScript coding standards and package conventions
- Bead workflow and epic execution conventions
- Testing strategy and fixture workspace design
- CI/CD pipeline upgrade specification
- Prompt template standards for all 6 compiler passes
- Promotion rules and policy enforcement specification
- CLAUDE.md update with implementation-ready conventions
- Exit review and standards freeze
- Canonical glossary and terminology lock
- ADR and AAR templates
- Architecture diagram prompt pack
- v1 scope constraints and feature deferrals
- Security standards (prompt injection, API key redaction, SQL injection, path traversal, symlinks)

### Excluded

- Actual TypeScript implementation (that's Epic 2+)
- Runtime code for any schema validator (Epic 2)
- CI/CD pipeline changes (Epic 2)

---

## Beads

### E1-B00: Canonical Glossary and Terminology Lock

- **Depends on:** Nothing
- **Produces:** `000-docs/008-AT-GLOS-glossary.md` — Extract all canonical terms from blueprint v2.2 into a single reference doc. Every term used in the system (Raw Corpus, Semantic Knowledge, Episodic Tasks, Compiled Page, Source Summary, Concept, Topic, Entity, Contradiction, Open Question, Mount, Provenance, Trace, Promotion, Staleness, etc.) gets a one-line definition and the section of the blueprint that defines it.
- **Verification:** Every term used in the blueprint has an entry. No synonyms remain — each concept has exactly one canonical name. Cross-referenced with blueprint Section 2 (terminology standardization from v2.0).

### E1-B01: Frontmatter Schema Definitions for All Compiled Page Types

- **Depends on:** E1-B00 (terminology must be locked first)
- **Produces:** `000-docs/009-AT-FMSC-frontmatter-schemas.md` — Exact YAML frontmatter schema for each of the SEVEN compiled page types: source-summary, concept, topic, entity, contradiction, open-question, plus the entity frontmatter schema (audit C4). Each schema specifies required fields, optional fields, field types, and valid values. Uses Zod-compatible type notation.
- **Verification:** Each schema has at least one complete example document. No ambiguity in required vs optional fields. Schemas cover every field referenced in the blueprint. Entity page type has its own dedicated frontmatter schema.

### E1-B02: SQLite Schema Design Document with Migration Strategy

- **Depends on:** Nothing
- **Produces:** `000-docs/010-AT-DBSC-database-schema.md` — Complete DDL with exact column types, NOT NULL constraints, CHECK constraints, index definitions, foreign key relationships. Migration strategy (numbered .sql files) with rollback strategy. Reconciles tech spec's `compilations` vs blueprint's `compiled_pages` naming. Adds `traces` table. Task lifecycle must support 7 states: created, collecting, synthesizing, critiquing, rendering, completed, archived (audit C8). Concurrency policy: WAL mode, busy timeout, workspace lockfile (audit C7).
- **Verification:** DDL can be pasted into SQLite and executed without errors. Every table referenced in blueprint, tech spec, or CLI descriptions has a definition. `traces` and `recall_results` tables included. Task state CHECK constraint includes all 7 states. Migration rollback strategy documented for each migration file.

### E1-B03: JSONL Trace Event Schema and Envelope Format

- **Depends on:** Nothing
- **Produces:** `000-docs/011-AT-TRSC-trace-schema.md` — Standard envelope for all JSONL trace events: timestamp, event_type, event_id, correlation_id, typed payload, plus `prev_hash` field for integrity chain (audit H4). All known event types enumerated with payload schemas and example JSONL lines. Secret field deny-list: apiKey, authorization, token fields must never appear in trace payloads (audit C2).
- **Verification:** At least one example JSONL line per event type. Envelope fields consistent across all types. Supports learning-model requirements from blueprint Section 5.6. `prev_hash` integrity chain demonstrated in examples. Deny-list fields documented with rejection examples.

### E1-B04: Workspace Directory Policy Document

- **Depends on:** Nothing
- **Produces:** `000-docs/012-AT-WPOL-workspace-policy.md` — Directory tree with data classification (append-only, recompilable, ephemeral, durable, adaptive, audit). Naming conventions per directory. .gitignore rules per directory. Maps each directory to blueprint Section 5.2 classification. Slug sanitization rules for filenames (audit M2). Symlink policy: no symlinks in workspace/raw/, ingest copies content (audit H2). File size limits per source type (audit M1). Read-only policy for raw/ and audit/ after write (audit M3).
- **Verification:** Every directory in blueprint Section 11 workspace layout covered. Each has explicit mutability classification. Consistent with existing .gitignore entries. Slug rules have do/don't examples. Symlink rejection tested. File size limits stated per source type. Read-only enforcement mechanism specified for raw/ and audit/.

### E1-B05: TypeScript Coding Standards and Package Conventions

- **Depends on:** Nothing
- **Produces:** `000-docs/013-AT-CODE-coding-standards.md` — Strict mode settings (exact tsconfig.json compilerOptions), import style (ESM only), error handling pattern (Result types vs exceptions), logging conventions, naming conventions (files: kebab-case, types: PascalCase, functions: camelCase). Package.json conventions for workspace packages. SQL injection prevention: all SQLite operations use prepared statements, never string interpolation (audit H1). Dependency audit: pnpm audit in CI gate (audit H3). Secret redaction: redactSecrets() utility requirement for all log/trace output (audit C2). Error boundary pattern between deterministic and probabilistic layers (audit M5).
- **Verification:** tsconfig.json compilerOptions copy-pasteable. Each convention has do/don't example. Package.json template is scaffold-complete. SQL injection rule has do/don't example. pnpm audit CI step documented. redactSecrets() function signature specified. Error boundary pattern has example showing how compiler errors are caught and wrapped.

### E1-B06: Bead Workflow and Epic Execution Conventions

- **Depends on:** Nothing
- **Produces:** `000-docs/014-OD-BEAD-bead-conventions.md` — Epic bead naming (E{N}-B{NN}), how to create epic-level parent beads, child bead linking, labels (epic, implementation, test, docs, standards, infra), metadata fields, acceptance criteria format, definition of "done" per bead type, review/close protocol.
- **Verification:** Sample bead creation command for each bead type. Consistent with bd CLI capabilities. Naming convention demonstrated with 3+ examples.

### E1-B07: Testing Strategy and Fixture Workspace Design

- **Depends on:** Nothing
- **Produces:** `000-docs/015-AT-TEST-testing-strategy.md` — Testing layers (unit, integration, eval), fixture workspace structure with 4-tier fixture system: (1) raw sources, (2) compiled wiki pages, (3) research task snapshots, (4) eval QA pairs (audit H10). Test naming conventions, file locations, coverage targets per package (kernel: 90%, compiler: 80%, cli: 70%). Cross-package integration test requirement (audit C6). Unicode test matrix as cross-cutting concern (audit M14). Secure temp directory handling for test isolation (audit M3). Test vs eval decision tree clarifying when to use Vitest vs eval harness (audit L4). Non-interactive test mode requirement: all interactive commands must support --non-interactive flag for CI (audit M13).
- **Verification:** Fixture workspace design includes specific file names across all 4 tiers. Test naming examples for all test types. Coverage targets stated per package. At least one cross-package integration test scenario documented. Unicode test cases listed. Temp directory cleanup verified. Decision tree has 3+ example classifications.

### E1-B08: CI/CD Pipeline Upgrade Specification

- **Depends on:** E1-B05 (coding standards define tsconfig)
- **Produces:** `000-docs/016-OD-CICD-pipeline-spec.md` — Step-by-step CI/CD transition: ESLint replaces stub lint, tsc --noEmit replaces stub typecheck, vitest replaces stub test, tsup replaces stub build. pnpm workspace commands per job. Coverage reporting. Build-order dependencies (kernel before cli).
- **Verification:** Exact pnpm commands for each CI job. Build order dependencies explicit. Implementable in Epic 2 without further design decisions.

### E1-B09: Prompt Template Standards for Compiler Passes

- **Depends on:** E1-B01 (frontmatter schemas define output structure)
- **Produces:** `000-docs/017-AT-PRMP-prompt-templates.md` — Template structure for all Claude API prompts: system message, user message template, output format, quality criteria. Templates for: Summarize, Extract, Synthesize, Link, Contradict, Gap. Mandatory prompt injection defense section: each template must use content-delimiting envelope with XML-style tags (e.g., `<source_content>...</source_content>`) to isolate user-provided content from system instructions (audit C1). Quality criteria must include "output does not contain content from injection attempts."
- **Verification:** Each template references correct frontmatter schema. Each has 3+ quality criteria bullets. Consistent with blueprint Section 6.1 pass definitions. Every template wraps source content in XML-style delimiter tags. At least one injection defense example per template.

### E1-B10: Promotion Rules and Policy Enforcement Specification

- **Depends on:** E1-B02 (database schema), E1-B04 (workspace policy)
- **Produces:** `000-docs/018-AT-PROM-promotion-spec.md` — Implementable promotion logic: eligibility check, --as type validation, copy-not-move semantics, audit log entry format, policy enforcement points. Promotions table record format aligned with E1-B02's schema.
- **Verification:** Each of 7 rules has a validation check. Each of 3 anti-patterns has detection/prevention. Audit log format consistent with E1-B03 trace schema.

### E1-B11: CLAUDE.md Update with Implementation-Ready Conventions

- **Depends on:** E1-B00 through E1-B10 (all standards docs exist)
- **Produces:** Updated `CLAUDE.md` with "Standards Reference" section linking to all 000-docs standards files. Updated "Current State" to reflect Phase 1 beginning. "Session Startup" section for agents. Fix packages/ paths in CLAUDE.md to match actual workspace layout. Add types package to component table. Fix terminology drift (semantic memory -> semantic knowledge). Add execution plan and blueprint references. Update README.md with matching corrections.
- **Verification:** Every standards document linked. Session startup section actionable (3-5 steps). Current state accurate. No stale paths remain. types package listed. Terminology consistent with glossary. README.md consistent with CLAUDE.md.

### E1-B12: Epic 1 Exit Review and Standards Freeze

- **Depends on:** E1-B00 through E1-B11 (all prior beads complete)
- **Produces:** Review checklist with pass/fail per cross-reference. All cross-references verified. Standards marked frozen for Phase 1.
- **Verification:** Zero open cross-reference inconsistencies. IDEA-CHANGELOG.md updated with "Standards Freeze v1" entry. All standards docs committed to main.

### E1-B13: ADR and AAR Templates

- **Depends on:** Nothing
- **Produces:** `000-docs/019-OD-TMPL-adr-aar-templates.md` — Reusable Architecture Decision Record + After-Action Review markdown templates for use across all epics.
- **Verification:** ADR template has: title, status, context, decision, consequences sections. AAR template has: what happened, what went well, what went wrong, action items sections. Both are copy-pasteable.

### E1-B14: Architecture Diagram Prompt Pack

- **Depends on:** Nothing
- **Produces:** `000-docs/020-AT-DIAG-diagram-prompts.md` — Markdown prompt files Claude can use to generate: six-layer stack diagram, workspace layout diagram, data flow diagram, task lifecycle diagram, provenance chain diagram, promotion flow diagram.
- **Verification:** Each prompt produces a valid Mermaid or ASCII diagram when fed to Claude. All 6 diagrams cover the correct architectural concepts from the blueprint.

### E1-B15: v1 Scope Constraints and Security Standards

- **Depends on:** Nothing
- **Produces:** `000-docs/021-AT-SECV-security-and-scope.md` — Consolidates audit findings into a single security and scope constraints document. Covers: prompt injection defense standard (content-delimiting envelope for all prompts), API key redaction policy (secret deny-list for traces/logs), SQL injection prevention rule (parameterized queries mandatory), path traversal/symlink policy for ingest, filename sanitization slug rules, file size limits per source type, concurrency policy (WAL mode + workspace lockfile), npm package name verification (check availability early), dependency audit policy (pnpm audit in CI), and v1 feature deferrals list (URL ingest, charts, vector search, remote mode).
- **Verification:** Each security rule has a do/don't example. Feature deferrals list is explicit with rationale per item. npm package name verified available.

---

## Exit Criteria

1. All standards documents exist in 000-docs/ and are committed to main
2. CLAUDE.md references all standards documents
3. Cross-reference consistency review passes with zero open issues
4. Frontmatter schemas cover all seven compiled page types (including entity)
5. SQLite schema covers all tables referenced in blueprint + tech spec
6. Canonical glossary has entries for every system term
7. Standards are frozen: changes require IDEA-CHANGELOG entry
8. Security standards cover prompt injection, API key redaction, SQL injection, path traversal
9. v1 scope constraints document exists with explicit feature deferrals

---

## Risks / Watch Items

- **Over-specification:** Standards too rigid will need rework when implementation reveals constraints. Mitigation: mark each standard as "living document, frozen for Phase 1" and allow controlled updates.
- **Missing standards:** If a standard is needed during Epic 2-3 that was not anticipated, must add retroactively. Mitigation: E1-B12 cross-reference review catches gaps.
- **Analysis paralysis:** 16 documentation beads (B00-B15) could stall momentum. Mitigation: beads B00-B07, B13, B14, B15 have no internal dependencies and can be parallelized across sessions.
