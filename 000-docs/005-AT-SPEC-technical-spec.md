# Technical Specification: intentional-cognition-os

> Compile knowledge for the machine. Distill understanding for the human.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-02
**Version:** 0.1.0
**Status:** Active

## Tech Stack

| Layer             | Technology                 | Version | Rationale                                |
| ----------------- | -------------------------- | ------- | ---------------------------------------- |
| Language          | TypeScript                 | 5.x     | Type safety, Claude SDK native           |
| Runtime           | Node.js                    | 22+     | LTS, ESM native                          |
| Package Manager   | pnpm                       | 10.x    | Workspace support, fast                  |
| CLI               | Commander.js               | 13.x    | Battle-tested, conventional              |
| State DB          | SQLite via better-sqlite3  | 11.x    | Local-first, zero infrastructure         |
| Audit Traces      | JSONL                      | —       | Append-only, human-readable              |
| AI                | @anthropic-ai/sdk          | 1.x     | Claude API for compilation and reasoning |
| Orchestration     | claude_agent_sdk           | —       | Multi-agent research workflows (Phase 3) |
| Schema Validation | Zod                        | 3.x     | Runtime type checking                    |
| Frontmatter       | gray-matter                | 4.x     | Parsing compiled wiki pages              |
| PDF Parsing       | pdf-parse                  | —       | Text extraction from PDFs                |
| Slides            | Marp CLI                   | —       | Markdown to presentation slides          |
| Charts            | matplotlib (Python)        | —       | Data visualization in reports            |
| Terminal Output   | chalk                      | 5.x     | CLI formatting                           |
| Testing           | Vitest                     | 4.x     | Fast, TypeScript-native                  |
| Linting           | ESLint + typescript-eslint | —       | Code quality                             |
| Build             | tsup                       | —       | Fast TypeScript bundling                 |

## Dependencies

### Core (Phase 1)

| Package           | Version | Purpose                                  |
| ----------------- | ------- | ---------------------------------------- |
| commander         | ^13.0   | CLI framework and argument parsing       |
| better-sqlite3    | ^11.0   | Local SQLite state database              |
| @anthropic-ai/sdk | ^1.0    | Claude API for compilation and reasoning |
| zod               | ^3.0    | Schema validation for configs and state  |
| chalk             | ^5.0    | Terminal output formatting               |
| gray-matter       | ^4.0    | Frontmatter parsing for wiki pages       |
| pdf-parse         | ^1.0    | PDF text extraction                      |

### Development

| Package           | Version | Purpose               |
| ----------------- | ------- | --------------------- |
| typescript        | ^5.0    | TypeScript compiler   |
| tsup              | ^8.0    | Build tool            |
| vitest            | ^4.0    | Test runner           |
| eslint            | ^10.0   | Linting               |
| typescript-eslint | ^8.0    | TypeScript lint rules |

## File Structure

```text
intentional-cognition-os/
├── 000-docs/                       # Enterprise documentation (doc-filing v4)
│   ├── 001-PP-BCASE-*.md           # Business case
│   ├── 002-PP-PRD-*.md             # Product requirements
│   ├── 003-AT-ARCH-*.md            # Architecture
│   ├── 004-PP-UJRN-*.md            # User journey
│   ├── 005-AT-SPEC-*.md            # Technical spec (this file)
│   ├── 006-OD-STAT-*.md            # Status
│   └── 007-PP-PLAN-*.md            # Master blueprint
├── .github/                        # CI/CD, templates
│   ├── workflows/ci.yml
│   ├── workflows/release.yml
│   └── ...
├── cli/                            # CLI entry point
│   ├── src/
│   │   ├── index.ts                # Main entry, command registration
│   │   ├── commands/
│   │   │   ├── ingest.ts           # ico ingest
│   │   │   ├── mount.ts            # ico mount
│   │   │   ├── compile.ts          # ico compile
│   │   │   ├── ask.ts              # ico ask
│   │   │   ├── research.ts         # ico research
│   │   │   ├── render.ts           # ico render
│   │   │   ├── lint.ts             # ico lint
│   │   │   ├── recall.ts           # ico recall
│   │   │   ├── promote.ts          # ico promote
│   │   │   ├── status.ts           # ico status
│   │   │   └── eval.ts             # ico eval
│   │   └── lib/
│   │       ├── output.ts           # Terminal formatting
│   │       └── config.ts           # Config loading
│   ├── package.json
│   └── tsup.config.ts
├── kernel/                         # Core runtime
│   ├── src/
│   │   ├── workspace.ts            # Workspace initialization and management
│   │   ├── mounts.ts               # Corpus mount registry
│   │   ├── state.ts                # SQLite state management
│   │   ├── provenance.ts           # Provenance tracking
│   │   ├── lifecycle.ts            # Task and artifact lifecycle
│   │   └── policy.ts               # Promotion and policy rules
│   ├── package.json
│   └── tsup.config.ts
├── compiler/                       # Knowledge compilation
│   ├── src/
│   │   ├── summarize.ts            # Source summarization
│   │   ├── extract.ts              # Concept extraction
│   │   ├── topics.ts               # Topic page generation
│   │   ├── backlinks.ts            # Backlink maintenance
│   │   ├── contradictions.ts       # Contradiction detection
│   │   ├── lint.ts                 # Knowledge health checks
│   │   └── diff.ts                 # Knowledge diff between compiles
│   ├── package.json
│   └── tsup.config.ts
├── mounts/                         # Corpus mount point configs
├── workspace/                      # Working data (gitignored except wiki/)
│   ├── raw/                        # Ingested source material
│   ├── wiki/                       # Compiled semantic knowledge
│   │   ├── sources/                # Per-source summaries
│   │   ├── concepts/               # Extracted concept pages
│   │   ├── entities/               # Entity pages
│   │   ├── topics/                 # Topic synthesis pages
│   │   ├── contradictions/         # Flagged contradictions
│   │   ├── open-questions/         # Identified gaps
│   │   └── indexes/                # Semantic indexes
│   ├── tasks/                      # Episodic research workspaces
│   ├── outputs/                    # Durable rendered artifacts
│   │   ├── reports/
│   │   ├── slides/
│   │   ├── charts/
│   │   └── briefings/
│   ├── recall/                     # Retention materials
│   │   ├── cards/
│   │   ├── decks/
│   │   ├── quizzes/
│   │   └── retention/
│   └── audit/                      # Deterministic control data
│       ├── traces/                 # JSONL event traces
│       ├── provenance/             # Source -> derived mapping
│       ├── policy/                 # Policy decision log
│       └── promotions/             # Promotion event log
├── evals/                          # Evaluation specs
├── apps/                           # Optional web UI (Phase 5+)
├── tests/                          # Integration tests
├── package.json                    # Root workspace config
├── pnpm-workspace.yaml
├── tsconfig.json
├── README.md
├── CLAUDE.md
└── CONTRIBUTING.md
```

## SQLite Schema (Deterministic State)

```sql
-- Source registry
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'pdf', 'markdown', 'html', 'text'
  title TEXT,
  author TEXT,
  ingested_at TEXT NOT NULL,
  word_count INTEGER,
  hash TEXT NOT NULL,          -- content hash for dedup
  metadata TEXT                -- JSON blob for type-specific metadata
);

-- Mount registry
CREATE TABLE mounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_indexed_at TEXT
);

-- Compilation state
CREATE TABLE compilations (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(id),
  type TEXT NOT NULL,          -- 'summary', 'concept', 'topic', 'entity'
  output_path TEXT NOT NULL,
  compiled_at TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_used INTEGER
);

-- Task registry
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  brief TEXT NOT NULL,
  status TEXT NOT NULL,        -- 'active', 'completed', 'archived'
  created_at TEXT NOT NULL,
  completed_at TEXT,
  workspace_path TEXT NOT NULL
);

-- Promotion log
CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  promoted_at TEXT NOT NULL,
  promoted_by TEXT NOT NULL    -- 'user' or 'system'
);

-- Recall tracking
CREATE TABLE recall_results (
  id TEXT PRIMARY KEY,
  concept TEXT NOT NULL,
  correct INTEGER NOT NULL,
  tested_at TEXT NOT NULL,
  confidence REAL
);
```

## CLI Commands

| Command        | Subcommand  | Arguments                   | Description                            |
| -------------- | ----------- | --------------------------- | -------------------------------------- |
| `ico init`     |             | `<name>`                    | Initialize a new workspace             |
| `ico ingest`   |             | `<path> [--type TYPE]`      | Ingest source material                 |
| `ico mount`    |             | `<path> --name NAME`        | Register a corpus mount                |
| `ico compile`  | `sources`   | `[--source ID]`             | Compile source summaries               |
| `ico compile`  | `topic`     | `<name>`                    | Compile a topic page                   |
| `ico compile`  | `concepts`  |                             | Extract and compile concept pages      |
| `ico ask`      |             | `<question>`                | Ask a question over compiled knowledge |
| `ico research` |             | `<brief>`                   | Create a scoped research workspace     |
| `ico render`   | `report`    | `--task ID \| --topic NAME` | Generate markdown report               |
| `ico render`   | `slides`    | `--task ID \| --topic NAME` | Generate Marp slide deck               |
| `ico lint`     | `knowledge` |                             | Run knowledge health checks            |
| `ico recall`   | `generate`  | `--topic NAME`              | Generate flashcards and quizzes        |
| `ico recall`   | `quiz`      | `[--topic NAME]`            | Run a recall quiz                      |
| `ico promote`  |             | `<path> --as TYPE`          | Promote output to knowledge layer      |
| `ico status`   |             |                             | Show workspace status                  |
| `ico eval`     | `run`       | `[--spec FILE]`             | Run evaluation specs                   |

## Environment Variables

| Variable           | Required              | Default             | Description                      |
| ------------------ | --------------------- | ------------------- | -------------------------------- |
| ANTHROPIC_API_KEY  | Yes (for AI features) | —                   | Claude API key                   |
| ICO_WORKSPACE      | No                    | `./workspace`       | Custom workspace path            |
| ICO_MODEL          | No                    | `claude-sonnet-4-6` | Default model for compilation    |
| ICO_RESEARCH_MODEL | No                    | `claude-opus-4-6`   | Model for complex research tasks |
| ICO_LOG_LEVEL      | No                    | `info`              | Logging verbosity                |

## Testing Strategy

| Layer           | Framework         | Scope                                                         |
| --------------- | ----------------- | ------------------------------------------------------------- |
| Unit            | Vitest            | Kernel state, compiler transforms, CLI parsing                |
| Integration     | Vitest            | End-to-end CLI commands against fixture workspaces            |
| Eval            | Custom (ico eval) | Compilation quality, recall accuracy, provenance completeness |
| Coverage Target | 80%               | Across kernel and compiler packages                           |

## Deployment

### Phase 1-4: Local

- npm package published as `intentional-cognition-os`
- Binary: `ico` (via package.json `bin` field)
- Install: `npm install -g intentional-cognition-os`
- No server, no cloud, no infrastructure

### Phase 5: Remote

- TypeScript backend with auth layer
- PostgreSQL replacing SQLite for multi-user state
- Object storage (S3/GCS) for raw files and artifacts
- Job queue for async compilation and research tasks
- API surface for team integrations
