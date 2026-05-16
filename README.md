# intentional-cognition-os

> Compile knowledge for the machine. Distill understanding for the human.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/jeremylongshore/intentional-cognition-os/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/intentional-cognition-os/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jeremylongshore/intentional-cognition-os)](https://github.com/jeremylongshore/intentional-cognition-os/releases)

## Overview

**Intentional Cognition OS** is a local-first, remote-capable knowledge operating system that ingests raw corpus, compiles semantic knowledge, creates episodic task workspaces for complex questions, generates durable artifacts, and improves both machine reasoning and human understanding over time.

A cognition runtime, not a chat wrapper.

## Core Loop

```
ingest → compile → reason → render → refine
```

## Three Modes

| Mode | Use Cases |
|------|-----------|
| **Local** | Personal research vault, project knowledge base, private analysis |
| **Remote** | Team knowledge system, shared research, permissioned org memory |
| **Repo-native** | Source-controlled knowledge, agent instructions, auditable research |

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm

### Installation

```bash
git clone https://github.com/jeremylongshore/intentional-cognition-os.git
cd intentional-cognition-os
pnpm install
```

## CLI

```bash
ico ingest ./sources
ico compile topic "agent memory"
ico ask "Compare semantic knowledge vs episodic tasks"
ico research "Build a briefing on ERC-8004 trust signals"
ico render report --task latest
ico render slides --task latest
ico lint knowledge
ico recall generate --topic "intent systems"
```

## Architecture

Six-layer cognition stack:

1. **Raw Corpus Layer** — Source-of-truth inputs (PDFs, articles, repos, notes)
2. **Semantic Knowledge Layer** — Compiled markdown knowledge (summaries, concepts, entities)
3. **Episodic Task Layer** — Scoped task workspaces for complex questions
4. **Artifact Layer** — Durable outputs (reports, slides, charts, briefings)
5. **Recall Layer** — Human learning and retention support (flashcards, quizzes)
6. **Audit & Policy Layer** — Deterministic control plane (traces, provenance, approvals)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Documentation

Project documentation lives in [`000-docs/`](000-docs/):

| Doc | Purpose |
|-----|---------|
| [Business Case](000-docs/001-PP-BCASE-business-case.md) | Problem, market, ROI |
| [PRD](000-docs/002-PP-PRD-product-requirements.md) | Requirements & user stories |
| [Architecture](000-docs/003-AT-ARCH-architecture.md) | System design & data flow |
| [User Journey](000-docs/004-PP-UJRN-user-journey.md) | Walkthrough & personas |
| [Technical Spec](000-docs/005-AT-SPEC-technical-spec.md) | Stack, APIs, deployment |
| [Status](000-docs/006-OD-STAT-status.md) | Current state & roadmap |
| [Master Blueprint](000-docs/007-PP-PLAN-master-blueprint.md) | Authoritative design document |
| [Execution Plan](000-docs/EXECUTION-PLAN-10-EPICS.md) | 10-epic implementation plan (133 beads) |
| Standards (0.16.221) | 14 frozen standards documents (see [CLAUDE.md](CLAUDE.md)) |

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.

## Author

**Jeremy Longshore** — [jeremylongshore](https://github.com/jeremylongshore)
