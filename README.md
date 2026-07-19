<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img alt="Bob's Big Brain Compiler — compile knowledge for the machine, distill understanding for the human." src="assets/banner-light.svg" width="860">
  </picture>
</p>

# Bob's Big Brain Compiler

> Formerly `intentional-cognition-os` — the npm package keeps that name.

Bob's Big Brain Compiler reads your documents, notes, and web clips and turns them into an organized, searchable knowledge base — every answer backed by a citation to the source.

A local-first knowledge OS. Point `ico` at a folder of PDFs, markdown notes, and web clips. It compiles them into a queryable wiki you can read, runs grounded Q&A with inline citations, spins up multi-agent research tasks for hard questions, generates spaced-repetition flashcards from what landed, and writes every step to an append-only audit trail. Single CLI. Your data never leaves disk except for the Claude API calls you opt into.

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/intentional-cognition-os.svg)](https://www.npmjs.com/package/intentional-cognition-os)
[![CI](https://github.com/jeremylongshore/bobs-big-brain-compiler/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/bobs-big-brain-compiler/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jeremylongshore/bobs-big-brain-compiler)](https://github.com/jeremylongshore/bobs-big-brain-compiler/releases)

> **Part of the [Bob's Big Brain](https://github.com/intent-solutions-io/bobs-big-brain-umbrella) stack** — this is the **compile** layer. It pairs with [Bob's Big Brain Registrar](https://github.com/jeremylongshore/bobs-big-brain-registrar) (govern) and [qmd](https://github.com/tobi/qmd) (retrieve) to turn raw corpus into governed, citation-backed memory. → [Ecosystem overview](https://github.com/intent-solutions-io/bobs-big-brain-umbrella)

---

## What it actually does

You drop documents into a folder. `ico` reads them, compiles the content into a structured wiki on disk (one markdown file per source, per concept, per topic, per contradiction it found), and then lets you:

- **Ask** a question — get an answer with `[source: filename]` citations next to every claim.
- **Research** a question that's too big for a single retrieval — `ico` spawns a scoped task workspace with four agents (collector, summarizer, skeptic, integrator) that argue across stages and produce a cited final write-up.
- **Render** a report or slide deck from any topic, and **promote** that artifact back into the wiki so the next answer can cite it.
- **Recall** what you ingested — generate flashcards with spaced repetition; export to Anki if you prefer.
- **Audit** anything. Every API call, file write, and task transition is recorded in append-only JSONL with a SHA-256 hash chain. If a citation looks wrong, you can trace it back to the exact source and prompt.

It is a cognition runtime, not a chat wrapper. The model proposes; a deterministic kernel owns durable state, traces, and control. **Your data lives in plain markdown + SQLite on your machine.** The model API is called only for the compilation/synthesis/reasoning steps — and only when you trigger them. The backend is a pluggable provider registry: Claude by default, or any OpenAI- or Anthropic-wire provider (OpenAI, Groq, NVIDIA, DeepSeek) or a local server (Ollama, vLLM, LM Studio) via `ICO_PROVIDER` — so you can keep every call on-device if you want to.

---

## Install

```bash
# the npm name predates the repo rename — intentional
npm install -g intentional-cognition-os
ico --version          # → 1.21.0
export ANTHROPIC_API_KEY=sk-ant-...
```

Requires **Node 22+** and an [Anthropic API key](https://console.anthropic.com/). pnpm not required for usage — only for building from source.

From source:

```bash
git clone https://github.com/jeremylongshore/bobs-big-brain-compiler.git
cd bobs-big-brain-compiler && pnpm install && pnpm build
node packages/cli/dist/index.js --version
```

---

## 5-minute quickstart

```bash
# 1. Create a workspace
ico init my-research

# 2. Tell it where your sources live
ico mount add papers ~/Documents/papers --workspace my-research

# 3. Ingest (parses PDFs/MD/web clips into ./raw/)
ico ingest ~/Documents/papers --workspace my-research

# 4. Compile — the Claude calls happen here
ico compile all --workspace my-research

# 5. Ask
ico ask "How does self-attention scale with sequence length?" \
    --workspace my-research
```

You now have:

- `my-research/wiki/` — readable markdown summary + concept + topic pages, all with frontmatter and inline `[[wikilinks]]`
- `my-research/audit/log.md` — chronological human-readable record of what just happened
- `my-research/audit/traces/*.jsonl` — machine-readable trace events for every step

`ico status` shows counts. `ico lint` audits the wiki for schema drift / staleness / orphans. `tail workspace/audit/log.md` answers "what did I do today."

---

## When to use it (and when not to)

| You want to…                                                               | Use `ico`? | Why                                                      |
| -------------------------------------------------------------------------- | ---------- | -------------------------------------------------------- |
| Build a personal research base from PDFs + notes                           | ✅ Yes     | Core use case                                            |
| Answer questions with traceable citations to your own sources              | ✅ Yes     | Citations are first-class, not bolted on                 |
| Run a multi-step research investigation (literature review, due diligence) | ✅ Yes     | `ico research` spawns scoped agents with a skeptic stage |
| Study what you've collected with spaced repetition                         | ✅ Yes     | `ico recall` builds + scores cards                       |
| Replace your team's wiki / shared docs                                     | ❌ No      | Single-user, single-machine for v1                       |
| Drop into Slack / chat with team-shared memory                             | ❌ No      | No multiplayer, no remote sync yet                       |
| Build a customer-facing chatbot                                            | ❌ No      | Use LangChain / a managed RAG service                    |

---

## vs. the obvious alternatives

|                                              | **ico**                                    | NotebookLM (Google) | Obsidian + AI plugins                             | Claude Projects / ChatGPT | LangChain / LlamaIndex    | Anki                          |
| -------------------------------------------- | ------------------------------------------ | ------------------- | ------------------------------------------------- | ------------------------- | ------------------------- | ----------------------------- |
| **Local-first**                              | ✅ markdown + SQLite on disk               | ❌ cloud            | ✅                                                | ❌ cloud                  | ✅ (library)              | ✅                            |
| **Source-cited answers**                     | ✅ inline `[source:...]` per claim         | ✅                  | depends on plugin                                 | ✅ but no per-claim audit | you build it              | n/a                           |
| **Inspectable compiled wiki**                | ✅ readable .md files                      | ❌ chat only        | ✅ (but you write the notes)                      | ❌                        | n/a — you build the store | n/a                           |
| **Multi-agent research mode**                | ✅ collector→summarizer→skeptic→integrator | ❌                  | ❌                                                | ❌                        | you build it              | ❌                            |
| **Spaced-repetition recall**                 | ✅ built-in, Anki export                   | ❌                  | plugin only                                       | ❌                        | ❌                        | ✅ (that's the whole product) |
| **Append-only audit trail**                  | ✅ SHA-256 hash-chained JSONL              | ❌                  | ❌                                                | ❌                        | ❌                        | ❌                            |
| **Open source / hackable**                   | ✅ Apache-2.0                              | ❌                  | partial (core closed)                             | ❌                        | ✅                        | ✅                            |
| **Single CLI, no plugin zoo**                | ✅ 16 commands                             | n/a                 | ❌ (Obsidian Sync / Smart Connections / Copilot…) | n/a                       | ❌ you assemble           | n/a                           |
| **You write the data; the AI just reads it** | ✅ kernel owns state                       | ✅                  | ✅                                                | ✅                        | depends                   | ✅                            |

**The honest summary**: NotebookLM is the closest competitor in _function_, but it's a cloud product with no audit trail and no recall layer. Obsidian + plugins gets you a local wiki but you write every note yourself — `ico` writes the wiki for you by compiling sources. LangChain gives you the parts; `ico` is the assembled tool.

---

## The six layers (architecture in one screen)

```
   L1 raw/          ← what you put in (PDFs, MD, web clips)            APPEND-ONLY
       ↓                                                                deterministic
   L2 wiki/         ← compiled markdown (sources, concepts, topics,    RECOMPILABLE
                      contradictions, open questions)                   probabilistic
       ↓
   L3 tasks/<id>/   ← scoped episodic research workspaces              PER-TASK
                      (brief, evidence, notes, critique, output)        probabilistic
       ↓
   L4 outputs/      ← rendered reports, slides, briefings              PROMOTABLE
                                                                        probabilistic
       ↓
   L5 recall/       ← flashcards, quizzes, retention scores            ADAPTIVE
                                                                        deterministic
   L6 audit/        ← trace JSONL + audit log + hash chain             APPEND-ONLY
                                                                        deterministic
```

The hard constraint, drilled through every component: **the model never directly writes to L6 or to promotion tables.** It proposes a summary, a card, a synthesis — the kernel decides whether it lands.

---

## Commands you'll actually use

|                                   |                                                        |
| --------------------------------- | ------------------------------------------------------ |
| `ico init <name>`                 | Create a workspace                                     |
| `ico mount add <name> <path>`     | Register a source directory                            |
| `ico ingest <path>`               | Parse PDFs/MD/web-clips into the raw layer             |
| `ico compile all`                 | Run the six compiler passes (Claude calls happen here) |
| `ico ask "<question>"`            | Grounded Q&A with citations                            |
| `ico research "<brief>"`          | Multi-agent research task (5 stages, ~5 min)           |
| `ico render report --topic <t>`   | Generate a markdown report                             |
| `ico recall generate --topic <t>` | Build flashcards from compiled wiki                    |
| `ico recall quiz --topic <t>`     | Interactive quiz; tracks retention                     |
| `ico recall export --format anki` | Anki-importable TSV                                    |
| `ico lint`                        | Audit the wiki (schema, staleness, orphans)            |
| `ico status` / `ico inspect`      | Workspace summary / per-subsystem detail               |

Global flags on every command: `--workspace <path>`, `--json`, `--verbose`, `--quiet`. Full reference: `ico --help` or any command with `--help`.

---

## Status

**v1.21.0 — stable.** 1.21.0 tests passing across 5 packages. Used daily by the author. Public release on npm.

- **Stable**: all 16 commands, the compilation passes, ask + research + recall + render + promote, the audit chain.
- **In progress**: post-v1 coverage uplift on compiler + cli packages; mutation-testing baseline.
- **Roadmap**: remote/sync (Phase 3), multi-user (Phase 4), plugin system (Phase 5). All deliberately deferred to keep v1 local-first and inspectable.

---

## Documentation

The detailed specs (architecture, frontmatter schemas, trace event types, promotion rules, etc.) live in [`000-docs/`](000-docs/). Start with [007-PP-PLAN-master-blueprint.md](000-docs/007-PP-PLAN-master-blueprint.md) if you want the authoritative design document, or [003-AT-ARCH-architecture.md](000-docs/003-AT-ARCH-architecture.md) for the system-design view.

Development setup, conventions, PR process: [CONTRIBUTING.md](CONTRIBUTING.md).

Vulnerability reporting: [SECURITY.md](SECURITY.md).

---

## License

Apache-2.0 — see [LICENSE](LICENSE).

## Author

Jeremy Longshore · [intentsolutions.io](https://intentsolutions.io)
