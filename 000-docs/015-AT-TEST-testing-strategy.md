# Testing Strategy and Fixture Workspace Design

> Test the system. Eval the knowledge. Never confuse the two.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Scope and Purpose

This document defines the testing architecture for Intentional Cognition OS: test layers, fixture design, naming conventions, coverage targets, isolation requirements, and the decision boundary between tests and evals.

Tests verify that the deterministic system behaves correctly. Evals verify that the probabilistic compiler produces quality knowledge. These are different activities with different tools, different pass/fail criteria, and different cadences. Conflating them produces unreliable CI and unchecked quality drift.

---

## 2. Test Layers

| Layer           | Framework                   | What It Verifies                                                                                    | Location                                   |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Unit**        | Vitest                      | Single-module behavior: state transitions, schema validation, CLI parsing, file operations          | Colocated `*.test.ts` next to source files |
| **Integration** | Vitest                      | Cross-package flows: CLI command -> kernel -> filesystem, ingest -> compile pipeline                | `tests/integration/` at repo root          |
| **Eval**        | Custom harness (`ico eval`) | Compilation quality: summary accuracy, concept extraction precision, contradiction detection recall | `evals/` at repo root                      |

Unit and integration tests run in CI on every push and PR. Evals run on-demand or on scheduled cadence — they require API calls and are non-deterministic by nature.

---

## 3. Test File Locations and Naming

### 3.1 Unit tests — colocated

Unit test files live next to the source file they test. Name pattern: `<source>.test.ts`.

```text
packages/kernel/src/workspace.ts
packages/kernel/src/workspace.test.ts

packages/kernel/src/state.ts
packages/kernel/src/state.test.ts

packages/compiler/src/summarize.ts
packages/compiler/src/summarize.test.ts

packages/cli/src/commands/ingest.ts
packages/cli/src/commands/ingest.test.ts

packages/types/src/schemas/source.ts
packages/types/src/schemas/source.test.ts
```

### 3.2 Integration tests — repo root

Integration tests live in `tests/integration/` and are named by the flow they exercise.

```text
tests/integration/ingest-to-compile.test.ts
tests/integration/compile-to-lint.test.ts
tests/integration/task-lifecycle.test.ts
tests/integration/promotion-flow.test.ts
tests/integration/cli-non-interactive.test.ts
tests/integration/unicode-paths.test.ts
```

### 3.3 Eval specs — evals directory

Eval specs live in `evals/` and follow the naming pattern `<pass>-<aspect>.eval.ts`.

```text
evals/summarize-accuracy.eval.ts
evals/summarize-completeness.eval.ts
evals/extract-precision.eval.ts
evals/extract-recall.eval.ts
evals/contradict-detection.eval.ts
evals/topic-synthesis-coherence.eval.ts
```

### 3.4 Test naming inside files

Use `describe` blocks named after the module. Use `it` blocks that state the expected behavior as a sentence starting with a verb.

```typescript
// packages/kernel/src/workspace.test.ts
describe('Workspace', () => {
  describe('init', () => {
    it('creates all six layer directories', () => {
      /* ... */
    });
    it('initializes SQLite database with schema', () => {
      /* ... */
    });
    it('writes empty index.md to wiki root', () => {
      /* ... */
    });
    it('rejects workspace paths that already exist', () => {
      /* ... */
    });
  });

  describe('validate', () => {
    it('returns errors for missing layer directories', () => {
      /* ... */
    });
    it('returns errors for missing SQLite database', () => {
      /* ... */
    });
  });
});
```

```typescript
// packages/compiler/src/summarize.test.ts
describe('Summarize', () => {
  it('produces valid frontmatter with required fields', () => {
    /* ... */
  });
  it('includes source hash in provenance metadata', () => {
    /* ... */
  });
  it('rejects source files exceeding token limit', () => {
    /* ... */
  });
});
```

```typescript
// packages/cli/src/commands/ingest.test.ts
describe('ingest command', () => {
  it('registers source in SQLite after successful ingest', () => {
    /* ... */
  });
  it('copies file to workspace/raw/ preserving extension', () => {
    /* ... */
  });
  it('exits with code 1 for missing file path', () => {
    /* ... */
  });
  it('supports --non-interactive flag without prompting', () => {
    /* ... */
  });
});
```

---

## 4. Coverage Targets

| Package             | Target   | Rationale                                                                                                                                                                                                                           |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types`    | **100%** | Zod schemas are the contract layer. Every schema must have a passing-input test and a failing-input test. No exceptions.                                                                                                            |
| `packages/kernel`   | **90%**  | Kernel owns deterministic state: workspace layout, SQLite operations, mount registry, lifecycle state machine, provenance tracking. Bugs here corrupt data.                                                                         |
| `packages/compiler` | **80%**  | Compiler has deterministic scaffolding (frontmatter generation, file writes, provenance links) that must be tested. The probabilistic core (LLM calls) is stubbed in unit tests and validated by evals.                             |
| `packages/cli`      | **70%**  | CLI is a thin routing layer. Test argument parsing, flag validation, error formatting, and `--non-interactive` behavior. Do not test the kernel or compiler through the CLI in unit tests — that is what integration tests are for. |

Coverage is enforced in CI via Vitest coverage thresholds in `vitest.config.ts`:

```typescript
// vitest.config.ts (root)
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: {
        'packages/types/src': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'packages/kernel/src': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/compiler/src': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'packages/cli/src': { statements: 70, branches: 70, functions: 70, lines: 70 },
      },
    },
  },
});
```

---

## 5. Fixture Workspace Design

Tests that interact with the workspace filesystem use a shared fixture workspace at `tests/fixtures/workspace/`. This workspace mirrors the production layout with pre-populated content across four tiers.

### 5.1 Directory layout

```text
tests/fixtures/workspace/
├── raw/                          # Tier 1: Raw source inputs
│   ├── sample-article.md         # Plain markdown article (~500 words)
│   ├── sample-paper.pdf          # Small PDF with extractable text
│   ├── sample-webpage.html       # Clipped HTML with metadata
│   ├── sample-notes.txt          # Plain text notes
│   ├── empty-file.md             # Zero-byte edge case
│   └── unicode/
│       ├── diacritics-cafe.md         # Filename: "diacritics-cafe.md", content with accented characters
│       ├── cjk-知識.md                # CJK characters in filename and content
│       ├── emoji-🧠-brain.md          # Emoji in filename
│       └── spaces in name.md          # Spaces in filename
│
├── wiki/                         # Tier 2: Pre-compiled knowledge pages
│   ├── index.md                  # Compiled wiki index
│   ├── sources/
│   │   ├── sample-article.md     # Source summary for sample-article
│   │   └── sample-paper.md       # Source summary for sample-paper
│   ├── concepts/
│   │   ├── knowledge-compilation.md  # Concept page with valid frontmatter
│   │   └── semantic-filesystem.md    # Concept page with backlinks
│   ├── topics/
│   │   └── knowledge-systems.md      # Topic synthesis page
│   ├── entities/
│   │   └── intentional-cognition-os.md  # Entity page
│   ├── contradictions/
│   │   └── compilation-vs-indexing.md   # Contradiction note between two sources
│   └── open-questions/
│       └── retrieval-strategy.md        # Identified knowledge gap
│
├── tasks/                        # Tier 3: Research task snapshots
│   ├── task-001-active/          # Task in "collecting" state
│   │   ├── task.json             # Task metadata: status=collecting
│   │   ├── evidence/
│   │   │   └── evidence-001.md
│   │   └── notes/
│   ├── task-002-completed/       # Task in "completed" state
│   │   ├── task.json             # Task metadata: status=completed
│   │   ├── evidence/
│   │   │   ├── evidence-001.md
│   │   │   └── evidence-002.md
│   │   ├── notes/
│   │   │   └── synthesis.md
│   │   ├── critique/
│   │   │   └── skeptic-review.md
│   │   └── output/
│   │       └── final-report.md
│   └── task-003-archived/        # Task in "archived" state
│       ├── task.json             # Task metadata: status=archived
│       └── output/
│           └── final-report.md
│
└── evals/                        # Tier 4: QA pairs for eval harness
    ├── summarize/
    │   ├── input-article.md      # Raw source input
    │   ├── expected-summary.md   # Expected summary output (gold standard)
    │   └── rubric.json           # Scoring rubric: {fields: [...], min_score: 0.8}
    ├── extract/
    │   ├── input-summaries/      # Directory of source summaries as input
    │   │   ├── summary-a.md
    │   │   └── summary-b.md
    │   ├── expected-concepts.json  # Expected concept list with definitions
    │   └── rubric.json
    └── contradict/
        ├── input-sources/        # Sources with known contradictions
        │   ├── source-claims-x.md
        │   └── source-claims-not-x.md
        ├── expected-contradictions.json  # Known contradiction pairs
        └── rubric.json
```

### 5.2 Tier descriptions

**Tier 1 — Raw Sources.** Minimal representative inputs covering each supported file type: markdown, PDF, HTML, plain text. Includes edge cases (empty file, unicode filenames). These fixtures are inputs to ingest and compile unit tests. They are small (under 1KB each except the PDF) to keep test execution fast.

**Tier 2 — Compiled Wiki Pages.** Pre-compiled pages with valid frontmatter, backlinks, and provenance references. These fixtures let tests validate lint operations, staleness detection, index rebuilds, and backlink integrity without running the compiler. Every page includes the required frontmatter fields for its type.

**Tier 3 — Research Task Snapshots.** Three task directories representing the three terminal lifecycle states: active (collecting), completed, and archived. These fixtures let tests validate task state machine transitions, workspace cleanup, and promotion eligibility checks without running a full research flow.

**Tier 4 — Eval QA Pairs.** Input-output pairs with scoring rubrics for each compilation pass. The inputs are raw sources or intermediate compilations. The expected outputs are gold-standard compilations. The rubrics define scoring criteria and minimum thresholds. These are consumed by the eval harness, not by Vitest.

### 5.3 Fixture frontmatter examples

Source summary (`wiki/sources/sample-article.md`):

```yaml
---
type: source-summary
source_id: sample-article
source_path: raw/sample-article.md
source_hash: sha256:abc123...
compiled_at: '2026-01-15T10:00:00Z'
model: claude-sonnet-4-6
tags: [knowledge-management, compilation]
---
```

Concept page (`wiki/concepts/knowledge-compilation.md`):

```yaml
---
type: concept
title: Knowledge Compilation
sources: [sample-article, sample-paper]
backlinks: [semantic-filesystem, knowledge-systems]
compiled_at: '2026-01-15T10:05:00Z'
model: claude-sonnet-4-6
---
```

Task metadata (`tasks/task-001-active/task.json`):

```json
{
  "id": "task-001",
  "brief": "Compare compilation approaches in knowledge management systems",
  "status": "collecting",
  "created_at": "2026-01-20T09:00:00Z",
  "completed_at": null,
  "workspace_path": "workspace/tasks/task-001-active"
}
```

---

## 6. Cross-Package Integration Test Scenarios

Integration tests exercise the full pipeline across package boundaries. Each test uses a temporary workspace initialized from fixtures.

### 6.1 Ingest-to-Compile pipeline

**File:** `tests/integration/ingest-to-compile.test.ts`

**Flow:** CLI `ingest` command -> kernel registers source in SQLite -> compiler `summarize` pass -> writes source summary to wiki -> kernel updates compilation state -> provenance record created in audit.

**Assertions:**

- Source row exists in SQLite `sources` table with correct hash
- Source summary file exists at `workspace/wiki/sources/<id>.md`
- Summary frontmatter includes `source_hash` matching the ingested file
- Compilation row exists in SQLite `compilations` table
- Provenance trace entry exists in `workspace/audit/provenance/`

```typescript
describe('ingest-to-compile pipeline', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await createTempWorkspace();
  });

  afterEach(async () => {
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it('produces a valid source summary with provenance from a raw markdown file', async () => {
    // 1. Ingest fixture source
    await ingest(tmpWorkspace, 'tests/fixtures/workspace/raw/sample-article.md');

    // 2. Verify SQLite source registration
    const db = openDb(tmpWorkspace);
    const source = db.prepare('SELECT * FROM sources WHERE path LIKE ?').get('%sample-article%');
    expect(source).toBeDefined();
    expect(source.hash).toMatch(/^sha256:/);

    // 3. Run compilation
    await compileSources(tmpWorkspace);

    // 4. Verify compiled output
    const summaryPath = path.join(tmpWorkspace, 'wiki/sources/sample-article.md');
    expect(fs.existsSync(summaryPath)).toBe(true);

    const matter = parseFrontmatter(await fs.readFile(summaryPath, 'utf-8'));
    expect(matter.data.source_hash).toBe(source.hash);
    expect(matter.data.type).toBe('source-summary');

    // 5. Verify provenance
    const provenance = await readProvenance(tmpWorkspace, source.id);
    expect(provenance.source_id).toBe(source.id);
    expect(provenance.output_path).toContain('wiki/sources/sample-article.md');
  });
});
```

### 6.2 Task lifecycle

**File:** `tests/integration/task-lifecycle.test.ts`

**Flow:** Create research task -> verify workspace created -> transition through states (created -> collecting -> synthesizing -> completed -> archived) -> verify output promotion eligibility -> verify trace closure.

### 6.3 CLI non-interactive mode

**File:** `tests/integration/cli-non-interactive.test.ts`

**Flow:** Run every interactive CLI command with `--non-interactive` flag -> verify no stdin reads -> verify deterministic exit codes.

### 6.4 Unicode path handling

**File:** `tests/integration/unicode-paths.test.ts`

**Flow:** Ingest each unicode fixture file -> compile -> verify output paths are valid -> verify SQLite stores paths correctly -> verify provenance links resolve.

---

## 7. Unicode Test Matrix

Unicode handling is a cross-cutting concern. Every package that touches file paths, source content, or compiled output must pass the unicode matrix.

### 7.1 Filename test cases

| Case                      | Fixture File         | Tests                                                                          |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| **ASCII baseline**        | `sample-article.md`  | Sanity check — all operations work on plain ASCII                              |
| **Spaces**                | `spaces in name.md`  | Path quoting, SQLite storage, provenance links                                 |
| **Diacritics**            | `diacritics-cafe.md` | Latin extended characters: cafe, resume, naive                                 |
| **CJK**                   | `cjk-知識.md`        | Chinese/Japanese/Korean characters in filenames                                |
| **Emoji**                 | `emoji-🧠-brain.md`  | Multi-byte emoji in filenames                                                  |
| **RTL markers**           | (generated in test)  | Right-to-left override characters — must not corrupt paths                     |
| **NFC/NFD normalization** | (generated in test)  | Same visual character, different byte sequences — must be handled consistently |

### 7.2 Content test cases

| Case                                        | What It Tests                                                |
| ------------------------------------------- | ------------------------------------------------------------ |
| Mixed-script content (Latin + CJK + Arabic) | Compiler produces valid summaries without corruption         |
| Source with emoji in headings               | Frontmatter extraction handles multi-byte heading text       |
| Right-to-left paragraph blocks              | Compiled output preserves directionality markers             |
| Content with zero-width joiners/non-joiners | Character boundaries handled correctly in concept extraction |

### 7.3 Where unicode tests run

- **Unit:** `packages/kernel/src/workspace.test.ts` — path handling for each fixture
- **Unit:** `packages/compiler/src/summarize.test.ts` — content handling for mixed-script input
- **Integration:** `tests/integration/unicode-paths.test.ts` — end-to-end path handling across the pipeline
- **Types:** `packages/types/src/schemas/source.test.ts` — Zod schemas accept unicode strings in title, path, and metadata fields

---

## 8. Temp Directory Handling and Test Isolation

### 8.1 Rules

1. Every test that touches the filesystem creates a unique temporary directory.
2. Temp directories use `os.tmpdir()` with a unique prefix: `ico-test-<random>`.
3. Cleanup happens in `afterEach` (per-test) or `afterAll` (per-suite), never left to the OS.
4. Tests never write to the fixture directory. Fixtures are read-only. Copy to temp before mutation.
5. Tests never share temp directories. Parallel test execution must not cause conflicts.

### 8.2 Helper function

```typescript
// tests/helpers/temp-workspace.ts
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_WORKSPACE = join(__dirname, '../fixtures/workspace');

/**
 * Creates an isolated temp workspace by copying the fixture workspace.
 * Returns the absolute path to the temp workspace.
 * Caller MUST clean up via removeTempWorkspace() in afterEach/afterAll.
 */
export async function createTempWorkspace(): Promise<string> {
  const prefix = join(tmpdir(), 'ico-test-');
  const dir = await mkdtemp(prefix);
  await cp(FIXTURE_WORKSPACE, dir, { recursive: true });
  return dir;
}

/**
 * Removes a temp workspace. Safe to call multiple times.
 */
export async function removeTempWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
```

### 8.3 Usage pattern

```typescript
import { createTempWorkspace, removeTempWorkspace } from '../helpers/temp-workspace';

describe('SomeModule', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempWorkspace();
  });

  afterEach(async () => {
    await removeTempWorkspace(tmpDir);
  });

  it('does something with the workspace', () => {
    // tmpDir is a fully populated, isolated workspace copy
  });
});
```

### 8.4 CI safety

The CI pipeline runs `find /tmp -name 'ico-test-*' -mmin +30 -exec rm -rf {} +` as a post-step to catch leaked temp directories from crashed test runs. This is a safety net, not a substitute for proper cleanup.

---

## 9. Test vs Eval Decision Tree

Use this decision tree to classify whether a verification belongs in Vitest (test) or the eval harness (eval).

```text
Is the expected output deterministic?
├── YES: Does the same input always produce the same output?
│   └── Vitest unit or integration test.
│
└── NO: The output depends on model behavior.
    │
    ├── Are you checking output STRUCTURE (schema, frontmatter, required fields)?
    │   └── Vitest unit test with mocked model responses.
    │
    └── Are you checking output QUALITY (accuracy, completeness, coherence)?
        └── Eval spec in evals/ directory.
```

### 9.1 Classification examples

| What You Are Verifying                                                | Classification         | Rationale                                                                  |
| --------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| SQLite state transitions after ingest                                 | **Vitest unit**        | Deterministic: same input always produces same rows                        |
| Zod schema rejects invalid frontmatter                                | **Vitest unit**        | Deterministic: schema validation is pure logic                             |
| CLI exits with code 1 on missing argument                             | **Vitest unit**        | Deterministic: argument parsing is pure logic                              |
| Compiled summary includes source_hash in frontmatter                  | **Vitest unit**        | Structure check: the hash field must exist regardless of model output      |
| Provenance chain links source to compiled page                        | **Vitest integration** | Deterministic: file system and SQLite state after a pipeline run           |
| Task state machine rejects invalid transition                         | **Vitest unit**        | Deterministic: state machine is pure logic                                 |
| Summary captures the three key claims from a source                   | **Eval**               | Quality judgment: requires assessing semantic content of model output      |
| Concept extraction identifies at least 5 concepts from a source set   | **Eval**               | Quality judgment: concept count and relevance depend on model behavior     |
| Contradiction detection finds the known conflict between two sources  | **Eval**               | Quality judgment: detecting contradictions requires semantic understanding |
| Topic synthesis page is coherent and cites all relevant sources       | **Eval**               | Quality judgment: coherence is not deterministically verifiable            |
| Non-interactive mode produces same output as interactive confirmation | **Vitest integration** | Deterministic: flag behavior is pure logic, not model-dependent            |

### 9.2 Gray area rule

If you are unsure, ask: "Can I write an exact equality assertion for this?" If yes, it is a test. If the assertion requires a scoring rubric, semantic similarity, or human-like judgment, it is an eval.

---

## 10. Non-Interactive Test Mode

### 10.1 Requirement

Every CLI command that prompts the user for input must support a `--non-interactive` flag. When this flag is set, the command must:

1. Never read from stdin.
2. Use default values for all prompts, or fail with a clear error if a required value has no default.
3. Produce identical functional output to the interactive version (given the same inputs).
4. Exit with a non-zero code if it cannot proceed without user input and no default exists.

### 10.2 Commands requiring --non-interactive support

| Command                          | Interactive Behavior                              | Non-Interactive Behavior                           |
| -------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `ico ingest <path>`              | Prompts to confirm source type detection          | Uses detected type, skips confirmation             |
| `ico compile sources`            | Prompts to confirm recompilation of stale sources | Recompiles all stale sources without prompting     |
| `ico promote <path> --as <type>` | Prompts to confirm promotion                      | Promotes without confirmation                      |
| `ico recall quiz`                | Interactive quiz session                          | Exits with error: "Quiz requires interactive mode" |
| `ico research <brief>`           | Prompts for scope confirmation                    | Uses brief as-is, skips confirmation               |
| `ico init <name>`                | Prompts to confirm workspace location             | Uses current directory, skips confirmation         |

### 10.3 Testing non-interactive mode

```typescript
describe('--non-interactive flag', () => {
  it('ingest completes without stdin when --non-interactive is set', async () => {
    const result = await runCli(['ingest', 'fixture.md', '--non-interactive'], {
      stdin: null, // no stdin available
      cwd: tmpWorkspace,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('prompt');
  });

  it('recall quiz exits with error in non-interactive mode', async () => {
    const result = await runCli(['recall', 'quiz', '--non-interactive'], {
      stdin: null,
      cwd: tmpWorkspace,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('requires interactive mode');
  });
});
```

### 10.4 CI enforcement

All CI test runs pass `--non-interactive` to every CLI invocation. If a command hangs waiting for stdin in CI, it is a bug.

---

## 11. Eval Harness Design

The eval harness is separate from Vitest. It runs via `ico eval run` and consumes specs from `evals/`.

### 11.1 Eval spec structure

Each eval spec defines: input, expected output (or rubric), the compilation pass to exercise, and scoring criteria.

```typescript
// evals/summarize-accuracy.eval.ts
import { defineEval } from '../eval-harness';

export default defineEval({
  name: 'summarize-accuracy',
  pass: 'summarize',
  input: 'tests/fixtures/workspace/evals/summarize/input-article.md',
  expected: 'tests/fixtures/workspace/evals/summarize/expected-summary.md',
  rubric: 'tests/fixtures/workspace/evals/summarize/rubric.json',
  scoring: {
    method: 'rubric', // 'rubric' | 'exact' | 'contains' | 'llm-judge'
    min_score: 0.8,
  },
});
```

### 11.2 Rubric format

```json
{
  "fields": [
    { "name": "has_title", "weight": 0.1, "check": "frontmatter_exists", "field": "title" },
    {
      "name": "has_source_hash",
      "weight": 0.1,
      "check": "frontmatter_exists",
      "field": "source_hash"
    },
    {
      "name": "key_claims_present",
      "weight": 0.4,
      "check": "contains_all",
      "values": ["claim A", "claim B", "claim C"]
    },
    {
      "name": "coherence",
      "weight": 0.2,
      "check": "llm_judge",
      "prompt": "Rate the coherence of this summary from 0 to 1."
    },
    {
      "name": "conciseness",
      "weight": 0.2,
      "check": "llm_judge",
      "prompt": "Rate conciseness: is the summary under 300 words without losing key claims?"
    }
  ],
  "min_score": 0.8
}
```

### 11.3 Eval output

Eval results are written to `workspace/audit/evals/` as JSONL. Each line records the eval name, timestamp, score, pass/fail, and per-field breakdown. This is the same audit layer (L6) used by the rest of the system.

---

## 12. Vitest Configuration

### 12.1 Root config

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: [
      'evals/**', // Evals are not Vitest tests
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      thresholds: {
        'packages/types/src': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'packages/kernel/src': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/compiler/src': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'packages/cli/src': { statements: 70, branches: 70, functions: 70, lines: 70 },
      },
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
```

### 12.2 CI integration

The CI workflow (`.github/workflows/ci.yml`) runs:

```yaml
- name: Test
  run: pnpm test -- --coverage --reporter=verbose

- name: Check coverage thresholds
  run: pnpm test -- --coverage --check
```

If any package falls below its coverage threshold, CI fails.

---

## 13. Mock Strategy for Probabilistic Boundaries

Unit tests must not call the Claude API. All model interactions are mocked at the boundary.

### 13.1 Mock boundary

The compiler exposes a `ModelClient` interface. In tests, inject a `MockModelClient` that returns deterministic responses.

```typescript
// packages/compiler/src/model-client.ts
export interface ModelClient {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
}

// tests/helpers/mock-model-client.ts
export class MockModelClient implements ModelClient {
  private responses: Map<string, string>;

  constructor(responses: Record<string, string>) {
    this.responses = new Map(Object.entries(responses));
  }

  async complete(prompt: string): Promise<string> {
    // Match on prompt substring for flexibility
    for (const [key, value] of this.responses) {
      if (prompt.includes(key)) return value;
    }
    throw new Error(
      `MockModelClient: no response configured for prompt containing: ${prompt.slice(0, 100)}`,
    );
  }
}
```

### 13.2 Rule

If a test file imports `MockModelClient`, it is a unit test and belongs next to the source. If a test needs real model output, it is an eval and belongs in `evals/`.

---

## 14. Running Tests

### 14.1 Commands

```bash
# All unit + integration tests
pnpm test

# Single package
pnpm test --filter packages/kernel

# Single test file
pnpm test packages/kernel/src/workspace.test.ts

# With coverage
pnpm test -- --coverage

# Integration tests only
pnpm test tests/integration/

# Watch mode (development)
pnpm test -- --watch

# Run evals (separate from Vitest)
pnpm run eval           # or: ico eval run
pnpm run eval:summarize # single eval spec
```

### 14.2 CI matrix

| Check                    | Runs On                           | Blocks Merge  |
| ------------------------ | --------------------------------- | ------------- |
| `pnpm test --coverage`   | Every push, every PR              | Yes           |
| Coverage threshold check | Every push, every PR              | Yes           |
| `pnpm lint`              | Every push, every PR              | Yes           |
| `pnpm typecheck`         | Every push, every PR              | Yes           |
| `ico eval run`           | Nightly schedule, manual dispatch | No (advisory) |

---

## 15. Checklist for Adding New Tests

When adding a test, verify:

- [ ] Test file is named `<source>.test.ts` and colocated with source (unit) or in `tests/integration/` (integration)
- [ ] Test uses `createTempWorkspace()` if it touches the filesystem
- [ ] Temp directory cleanup is in `afterEach` or `afterAll`
- [ ] Model calls are mocked via `MockModelClient` (unit tests only)
- [ ] Unicode fixtures are included if the module handles file paths or content
- [ ] `--non-interactive` variant exists if testing a CLI command with prompts
- [ ] Test names start with a verb and describe expected behavior
- [ ] No test depends on execution order or shared mutable state
