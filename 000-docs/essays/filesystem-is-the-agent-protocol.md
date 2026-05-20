---
title: 'The Filesystem Is the Agent Protocol'
date: 2026-04-09
author: Jeremy Longshore
tags:
  - ai-agents
  - filesystem
  - workspace-conventions
  - knowledge-systems
  - compilation
---

# The Filesystem Is the Agent Protocol

In 1969, Ken Thompson made a decision that shaped all of computing: everything is a file. Devices, processes, network connections --- the Unix filesystem became a universal addressing scheme. You could `cat /dev/lp0` to talk to a printer. You didn't need a printer API.

In 2026, AI agents are making the opposite decision. Every framework invents its own state management. Cognitive state lives in context windows that evaporate on timeout. Memory is an afterthought bolted onto a chat loop. Coordination between agents means custom message-passing protocols that nobody outside the framework can inspect.

We standardized tool access. MCP gave agents a uniform way to call functions --- the equivalent of syscalls. But nobody standardized where agents _work_. There is no `/home` for an agent. No working directory. No convention for how an agent's evidence, drafts, notes, and conclusions should be laid out on disk so that another agent (or a human) can walk into the workspace and understand what happened.

This essay argues that the missing piece is not another orchestration framework. It is a structured, durable, audited workspace --- a filesystem convention that treats the context window as a volatile cache and the filesystem as the primary workspace. This is not an original observation. Multiple research efforts have converged on the same insight from different directions. What follows is what we learned building one such system, including the parts we got wrong.

## A Brief History of Making Things Addressable

The arc of computing infrastructure bends toward addressability. Each major advance took something that was previously opaque and gave it a name you could point to.

**Assemblers** replaced raw machine code addresses with symbolic labels. Instead of jumping to byte offset 0x4A2F, you wrote `JMP loop_start`. The program's structure became readable and modifiable. The key insight wasn't the syntax --- it was that the jump target had a _name_ that survived editing.

**Compilers** added durable intermediate representations. A C compiler doesn't just translate source to binary --- it produces object files, symbol tables, and link maps. These intermediate artifacts are inspectable. When something goes wrong, you can examine the `.o` file, read the symbol table, check the linker output. The compilation pipeline makes its work visible at every stage.

**Unix** took this further. Thompson and Ritchie made everything addressable through one interface: the filesystem. Devices became files (`/dev/`). Process information became files (`/proc/`). The filesystem wasn't just storage --- it was the universal namespace. Any tool that could read and write files could participate in the system. This is why Unix pipelines work: `cat`, `grep`, `sort`, and `wc` don't need to know about each other. They just read from stdin and write to stdout, which are file descriptors.

**Plan 9** extended the metaphor to networks. Remote resources got local filesystem paths. You could `ls /net/tcp` to see network connections. The filesystem became the coordination protocol for distributed systems.

Each of these breakthroughs followed the same pattern: take something opaque (memory addresses, compilation state, device I/O, network resources) and make it addressable through a uniform interface. Once something has an address, you can name it, version it, share it, and build tools around it without tight coupling.

Today, the opaque thing is **agent cognitive state**. When a Claude or GPT agent researches a topic, its gathered evidence, working hypotheses, intermediate drafts, and final conclusions exist only in the context window. When the context window is exhausted or the session ends, that state is gone. There is no address for "the evidence this agent collected" or "the draft this agent is working on." There is no `ls` for an agent's working memory.

This is where the computing infrastructure analogy is useful (though imperfect --- we have one implementation, not a proven standard). The pattern suggests that making agent cognitive state addressable through the filesystem could unlock the same kind of composability that `everything-is-a-file` unlocked for Unix tools.

## The Gap: MCP Gave Us Syscalls But Not a Filesystem

The Model Context Protocol standardized how agents call tools. Before MCP, every agent framework invented its own function-calling interface. MCP said: here is a standard way to describe tools, pass parameters, and return results. This was necessary and valuable. It is the syscall layer.

But syscalls without a filesystem mean every program manages its own storage. And that is exactly where AI agents are today.

Consider what happens when you ask an agent to research a complex topic across multiple sessions:

- **LangGraph** stores state in a checkpointer. The state shape is defined per-graph. There is no convention for where evidence goes versus where conclusions go.
- **CrewAI** passes results between agents via task objects. The intermediate state is in-memory. If you want to inspect what the "researcher" agent found, you need to hook into the framework.
- **AutoGen** uses conversation history as the coordination mechanism. Everything is a chat message. There is no distinction between evidence, working notes, and final output.
- **Claude's tool_use** returns results into the context window. The context window _is_ the working memory. When it fills up, you start over.

None of these are wrong for their use cases. But they all share a property: the agent's cognitive workspace is opaque to everything outside the framework. You can't `ls` what an agent found. You can't `diff` two research sessions. You can't `grep` across agent outputs without framework-specific tooling.

This is not an observation unique to us. The academic and open-source community has been converging on filesystem-based approaches from several directions:

- **CoALA** (Cognitive Architectures for Language Agents, Sumers et al., 2023) proposed a theoretical framework distinguishing working memory, episodic memory, semantic memory, and procedural memory. The memory taxonomy maps cleanly to filesystem directories.
- **AgentFS** gives agents a virtual filesystem for persistent storage, explicitly drawing the Unix analogy.
- **Git Context Controller** uses git repositories as the coordination substrate for multi-agent workflows --- version-controlled files as the shared state.
- **Generative Agents** (Park et al., 2023) demonstrated that agents with structured, retrievable memory (stored as text records with timestamps and importance scores) produce qualitatively different behavior than agents with only conversation context.
- **AgentSight** provides observability tools for inspecting agent internal state --- solving the problem at the monitoring layer rather than the storage layer.
- **MemOS** (Hu et al., 2025) proposes an operating-system-style architecture for LLM memory management, with explicit memory modules and lifecycle management.
- **Letta** (formerly MemGPT) implements a tiered memory system where agents explicitly manage what stays in their context window versus what gets paged to external storage.

What none of these systems do (as far as I've found) is compute live views from audit trails. They store state; they don't derive observability from stored operations. That might be the one genuinely under-explored idea in this space.

## The Inversion: Filesystem Primary, Context Window Cache

The current default paradigm for AI agent development:

| Concern        | Current Approach               |
| -------------- | ------------------------------ |
| Working memory | Context window                 |
| Persistence    | Optional, framework-specific   |
| Coordination   | Message passing between agents |
| Introspection  | Logging (if you're lucky)      |
| Auditability   | Not a priority                 |

The proposed inversion:

| Concern        | Workspace Approach              |
| -------------- | ------------------------------- |
| Working memory | Files on disk                   |
| Persistence    | Filesystem (it is always there) |
| Coordination   | Reading and writing files       |
| Introspection  | `ls`, `cat`, `grep`             |
| Auditability   | Append-only trace files         |

This is not as clean as the table makes it look. I need to be honest about the actual implementation: **SQLite is the real coordination substrate, not the filesystem.** The sources table, compilations table, tasks table, and promotions table are what maintain consistent state. The filesystem stores the _content_ of that state --- the markdown files, the raw PDFs, the JSONL traces. The database answers "what has been compiled and what is stale?" The filesystem answers "what does the compiled output actually say?"

So the more accurate claim is: agents need a durable, structured workspace with both a state database and a content filesystem, and the content should be in human-readable formats (markdown, JSONL) that can be inspected without special tooling.

The context window still matters. It is where the agent does its actual thinking --- reading source material, drafting summaries, reasoning about contradictions. But the context window should be treated the way CPU registers treat RAM: as a working space that loads from and stores to a durable backing store. The backing store is the workspace.

This means the agent's workflow changes from "do everything in one context window" to:

1. Read the relevant workspace files into context
2. Do the cognitive work (summarize, analyze, synthesize)
3. Write results back to the workspace
4. Clear context and move to the next task

This is the compilation model. And it is what compilers have been doing since the 1950s.

## The Implementation: ICO as Reference

Intentional Cognition OS is a reference implementation of these workspace conventions. "Reference" is the right word --- it has zero external users, 878 tests, and fourteen CLI commands. It is a working system, not a proven standard.

The workspace layout has six layers, each with explicit mutability rules:

```text
workspace/
  raw/          # L1: Append-only. Source PDFs, articles, notes.
  wiki/         # L2: Recompilable. Compiled knowledge as markdown.
  tasks/        # L3: Ephemeral. Scoped research workspaces.
  outputs/      # L4: Durable. Rendered reports, slides.
  recall/       # L5: Adaptive. Flashcards and retention data.
  audit/        # L6: Append-only. JSONL traces, provenance, promotions.
```

The compilation pipeline transforms raw sources into compiled knowledge through six passes:

1. **Summarize**: One source in, one summary out. `raw/papers/attention.pdf` becomes `wiki/sources/attention-is-all-you-need.md`.
2. **Extract**: Pull concepts and entities. Creates `wiki/concepts/self-attention.md`, `wiki/entities/google-brain.md`.
3. **Synthesize**: Cross-source topic pages. `wiki/topics/transformer-architectures.md` draws from multiple sources.
4. **Contradict**: Find disagreements between sources. `wiki/contradictions/scaling-laws-disagreement.md`.
5. **Gap**: Identify what the corpus doesn't cover. `wiki/open-questions/attention-complexity-bounds.md`.
6. **Link**: Build cross-reference indexes. `wiki/indexes/by-topic.md`.

The critical architectural constraint is the **deterministic/probabilistic boundary**. Claude (the LLM) proposes content --- it drafts the summaries, extracts the concepts, identifies the contradictions. But the deterministic system (TypeScript kernel + SQLite) owns all durable state. The model never writes directly to the audit trail, never modifies the source registry, never triggers promotions. Every write goes through a kernel function that validates, records provenance, emits a trace event, and appends to the audit log.

Here is what multi-agent research looks like concretely. When a user runs `ico research "How do transformer attention patterns differ from biological attention?"`, the system:

1. Creates a task workspace: `workspace/tasks/tsk-01JQXYZ.../` with subdirectories for `evidence/`, `notes/`, `drafts/`, `critique/`, and `output/`.
2. Writes a `brief.md` with YAML frontmatter recording the question, timestamp, and task ID.
3. Registers the task in SQLite with status `created`.
4. Emits a trace event and appends to the audit log.

After creation, collector agents gather evidence from the compiled wiki into `evidence/`. Summarizer agents write working notes to `notes/`. An integrator drafts the answer in `drafts/`. A skeptic writes counter-arguments to `critique/`. The final output lands in `output/`. Each agent reads and writes files --- they coordinate through the filesystem. When the task completes, valuable findings can be promoted back to L2 (`ico promote output/key-finding.md --as topic`), and the task workspace is archived.

This is mundane. That is the point. There is nothing exotic about creating directories, writing markdown files, and tracking state in SQLite. But the mundaneness is the feature. Any tool that can read files can observe what the agents did. Any agent that can write files can participate. The coordination protocol is the filesystem.

## What We Got Wrong

Building ICO surfaced several mistakes that are worth documenting for anyone attempting something similar.

**The procfs analogy was premature.** Our original design included a `_proc/` virtual directory that would expose computed views of workspace state --- live task status, compilation progress, staleness reports --- as readable files, inspired by Linux's `/proc` filesystem. This is not implemented, and calling it "procfs" in our design docs was aspirational at best. What we actually have is SQLite queries exposed through CLI commands (`ico status`, `ico inspect`). The idea of computed filesystem views derived from audit trails remains interesting, but claiming we built it would be dishonest.

**The triple-write is over-engineered.** Every significant operation in ICO writes to three places: SQLite (structured state), JSONL trace files (append-only audit), and the filesystem (content). The SQLite + JSONL dual-write for audit data made sense on paper --- SQLite for queryability, JSONL for tamper-evident integrity chains with SHA-256 hashing. In practice, maintaining consistency across three write targets adds complexity without proportional benefit at our current scale (one user, local-only). A single SQLite database with WAL mode would probably suffice for Phase 1. We kept the design because the JSONL traces become valuable when you want to replay operations or train on your own workflow, but we should have deferred this to a later phase.

**The 7-state task machine encodes opinions, not requirements.** Tasks in ICO progress through seven states: `created`, `collecting`, `synthesizing`, `critiquing`, `rendering`, `completed`, `archived`. This state machine reflects one specific research methodology (gather evidence, synthesize, critique, render). Other research workflows --- exploratory brainstorming, adversarial debate, iterative hypothesis refinement --- don't fit this progression. We should have started with three states (`open`, `completed`, `archived`) and let the workflow emerge from the filesystem structure rather than encoding it in the database schema.

**The promotion engine has 11 error codes for what is conceptually a file copy.** The `PromotionErrorCode` type includes `INELIGIBLE_PATH`, `FILE_NOT_FOUND`, `EMPTY_FILE`, `MISSING_FRONTMATTER`, `INVALID_TYPE`, `DRAFT_REJECTED`, `EVIDENCE_REJECTED`, `NOT_CONFIRMED`, `TARGET_EXISTS`, `COPY_FAILED`, and `AUDIT_WRITE_FAILED`. Each error has a distinct exit code and user-facing message. This granularity exists because promotion is the gateway between ephemeral work (L4 artifacts) and durable knowledge (L2 wiki), and we wanted to make every rejection reason explicit and actionable. But eleven error codes for "copy a file from outputs/ to wiki/" suggests the abstraction is carrying too much weight. The validation rules are individually reasonable --- don't promote empty files, don't promote task drafts directly --- but the aggregate complexity is a code smell.

**Filesystem permissions are design conventions, not security boundaries.** ICO sets files in `raw/` and `audit/` to `0444` (read-only) after writing, which provides some protection against accidental modification. But these are enforced by code discipline and OS file permissions, not by a security model. Any process running as the same user can `chmod` and overwrite them. We describe these as "enforcement mechanisms" in our documentation, and that framing overpromises. They are conventions backed by lint checks and defensive code, not security guarantees.

## The Invitation

ICO is open source under the MIT license. The code is at [github.com/jeremylongshore/intentional-cognition-os](https://github.com/jeremylongshore/intentional-cognition-os). We are not asking anyone to adopt a standard.

What we are asking is simpler: **try giving your agents a structured workspace and see if they perform better.**

The specific claim we are willing to defend is narrow: agents that compile knowledge into durable, structured, human-readable files produce better results than agents that keep everything in the context window. Compilation --- the act of transforming raw inputs into derived, typed, cross-referenced outputs --- is the mechanism that makes knowledge reusable across sessions, inspectable by humans, and auditable after the fact.

We should have tested this claim rigorously before building eight epics of implementation. The evaluation framework is Epic 10 in our plan. It should have been Epic 2. The core experiment is straightforward: take a set of research questions, run them with raw-docs-in-context (the baseline) and with compiled-wiki-in-context (the treatment), and measure answer quality, factual accuracy, and source attribution. If compiled knowledge doesn't meaningfully beat raw documents stuffed into a context window, then the compilation layer doesn't deserve to exist. We have not run this experiment yet. That is a significant gap, and we are aware of it.

In the meantime, here is what we observe anecdotally: when agents work in a structured workspace, the _human_ experience improves even if the agent performance is unchanged. You can see what the agent did. You can read the evidence it gathered. You can check the sources it cited. You can disagree with its conclusions and point to the specific draft where it went wrong. The workspace makes the agent's cognition _addressable_, and addressability enables accountability.

This brings us back to where we started. Assemblers made code addresses readable. Compilers made intermediate representations inspectable. Unix made devices and processes addressable through files. The pattern is consistent: when you give something an address, you can reason about it, compose it, and improve it.

Agent cognitive state deserves an address. A structured workspace --- conventions for where evidence goes, how compilations are tracked, what gets audited --- is how you provide one. Whether those conventions look like ICO's six-layer layout or something entirely different doesn't matter much. What matters is that the workspace exists, that it is durable, that it is human-readable, and that the agent's work is visible after the session ends.

The filesystem is already there. It has been there since 1969. We just need to use it.

---

## References

- Sumers, T. R., Yao, S., Narasimhan, K., & Griffiths, T. L. (2023). "Cognitive Architectures for Language Agents." _arXiv:2309.02427_.
- Park, J. S., O'Brien, J. C., Cai, C. J., et al. (2023). "Generative Agents: Interactive Simulacra of Human Behavior." _UIST 2023_.
- Hu, Z., et al. (2025). "MemOS: An Operating System for LLM Memory Management." _arXiv preprint_.
- AgentFS. GitHub. Virtual filesystem for AI agent persistent storage.
- Git Context Controller. Using git repositories as multi-agent coordination substrate.
- Letta (formerly MemGPT). Tiered memory management for LLM agents.
- AgentSight. Observability tooling for AI agent internal state inspection.
- Anthropic. (2024). "Model Context Protocol Specification."
