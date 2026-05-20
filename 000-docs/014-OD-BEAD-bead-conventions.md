# Bead Workflow and Epic Execution Conventions

> Claim it. Work it. Close it with evidence. No exceptions.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Purpose

This document defines the bead naming scheme, lifecycle, labeling taxonomy, acceptance criteria format, definition of done per bead type, and review/close protocol for the Intentional Cognition OS project. Every agent session, every human contributor, and every automated workflow follows these conventions. Deviation requires an IDEA-CHANGELOG entry.

---

## 2. Bead ID Scheme

### 2.1 System-Assigned IDs

Beads uses auto-generated IDs with the project prefix. This project's prefix is `intentional-cognition-os`. All bead IDs follow this pattern:

```
intentional-cognition-os-<hash>        # Epic parent beads
intentional-cognition-os-<hash>.<N>    # Child beads (auto-assigned by --parent)
```

Examples from this project:

| System ID                        | Human Label | Description                                  |
| -------------------------------- | ----------- | -------------------------------------------- |
| `intentional-cognition-os-0cf`   | Epic 1      | Canonical Design Pack epic parent            |
| `intentional-cognition-os-0cf.7` | E1-B06      | Bead Workflow and Epic Execution Conventions |
| `intentional-cognition-os-wlu`   | Epic 2      | Repo Foundation epic parent                  |

You never choose the system ID. Beads assigns it. You reference it in commands.

### 2.2 Human Labels

Human labels appear in bead titles for readability and cross-referencing in documentation. Format:

```
E{N}-B{NN}: <Short Description>
```

- `E{N}` — Epic number, 1-indexed, no zero-padding. Range: E1 through E10.
- `B{NN}` — Bead number within the epic, zero-padded to two digits. Range: B00 through B99.

Examples:

| Human Label | Title                                        |
| ----------- | -------------------------------------------- |
| `E1-B00`    | Canonical Glossary and Terminology Lock      |
| `E1-B06`    | Bead Workflow and Epic Execution Conventions |
| `E3-B04`    | Source Registry and Content Hashing          |
| `E6-B02`    | Summarize Pass                               |
| `E10-B11`   | v1 Gate and Release                          |

The human label is embedded in the bead title. It is not a separate metadata field. When creating beads, the title MUST start with the human label:

```
--title="E1-B06: Bead Workflow and Epic Execution Conventions"
```

---

## 3. Epic Parent Beads

Each of the 10 epics has exactly one parent bead of type `epic`. Epic parents are coordination containers, not work items.

### 3.1 Creating an Epic Parent

```bash
bd create \
  --type=epic \
  --priority=P0 \
  --title="Epic 1: Canonical Design Pack, Standards, and Execution Templates" \
  --description="Lock the repo canon before implementation fans out. Every later epic references these artifacts for schema definitions, coding conventions, bead workflow, and quality standards." \
  --labels="epic"
```

### 3.2 Epic Parent Rules

- **Type:** `epic` (the only valid type for parent beads)
- **Priority:** Always P0. Epic parents represent the highest-priority organizational unit.
- **Labels:** Must include `epic`. May additionally include phase labels (e.g., `phase:0.5`, `phase:1`).
- **Status:** Remains `open` until all child beads are closed. Then close via `bd epic close-eligible`.
- **Never claim an epic parent.** Claim child beads. The epic parent is a structural container.

### 3.3 Epic-Level Dependencies

Wire epic-to-epic dependencies so `bd blocked` and `bd ready` produce correct results:

```bash
# Epic 2 depends on Epic 1
bd dep add intentional-cognition-os-wlu intentional-cognition-os-0cf

# Epic 4 depends on Epic 2 AND Epic 3
bd dep add intentional-cognition-os-9zv intentional-cognition-os-wlu
bd dep add intentional-cognition-os-9zv intentional-cognition-os-k07
```

The full dependency spine is documented in `EXECUTION-PLAN-10-EPICS.md`. Register all cross-epic dependencies immediately after creating epic parents.

---

## 4. Child Beads

Child beads are the actual work items. Every piece of deliverable work is a child bead under an epic parent.

### 4.1 Creating a Child Bead

```bash
bd create \
  --parent=intentional-cognition-os-0cf \
  --priority=P1 \
  --title="E1-B06: Bead Workflow and Epic Execution Conventions" \
  --description="Define bead conventions: naming (E{N}-B{NN}), labels, metadata fields, acceptance criteria format, definition of done per bead type, review/close protocol. Produces 000-docs/014-OD-BEAD-bead-conventions.md." \
  --labels="epic:1,type:docs" \
  --acceptance="Verify: sample bead creation command for each bead type. Verify: consistent with bd CLI capabilities. Verify: naming convention demonstrated with 3+ examples."
```

### 4.2 Child Bead Rules

- **Type:** `task` (default). All child beads use `task` type regardless of label. The `--labels` flag carries semantic meaning.
- **Priority:** P1 for standard child beads. P0 is reserved for epic parents. Use P2 for nice-to-have items within an epic.
- **Parent:** Always set via `--parent=<epic-system-id>`. Every child bead belongs to exactly one epic.
- **Labels:** Mandatory. At minimum `epic:N` and one type label. See Section 5.
- **Acceptance criteria:** Mandatory. See Section 7.

### 4.3 Intra-Epic Dependencies

When one bead within an epic depends on another, wire the dependency:

```bash
# E1-B01 depends on E1-B00 (frontmatter schemas need locked terminology)
bd dep add intentional-cognition-os-0cf.2 intentional-cognition-os-0cf.1
```

### 4.4 Cross-Epic Dependencies

Beads in later epics may depend on specific beads in earlier epics:

```bash
# E2-B05 (shared types) depends on E1-B01 (frontmatter schemas)
bd dep add <e2-b05-id> intentional-cognition-os-0cf.2
```

Always register these at epic creation time, not when you happen to start work.

---

## 5. Label Taxonomy

Every child bead carries two label categories: an epic affiliation label and a type classification label.

### 5.1 Epic Affiliation

Format: `epic:N` where N is the epic number.

```
epic:1    epic:2    epic:3    ...    epic:10
```

### 5.2 Type Classification

Exactly one of the following type labels per bead:

| Label                 | Meaning                                     | Typical Deliverable              |
| --------------------- | ------------------------------------------- | -------------------------------- |
| `type:standards`      | Design specification or convention document | Markdown doc in `000-docs/`      |
| `type:implementation` | Application code                            | TypeScript source in `packages/` |
| `type:test`           | Test code or test infrastructure            | Vitest specs, fixtures           |
| `type:docs`           | Operational or process documentation        | Markdown doc, CLAUDE.md updates  |
| `type:infra`          | CI/CD, tooling, repo scaffolding            | Workflow YAML, config files      |
| `type:review`         | Exit review, cross-reference audit          | Checklist, pass/fail results     |

### 5.3 Applying Labels

At creation time:

```bash
bd create --labels="epic:1,type:standards" ...
```

After creation:

```bash
bd label add intentional-cognition-os-0cf.7 type:docs
```

### 5.4 Querying by Label

```bash
# All standards beads across all epics
bd list --label="type:standards"

# All beads in Epic 3
bd list --label="epic:3"

# All implementation beads in Epic 6
bd list --label="epic:6" --label="type:implementation"
```

---

## 6. Metadata Fields

Use bd's built-in fields. Do not invent custom metadata unless there is no built-in equivalent.

### 6.1 Required Fields (Set at Creation)

| Field       | Flag            | Content                                                                                       |
| ----------- | --------------- | --------------------------------------------------------------------------------------------- |
| Title       | `--title`       | Human label + short description. e.g., `E1-B06: Bead Workflow and Epic Execution Conventions` |
| Description | `--description` | What the bead delivers and why. Reference the `Produces:` line from the epic doc.             |
| Priority    | `--priority`    | `P0` for epics, `P1` for standard child beads.                                                |
| Parent      | `--parent`      | System ID of the epic parent bead.                                                            |
| Labels      | `--labels`      | `epic:N,type:<classification>`                                                                |
| Acceptance  | `--acceptance`  | Bullet list of verification criteria. See Section 7.                                          |

### 6.2 Optional Fields

| Field        | Flag             | When to Use                                                                           |
| ------------ | ---------------- | ------------------------------------------------------------------------------------- |
| Assignee     | `--assignee`     | Set when claiming. Or use `--claim`.                                                  |
| Notes        | `--notes`        | Implementation context, design rationale, gotchas discovered during work.             |
| Design       | `--design`       | Architectural decisions made while working the bead.                                  |
| Estimate     | `--estimate`     | Time estimate in minutes. Set if tracking velocity.                                   |
| Due          | `--due`          | Hard deadlines only. Do not set speculatively.                                        |
| External ref | `--external-ref` | Link to GitHub issue, PR, or external tracker. e.g., `gh-42`                          |
| Spec ID      | `--spec-id`      | Link to specification document path. e.g., `000-docs/014-OD-BEAD-bead-conventions.md` |

---

## 7. Acceptance Criteria Format

Every child bead must have acceptance criteria. Criteria are action-oriented statements that begin with `Verify:` or `Ensure:`.

### 7.1 Format

```
Verify: <observable outcome>.
Ensure: <constraint that must hold>.
```

### 7.2 Examples by Bead Type

**Standards bead (E1-B01):**

```
Verify: each of the 7 compiled page types has a complete frontmatter schema.
Verify: every schema includes at least one complete example document.
Ensure: no ambiguity between required and optional fields.
Ensure: schemas cover every field referenced in the blueprint.
```

**Implementation bead (E3-B04):**

```
Verify: source registry stores SHA-256 content hash per ingested file.
Verify: duplicate detection rejects re-ingest of identical content.
Ensure: all SQLite operations use prepared statements.
Ensure: unit tests pass with 90%+ line coverage.
```

**Test bead (E2-B09):**

```
Verify: fixture workspace contains raw sources, compiled pages, and task snapshots.
Verify: vitest discovers and runs all fixture-based tests.
Ensure: fixtures do not depend on external API calls.
```

**Docs bead (E1-B06):**

```
Verify: sample bead creation command for each bead type.
Verify: naming convention demonstrated with 3+ examples.
Ensure: consistent with bd CLI capabilities.
```

**Infra bead (E2-B10):**

```
Verify: CI workflow runs lint, typecheck, test on push to main.
Verify: pnpm audit runs as a CI gate.
Ensure: pipeline completes in under 5 minutes.
```

**Review bead (E1-B12):**

```
Verify: every cross-reference between standards docs resolves correctly.
Verify: pass/fail recorded for each check.
Ensure: zero open inconsistencies at close.
```

### 7.3 Setting Acceptance Criteria

At creation:

```bash
bd create \
  --acceptance="Verify: sample bead creation command for each bead type. Verify: consistent with bd CLI capabilities. Verify: naming convention demonstrated with 3+ examples." \
  ...
```

After creation:

```bash
bd update intentional-cognition-os-0cf.7 \
  --acceptance="Verify: sample bead creation command for each bead type. Verify: consistent with bd CLI capabilities. Verify: naming convention demonstrated with 3+ examples."
```

---

## 8. Definition of Done by Bead Type

A bead is not done until every acceptance criterion is satisfied AND the type-specific completion checklist passes.

### 8.1 Standards (`type:standards`)

- [ ] Document committed to `000-docs/` with correct doc-filing v4 filename
- [ ] All cross-references to other standards docs verified (links resolve, content consistent)
- [ ] Document marked "Frozen for Phase 1" in header
- [ ] IDEA-CHANGELOG.md updated if this changes a prior design decision

### 8.2 Implementation (`type:implementation`)

- [ ] Code committed to the correct `packages/` subdirectory
- [ ] All unit tests pass (`pnpm test` in package directory)
- [ ] Coverage meets package target (kernel: 90%, compiler: 80%, cli: 70%)
- [ ] TypeScript strict mode passes (`pnpm typecheck`)
- [ ] Lint passes (`pnpm lint`)
- [ ] No TODO/FIXME/HACK comments without a linked bead ID

### 8.3 Test (`type:test`)

- [ ] Tests pass in CI (`pnpm test`)
- [ ] Coverage meets or exceeds the target stated in acceptance criteria
- [ ] Fixtures committed alongside tests
- [ ] No flaky tests (run 3x locally before marking done)

### 8.4 Docs (`type:docs`)

- [ ] Document committed with correct filename
- [ ] All internal links verified (section references, file paths)
- [ ] Terminology consistent with `008-AT-GLOS-glossary.md`
- [ ] No stale references to removed or renamed artifacts

### 8.5 Infra (`type:infra`)

- [ ] Pipeline runs green on the target branch
- [ ] Configuration committed (workflow YAML, config files)
- [ ] No secrets committed (API keys, tokens)
- [ ] Rollback procedure documented or self-evident

### 8.6 Review (`type:review`)

- [ ] Every check in the review checklist has a pass/fail result
- [ ] All failures have been remediated or have a linked follow-up bead
- [ ] Review results committed as a document or appended to the bead's notes

---

## 9. Bead Lifecycle and Workflow

### 9.1 Status Transitions

```
open  ──►  in_progress  ──►  closed
  │             │
  │             ▼
  │          blocked  ──►  in_progress  (when blocker resolves)
  │
  ▼
deferred  ──►  open  (when undeferred)
```

Valid statuses: `open`, `in_progress`, `blocked`, `deferred`, `closed`, `pinned`, `hooked`.

### 9.2 The Work Cycle

Every bead follows this sequence. No exceptions.

**Step 1: Find work.**

```bash
bd ready                    # Show unblocked, open beads
bd show <id>                # Review details and acceptance criteria
```

**Step 2: Claim it.**

```bash
bd update <id> --claim      # Sets assignee + status to in_progress atomically
```

**Step 3: Work it.**

Do the work. Commit code. Write documents. Run tests. Append notes as you go:

```bash
bd note <id> "Discovered that X requires Y. Adjusting approach."
```

**Step 4: Close it with evidence.**

```bash
bd close <id> -r "Committed 000-docs/014-OD-BEAD-bead-conventions.md. All acceptance criteria met: 6 sample commands, 5+ naming examples, consistent with bd --help output."
```

The close reason MUST include evidence. Acceptable evidence:

- **File paths:** `Committed packages/kernel/src/mount.ts`
- **Test output:** `All 47 tests pass, 92% coverage`
- **PR link:** `PR #12 merged to main`
- **Review result:** `12/12 cross-reference checks pass`

**Step 5: Sync.**

```bash
bd dolt pull               # Pull any updates from main
```

### 9.3 Blocking and Unblocking

If you discover a bead is blocked mid-work:

```bash
bd update <id> --status=blocked
bd note <id> "Blocked on <blocker-id>: need frontmatter schemas finalized first."
```

When the blocker resolves, beads automatically transitions dependents. Check:

```bash
bd blocked                  # See what's still stuck
bd ready                    # See what's newly available
```

### 9.4 Deferring

For beads that are not blocked but should not be worked yet:

```bash
bd defer <id> --until="2026-04-15"    # Hidden from bd ready until that date
bd undefer <id>                        # Bring it back early
```

---

## 10. Branch and Commit Conventions

### 10.1 Branch Naming

Feature branches reference the epic and bead(s) being worked:

```
feat/epic{N}-<description>-bz<story>-bz<story>
```

The `bz` prefix stands for "bead zone" and maps to the bead's human label number.

Examples:

```
feat/epic1-canonical-design-pack
feat/epic1-glossary-frontmatter-bz00-bz01
feat/epic2-repo-foundation-bz00-bz01-bz02
feat/epic3-kernel-mounts-bz03-bz04
```

Rules:

- One branch per logical unit of work (one or more related beads).
- Never commit directly to `main`. Always use a feature branch.
- Branch from `main`. Merge back to `main` via PR when beads are closed.

### 10.2 Conventional Commits

All commits follow the conventional commit format:

```
<type>(<scope>): <subject>

[optional body with bead reference]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`

The commit body SHOULD reference the bead human label:

```
docs(standards): frontmatter schemas for all 7 compiled page types

E1-B01: Complete frontmatter schema definitions with Zod-compatible
type notation and example documents for each page type.
```

```
feat(kernel): source registry with SHA-256 content hashing

E3-B04: Implements source identity tracking. Content hash computed
at ingest time. Duplicate detection prevents re-ingest.
```

```
test(fixtures): 4-tier fixture workspace for integration tests

E2-B09: Raw sources, compiled pages, task snapshots, and eval pairs.
All fixtures committed under tests/fixtures/.
```

### 10.3 Autonomous Git on Feature Branches

When working on a feature branch:

- Auto-commit after passing tests. Do not ask for permission.
- Auto-push to remote.
- Auto-create PRs when beads are closed.
- Never touch `main` directly.
- Before merging, check PR review comments (`gh api`), fix all issues, re-verify tests, push, then state "comments addressed, ready to merge."

---

## 11. Sample Bead Creation Commands

### 11.1 Epic Parent (type: epic)

```bash
bd create \
  --type=epic \
  --priority=P0 \
  --title="Epic 3: Kernel Core — Workspace, State, Mounts, and Provenance" \
  --description="Build the deterministic substrate: workspace management, SQLite state, mount registry, source tracking, provenance, trace writer, task state machine." \
  --labels="epic"
```

### 11.2 Standards Bead (type:standards)

```bash
bd create \
  --parent=intentional-cognition-os-0cf \
  --priority=P1 \
  --title="E1-B01: Frontmatter Schema Definitions" \
  --description="Exact YAML frontmatter schema for each of the 7 compiled page types. Uses Zod-compatible type notation. Produces 000-docs/009-AT-FMSC-frontmatter-schemas.md." \
  --labels="epic:1,type:standards" \
  --acceptance="Verify: each of 7 page types has a complete schema. Verify: at least one example document per schema. Ensure: no ambiguity in required vs optional fields."
```

### 11.3 Implementation Bead (type:implementation)

```bash
bd create \
  --parent=intentional-cognition-os-k07 \
  --priority=P1 \
  --title="E3-B04: Source Registry and Content Hashing" \
  --description="Implement source identity tracking with SHA-256 content hashing. Duplicate detection at ingest time. All SQLite operations use prepared statements." \
  --labels="epic:3,type:implementation" \
  --acceptance="Verify: SHA-256 hash computed per ingested file. Verify: duplicate rejection works. Ensure: parameterized SQL only. Ensure: 90%+ unit test coverage."
```

### 11.4 Test Bead (type:test)

```bash
bd create \
  --parent=intentional-cognition-os-wlu \
  --priority=P1 \
  --title="E2-B09: Fixture Workspace and Integration Test Setup" \
  --description="Create 4-tier fixture system: raw sources, compiled pages, task snapshots, eval QA pairs. Configure vitest for cross-package integration tests." \
  --labels="epic:2,type:test" \
  --acceptance="Verify: fixture workspace has files in all 4 tiers. Verify: vitest discovers all tests. Ensure: no external API dependencies in fixtures."
```

### 11.5 Docs Bead (type:docs)

```bash
bd create \
  --parent=intentional-cognition-os-0cf \
  --priority=P1 \
  --title="E1-B06: Bead Workflow and Epic Execution Conventions" \
  --description="Define bead conventions: naming (E{N}-B{NN}), labels, metadata fields, acceptance criteria format, definition of done per bead type, review/close protocol. Produces 000-docs/014-OD-BEAD-bead-conventions.md." \
  --labels="epic:1,type:docs" \
  --acceptance="Verify: sample bead creation command for each bead type. Verify: consistent with bd CLI capabilities. Verify: naming convention demonstrated with 3+ examples."
```

### 11.6 Infra Bead (type:infra)

```bash
bd create \
  --parent=intentional-cognition-os-wlu \
  --priority=P1 \
  --title="E2-B10: CI/CD Pipeline Upgrade" \
  --description="Replace stub CI jobs with real tooling: ESLint, tsc --noEmit, vitest, tsup. Add pnpm audit as CI gate. Build order: types -> kernel -> compiler -> cli." \
  --labels="epic:2,type:infra" \
  --acceptance="Verify: CI runs lint, typecheck, test, build. Verify: pnpm audit gate active. Ensure: pipeline completes in under 5 minutes."
```

### 11.7 Review Bead (type:review)

```bash
bd create \
  --parent=intentional-cognition-os-0cf \
  --priority=P1 \
  --title="E1-B12: Epic 1 Exit Review and Standards Freeze" \
  --description="Cross-reference consistency review across all E1 standards docs. Verify every internal link. Mark all standards frozen for Phase 1." \
  --labels="epic:1,type:review" \
  --acceptance="Verify: every cross-reference resolves. Verify: pass/fail per check. Ensure: zero open inconsistencies. Ensure: IDEA-CHANGELOG updated with Standards Freeze v1 entry."
```

---

## 12. Review and Close Protocol

### 12.1 Self-Review (Agent or Human)

Before closing any bead:

1. Re-read the acceptance criteria: `bd show <id>`
2. Walk each criterion. Is there evidence it is satisfied?
3. Run relevant verification (tests, link checks, linting).
4. If any criterion fails, fix it. Do not close a partial bead.

### 12.2 Close with Evidence

```bash
bd close <id> -r "<evidence summary>"
```

The reason string must be substantive. Examples:

```bash
# Standards bead
bd close intentional-cognition-os-0cf.2 -r "Committed 000-docs/009-AT-FMSC-frontmatter-schemas.md. 7 schemas with examples. Cross-refs to glossary verified."

# Implementation bead
bd close intentional-cognition-os-k07.5 -r "Source registry implemented in packages/kernel/src/source-registry.ts. 23 tests pass, 94% coverage. PR #18 open."

# Infra bead
bd close intentional-cognition-os-wlu.11 -r "CI pipeline green on feat/epic2-ci-upgrade. Lint, typecheck, test, build all pass. pnpm audit gate active."
```

### 12.3 Closing Multiple Beads

When you complete several related beads in one session:

```bash
bd close intentional-cognition-os-0cf.1 intentional-cognition-os-0cf.2 -r "Glossary and frontmatter schemas committed. Cross-referenced and consistent."
```

### 12.4 Post-Close

After closing, check what you unblocked:

```bash
bd close <id> -r "evidence" --suggest-next
```

This shows newly unblocked beads that are now ready for work.

### 12.5 Epic Closure

Never manually close an epic parent. Use:

```bash
bd epic close-eligible
```

This closes any epic whose children are all closed. If children remain open, the epic stays open.

---

## 13. Session Startup Protocol

Every agent session begins with:

```bash
bd prime                    # Recover context after compaction
bd dolt pull                # Pull latest bead state from main
bd ready                    # See what's available
bd list --status=in_progress  # Check for beads you already claimed
```

If you have in-progress beads, resume them. If not, claim the highest-priority ready bead. Do not start work without claiming a bead first.

---

## 14. Health and Hygiene

### 14.1 Regular Checks

```bash
bd doctor                   # Installation health
bd doctor --check=conventions  # Convention drift detection
bd stale                    # Beads with no recent activity
bd orphans                  # Broken dependency references
bd preflight                # Pre-PR readiness checklist
```

### 14.2 Before Merging to Main

```bash
bd preflight                # Lint, stale, orphans check
bd dolt pull                # Ensure bead state is current
# Verify all claimed beads are closed or explicitly deferred
bd list --status=in_progress  # Should be empty before merge
```

---

## 15. Anti-Patterns

| Anti-Pattern                             | Correction                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Working without claiming a bead          | Always `bd update <id> --claim` before writing code                                     |
| Closing without evidence                 | Always `bd close <id> -r "evidence"`. Empty reasons are rejected by convention.         |
| Using TodoWrite or markdown for tracking | All task tracking goes through `bd`. No exceptions.                                     |
| Manually closing epic parents            | Use `bd epic close-eligible`.                                                           |
| Creating beads without labels            | Every child bead needs `epic:N` and `type:<classification>`.                            |
| Skipping acceptance criteria             | Every child bead needs `--acceptance`. Beads without criteria cannot be verified.       |
| Committing to main directly              | Use feature branches. Merge via PR.                                                     |
| Setting epic parents to in_progress      | Epic parents stay `open` until all children close. Claim children, not parents.         |
| Using `bd edit` in agent sessions        | `bd edit` opens `$EDITOR` which blocks agents. Use `bd update --field="value"` instead. |

---

## 16. Quick Reference Card

```
CREATE EPIC:    bd create --type=epic --priority=P0 --title="Epic N: ..." --labels="epic"
CREATE CHILD:   bd create --parent=<epic-id> --priority=P1 --title="EN-BNN: ..." --labels="epic:N,type:X" --acceptance="..."
WIRE DEPS:      bd dep add <dependent> <dependency>
FIND WORK:      bd ready
CLAIM:          bd update <id> --claim
ADD NOTES:      bd note <id> "context"
CLOSE:          bd close <id> -r "evidence"
CHECK BLOCKED:  bd blocked
CHECK HEALTH:   bd doctor
SYNC:           bd dolt pull
CLOSE EPIC:     bd epic close-eligible
```

---

## References

- Execution plan: `000-docs/EXECUTION-PLAN-10-EPICS.md`
- Epic 1 reference: `000-docs/epics/epic-01-canonical-design-pack.md`
- Master blueprint: `000-docs/007-PP-PLAN-master-blueprint.md`
- Glossary: `000-docs/008-AT-GLOS-glossary.md`
- bd CLI help: `bd --help`, `bd <command> --help`
- bd workflow context: `bd prime`
