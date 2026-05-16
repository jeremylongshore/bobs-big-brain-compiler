# intentional-cognition-os

> Compile knowledge for the machine. Distill understanding for the human.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/jeremylongshore/intentional-cognition-os/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/intentional-cognition-os/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jeremylongshore/intentional-cognition-os)](https://github.com/jeremylongshore/intentional-cognition-os/releases)

## Overview

**Intentional Cognition OS** (`ico`) is a local-first knowledge operating system. You point it at a folder of sources — PDFs, markdown notes, web clips — and it:

- Compiles raw corpus into a semantic wiki (concepts, topics, entities, contradictions)
- Answers grounded questions with inline source citations
- Spins up scoped episodic workspaces for hard research questions
- Renders durable artifacts (reports, slides) that you can promote back into the wiki
- Generates flashcards and quizzes to help you retain what you've ingested

It is a cognition runtime, not a chat wrapper. The model proposes; the deterministic kernel owns durable state, traces, and control.

## Core loop

```
ingest → compile → reason → render → refine
```

Every step writes to an append-only audit trail (SQLite index + JSONL trace files), so the system is inspectable, reproducible, and queryable.

## Quick start

### Prerequisites

- Node.js **22+**
- pnpm **10+**
- An [Anthropic API key](https://console.anthropic.com/) (the system uses Claude for compilation and reasoning)

### Install

```bash
git clone https://github.com/jeremylongshore/intentional-cognition-os.git
cd intentional-cognition-os
pnpm install
pnpm build
```

The CLI binary `ico` is available via `node packages/cli/dist/index.js` after build, or globally after `npm pack && npm install -g intentional-cognition-os-*.tgz`.

### First run

```bash
# Create a workspace
ico init my-knowledge

# Mount a corpus directory
ico mount add papers ~/research/papers --workspace my-knowledge

# Ingest sources
export ANTHROPIC_API_KEY=sk-ant-...
ico ingest ~/research/papers --workspace my-knowledge

# Compile semantic knowledge
ico compile all --workspace my-knowledge

# Ask a grounded question
ico ask "How does self-attention scale with sequence length?" --workspace my-knowledge

# Inspect what landed
ico status --workspace my-knowledge
```

## CLI surface

| Command | What it does |
|---|---|
| `ico init <name>` | Create a new workspace with `wiki/`, `tasks/`, `outputs/`, `recall/`, `audit/`, `.ico/state.db` |
| `ico mount add\|list\|remove` | Register / inspect / remove corpus mount points |
| `ico ingest <path>` | Ingest a file or directory into `raw/`. Supports PDF, Markdown, web clips |
| `ico compile sources\|topics\|all` | Run the six compiler passes (summarize → extract → synthesize → link → contradict → gap) |
| `ico ask "<question>"` | Retrieval-augmented Q&A grounded in the compiled wiki, with inline citations |
| `ico research "<brief>"` | Spin up a scoped episodic task: Collector → Summarizer → Skeptic → Integrator → render |
| `ico research archive <id>` | Archive a completed research task |
| `ico render report\|slides` | Render artifacts from a topic, task, or set of pages |
| `ico promote <path> --as <type>` | Promote an L4 artifact into the L2 wiki |
| `ico unpromote <path>` | Inverse of promote |
| `ico lint` | Audit compiled knowledge for schema validity, staleness, uncompiled sources, orphans |
| `ico recall generate --topic <name>` | Generate flashcards + quiz from compiled wiki for a topic |
| `ico recall quiz --topic <name>` | Run an interactive quiz; supports `--answers-file <json>` for CI |
| `ico recall weak [--report]` | Show lowest-retention concepts |
| `ico recall export --format anki [--out <path>]` | Export cards as Anki-importable TSV |
| `ico eval run [--spec <path>]` | Run YAML eval specs from `evals/`; supports retrieval + smoke handlers |
| `ico status` | Workspace summary (counts, mounts, tasks, traces) |
| `ico inspect <subcommand>` | Inspect specific subsystems (tasks, sources, …) |

Global flags work on every command: `--workspace <path>`, `--json`, `--verbose`, `--quiet`.

## Architecture

Six-layer cognition stack:

| Layer | Path | What lives here |
|---|---|---|
| **L1 — Raw Corpus** | `workspace/raw/` | Source-of-truth inputs. Append-only. |
| **L2 — Semantic Knowledge** | `workspace/wiki/` | Compiled markdown: source summaries, concepts, entities, topics, contradictions, open questions. Recompilable from L1. |
| **L3 — Episodic Tasks** | `workspace/tasks/<id>/` | Scoped per-question research workspaces. Brief, evidence, notes, critique, output. |
| **L4 — Artifacts** | `workspace/outputs/` | Rendered reports, slides, briefings. Promotable to L2. |
| **L5 — Recall** | `workspace/recall/` | Flashcards, quizzes, retention scores. Adaptive. |
| **L6 — Audit & Policy** | `workspace/audit/` | Append-only trace JSONL + audit log. Deterministic control plane. |

The **deterministic vs probabilistic boundary** is the most important constraint:

- **Deterministic** (Kernel + SQLite + JSONL): file storage, mount registry, task state, provenance, policy, permissions, audit, promotion rules, eval execution.
- **Probabilistic** (Compiler + Claude API): summarization, synthesis, concept extraction, contradiction detection, question decomposition, artifact drafting, recall generation.

The model never directly writes to audit, policy, or promotion tables. It proposes; the kernel decides.

## Development

| | |
|---|---|
| **Build all packages** | `pnpm build` |
| **Run full test suite** | `pnpm test` |
| **Lint** | `pnpm lint` |
| **Typecheck** | `pnpm typecheck` |
| **Coverage** | `pnpm test:coverage` |
| **Single test file** | `pnpm --filter @ico/<package> test -- <file>` |

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development setup, coding conventions, and PR process.

## Documentation

Standards and design documents live in [`000-docs/`](000-docs/):

| Doc | Purpose |
|---|---|
| [Business Case](000-docs/001-PP-BCASE-business-case.md) | Problem, market, ROI |
| [PRD](000-docs/002-PP-PRD-product-requirements.md) | Requirements & user stories |
| [Architecture](000-docs/003-AT-ARCH-architecture.md) | System design & data flow |
| [User Journey](000-docs/004-PP-UJRN-user-journey.md) | Walkthrough & personas |
| [Technical Spec](000-docs/005-AT-SPEC-technical-spec.md) | Stack, APIs, deployment |
| [Master Blueprint](000-docs/007-PP-PLAN-master-blueprint.md) | Authoritative design document |
| [Glossary](000-docs/008-AT-GLOS-glossary.md) | Canonical terminology |
| [Frontmatter Schemas](000-docs/009-AT-FMSC-frontmatter-schemas.md) | YAML schemas for all compiled page types |
| [Database Schema](000-docs/010-AT-DBSC-database-schema.md) | SQLite DDL + migration strategy |
| [Trace Schema](000-docs/011-AT-TRSC-trace-schema.md) | JSONL event envelope + event types |
| [Workspace Policy](000-docs/012-AT-WPOL-workspace-policy.md) | Directory layout + naming |
| [Coding Standards](000-docs/013-AT-CODE-coding-standards.md) | TypeScript conventions |
| [Testing Strategy](000-docs/015-AT-TEST-testing-strategy.md) | Test layers + coverage targets |
| [Promotion Rules](000-docs/018-AT-PROM-promotion-spec.md) | L4 → L2 promotion logic |
| [Trace Coverage Audit](000-docs/023-OD-AUDIT-trace-coverage-2026-05-15.md) | Per-command trace-emission audit (E10-B04) |

## Roadmap

| Phase | Status |
|---|---|
| Phase 1 — Local-first MVP (Epics 1–9) | ✅ Complete |
| Phase 2 — Hardening & v1.0 release (Epic 10) | 🚧 In progress |
| Phase 3 — Remote/cloud features | Future |
| Phase 4 — Multi-user collaboration | Future |
| Phase 5 — Plugin system | Future |

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

MIT — see [LICENSE](LICENSE).

## Author

Jeremy Longshore · [intentsolutions.io](https://intentsolutions.io)
