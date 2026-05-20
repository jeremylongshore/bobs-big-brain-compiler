# Promotion Rules and Policy Enforcement Specification

> Explicit promotion. Copy-not-move. Always audited. Never automatic.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Purpose

This document defines the complete promotion logic for Intentional Cognition OS. Promotion is the act of filing a durable output (L4 artifact in `workspace/outputs/`) back into the semantic knowledge layer (L2 in `workspace/wiki/`). It is the only mechanism by which rendered artifacts become first-class compiled knowledge.

Promotion is explicit, audited, and copy-not-move. The operator decides what gets promoted. The system enforces eligibility, validates the target type, copies the file, mutates frontmatter, writes a database record, emits a trace event, and appends to the audit log. No step is optional.

**Governing references:**

| Document                       | Section       | What it governs                         |
| ------------------------------ | ------------- | --------------------------------------- |
| Master Blueprint (007-PP-PLAN) | Section 7     | Promotion rules and anti-patterns       |
| Database Schema (010-AT-DBSC)  | Section 3.5   | `promotions` table DDL                  |
| Trace Schema (011-AT-TRSC)     | Section 6.9   | `promotion` event type and payload      |
| Workspace Policy (012-AT-WPOL) | Section 3, 10 | Directory classifications and ownership |
| Glossary (008-AT-GLOS)         | Section 9     | Canonical promotion terminology         |

---

## 2. Command Interface

```
ico promote <path> --as <type> [--confirm]
```

| Argument      | Required | Description                                                                               |
| ------------- | -------- | ----------------------------------------------------------------------------------------- |
| `<path>`      | Yes      | Workspace-relative or absolute path to the artifact in `workspace/outputs/`.              |
| `--as <type>` | Yes      | Target wiki page type. Must be one of: `topic`, `concept`, `entity`, `reference`.         |
| `--confirm`   | No       | Skip interactive confirmation prompt. Required for non-interactive (scripted) invocation. |

**Exit codes:**

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Promotion succeeded                                                        |
| 1    | Eligibility check failed (file not in outputs, empty, missing frontmatter) |
| 2    | Type validation failed (invalid `--as` value)                              |
| 3    | Anti-pattern detected (draft, evidence, or unreviewed file)                |
| 4    | Filesystem error (copy failed, target path collision)                      |
| 5    | Database or audit write failed                                             |

---

## 3. The Seven Promotion Rules

Each rule has a validation check executed by the kernel before the copy operation proceeds. All seven checks must pass. Failure at any check aborts the promotion and returns the corresponding exit code.

### Rule 1: Only artifacts in `workspace/outputs/` are eligible

**Validation:** Resolve the provided path to an absolute path. Confirm the resolved path is a descendant of `workspace/outputs/`. Reject paths outside this directory with exit code 1.

```typescript
// Pseudocode
const resolved = path.resolve(workspaceRoot, sourcePath);
if (!resolved.startsWith(path.join(workspaceRoot, 'outputs'))) {
  throw new PromotionError(
    'INELIGIBLE_PATH',
    `Only files in workspace/outputs/ are eligible for promotion. Got: ${sourcePath}`,
  );
}
```

**What it prevents:** Promotion of raw corpus (L1), ephemeral task files (L3), recall materials (L5), or audit data (L6) into the compiled knowledge layer.

### Rule 2: Promotion requires an explicit command

**Validation:** Promotion is triggered only by `ico promote`. No other command, lifecycle hook, compilation pass, or agent action may invoke the promotion pipeline. The kernel exposes a single `promote()` function gated by a caller check.

**What it prevents:** Accidental or implicit promotion via side effects in other operations.

### Rule 3: `--as` specifies the target type

**Validation:** The `--as` argument must be one of the four allowed values. Reject anything else with exit code 2.

```typescript
const VALID_PROMOTION_TYPES = ['topic', 'concept', 'entity', 'reference'] as const;
type PromotionType = (typeof VALID_PROMOTION_TYPES)[number];

if (!VALID_PROMOTION_TYPES.includes(targetType)) {
  throw new PromotionError(
    'INVALID_TYPE',
    `--as must be one of: ${VALID_PROMOTION_TYPES.join(', ')}. Got: ${targetType}`,
  );
}
```

**Type semantics:**

| Type        | Target directory           | When to use                                           |
| ----------- | -------------------------- | ----------------------------------------------------- |
| `topic`     | `workspace/wiki/topics/`   | Cross-source synthesis on a named subject             |
| `concept`   | `workspace/wiki/concepts/` | Discrete concept definition with citations            |
| `entity`    | `workspace/wiki/entities/` | Named entity — person, org, tool, framework           |
| `reference` | `workspace/wiki/sources/`  | Reference material that functions as a source summary |

### Rule 4: Promoted content is copied, not moved

**Validation:** Use `fs.copyFile()`. After copy, verify the source file still exists at its original path. If the source file is missing after copy (indicating a move or race condition), log a warning and do not roll back the copy — the promoted version is valid.

```typescript
await fs.copyFile(sourcePath, targetPath);
// Verify source still exists (copy-not-move invariant)
if (!(await fs.pathExists(sourcePath))) {
  logger.warn(
    `Source file disappeared after copy: ${sourcePath}. Promotion succeeded but copy-not-move invariant was violated.`,
  );
}
```

**What it preserves:** The original artifact remains in `workspace/outputs/` for reference, re-promotion with a different type, or deletion by the operator.

### Rule 5: Promotion event is logged in audit

**Validation:** After successful copy and frontmatter mutation, write three audit artifacts atomically (all three must succeed or the promotion is rolled back):

1. **Promotions table record** in SQLite (Section 5)
2. **Trace event** in `workspace/audit/traces/<date>.jsonl` (Section 6)
3. **Promotion audit file** in `workspace/audit/promotions/<ulid>.jsonl` (Section 7)
4. **Append to `workspace/audit/log.md`** (Section 8)

If any audit write fails, delete the copied file from `workspace/wiki/` and return exit code 5.

### Rule 6: Promoted pages enter the normal compilation lifecycle

**Validation:** This is not a pre-promotion check — it is a post-promotion invariant. After promotion, the copied file in `workspace/wiki/<type>/` must:

- Be discoverable by `ico compile all` and `ico lint knowledge`
- Be linkable by the Link compilation pass
- Be contradictable by the Contradict compilation pass
- Be lintable for frontmatter conformance, staleness, and schema compliance

No special flag or metadata exempts promoted pages from the standard compilation lifecycle.

### Rule 7: Automatic promotion is never allowed

**Validation:** The `promoted_by` field in the `promotions` table is always `'user'`. The kernel rejects any attempt to set `promoted_by` to `'system'`. This is enforced at the kernel level, not just the database CHECK constraint.

```typescript
// Kernel-level enforcement
if (actor !== 'user') {
  throw new PromotionError(
    'AUTOMATIC_PROMOTION_BLOCKED',
    'Automatic promotion is not allowed. Promotion must be user-initiated.',
  );
}
```

**What it prevents:** Agent workflows, compilation passes, task completion hooks, or any automated process from promoting artifacts without explicit operator action.

---

## 4. Anti-Pattern Detection and Prevention

Three anti-patterns are defined in the Master Blueprint (Section 7.2). Each has a detection mechanism that runs as part of the eligibility check, before the copy operation.

### Anti-pattern 1: Promoting raw task drafts

**Detection:** Reject any file whose resolved path contains `workspace/tasks/` and specifically the `drafts/` subdirectory. This catches attempts to promote intermediate work products that have not been rendered as final outputs.

```typescript
const resolvedPath = path.resolve(workspaceRoot, sourcePath);
if (
  resolvedPath.includes(path.join('tasks', '')) &&
  resolvedPath.includes(path.join('drafts', ''))
) {
  throw new PromotionError(
    'DRAFT_REJECTED',
    `Cannot promote task drafts. Only final artifacts in workspace/outputs/ are eligible. Got: ${sourcePath}`,
  );
}
```

**Note:** This check is defense-in-depth. Rule 1 already restricts promotion to `workspace/outputs/`. This anti-pattern check provides a more specific error message when the operator attempts to promote from a task drafts directory.

### Anti-pattern 2: Promoting without review

**Detection:** Require explicit confirmation before promotion completes. In interactive mode, prompt the operator with a summary of what will be promoted and where. In non-interactive mode, require the `--confirm` flag.

```
ico promote workspace/outputs/reports/transformer-survey.md --as topic

Promotion summary:
  Source:  workspace/outputs/reports/transformer-survey.md
  Target:  workspace/wiki/topics/transformer-survey.md
  Type:    topic
  Title:   "Transformer Architecture Survey"

Proceed? [y/N]
```

Without confirmation (interactive `y` or `--confirm` flag), the promotion is aborted with exit code 3.

**What it enforces:** Promotion is a quality gate. The operator must consciously review and approve each promotion. Bulk or unattended promotion is deliberately friction-heavy.

### Anti-pattern 3: Promoting ephemeral evidence

**Detection:** Reject any file whose resolved path contains `workspace/tasks/` and specifically the `evidence/` subdirectory. Evidence stays in L3 — only synthesized outputs belong in L2.

```typescript
const resolvedPath = path.resolve(workspaceRoot, sourcePath);
if (
  resolvedPath.includes(path.join('tasks', '')) &&
  resolvedPath.includes(path.join('evidence', ''))
) {
  throw new PromotionError(
    'EVIDENCE_REJECTED',
    `Cannot promote task evidence. Evidence stays in L3. Only synthesis outputs in workspace/outputs/ are eligible. Got: ${sourcePath}`,
  );
}
```

**Note:** Like anti-pattern 1, this is defense-in-depth behind Rule 1. It provides a targeted error message for a specific misuse pattern.

---

## 5. Promotions Table Record Format

The `promotions` table in SQLite stores a record for every promotion. Schema defined in 010-AT-DBSC Section 3.5.

```sql
CREATE TABLE promotions (
    id              TEXT    PRIMARY KEY,
    source_path     TEXT    NOT NULL,
    target_path     TEXT    NOT NULL,
    target_type     TEXT    NOT NULL CHECK (target_type IN (
                                'topic', 'concept', 'entity', 'reference'
                            )),
    promoted_at     TEXT    NOT NULL,
    promoted_by     TEXT    NOT NULL CHECK (promoted_by IN ('user', 'system'))
);
```

**Record construction:**

| Field         | Value                   | Source                                                            |
| ------------- | ----------------------- | ----------------------------------------------------------------- |
| `id`          | ULID                    | Generated by the kernel at promotion time                         |
| `source_path` | Workspace-relative path | The `<path>` argument, normalized to workspace-relative           |
| `target_path` | Workspace-relative path | Computed: `wiki/<type>/<slugified-title>.md`                      |
| `target_type` | Promotion type          | The `--as` argument: `topic`, `concept`, `entity`, or `reference` |
| `promoted_at` | ISO 8601 UTC timestamp  | `new Date().toISOString()` at promotion time                      |
| `promoted_by` | `'user'`                | Always `'user'` in Phase 1. `'system'` is blocked by kernel.      |

**Additional field: `source_hash`.** The blueprint and bead spec call for `source_hash` in the promotion record. This field is not in the Phase 1 DDL (010-AT-DBSC). It will be added via migration `002-add-source-hash-to-promotions.sql` before the promote command is implemented. Until then, the SHA-256 content hash of the source file is recorded in the trace event payload and the audit file, ensuring no provenance data is lost.

**Example INSERT:**

```sql
INSERT INTO promotions (id, source_path, target_path, target_type, promoted_at, promoted_by)
VALUES (
  '01HXK3V9P7Q8R2S4T6W8Y0Z1',
  'outputs/reports/transformer-survey.md',
  'wiki/topics/transformer-survey.md',
  'topic',
  '2026-04-06T14:30:00.000Z',
  'user'
);
```

---

## 6. Trace Event Format

The `promotion` event type is defined in 011-AT-TRSC Section 6.9. Every promotion emits exactly one trace event.

**Envelope:**

```json
{
  "timestamp": "2026-04-06T14:30:00.000Z",
  "event_type": "promotion",
  "event_id": "9b5e4d3c-2a1f-4b0e-8d9c-7a6b5c4d3e2f",
  "correlation_id": null,
  "payload": {
    "source_path": "workspace/outputs/reports/transformer-survey.md",
    "target_path": "workspace/wiki/topics/transformer-survey.md",
    "target_type": "topic",
    "actor": "user",
    "source_hash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
  },
  "prev_hash": "b0d9c8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9"
}
```

**Payload fields:**

| Field         | Type   | Required | Description                                                        |
| ------------- | ------ | -------- | ------------------------------------------------------------------ |
| `source_path` | string | Yes      | Workspace-relative path of the artifact being promoted             |
| `target_path` | string | Yes      | Workspace-relative path in wiki where the page lands               |
| `target_type` | string | Yes      | Wiki page type: `topic`, `concept`, `entity`, `reference`          |
| `actor`       | string | Yes      | Who triggered: `user` (always in Phase 1)                          |
| `source_hash` | string | Yes      | `sha256:<hex>` digest of the source file content at promotion time |

**`correlation_id`:** Promotion events are standalone operations. `correlation_id` is `null` unless the promotion occurs as part of a larger workflow (e.g., a task completion flow that prompts the operator to promote). In that case, the promotion event shares the task's `correlation_id`.

**Trace index record:** After writing the JSONL event, insert a corresponding row into the `traces` table:

```sql
INSERT INTO traces (id, event_type, correlation_id, timestamp, file_path, line_offset, summary)
VALUES (
  '9b5e4d3c-2a1f-4b0e-8d9c-7a6b5c4d3e2f',
  'promotion',
  NULL,
  '2026-04-06T14:30:00.000Z',
  'audit/traces/2026-04-06.jsonl',
  4096,
  'Promoted outputs/reports/transformer-survey.md → wiki/topics/transformer-survey.md as topic'
);
```

---

## 7. Promotion Audit File

In addition to the trace event, each promotion writes a dedicated audit file to `workspace/audit/promotions/`. This file provides a self-contained, greppable record of the promotion decision.

**File path:** `workspace/audit/promotions/<ulid>.jsonl`

**File content:** A single JSONL line containing the complete promotion record.

```json
{
  "promotion_id": "01HXK3V9P7Q8R2S4T6W8Y0Z1",
  "source_path": "outputs/reports/transformer-survey.md",
  "target_path": "wiki/topics/transformer-survey.md",
  "target_type": "topic",
  "promoted_at": "2026-04-06T14:30:00.000Z",
  "promoted_by": "user",
  "source_hash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "source_title": "Transformer Architecture Survey",
  "source_word_count": 3200,
  "frontmatter_added": ["promoted_from", "promoted_at", "promoted_by"]
}
```

This file is append-only and immutable after creation, consistent with the L6 audit directory policy (012-AT-WPOL Section 8).

---

## 8. Audit Log Entry

Every promotion appends a one-line entry to `workspace/audit/log.md`. Format matches the existing log.md convention: timestamp, operation type, one-line summary.

```markdown
- **2026-04-06T14:30:00.000Z** — `promotion` — Promoted `outputs/reports/transformer-survey.md` → `wiki/topics/transformer-survey.md` as `topic` (user)
```

---

## 9. Eligibility Check Pipeline

The eligibility check runs all validations in order before the copy operation. If any check fails, the pipeline halts and returns the corresponding exit code.

```
Step 1: Path resolution
  └─ Resolve provided path to absolute
  └─ Verify path is descendant of workspace/outputs/
  └─ FAIL → exit 1 (INELIGIBLE_PATH)

Step 2: File existence
  └─ Verify file exists at resolved path
  └─ FAIL → exit 1 (FILE_NOT_FOUND)

Step 3: Non-empty check
  └─ Verify file size > 0 bytes
  └─ FAIL → exit 1 (EMPTY_FILE)

Step 4: Frontmatter check
  └─ Parse file with gray-matter
  └─ Verify YAML frontmatter block exists
  └─ Verify frontmatter contains at least a `title` field
  └─ FAIL → exit 1 (MISSING_FRONTMATTER)

Step 5: Type validation
  └─ Verify --as value is one of: topic, concept, entity, reference
  └─ FAIL → exit 2 (INVALID_TYPE)

Step 6: Anti-pattern detection
  └─ Check path does not match workspace/tasks/*/drafts/* pattern
  └─ Check path does not match workspace/tasks/*/evidence/* pattern
  └─ FAIL → exit 3 (ANTI_PATTERN_DETECTED)

Step 7: Target path computation
  └─ Extract title from frontmatter
  └─ Slugify title per 012-AT-WPOL Section 4.1 rules
  └─ Compute target: workspace/wiki/<type>/<slug>.md
  └─ Check for collision (file already exists at target)
  └─ FAIL on collision → exit 4 (TARGET_EXISTS)

Step 8: Confirmation
  └─ Display promotion summary
  └─ Require interactive y or --confirm flag
  └─ FAIL → exit 3 (NOT_CONFIRMED)
```

All eight steps must pass before the copy-and-audit phase begins.

---

## 10. Copy and Audit Phase

Once eligibility passes, the promotion executes in this order. Steps 2-5 are wrapped in a transaction (SQLite) with filesystem rollback.

```
Step 1: Compute source hash
  └─ SHA-256 of source file content
  └─ Store as sha256:<hex>

Step 2: Copy file
  └─ fs.copyFile(sourcePath, targetPath)
  └─ Verify copy succeeded (target exists, size matches)

Step 3: Mutate frontmatter on copied file
  └─ Read copied file with gray-matter
  └─ Add promoted_from, promoted_at, promoted_by fields
  └─ Write back to target path
  └─ Do NOT touch the original file in workspace/outputs/

Step 4: Write promotions table record
  └─ INSERT into promotions table (Section 5)

Step 5: Write trace event
  └─ Append promotion event to workspace/audit/traces/<date>.jsonl (Section 6)
  └─ INSERT trace index row into traces table

Step 6: Write promotion audit file
  └─ Write workspace/audit/promotions/<ulid>.jsonl (Section 7)

Step 7: Append to log.md
  └─ Append one-line entry to workspace/audit/log.md (Section 8)

Rollback on failure:
  └─ If steps 3-7 fail: delete the copied file at targetPath
  └─ If step 2 fails: nothing to roll back
  └─ Log the failure as a trace event with event_type "promotion" and an error payload
```

---

## 11. Frontmatter Mutation

The copied file (at the target path in `workspace/wiki/`) has three fields added to its YAML frontmatter. The original file in `workspace/outputs/` is never modified.

**Fields added:**

| Field           | Type   | Value                                                                                            |
| --------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `promoted_from` | string | Workspace-relative path of the original artifact (e.g., `outputs/reports/transformer-survey.md`) |
| `promoted_at`   | string | ISO 8601 UTC timestamp of the promotion                                                          |
| `promoted_by`   | string | `user` (always in Phase 1)                                                                       |

**Example frontmatter before promotion (in outputs/):**

```yaml
---
title: 'Transformer Architecture Survey'
format: report
task_id: task-20260406-001
rendered_at: '2026-04-06T10:00:04.567Z'
---
```

**Example frontmatter after promotion (in wiki/topics/):**

```yaml
---
title: 'Transformer Architecture Survey'
format: report
task_id: task-20260406-001
rendered_at: '2026-04-06T10:00:04.567Z'
promoted_from: 'outputs/reports/transformer-survey.md'
promoted_at: '2026-04-06T14:30:00.000Z'
promoted_by: 'user'
---
```

---

## 12. Target Path Computation

The target path is deterministically computed from the `--as` type and the source file's frontmatter title.

**Algorithm:**

1. Extract the `title` field from the source file's YAML frontmatter.
2. Slugify the title per 012-AT-WPOL Section 4.1 slug sanitization rules:
   - Lowercase, `a-z` digits `0-9` hyphens only
   - Maximum 80 characters
   - No consecutive, leading, or trailing hyphens
   - Replace spaces and underscores with hyphens
   - Transliterate Unicode to ASCII
3. Append `.md` extension.
4. Construct path: `workspace/wiki/<type>/<slug>.md`

**Type-to-directory mapping:**

| `--as` value | Target directory           |
| ------------ | -------------------------- |
| `topic`      | `workspace/wiki/topics/`   |
| `concept`    | `workspace/wiki/concepts/` |
| `entity`     | `workspace/wiki/entities/` |
| `reference`  | `workspace/wiki/sources/`  |

**Collision handling:** If a file already exists at the computed target path, the promotion is rejected with exit code 4 and the message: `Target path already exists: <path>. Rename the existing page or choose a different title before promoting.` The system does not auto-suffix with `-v2` or similar — the operator resolves naming conflicts manually.

---

## 13. Policy Enforcement Points

Three enforcement points in the promotion pipeline ensure policy compliance. Each point is a function call in the kernel that must return success before execution continues.

### 13.1 Pre-copy validation

**When:** After the eligibility check (Section 9), before `fs.copyFile`.

**What it checks:**

- All seven promotion rules (Section 3) pass
- All three anti-patterns (Section 4) are not detected
- Target directory exists (create it if not, per workspace init policy)
- Workspace lockfile acquired (012-AT-WPOL, 010-AT-DBSC Section 2.1)

**On failure:** Abort promotion. No files are created or modified.

### 13.2 Post-copy audit write

**When:** Immediately after the file copy and frontmatter mutation succeed.

**What it does:**

- Writes the `promotions` table record
- Emits the `promotion` trace event
- Writes the promotion audit file
- Appends to `log.md`

**On failure:** Delete the copied file. Release lockfile. Return exit code 5. The promotion did not happen — the database and audit trail must not contain a record for a promotion whose file copy was rolled back.

### 13.3 Lint integration

**When:** On subsequent `ico lint knowledge` runs.

**What it checks:**

- Promoted pages have valid frontmatter including `promoted_from`, `promoted_at`, `promoted_by`
- The `promoted_from` path still exists in `workspace/outputs/` (copy-not-move verification)
- The promoted page conforms to the schema for its type (same lint rules as compiler-generated pages)
- The promotion has a corresponding record in the `promotions` table

**Lint output:**

| Lint code | Severity | Description                                                                                         |
| --------- | -------- | --------------------------------------------------------------------------------------------------- |
| `PROM001` | warning  | Source file missing from outputs (copy-not-move violated — manual deletion is fine, but lint warns) |
| `PROM002` | error    | Promoted page missing `promoted_from` frontmatter field                                             |
| `PROM003` | error    | Promoted page has no corresponding promotions table record                                          |
| `PROM004` | error    | Promoted page frontmatter does not conform to wiki type schema                                      |

---

## 14. Zod Validation Schemas

Runtime validation for promotion inputs and records uses Zod. These schemas are defined in `packages/types/` and used by the kernel.

```typescript
import { z } from 'zod';

// Promotion target types
export const PromotionType = z.enum(['topic', 'concept', 'entity', 'reference']);
export type PromotionType = z.infer<typeof PromotionType>;

// Promotion command input
export const PromotionInput = z.object({
  sourcePath: z.string().min(1),
  targetType: PromotionType,
  confirm: z.boolean().default(false),
});
export type PromotionInput = z.infer<typeof PromotionInput>;

// Promotion database record
export const PromotionRecord = z.object({
  id: z.string().ulid(),
  source_path: z.string().min(1),
  target_path: z.string().min(1),
  target_type: PromotionType,
  promoted_at: z.string().datetime(),
  promoted_by: z.enum(['user', 'system']),
});
export type PromotionRecord = z.infer<typeof PromotionRecord>;

// Promotion trace payload
export const PromotionTracePayload = z.object({
  source_path: z.string().min(1),
  target_path: z.string().min(1),
  target_type: PromotionType,
  actor: z.enum(['user', 'system']),
  source_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type PromotionTracePayload = z.infer<typeof PromotionTracePayload>;

// Promotion audit file record
export const PromotionAuditRecord = z.object({
  promotion_id: z.string().ulid(),
  source_path: z.string().min(1),
  target_path: z.string().min(1),
  target_type: PromotionType,
  promoted_at: z.string().datetime(),
  promoted_by: z.enum(['user', 'system']),
  source_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source_title: z.string().min(1),
  source_word_count: z.number().int().nonnegative(),
  frontmatter_added: z.array(z.string()),
});
export type PromotionAuditRecord = z.infer<typeof PromotionAuditRecord>;
```

---

## 15. Error Taxonomy

All promotion errors use a structured error type. The kernel throws `PromotionError` with a code and message. The CLI catches and formats the error for the operator.

| Error Code            | Exit Code | Trigger                                                  |
| --------------------- | --------- | -------------------------------------------------------- |
| `INELIGIBLE_PATH`     | 1         | Source path not in `workspace/outputs/`                  |
| `FILE_NOT_FOUND`      | 1         | Source file does not exist                               |
| `EMPTY_FILE`          | 1         | Source file is 0 bytes                                   |
| `MISSING_FRONTMATTER` | 1         | Source file has no YAML frontmatter or no `title` field  |
| `INVALID_TYPE`        | 2         | `--as` value not in allowed set                          |
| `DRAFT_REJECTED`      | 3         | File path matches task drafts pattern                    |
| `EVIDENCE_REJECTED`   | 3         | File path matches task evidence pattern                  |
| `NOT_CONFIRMED`       | 3         | Operator did not confirm promotion                       |
| `TARGET_EXISTS`       | 4         | File already exists at computed target path              |
| `COPY_FAILED`         | 4         | `fs.copyFile` threw an error                             |
| `AUDIT_WRITE_FAILED`  | 5         | Database insert, trace write, or audit file write failed |

---

## 16. Sequence Diagram

Complete promotion flow from CLI invocation to audit completion.

```
Operator                    CLI                     Kernel                     SQLite          Filesystem
   │                         │                        │                          │                │
   │  ico promote <path>     │                        │                          │                │
   │  --as topic --confirm   │                        │                          │                │
   │────────────────────────>│                        │                          │                │
   │                         │  promote(input)        │                          │                │
   │                         │───────────────────────>│                          │                │
   │                         │                        │  1. resolve path         │                │
   │                         │                        │  2. check in outputs/    │                │
   │                         │                        │  3. check file exists    │                │
   │                         │                        │  4. check non-empty      │                │
   │                         │                        │  5. parse frontmatter    │                │
   │                         │                        │  6. validate --as type   │                │
   │                         │                        │  7. anti-pattern check   │                │
   │                         │                        │  8. compute target path  │                │
   │                         │                        │  9. check no collision   │                │
   │                         │                        │  10. acquire lockfile    │                │
   │                         │                        │                          │                │
   │                         │                        │  11. compute source hash │                │
   │                         │                        │───────────────────────────────────────────>│
   │                         │                        │                          │   copyFile     │
   │                         │                        │<───────────────────────────────────────────│
   │                         │                        │                          │                │
   │                         │                        │  12. mutate frontmatter  │                │
   │                         │                        │───────────────────────────────────────────>│
   │                         │                        │                          │  write target  │
   │                         │                        │<───────────────────────────────────────────│
   │                         │                        │                          │                │
   │                         │                        │  13. INSERT promotions   │                │
   │                         │                        │─────────────────────────>│                │
   │                         │                        │                          │                │
   │                         │                        │  14. INSERT traces       │                │
   │                         │                        │─────────────────────────>│                │
   │                         │                        │                          │                │
   │                         │                        │  15. write audit file    │                │
   │                         │                        │───────────────────────────────────────────>│
   │                         │                        │                          │                │
   │                         │                        │  16. append log.md       │                │
   │                         │                        │───────────────────────────────────────────>│
   │                         │                        │                          │                │
   │                         │                        │  17. release lockfile    │                │
   │                         │                        │                          │                │
   │                         │  { success, record }   │                          │                │
   │                         │<───────────────────────│                          │                │
   │  "Promoted to wiki/     │                        │                          │                │
   │   topics/transformer-   │                        │                          │                │
   │   survey.md"            │                        │                          │                │
   │<────────────────────────│                        │                          │                │
```

---

## 17. Cross-Reference Map

| Concept           | This Document | Blueprint   | Database Schema | Trace Schema | Workspace Policy | Glossary   |
| ----------------- | ------------- | ----------- | --------------- | ------------ | ---------------- | ---------- |
| Promotion rules   | Section 3     | Section 7.1 | —               | —            | —                | Section 9  |
| Anti-patterns     | Section 4     | Section 7.2 | —               | —            | —                | Section 9  |
| Promotions table  | Section 5     | Section 7   | Section 3.5     | —            | —                | —          |
| Trace event       | Section 6     | Section 5.5 | Section 3.7     | Section 6.9  | —                | Section 12 |
| Audit file        | Section 7     | —           | —               | —            | Section 3 (L6)   | —          |
| Log entry         | Section 8     | Section 5.5 | —               | —            | Section 3 (L6)   | Section 12 |
| Eligibility check | Section 9     | Section 7.1 | —               | —            | Section 3 (L4)   | —          |
| Target path       | Section 12    | Section 11  | —               | —            | Section 4        | —          |
| Slug rules        | Section 12    | —           | —               | —            | Section 4.1      | —          |
| Lint codes        | Section 13.3  | —           | —               | —            | Section 11       | —          |
| Zod schemas       | Section 14    | —           | Section 3.5     | Section 6.9  | —                | —          |

---

## 18. Versioning

This specification is frozen for Phase 1. Changes require:

1. An entry in `000-docs/IDEA-CHANGELOG.md` with rationale
2. Update to this document with new version number
3. Corresponding migration if the `promotions` table schema changes
4. Update to 011-AT-TRSC if the `promotion` trace payload changes
5. Review of all documents referencing promotion logic
