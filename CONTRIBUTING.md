# Contributing to intentional-cognition-os

Thank you for your interest in contributing to **intentional-cognition-os**! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm
- Git
- GitHub account

### Development Setup

```bash
# Clone the repository
git clone https://github.com/jeremylongshore/bobs-big-brain-compiler.git
cd bobs-big-brain-compiler

# Install dependencies
pnpm install

# Run tests
pnpm test

# Run linter
pnpm lint
```

## How to Contribute

### Reporting Bugs

1. Search [existing issues](https://github.com/jeremylongshore/bobs-big-brain-compiler/issues) first
2. Open a [bug report](https://github.com/jeremylongshore/bobs-big-brain-compiler/issues/new?template=bug_report.md)
3. Include reproduction steps, expected vs actual behavior, and environment details

### Suggesting Enhancements

1. Check [existing feature requests](https://github.com/jeremylongshore/bobs-big-brain-compiler/issues?q=label%3Aenhancement)
2. Open a [feature request](https://github.com/jeremylongshore/bobs-big-brain-compiler/issues/new?template=feature_request.md)

### Pull Requests

1. Fork the repository
2. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Make your changes
4. Write or update tests
5. Ensure all tests pass
6. Commit with [conventional commit messages](#commit-messages)
7. Push and open a pull request

## Development Process

### Branch Strategy

| Branch      | Purpose               |
| ----------- | --------------------- |
| `main`      | Production-ready code |
| `feature/*` | New features          |
| `fix/*`     | Bug fixes             |
| `docs/*`    | Documentation changes |

### Testing

Run the full sweep before submitting a PR:

```bash
pnpm build       # tsup, sequential per package
pnpm typecheck   # tsc --noEmit across every workspace package
pnpm lint        # eslint
pnpm test        # vitest, every package
pnpm test:coverage   # optional — coverage report
```

Single-file iteration:

```bash
pnpm --filter @ico/kernel test -- recall-results.test.ts
pnpm --filter intentional-cognition-os test -- --reporter=verbose
```

The four workspace packages each have their own vitest suite:

| Workspace       | Published name                                                  |
| --------------- | --------------------------------------------------------------- |
| `@ico/types`    | private (workspace-only)                                        |
| `@ico/kernel`   | private (workspace-only)                                        |
| `@ico/compiler` | private (workspace-only)                                        |
| `packages/cli`  | **`intentional-cognition-os`** — the only npm-published package |

The full suite currently runs 1100+ tests in ~90 s.

**Testing patterns** (see `000-docs/015-AT-TEST-testing-strategy.md` for the canonical reference):

| Pattern                                                                    | Why                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Result<T, E>` everywhere — never `throw` from kernel/compiler public APIs | Lets callers reason about every failure mode with type-safe `if (!r.ok) return err(...)`. Tests assert `r.ok === false` and inspect `r.error.message`. |
| Atomic writes (`.tmp + renameSync`) for every file mutation                | Disk failure mid-write leaves no partial file. Verified by `packages/compiler/src/recall/disk-full.test.ts`.                                           |
| `vi.fn()` mocks for `ClaudeClient` in agent / compiler-pass tests          | Keeps tests offline, deterministic, free. Production code accepts an injected client, so tests never hit Anthropic.                                    |
| Real workspace + real SQLite in integration tests                          | Faster than spawning subprocesses and catches the kernel/compiler interaction the unit tests miss. See `recall-pipeline.integration.test.ts`.          |
| Trace assertions via `readTraces(db, { eventType })`                       | Asserting trace emission is the contract layer between the operator and the system; per 011-AT-TRSC every mutation emits at least one event.           |
| `correlation_id` on multi-event flows                                      | Group related events for audit reconstruction. Tests assert the same `correlation_id` appears on `lint.run` + `lint.result`, etc.                      |

### Code Review

- All PRs require CI to pass (build, lint, typecheck, test).
- PRs touching the audit/trace layer must include a trace-emission assertion.
- PRs touching atomic-write paths must keep the disk-failure test green.
- Keep PRs focused — one bead or one logical change per PR. Stack with `gh pr create --base <upstream>` when sequencing.

## Style Guides

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

[optional body]
[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`

**Examples:**

- `feat(compiler): add concept extraction pipeline`
- `fix(ingest): handle empty PDF gracefully`
- `docs(readme): update installation instructions`

### Code Style

- TypeScript with strict mode; `verbatimModuleSyntax: true`. No CommonJS.
- 2-space indentation, LF line endings, UTF-8 (`.editorconfig` is authoritative).
- ESM-only — every package has `"type": "module"`.
- Imports sorted via `eslint-plugin-simple-import-sort`. Run `pnpm lint --fix`.
- Public functions on kernel/compiler boundaries return `Result<T, Error>` rather than throwing.
- Avoid `as` casts when a type guard works. When `as` is necessary, add an inline comment explaining why.
- File writes use the atomic pattern: `writeFileSync(path + '.tmp', body); renameSync(path + '.tmp', path)`.

### Architecture Boundaries (Non-Negotiables)

These constraints come from `000-docs/007-PP-PLAN-master-blueprint.md` and are enforced in PR review:

1. **Compilation, not indexing** — derive summaries, concepts, backlinks, contradictions from sources; don't just shove text into a vector store.
2. **Semantic filesystem** — knowledge is mounted markdown, operable with `grep` / `jq`, not hidden in an opaque blob.
3. **Ephemeral episodic tasks** — hard questions get structured working memory (`tasks/tsk-<id>/`) that gets archived, not appended to a global chat log.
4. **Source integrity** — raw and derived always separate (L1 ≠ L2); provenance always tracked in SQLite + JSONL.
5. **Deterministic control plane** — the kernel owns durable state; the model proposes; the model never writes to audit, policy, or promotion tables directly.

### Project Layout

| Package              | Role                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/types/`    | Shared `Result<T,E>`, Zod schemas, frontmatter schemas                                                               |
| `packages/kernel/`   | SQLite state, mounts, sources, provenance, traces, tasks, recall, retention, evals — the deterministic control plane |
| `packages/compiler/` | Claude API client, ingest adapters, six compiler passes, ask pipeline, render, agents, recall generator/quiz/export  |
| `packages/cli/`      | Commander entry point, per-command handlers, friendly-error mapper, top-level process handlers                       |

Adding a new event type? Update `000-docs/011-AT-TRSC-trace-schema.md` first, then emit it. Adding a new compiled-page type? Update `000-docs/009-AT-FMSC-frontmatter-schemas.md` and the validator.

## Community

- **Questions**: [GitHub Discussions](https://github.com/jeremylongshore/bobs-big-brain-compiler/discussions)
- **Bugs**: [Issue Tracker](https://github.com/jeremylongshore/bobs-big-brain-compiler/issues)
- **Email**: jeremy@jeremylongshore.com

## License

By contributing, you agree that your contributions will be licensed under the
project's [Apache License 2.0](LICENSE).

---

_Thank you for helping improve intentional-cognition-os!_
