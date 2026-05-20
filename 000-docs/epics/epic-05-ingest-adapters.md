# Epic 5: Ingest Adapters and Source Identity

**Objective:** Get real source material into the system cleanly. After this epic, the system can ingest markdown, PDF, and web-clip sources with full metadata extraction, content hashing, and provenance tracking. Ingest is source-by-source and human-in-the-loop by default.

**Why it exists:** The system is only as good as what goes in. Without proper adapters for different source types, metadata extraction, deduplication, and human review, the knowledge base will have garbage-in quality problems from day one.

**What it unlocks:** Epic 6 (compiler needs sources to compile)

**Dependencies:** Epics 3 and 4

**Phase:** 1

---

## Scope

### Included

- Markdown ingest adapter (frontmatter extraction, title detection, word count)
- PDF ingest adapter (pdf-parse text extraction, metadata)
- Web-clip ingest adapter (HTML to markdown conversion)
- Adapter registry with type detection
- Full ingest pipeline integration (adapter → copy → register → provenance → trace → audit)
- Duplicate detection and re-ingest handling
- Human-in-the-loop confirmation flow
- Batch directory ingest with --yes flag
- Source metadata display and status enhancement
- Edge case test suite

### Excluded

- AI-powered summarization after ingest (Epic 6)
- Any compilation passes (Epic 6)
- Remote source fetching (future scope)

---

## Beads

### E5-B01: Markdown Ingest Adapter

- **Depends on:** E2-B04, E2-B05
- **Produces:** `packages/compiler/src/adapters/markdown.ts`. Reads file, extracts frontmatter metadata (title, author, date, tags), computes word count, first heading as fallback title. Returns IngestResult.
- **Verification:** With frontmatter: all metadata extracted. Without: title from first heading. Word count accurate. Hash deterministic.

### E5-B02: PDF Ingest Adapter

- **Depends on:** E2-B04
- **Produces:** `packages/compiler/src/adapters/pdf.ts`. Uses pdf-parse. Extracts text, metadata (title, author, date, page count). Handles image-only PDFs, corrupted files, password-protected.
- **Verification:** Text PDF: content and metadata extracted. Image-only: helpful error. Page count correct.

### E5-B03: Web-Clip Ingest Adapter

- **Depends on:** E2-B04
- **Produces:** `packages/compiler/src/adapters/web-clip.ts`. Reads HTML, extracts title, strips to markdown, extracts source URL from canonical link. Returns IngestResult.
- **Verification:** HTML file: title, content, URL extracted. Clean markdown output. Reasonable word count.

### E5-B04: Adapter Registry and Type Detection

- **Depends on:** E5-B01, E5-B02, E5-B03
- **Produces:** `packages/compiler/src/adapters/registry.ts`. detectSourceType() from extension, ingestSource() routes to correct adapter.
- **Verification:** .md → markdown, .pdf → PDF, .html → web-clip. --type override works. Unknown extension → clear error.

### E5-B05: Ingest Pipeline Integration

- **Depends on:** E5-B04, E3-B04, E3-B05, E3-B06
- **Produces:** `packages/compiler/src/ingest-pipeline.ts`. Full pipeline: detect type → resolve symlinks → validate → run adapter → copy to raw/ → register source → record provenance → write trace → append audit log. Resolve all symlinks with `fs.realpath()` before processing and reject any symlink that resolves to a path outside the source directory (audit H2). Apply configurable file size limit via `MAX_INGEST_FILE_SIZE` environment variable, default 50MB — files exceeding this limit are rejected with a clear error (audit M1). Use atomic writes for raw/ copies (write to .tmp file, then rename) to prevent partial files on crash.
- **Verification:** End-to-end ingest: file copied, source registered, provenance recorded, trace written, audit updated. Hash consistency. Symlink to /etc/passwd rejected. Symlink within source directory accepted. File over size limit rejected with message including the limit. No .tmp files remain after successful ingest.

### E5-B06: Duplicate Detection and Re-Ingest Handling

- **Depends on:** E5-B05, E3-B04
- **Produces:** Updates to `ingest-pipeline.ts` with dedup and re-ingest logic.
- **Verification:** Same hash → "already ingested" no-op. Changed hash → source updated, old compilation marked stale, trace emitted.

### E5-B07: Human-in-the-Loop Ingest Confirmation

- **Depends on:** E5-B05, E4-B06
- **Produces:** Updates to `packages/cli/src/commands/ingest.ts` with confirmation flow showing metadata preview. Display file size and estimated token count (chars/4 heuristic) in the confirmation preview so the operator can assess cost before proceeding (audit M1). The `--yes` flag is explicitly required for CI/scripting and is documented as the non-interactive test strategy — all integration tests that exercise ingest must use `--yes` (audit M13).
- **Verification:** Shows metadata including file size and estimated tokens before proceeding. 'n' aborts. 'y' completes. --yes skips confirmation. Integration tests pass without TTY by using --yes.

### E5-B08: Batch Ingest with Directory Scanning

- **Depends on:** E5-B07, E5-B04
- **Produces:** Updates to ingest command accepting directory paths. Scans for supported types.
- **Verification:** 3-file directory → all ingested. Without --yes: individual prompts. Unsupported files skipped with warning.

### E5-B09: Source Metadata Display and ico status Enhancement

- **Depends on:** E4-B05, E5-B05
- **Produces:** Enhanced `ico status` with source-level detail. `--sources` flag for detailed list.
- **Verification:** After 5 ingests: correct counts by type. --sources shows all with metadata. Stale sources flagged.

### E5-B10: Ingest Adapter Unit Test Suite and Edge Cases

- **Depends on:** E5-B01 through E5-B04
- **Produces:** Comprehensive edge case tests: empty files, large files, unusual encodings, no headings, no metadata, special characters, symlinks, read-only. Add specific test cases: symlink-outside-source-directory rejection (symlink to /tmp or /etc is rejected with security error), file-over-size-limit rejection (file exceeding MAX_INGEST_FILE_SIZE returns clear error), Unicode filenames (e.g., `日本語ファイル.md`, `café-notes.md` ingest correctly), empty file handling (0-byte file ingests with appropriate metadata showing 0 words).
- **Verification:** All edge cases pass. No unhandled exceptions. Clear error messages. Coverage at target. Symlink attack produces security-class error. Oversize file produces size-class error. Unicode filenames round-trip correctly. Empty file produces valid source record with zero word count.

---

## Exit Criteria

1. Markdown, PDF, and web-clip sources ingest with metadata extraction
2. Content hashing deterministic and deduplication works
3. Re-ingest of changed files marks old compilations stale
4. Human-in-the-loop confirmation works (source-by-source default)
5. Batch directory ingest works with --yes flag
6. Full provenance chain from raw file to source record
7. `ico status` shows source-level detail
8. Edge case test suite passes

---

## Risks / Watch Items

- **pdf-parse quality varies.** Mitigation: show extracted text preview in confirmation step.
- **HTML parsing fragile.** Mitigation: use well-tested library, accept imperfect with operator review.
- **Large file ingest slow.** Mitigation: progress indication for files >1MB.
- **Symlink attacks** — source directories may contain symlinks to sensitive files outside the workspace. Mitigation: E5-B05 resolves all symlinks with `fs.realpath()` and rejects any that resolve outside the source directory.
