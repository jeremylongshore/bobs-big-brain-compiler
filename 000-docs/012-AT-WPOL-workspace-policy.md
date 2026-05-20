# Workspace Directory Policy

> Where every file lives, why, and what can happen to it.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Purpose

This document is the authoritative reference for the `workspace/` directory tree. It specifies the storage location, data classification, mutability rules, naming conventions, gitignore policy, and enforcement mechanisms for every directory in the ICO workspace layout.

All directories and rules map directly to the six-layer architecture defined in the Master Blueprint (Section 5) and the workspace layout defined in Section 11.

---

## 2. Directory Tree Overview

```text
workspace/
├── raw/                  # L1: Canonical (append-only)
│   ├── articles/
│   ├── papers/
│   ├── repos/
│   └── notes/
├── wiki/                 # L2: Compiled (recompilable)
│   ├── index.md
│   ├── sources/
│   ├── concepts/
│   ├── entities/
│   ├── topics/
│   ├── contradictions/
│   ├── open-questions/
│   └── indexes/
├── tasks/                # L3: Ephemeral (per-task lifecycle)
│   └── <task-id>/
│       ├── evidence/
│       ├── notes/
│       ├── drafts/
│       ├── critique/
│       └── output/
├── outputs/              # L4: Durable
│   ├── reports/
│   ├── slides/
│   ├── charts/
│   └── briefings/
├── recall/               # L5: Adaptive
│   ├── cards/
│   ├── decks/
│   ├── quizzes/
│   └── retention/
└── audit/                # L6: Audit (append-only)
    ├── log.md
    ├── traces/
    ├── provenance/
    ├── policy/
    └── promotions/
```

---

## 3. Data Classification by Directory

Every file in the workspace has exactly one classification. The classification determines what can happen to that file after it is written.

| Directory                             | Layer | Classification | Definition                                       | Mutability         | Write Policy                                  |
| ------------------------------------- | ----- | -------------- | ------------------------------------------------ | ------------------ | --------------------------------------------- |
| `workspace/raw/`                      | L1    | **Canonical**  | Source-of-truth inputs the system never modifies | Append-only        | Write once on ingest, never mutate            |
| `workspace/raw/articles/`             | L1    | Canonical      | Web-clipped articles and blog posts              | Append-only        | Write once on ingest, never mutate            |
| `workspace/raw/papers/`               | L1    | Canonical      | Academic papers and PDFs                         | Append-only        | Write once on ingest, never mutate            |
| `workspace/raw/repos/`                | L1    | Canonical      | Cloned repository snapshots                      | Append-only        | Write once on ingest, never mutate            |
| `workspace/raw/notes/`                | L1    | Canonical      | User-authored notes and transcripts              | Append-only        | Write once on ingest, never mutate            |
| `workspace/wiki/`                     | L2    | **Compiled**   | Derived from L1 via compilation passes           | Recompilable       | Overwritten on recompilation only             |
| `workspace/wiki/index.md`             | L2    | Compiled       | Auto-generated catalog of all compiled pages     | Recompilable       | Rebuilt automatically on compilation          |
| `workspace/wiki/sources/`             | L2    | Compiled       | Per-source summary pages                         | Recompilable       | Overwritten on recompilation only             |
| `workspace/wiki/concepts/`            | L2    | Compiled       | Extracted concept definitions                    | Recompilable       | Overwritten on recompilation only             |
| `workspace/wiki/entities/`            | L2    | Compiled       | Entity pages (people, orgs, tools)               | Recompilable       | Overwritten on recompilation only             |
| `workspace/wiki/topics/`              | L2    | Compiled       | Cross-source topic synthesis pages               | Recompilable       | Overwritten on recompilation only             |
| `workspace/wiki/contradictions/`      | L2    | Compiled       | Flagged conflicts between sources                | Recompilable       | Overwritten on recompilation only             |
| `workspace/wiki/open-questions/`      | L2    | Compiled       | Identified knowledge gaps                        | Recompilable       | Overwritten on recompilation only             |
| `workspace/wiki/indexes/`             | L2    | Compiled       | Semantic indexes and cross-references            | Recompilable       | Overwritten on recompilation only             |
| `workspace/tasks/`                    | L3    | **Ephemeral**  | Temporary scoped research workspaces             | Per-task lifecycle | Created on task start, archived on completion |
| `workspace/tasks/<task-id>/evidence/` | L3    | Ephemeral      | Gathered evidence from L2                        | Per-task lifecycle | Written by collector agents                   |
| `workspace/tasks/<task-id>/notes/`    | L3    | Ephemeral      | Working notes and summaries                      | Per-task lifecycle | Written by summarizer agents                  |
| `workspace/tasks/<task-id>/drafts/`   | L3    | Ephemeral      | Draft outputs in progress                        | Per-task lifecycle | Written by integrator agents                  |
| `workspace/tasks/<task-id>/critique/` | L3    | Ephemeral      | Skeptic challenges and counter-arguments         | Per-task lifecycle | Written by skeptic agents                     |
| `workspace/tasks/<task-id>/output/`   | L3    | Ephemeral      | Final task deliverables                          | Per-task lifecycle | Written by builder agents                     |
| `workspace/outputs/`                  | L4    | **Durable**    | Rendered artifacts intended for reuse            | Permanent          | Written on render, deleted only by user       |
| `workspace/outputs/reports/`          | L4    | Durable        | Markdown reports                                 | Permanent          | Written by `ico render report`                |
| `workspace/outputs/slides/`           | L4    | Durable        | Marp slide decks                                 | Permanent          | Written by `ico render slides`                |
| `workspace/outputs/charts/`           | L4    | Durable        | Data visualizations                              | Permanent          | Written by render pipeline                    |
| `workspace/outputs/briefings/`        | L4    | Durable        | Executive briefings                              | Permanent          | Written by render pipeline                    |
| `workspace/recall/`                   | L5    | **Adaptive**   | Human retention materials modified by feedback   | Adaptive           | Generated from L2, updated by quiz results    |
| `workspace/recall/cards/`             | L5    | Adaptive       | Individual flashcard files                       | Adaptive           | Generated and updated per concept             |
| `workspace/recall/decks/`             | L5    | Adaptive       | Grouped flashcard collections                    | Adaptive           | Rebuilt on generation                         |
| `workspace/recall/quizzes/`           | L5    | Adaptive       | Quiz question sets                               | Adaptive           | Rebuilt on generation                         |
| `workspace/recall/retention/`         | L5    | Adaptive       | Retention scores and performance data            | Adaptive           | Updated after each quiz session               |
| `workspace/audit/`                    | L6    | **Audit**      | Deterministic control data and traces            | Append-only        | Written by kernel, never mutated              |
| `workspace/audit/log.md`              | L6    | Audit          | Chronological human-readable operation digest    | Append-only        | Appended by kernel on each operation          |
| `workspace/audit/traces/`             | L6    | Audit          | JSONL event traces per operation                 | Append-only        | One file per traced operation                 |
| `workspace/audit/provenance/`         | L6    | Audit          | Source-to-derived mapping records                | Append-only        | Written on compilation                        |
| `workspace/audit/policy/`             | L6    | Audit          | Policy decision records                          | Append-only        | Written on policy evaluation                  |
| `workspace/audit/promotions/`         | L6    | Audit          | Promotion event log                              | Append-only        | Written on each `ico promote`                 |

---

## 4. Naming Conventions

### 4.1 Slug Sanitization Rules

All filenames generated by the system use slugified names. The slug rules are:

| Rule                   | Specification                                                            |
| ---------------------- | ------------------------------------------------------------------------ |
| Character set          | Lowercase `a-z`, digits `0-9`, hyphens `-`                               |
| Maximum length         | 80 characters                                                            |
| No consecutive hyphens | `my--file` is invalid                                                    |
| No leading hyphens     | `-my-file` is invalid                                                    |
| No trailing hyphens    | `my-file-` is invalid                                                    |
| No leading digits      | `123-file` is invalid; use `file-123`                                    |
| Whitespace handling    | Replace spaces and underscores with single hyphens                       |
| Unicode handling       | Transliterate to ASCII, then apply slug rules                            |
| Extension preserved    | Slug applies to the stem only; extension is appended after slugification |

**Valid examples:**

| Input                      | Slugified Output            |
| -------------------------- | --------------------------- |
| `My Research Paper (2024)` | `my-research-paper-2024.md` |
| `machine_learning_intro`   | `machine-learning-intro.md` |
| `Dr. John Smith`           | `dr-john-smith.md`          |
| `API vs REST vs GraphQL`   | `api-vs-rest-vs-graphql.md` |
| `topic: Neural Networks`   | `topic-neural-networks.md`  |

**Invalid examples:**

| Input                | Rejected Slug        | Reason                                  |
| -------------------- | -------------------- | --------------------------------------- |
| `--double-start`     | `--double-start`     | Leading hyphens                         |
| `too-many---hyphens` | `too-many---hyphens` | Consecutive hyphens                     |
| `trailing-`          | `trailing-`          | Trailing hyphen                         |
| `UPPER_CASE`         | `UPPER_CASE`         | Contains uppercase (must be lowercased) |
| (81+ chars)          | (truncated)          | Exceeds 80-character limit              |

### 4.2 Per-Directory Naming Patterns

| Directory              | Pattern                        | Example                                  |
| ---------------------- | ------------------------------ | ---------------------------------------- |
| `raw/articles/`        | `<slug>.<original-ext>`        | `attention-is-all-you-need.pdf`          |
| `raw/papers/`          | `<slug>.<original-ext>`        | `transformer-architecture-survey.pdf`    |
| `raw/repos/`           | `<repo-slug>/` (directory)     | `langchain-core/`                        |
| `raw/notes/`           | `<slug>.md`                    | `meeting-notes-2026-04-01.md`            |
| `wiki/sources/`        | `<source-slug>.md`             | `attention-is-all-you-need.md`           |
| `wiki/concepts/`       | `<concept-slug>.md`            | `self-attention-mechanism.md`            |
| `wiki/entities/`       | `<entity-slug>.md`             | `openai.md`                              |
| `wiki/topics/`         | `<topic-slug>.md`              | `transformer-architectures.md`           |
| `wiki/contradictions/` | `<slug>.md`                    | `scaling-laws-disagreement.md`           |
| `wiki/open-questions/` | `<slug>.md`                    | `attention-complexity-bounds.md`         |
| `wiki/indexes/`        | `<index-type>.md`              | `by-topic.md`, `by-source.md`            |
| `tasks/<task-id>/`     | `tsk-<ulid>/`                  | `tsk-01HXK3V9P7Q8R2S4T6W8Y0Z1/`          |
| `tasks/<id>/evidence/` | `<source-slug>.md`             | `attention-is-all-you-need.md`           |
| `tasks/<id>/notes/`    | `<slug>.md`                    | `key-findings-round-1.md`                |
| `tasks/<id>/drafts/`   | `draft-<n>.md`                 | `draft-01.md`, `draft-02.md`             |
| `tasks/<id>/critique/` | `<slug>.md`                    | `weak-evidence-claims.md`                |
| `tasks/<id>/output/`   | `<slug>.<ext>`                 | `final-report.md`                        |
| `outputs/reports/`     | `<slug>.md`                    | `transformer-survey-report.md`           |
| `outputs/slides/`      | `<slug>.md`                    | `transformer-survey-slides.md`           |
| `outputs/charts/`      | `<slug>.<ext>`                 | `scaling-law-comparison.png`             |
| `outputs/briefings/`   | `<slug>.md`                    | `q2-research-briefing.md`                |
| `recall/cards/`        | `<concept-slug>.md`            | `self-attention-mechanism.md`            |
| `recall/decks/`        | `<topic-slug>.md`              | `transformer-architectures.md`           |
| `recall/quizzes/`      | `<slug>.md`                    | `transformers-quiz-01.md`                |
| `recall/retention/`    | `<concept-slug>.json`          | `self-attention-mechanism.json`          |
| `audit/traces/`        | `<operation>-<ulid>.jsonl`     | `compile-01HXK3V9P7Q8R2S4T6W8Y0Z1.jsonl` |
| `audit/provenance/`    | `<source-slug>.jsonl`          | `attention-is-all-you-need.jsonl`        |
| `audit/policy/`        | `<decision-type>-<ulid>.jsonl` | `promote-01HXK3V9P7Q8R2S4T6W8Y0Z1.jsonl` |
| `audit/promotions/`    | `<ulid>.jsonl`                 | `01HXK3V9P7Q8R2S4T6W8Y0Z1.jsonl`         |

---

## 5. Gitignore Policy

The `.gitignore` rules determine what enters version control and what stays local. These rules reflect data classification: canonical and ephemeral data is local-only; compiled and audit data is tracked.

### 5.1 Current .gitignore Entries (workspace section)

```gitignore
# ===== Workspace =====
workspace/raw/
workspace/tasks/
workspace/outputs/
workspace/recall/
workspace/audit/
```

### 5.2 Per-Directory Git Policy

| Directory                 | Tracked                                                   | Rationale                                                                                                                                           |
| ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace/raw/`          | **No** — gitignored                                       | Source files are user data, often large binaries (PDFs). Not suitable for version control. Backed up by the user independently.                     |
| `workspace/wiki/`         | **Yes** — tracked                                         | Compiled knowledge is the primary intellectual asset. Version history enables diff, blame, and rollback of compilation output.                      |
| `workspace/wiki/index.md` | **Yes** — tracked                                         | Auto-rebuilt catalog; tracked to show knowledge evolution over time.                                                                                |
| `workspace/tasks/`        | **No** — gitignored                                       | Ephemeral working data. Archived tasks may be large and contain intermediate artifacts not worth versioning.                                        |
| `workspace/outputs/`      | **No** — gitignored (selective tracking via `git add -f`) | Durable outputs are often large (slides, charts). Selectively force-add specific reports the user wants versioned.                                  |
| `workspace/recall/`       | **No** — gitignored                                       | Retention data is personal, adaptive, and frequently updated. Not useful in version control.                                                        |
| `workspace/audit/`        | **No** — gitignored                                       | Audit traces are append-only JSONL files that grow continuously. Tracked operationally, not via git. `audit/log.md` may be selectively force-added. |

### 5.3 Selective Tracking

For directories that are gitignored by default, operators may selectively track specific files:

```bash
# Force-track a specific report
git add -f workspace/outputs/reports/quarterly-analysis.md

# Force-track the human-readable audit log
git add -f workspace/audit/log.md
```

The system never auto-commits workspace files. Selective tracking is always an explicit operator decision.

---

## 6. Symlink Policy

**Rule: No symlinks in `workspace/raw/`. Ingest copies content.**

### 6.1 Rationale

Symlinks in the canonical layer create three failure modes:

1. **Broken references.** If the symlink target is moved, renamed, or deleted, the canonical layer silently loses data.
2. **Hash instability.** Content hashing for dedup and staleness detection must operate on file content, not link targets. Symlinks make the hash ambiguous.
3. **Portability.** Workspaces must be portable across machines. Symlinks to absolute paths break on copy, sync, or backup.

### 6.2 Enforcement

| Stage                    | Behavior                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ico ingest <path>`      | If `<path>` is a symlink, resolve it and copy the target content. Log a warning: `symlink resolved: copied content from <target>`.         |
| `ico ingest <directory>` | Walk the directory. For each symlink encountered, resolve and copy. Log each resolution.                                                   |
| Startup validation       | On `ico status` and `ico lint knowledge`, scan `workspace/raw/` for any symlinks. Report as lint warning: `symlink found in raw/: <path>`. |

### 6.3 Other Directories

Symlinks are permitted in `workspace/wiki/`, `workspace/tasks/`, `workspace/outputs/`, `workspace/recall/`, and `workspace/audit/` only for internal cross-referencing within the workspace tree. Symlinks pointing outside the workspace root are rejected everywhere.

---

## 7. File Size Limits

File size limits are enforced at ingest time to prevent the workspace from accumulating oversized files that degrade performance, complicate backup, and waste storage.

### 7.1 Limits by Source Type

| Source Type | File Extension(s)                                              | Max Size | Rationale                                                                                                       |
| ----------- | -------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| PDF         | `.pdf`                                                         | 50 MB    | Academic papers and reports; larger files indicate scanned images or embedded media that should be preprocessed |
| Markdown    | `.md`, `.mdx`                                                  | 5 MB     | Text-only; files above this are likely generated dumps, not authored content                                    |
| HTML        | `.html`, `.htm`                                                | 10 MB    | Web clips; larger files contain embedded assets that should be stripped                                         |
| Plain text  | `.txt`, `.text`                                                | 5 MB     | Log files and transcripts; larger files should be split before ingest                                           |
| Source code | `.ts`, `.js`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.h` | 2 MB     | Individual source files; repos should be ingested as directories                                                |
| JSON / YAML | `.json`, `.yaml`, `.yml`                                       | 10 MB    | Config and data files; larger datasets need preprocessing                                                       |
| Images      | `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`                        | 20 MB    | Reference diagrams; not a primary ingest target                                                                 |
| Other       | `*`                                                            | 5 MB     | Default conservative limit for unlisted types                                                                   |

### 7.2 Enforcement

| Stage                       | Behavior                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ico ingest <path>`         | Check file size before copy. If over limit, reject with error: `file exceeds size limit for type <type>: <size> > <limit>`. |
| `ico ingest <path> --force` | Override size limit with explicit flag. Log warning to audit: `size limit overridden: <path> (<size>)`.                     |
| Configuration               | Limits are configurable in `workspace/audit/policy/size-limits.json`. Default values match this table.                      |

### 7.3 Aggregate Limits

No per-directory aggregate limit is enforced in Phase 1. The system logs total workspace size on `ico status` to provide visibility. Aggregate limits may be introduced in Phase 3+ if workspace bloat becomes a practical concern.

---

## 8. Read-Only Enforcement

Two directories require read-only enforcement after initial write: `workspace/raw/` (canonical sources) and `workspace/audit/` (audit traces). No file in these directories is ever modified in place after creation.

### 8.1 What "Read-Only After Write" Means

| Property | Definition                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| Create   | Permitted. New files are written on ingest (raw) or on operation completion (audit).                         |
| Read     | Permitted. Any component can read files in these directories.                                                |
| Update   | **Forbidden.** No file is modified after initial write.                                                      |
| Delete   | **Forbidden** for audit. **Operator-only** for raw (via explicit `ico raw delete <path>` with confirmation). |
| Rename   | **Forbidden.** Renaming changes identity; treat as delete + create.                                          |

### 8.2 Enforcement Mechanism

Read-only enforcement operates at three levels:

| Level           | Mechanism                                                                                                                                                                          | When                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Application** | Kernel write functions for `raw/` and `audit/` reject overwrite attempts. All writes go through `kernel/src/workspace.ts` — direct filesystem writes are prohibited by convention. | Every write operation     |
| **Filesystem**  | After writing a file to `raw/` or `audit/`, the kernel sets the file permission to `0444` (read-only for all). This provides OS-level protection against accidental overwrites.    | Post-write hook in kernel |
| **Lint**        | `ico lint knowledge` scans `raw/` and `audit/` for files with write permissions (`0644` or `0666`). Reports as lint error: `writable file in read-only directory: <path>`.         | On lint or status         |

### 8.3 Correction of Raw Sources

If a source in `raw/` needs to be replaced (e.g., a better scan of a paper):

1. Ingest the new version. It receives a new content hash and a new filename if the slug collides (appended with `-v2`, `-v3`, etc.).
2. The old version remains in place. It is never overwritten.
3. Recompilation picks up the new version based on the updated hash in the sources table.
4. The operator may delete the old version via `ico raw delete <path>` (requires confirmation, logs to audit).

### 8.4 Audit Immutability

Files in `workspace/audit/` are never deleted, overwritten, or truncated by any system operation. The only exception is workspace destruction (`ico workspace destroy --confirm`), which removes the entire workspace tree.

The `audit/log.md` file is append-only: new entries are appended to the end of the file. The file is never rewritten from scratch. If it becomes unwieldy, the operator can archive it manually and the system starts a new `log.md`.

---

## 9. Directory Initialization

When `ico init <name>` creates a new workspace, it creates the full directory tree with `.gitkeep` files in empty directories to ensure the structure is preserved in version control where applicable.

### 9.1 Created Directories

```text
workspace/
workspace/raw/
workspace/raw/articles/
workspace/raw/papers/
workspace/raw/repos/
workspace/raw/notes/
workspace/wiki/
workspace/wiki/sources/
workspace/wiki/concepts/
workspace/wiki/entities/
workspace/wiki/topics/
workspace/wiki/contradictions/
workspace/wiki/open-questions/
workspace/wiki/indexes/
workspace/tasks/
workspace/outputs/
workspace/outputs/reports/
workspace/outputs/slides/
workspace/outputs/charts/
workspace/outputs/briefings/
workspace/recall/
workspace/recall/cards/
workspace/recall/decks/
workspace/recall/quizzes/
workspace/recall/retention/
workspace/audit/
workspace/audit/traces/
workspace/audit/provenance/
workspace/audit/policy/
workspace/audit/promotions/
```

### 9.2 Created Files

| File                                      | Content                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `workspace/wiki/index.md`                 | Empty catalog with frontmatter stub                          |
| `workspace/audit/log.md`                  | Header line: `# ICO Audit Log` with initialization timestamp |
| `workspace/audit/policy/size-limits.json` | Default size limits matching Section 7.1                     |

### 9.3 Gitkeep Policy

Place `.gitkeep` in every subdirectory under `workspace/wiki/` (tracked). Do not place `.gitkeep` in gitignored directories — they are created by the kernel at runtime and do not need to exist in version control.

---

## 10. Directory-to-Blueprint Mapping

Every workspace directory maps to a specific layer and section in the Master Blueprint (007-PP-PLAN).

| Directory                        | Blueprint Layer         | Blueprint Section     | Classification | Deterministic Owner       |
| -------------------------------- | ----------------------- | --------------------- | -------------- | ------------------------- |
| `workspace/raw/`                 | L1 — Raw Corpus         | 5.1, 5.2              | Canonical      | Kernel (ingest)           |
| `workspace/raw/articles/`        | L1                      | 5.1                   | Canonical      | Kernel (ingest)           |
| `workspace/raw/papers/`          | L1                      | 5.1                   | Canonical      | Kernel (ingest)           |
| `workspace/raw/repos/`           | L1                      | 5.1                   | Canonical      | Kernel (ingest)           |
| `workspace/raw/notes/`           | L1                      | 5.1                   | Canonical      | Kernel (ingest)           |
| `workspace/wiki/`                | L2 — Semantic Knowledge | 5.1, 5.2, 6.1         | Compiled       | Compiler (all passes)     |
| `workspace/wiki/index.md`        | L2                      | 5.5                   | Compiled       | Kernel (auto-rebuild)     |
| `workspace/wiki/sources/`        | L2                      | 6.1 (Summarize pass)  | Compiled       | Compiler (summarize)      |
| `workspace/wiki/concepts/`       | L2                      | 6.1 (Extract pass)    | Compiled       | Compiler (extract)        |
| `workspace/wiki/entities/`       | L2                      | 6.1 (Extract pass)    | Compiled       | Compiler (extract)        |
| `workspace/wiki/topics/`         | L2                      | 6.1 (Synthesize pass) | Compiled       | Compiler (synthesize)     |
| `workspace/wiki/contradictions/` | L2                      | 6.1 (Contradict pass) | Compiled       | Compiler (contradict)     |
| `workspace/wiki/open-questions/` | L2                      | 6.1 (Gap pass)        | Compiled       | Compiler (gap)            |
| `workspace/wiki/indexes/`        | L2                      | 6.1 (Link pass)       | Compiled       | Compiler (link)           |
| `workspace/tasks/`               | L3 — Episodic Tasks     | 5.1, 5.2, 8.1         | Ephemeral      | Kernel (task lifecycle)   |
| `workspace/tasks/<id>/evidence/` | L3                      | 8.2                   | Ephemeral      | Collector agents          |
| `workspace/tasks/<id>/notes/`    | L3                      | 8.2                   | Ephemeral      | Summarizer agents         |
| `workspace/tasks/<id>/drafts/`   | L3                      | 8.2                   | Ephemeral      | Integrator agents         |
| `workspace/tasks/<id>/critique/` | L3                      | 8.2                   | Ephemeral      | Skeptic agents            |
| `workspace/tasks/<id>/output/`   | L3                      | 8.2, 8.3              | Ephemeral      | Builder agents            |
| `workspace/outputs/`             | L4 — Artifacts          | 5.1, 5.2, 7.1         | Durable        | Kernel (render + promote) |
| `workspace/outputs/reports/`     | L4                      | 7.1                   | Durable        | Render pipeline           |
| `workspace/outputs/slides/`      | L4                      | 7.1                   | Durable        | Render pipeline           |
| `workspace/outputs/charts/`      | L4                      | 7.1                   | Durable        | Render pipeline           |
| `workspace/outputs/briefings/`   | L4                      | 7.1                   | Durable        | Render pipeline           |
| `workspace/recall/`              | L5 — Recall             | 5.1, 5.2, 9.1         | Adaptive       | Kernel (recall lifecycle) |
| `workspace/recall/cards/`        | L5                      | 9.2                   | Adaptive       | Recall generator          |
| `workspace/recall/decks/`        | L5                      | 9.2                   | Adaptive       | Recall generator          |
| `workspace/recall/quizzes/`      | L5                      | 9.2                   | Adaptive       | Recall generator          |
| `workspace/recall/retention/`    | L5                      | 9.3                   | Adaptive       | Quiz feedback loop        |
| `workspace/audit/`               | L6 — Audit & Policy     | 5.1, 5.2, 5.5         | Audit          | Kernel (all operations)   |
| `workspace/audit/log.md`         | L6                      | 5.5                   | Audit          | Kernel (append-only)      |
| `workspace/audit/traces/`        | L6                      | 5.5                   | Audit          | Kernel (per-operation)    |
| `workspace/audit/provenance/`    | L6                      | 5.3                   | Audit          | Kernel (on compilation)   |
| `workspace/audit/policy/`        | L6                      | 5.3                   | Audit          | Kernel (on policy eval)   |
| `workspace/audit/promotions/`    | L6                      | 7.1                   | Audit          | Kernel (on promote)       |

---

## 11. Summary of Invariants

These rules are enforced by the kernel and validated by `ico lint knowledge`. Violation of any invariant is a lint error.

1. **No file in `workspace/raw/` is modified after creation.** New versions are new files.
2. **No file in `workspace/audit/` is modified or deleted.** Append-only, always.
3. **No symlinks exist in `workspace/raw/`.** Ingest resolves and copies.
4. **No symlinks point outside the workspace root** in any directory.
5. **All system-generated filenames conform to the slug rules** in Section 4.1.
6. **No file exceeds its type-specific size limit** unless ingested with `--force`.
7. **Files in `workspace/raw/` and `workspace/audit/` have permission `0444`** after write.
8. **Every file in `workspace/wiki/` has valid YAML frontmatter** conforming to the compilation schema for its type.
9. **Task directories under `workspace/tasks/` follow the `tsk-<ulid>/` naming pattern.**
10. **The model never writes directly to `workspace/audit/` or `workspace/audit/policy/`.** All audit writes go through the kernel's deterministic control plane.
