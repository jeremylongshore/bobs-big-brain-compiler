# Architecture Diagram Prompt Pack

> Six diagrams. Six perspectives on the same system.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

These six diagrams cover the complete architecture of Intentional Cognition OS. Each entry provides a generation prompt, the expected Mermaid diagram code, and a description of what the diagram shows. Feed any prompt directly to an LLM to regenerate or extend the diagram.

Diagrams are ordered from structural (what the system is) to behavioral (what the system does).

---

## 1. Six-Layer Stack Diagram

**What it shows.** The six storage and responsibility layers of the system, stacked vertically from raw inputs at the bottom to audit control at the top. Each layer shows its storage path, data classification, and mutability policy.

**Generation prompt.**

> Draw a vertical stack diagram in Mermaid showing the six layers of the Intentional Cognition OS architecture. Layer 1 (Raw Corpus) is at the bottom; Layer 6 (Audit & Policy) is at the top. For each layer show: the layer number and name, the storage path under workspace/, and the mutability classification (append-only, recompilable, created/archived per task, promotable, adaptive, or append-only). Use a block diagram or flowchart with top-down orientation. Apply distinct fill colors per layer to distinguish them visually. L1 is the source of truth; L6 is the deterministic control plane.

**Diagram.**

```mermaid
%%{init: {"flowchart": {"rankDir": "TB"}, "themeVariables": {"fontSize": "14px"}}}%%
flowchart TB
    %% Layer definitions — top to bottom in diagram, L6 at top per spec
    L6["**L6 — Audit & Policy**
    workspace/audit/
    Classification: Audit
    Mutability: Append-only
    Owns: provenance · traces · policy · promotions · evals"]

    L5["**L5 — Recall**
    workspace/recall/
    Classification: Adaptive
    Mutability: Updated by feedback
    Owns: flashcards · quizzes · decks · retention scores"]

    L4["**L4 — Artifacts**
    workspace/outputs/
    Classification: Durable
    Mutability: Permanent — promotable to L2
    Owns: reports · slides · charts · briefings"]

    L3["**L3 — Episodic Tasks**
    workspace/tasks/&lt;task-id&gt;/
    Classification: Ephemeral
    Mutability: Created and archived per task
    Owns: evidence · notes · drafts · critique · output"]

    L2["**L2 — Semantic Knowledge**
    workspace/wiki/
    Classification: Compiled
    Mutability: Recompilable from L1
    Owns: summaries · concepts · topics · entities · backlinks · contradictions"]

    L1["**L1 — Raw Corpus**
    workspace/raw/
    Classification: Canonical
    Mutability: Append-only — never modified after ingest
    Owns: articles · papers · repos · notes · datasets"]

    %% Stack — L6 at top, L1 at bottom
    L6 --> L5
    L5 --> L4
    L4 --> L3
    L3 --> L2
    L2 --> L1

    %% Styles
    style L1 fill:#2d4a22,color:#e8f5e9,stroke:#4caf50,stroke-width:2px
    style L2 fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5,stroke-width:2px
    style L3 fill:#4a2d00,color:#fff8e1,stroke:#ffa726,stroke-width:2px
    style L4 fill:#3a1a5c,color:#f3e5f5,stroke:#ab47bc,stroke-width:2px
    style L5 fill:#1a4a3a,color:#e8f5e9,stroke:#26a69a,stroke-width:2px
    style L6 fill:#4a1a1a,color:#fce4ec,stroke:#ef5350,stroke-width:2px
```

---

## 2. Workspace Layout Diagram

**What it shows.** The full directory tree of an initialized ICO workspace, as specified in Blueprint Section 11. Covers all six storage layers and the code component directories. This is the canonical reference for where every file type belongs.

**Generation prompt.**

> Draw a tree diagram in Mermaid showing the complete directory layout of the Intentional Cognition OS workspace. The root is intentional-cognition-os/. Include these top-level directories: cli/, kernel/, compiler/, workspace/, mounts/, evals/, apps/, and 000-docs/. Under workspace/, expand all subdirectories: raw/ (with articles/, papers/, repos/, notes/), wiki/ (with index.md, sources/, concepts/, entities/, topics/, contradictions/, open-questions/, indexes/), tasks/ (with a single <task-id>/ showing evidence/, notes/, drafts/, critique/, output/), outputs/ (with reports/, slides/, charts/, briefings/), recall/ (with cards/, decks/, quizzes/, retention/), and audit/ (with log.md, traces/, provenance/, policy/, promotions/). Label each top-level workspace subdirectory with its layer number (L1–L6).

**Diagram.**

```mermaid
%%{init: {"flowchart": {"rankDir": "LR"}}}%%
flowchart LR
    ROOT["intentional-cognition-os/"]

    %% Code components
    CLI["cli/\n(ICO entry point)"]
    KERNEL["kernel/\n(state · mounts · lifecycle)"]
    COMPILER["compiler/\n(summarize · extract · link · lint)"]
    MOUNTS["mounts/\n(corpus mount configs)"]
    EVALS["evals/\n(evaluation specs)"]
    APPS["apps/\n(web UI — Phase 5+)"]
    DOCS["000-docs/\n(architecture & planning)"]

    %% Workspace root
    WS["workspace/"]

    %% L1
    RAW["raw/  ← L1 Raw Corpus"]
    RAW_A["articles/"]
    RAW_P["papers/"]
    RAW_R["repos/"]
    RAW_N["notes/"]

    %% L2
    WIKI["wiki/  ← L2 Semantic Knowledge"]
    WIKI_IDX["index.md"]
    WIKI_SRC["sources/"]
    WIKI_CON["concepts/"]
    WIKI_ENT["entities/"]
    WIKI_TOP["topics/"]
    WIKI_CTR["contradictions/"]
    WIKI_OQ["open-questions/"]
    WIKI_IX["indexes/"]

    %% L3
    TASKS["tasks/  ← L3 Episodic Tasks"]
    TASK_ID["&lt;task-id&gt;/"]
    TASK_EV["evidence/"]
    TASK_NO["notes/"]
    TASK_DR["drafts/"]
    TASK_CR["critique/"]
    TASK_OP["output/"]

    %% L4
    OUT["outputs/  ← L4 Artifacts"]
    OUT_R["reports/"]
    OUT_S["slides/"]
    OUT_C["charts/"]
    OUT_B["briefings/"]

    %% L5
    REC["recall/  ← L5 Recall"]
    REC_C["cards/"]
    REC_D["decks/"]
    REC_Q["quizzes/"]
    REC_RT["retention/"]

    %% L6
    AUD["audit/  ← L6 Audit & Policy"]
    AUD_LOG["log.md"]
    AUD_TR["traces/"]
    AUD_PR["provenance/"]
    AUD_PO["policy/"]
    AUD_PM["promotions/"]

    %% Root connections
    ROOT --> CLI
    ROOT --> KERNEL
    ROOT --> COMPILER
    ROOT --> WS
    ROOT --> MOUNTS
    ROOT --> EVALS
    ROOT --> APPS
    ROOT --> DOCS

    %% Workspace branches
    WS --> RAW
    WS --> WIKI
    WS --> TASKS
    WS --> OUT
    WS --> REC
    WS --> AUD

    %% L1 tree
    RAW --> RAW_A
    RAW --> RAW_P
    RAW --> RAW_R
    RAW --> RAW_N

    %% L2 tree
    WIKI --> WIKI_IDX
    WIKI --> WIKI_SRC
    WIKI --> WIKI_CON
    WIKI --> WIKI_ENT
    WIKI --> WIKI_TOP
    WIKI --> WIKI_CTR
    WIKI --> WIKI_OQ
    WIKI --> WIKI_IX

    %% L3 tree
    TASKS --> TASK_ID
    TASK_ID --> TASK_EV
    TASK_ID --> TASK_NO
    TASK_ID --> TASK_DR
    TASK_ID --> TASK_CR
    TASK_ID --> TASK_OP

    %% L4 tree
    OUT --> OUT_R
    OUT --> OUT_S
    OUT --> OUT_C
    OUT --> OUT_B

    %% L5 tree
    REC --> REC_C
    REC --> REC_D
    REC --> REC_Q
    REC --> REC_RT

    %% L6 tree
    AUD --> AUD_LOG
    AUD --> AUD_TR
    AUD --> AUD_PR
    AUD --> AUD_PO
    AUD --> AUD_PM

    %% Styles — match layer colors from Diagram 1
    style RAW fill:#2d4a22,color:#e8f5e9,stroke:#4caf50
    style WIKI fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style TASKS fill:#4a2d00,color:#fff8e1,stroke:#ffa726
    style OUT fill:#3a1a5c,color:#f3e5f5,stroke:#ab47bc
    style REC fill:#1a4a3a,color:#e8f5e9,stroke:#26a69a
    style AUD fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
```

---

## 3. Data Flow Diagram

**What it shows.** The full operating loop — ingest → compile → reason → render → refine — with branching for simple ask vs. complex research, multi-agent roles, promotion back to L2, and recall generation. This is the behavioral view of the system.

**Generation prompt.**

> Draw a data flow diagram in Mermaid showing the Intentional Cognition OS operating loop. Start with user sources being ingested via `ico ingest` into the Raw Corpus (L1). From L1, `ico compile` transforms content into the Semantic Knowledge layer (L2). From L2, the user can issue `ico ask`. Simple questions route to a Direct Answer. Complex questions route to the Episodic Task layer (L3) where collector, summarizer, skeptic, and integrator agents operate in sequence. Both paths converge at `ico render`, which produces an artifact in the Artifact layer (L4). From L4, two branches exist: `ico promote` copies the artifact back to L2 (entering the compilation lifecycle), and `ico recall generate` produces material in the Recall layer (L5). All meaningful events write traces to the Audit & Policy layer (L6) via `ico lint` and `ico eval`. Show the audit trace arrows as dashed lines to distinguish them from the primary data flow. Label each major transition with the CLI command that triggers it.

**Diagram.**

```mermaid
flowchart TD
    USER["User Sources\n(PDFs · articles · repos · notes)"]

    L1["L1 — Raw Corpus\nworkspace/raw/"]
    L2["L2 — Semantic Knowledge\nworkspace/wiki/"]
    L3["L3 — Episodic Tasks\nworkspace/tasks/&lt;id&gt;/"]
    L4["L4 — Artifacts\nworkspace/outputs/"]
    L5["L5 — Recall\nworkspace/recall/"]
    L6["L6 — Audit & Policy\nworkspace/audit/"]

    %% Simple ask path
    SIMPLE["Direct Answer\n(cited response)"]

    %% Multi-agent roles
    COLLECT["Collector\ngather evidence from L2"]
    SUMMARIZE["Summarizer\ndistill working notes"]
    SKEPTIC["Skeptic\nchallenge conclusions"]
    INTEGRATE["Integrator\nsynthesize final answer"]

    %% Primary flow
    USER -->|"ico ingest"| L1
    L1 -->|"ico compile"| L2
    L2 -->|"ico ask"| FORK{simple or complex?}

    FORK -->|simple| SIMPLE
    FORK -->|complex| COLLECT

    COLLECT --> SUMMARIZE
    SUMMARIZE --> SKEPTIC
    SKEPTIC --> INTEGRATE

    SIMPLE -->|"ico render"| L4
    INTEGRATE -->|"ico render"| L4

    %% Promotion and recall
    L4 -->|"ico promote"| L2
    L4 -->|"ico recall generate"| L5

    %% Audit traces (dashed)
    L1 -.->|"ingest trace"| L6
    L2 -.->|"compile trace"| L6
    L3 -.->|"task trace"| L6
    L4 -.->|"render trace"| L6
    L5 -.->|"recall trace"| L6
    L2 -.->|"ico lint / ico eval"| L6

    %% L3 grouping note
    COLLECT -.-> L3
    SUMMARIZE -.-> L3
    SKEPTIC -.-> L3
    INTEGRATE -.-> L3

    %% Styles
    style L1 fill:#2d4a22,color:#e8f5e9,stroke:#4caf50
    style L2 fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style L3 fill:#4a2d00,color:#fff8e1,stroke:#ffa726
    style L4 fill:#3a1a5c,color:#f3e5f5,stroke:#ab47bc
    style L5 fill:#1a4a3a,color:#e8f5e9,stroke:#26a69a
    style L6 fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
    style FORK fill:#333,color:#fff,stroke:#888
    style USER fill:#1a1a2e,color:#eee,stroke:#555
    style SIMPLE fill:#1a1a2e,color:#eee,stroke:#555
    style COLLECT fill:#4a2d00,color:#fff8e1,stroke:#ffa726
    style SUMMARIZE fill:#4a2d00,color:#fff8e1,stroke:#ffa726
    style SKEPTIC fill:#4a2d00,color:#fff8e1,stroke:#ffa726
    style INTEGRATE fill:#4a2d00,color:#fff8e1,stroke:#ffa726
```

---

## 4. Task Lifecycle Diagram

**What it shows.** The state machine for an episodic research task. States run from `created` through `archived`. Each state shows the agent role active at that stage and the workspace subdirectory being written.

**Generation prompt.**

> Draw a state diagram in Mermaid (stateDiagram-v2) showing the lifecycle of an Intentional Cognition OS research task. The states are: created, collecting, synthesizing, critiquing, rendering, completed, and archived. Transitions are triggered by agent role completion or operator action. Annotate each state with the active agent role (Collector, Summarizer, Skeptic, Integrator, Builder, or system) and the workspace subdirectory being written (evidence/, notes/, critique/, output/). Show that completed is the only state from which promotion to L2 is allowed. Show that the task can be archived from completed. Include a failed edge from any active state back to created for error recovery.

**Diagram.**

```mermaid
stateDiagram-v2
    [*] --> created : ico research

    state created {
        [*] --> init
        init : System creates workspace/tasks/&lt;id&gt;/
        init : Writes task manifest to audit/traces/
    }

    state collecting {
        [*] --> gather
        gather : Agent role: Collector
        gather : Writes to: tasks/&lt;id&gt;/evidence/
    }

    state synthesizing {
        [*] --> distill
        distill : Agent role: Summarizer
        distill : Writes to: tasks/&lt;id&gt;/notes/
    }

    state critiquing {
        [*] --> challenge
        challenge : Agent role: Skeptic
        challenge : Writes to: tasks/&lt;id&gt;/critique/
    }

    state rendering {
        [*] --> build
        build : Agent role: Integrator + Builder
        build : Writes to: tasks/&lt;id&gt;/output/
        build : Copies artifact to workspace/outputs/
    }

    state completed {
        [*] --> done
        done : Artifact available in workspace/outputs/
        done : Promotion eligible via ico promote
        done : Recall generation eligible via ico recall generate
    }

    state archived {
        [*] --> archive
        archive : Workspace retained but no longer active
        archive : Task trace closed in audit/traces/
    }

    created --> collecting : task initialized
    collecting --> synthesizing : evidence gathered
    synthesizing --> critiquing : notes complete
    critiquing --> rendering : critique complete
    rendering --> completed : artifact rendered
    completed --> archived : ico archive / auto-archive policy

    %% Error recovery
    collecting --> created : error — restart
    synthesizing --> created : error — restart
    critiquing --> created : error — restart
    rendering --> created : error — restart

    %% Terminal
    archived --> [*]
```

---

## 5. Provenance Chain Diagram

**What it shows.** The full provenance chain from a raw source file to a rendered report. Each transformation step records an audit trace. This diagram proves that every durable output is traceable back to its source and that the deterministic system — not the model — owns the chain.

**Generation prompt.**

> Draw a flowchart in Mermaid showing the provenance chain of the Intentional Cognition OS. The chain runs left to right: Raw Source → (ico ingest) → Source Record in L1 → (ico compile: Summarize pass) → Source Summary in L2 → (ico compile: Synthesize pass) → Topic Page in L2 → (ico render) → Report in L4 → (ico promote) → Promoted Page in L2. At each transformation arrow, show a dashed downward arrow to an Audit Trace node in L6, labeled with the event type (ingest_event, compile_event, render_event, promote_event). Distinguish deterministic nodes (filled with a dark red/audit color) from probabilistic transformation steps (filled with a blue/compiled color). Add a note that the model proposes content at each probabilistic step but the kernel writes the audit record.

**Diagram.**

```mermaid
flowchart LR
    %% Primary provenance chain
    SRC["Raw Source\n(PDF · article · repo · note)"]
    L1REC["Source Record\nworkspace/raw/\nL1 — Canonical"]
    SUMM["Source Summary\nworkspace/wiki/sources/\nL2 — Compiled"]
    TOPIC["Topic Page\nworkspace/wiki/topics/\nL2 — Compiled"]
    REPORT["Report\nworkspace/outputs/reports/\nL4 — Durable"]
    PROMOTED["Promoted Page\nworkspace/wiki/topics/\nL2 — Compiled"]

    %% Audit trace nodes
    T1["audit/provenance/\ningest_event\n{source, hash, timestamp}"]
    T2["audit/traces/\ncompile_event\n{pass: summarize, source_id}"]
    T3["audit/traces/\ncompile_event\n{pass: synthesize, topic}"]
    T4["audit/traces/\nrender_event\n{task_id, artifact_path}"]
    T5["audit/promotions/\npromote_event\n{source, target, actor}"]

    %% Primary chain
    SRC -->|"ico ingest\n[deterministic]"| L1REC
    L1REC -->|"ico compile sources\n[probabilistic — model summarizes]"| SUMM
    SUMM -->|"ico compile topic\n[probabilistic — model synthesizes]"| TOPIC
    TOPIC -->|"ico render report\n[probabilistic — model drafts]"| REPORT
    REPORT -->|"ico promote\n[deterministic — explicit operator action]"| PROMOTED

    %% Audit traces (dashed)
    L1REC -.->|"kernel writes"| T1
    SUMM -.->|"kernel writes"| T2
    TOPIC -.->|"kernel writes"| T3
    REPORT -.->|"kernel writes"| T4
    PROMOTED -.->|"kernel writes"| T5

    %% Styles
    style SRC fill:#1a1a2e,color:#eee,stroke:#555
    style L1REC fill:#2d4a22,color:#e8f5e9,stroke:#4caf50
    style SUMM fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style TOPIC fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style REPORT fill:#3a1a5c,color:#f3e5f5,stroke:#ab47bc
    style PROMOTED fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style T1 fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
    style T2 fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
    style T3 fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
    style T4 fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
    style T5 fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
```

**Deterministic/probabilistic boundary note.** The model proposes content at every `[probabilistic]` step. The kernel writes the audit record at every step — deterministic, unconditional, not delegated to the model. The model never writes to `workspace/audit/`.

---

## 6. Promotion Flow Diagram

**What it shows.** The promotion pipeline: how a durable artifact moves from L4 back into the semantic knowledge layer (L2). Covers eligibility checks, the explicit `ico promote` command, the copy operation, audit logging, and re-entry into the compilation lifecycle. Shows the anti-patterns that block promotion.

**Generation prompt.**

> Draw a flowchart in Mermaid showing the promotion flow of the Intentional Cognition OS. Start with an artifact in workspace/outputs/ (L4). Show an eligibility check: is the artifact in workspace/outputs/? If not, reject with "Not eligible — must be in workspace/outputs/". If yes, the operator issues `ico promote <path> --as <type>` where type is one of: topic, concept, entity, or reference. The system copies (not moves) the artifact to workspace/wiki/<type>/. It writes a promotion record to workspace/audit/promotions/ containing source path, target path, timestamp, and actor. The promoted page then enters the normal compilation lifecycle: it becomes eligible for Link, Contradict, and Gap passes. Show a blocked path for automatic promotion with a rejection node labeled "Automatic promotion not allowed — must be explicit". Include the anti-patterns as a separate warning subgraph: promoting raw task drafts, promoting without review, and promoting ephemeral evidence.

**Diagram.**

```mermaid
flowchart TD
    ARTIFACT["Artifact\nworkspace/outputs/\nL4 — Durable"]

    CHECK{In workspace/outputs/?}
    REJECT_PATH["Rejected\nNot eligible\nMust be in workspace/outputs/"]

    AUTO_BLOCK["Rejected\nAutomatic promotion\nnot allowed\nPromotion is always explicit"]

    CMD["ico promote &lt;path&gt; --as &lt;type&gt;\ntype: topic | concept | entity | reference\n[Operator — explicit action required]"]

    COPY["System copies artifact\nworkspace/wiki/&lt;type&gt;/\n(original remains in workspace/outputs/)"]

    AUDIT_WRITE["Promotion record written\nworkspace/audit/promotions/\n{source, target, timestamp, actor}"]

    L2_ENTRY["Promoted page enters L2\ncompilation lifecycle"]

    LINK_PASS["Link pass eligible\nbidirectional references added"]
    CONTRADICT["Contradict pass eligible\nconflict checking enabled"]
    GAP["Gap pass eligible\nopen-question detection enabled"]

    %% Anti-patterns subgraph
    subgraph ANTIPATTERNS ["Anti-patterns — blocked"]
        AP1["Promoting raw task drafts\nUse only completed, reviewed artifacts"]
        AP2["Promoting without review\nPromotion is a quality gate"]
        AP3["Promoting ephemeral evidence\nEvidence stays in L3 — only synthesis to L2"]
    end

    %% Main flow
    ARTIFACT --> CHECK
    CHECK -->|No| REJECT_PATH
    CHECK -->|Yes| CMD

    %% Auto promotion block
    AUTO_BLOCK -.->|"system cannot self-promote"| CMD

    CMD --> COPY
    COPY --> AUDIT_WRITE
    AUDIT_WRITE --> L2_ENTRY

    L2_ENTRY --> LINK_PASS
    L2_ENTRY --> CONTRADICT
    L2_ENTRY --> GAP

    %% Anti-patterns connection
    CMD -.->|"blocked"| ANTIPATTERNS

    %% Styles
    style ARTIFACT fill:#3a1a5c,color:#f3e5f5,stroke:#ab47bc
    style CMD fill:#1a1a2e,color:#eee,stroke:#888
    style COPY fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style AUDIT_WRITE fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
    style L2_ENTRY fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style LINK_PASS fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style CONTRADICT fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style GAP fill:#1a3a5c,color:#e3f2fd,stroke:#42a5f5
    style REJECT_PATH fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
    style AUTO_BLOCK fill:#4a1a1a,color:#fce4ec,stroke:#ef5350
    style CHECK fill:#333,color:#fff,stroke:#888
    style ANTIPATTERNS fill:#2a1a1a,color:#fce4ec,stroke:#ef5350
    style AP1 fill:#2a1a1a,color:#fce4ec,stroke:#555
    style AP2 fill:#2a1a1a,color:#fce4ec,stroke:#555
    style AP3 fill:#2a1a1a,color:#fce4ec,stroke:#555
```

---

## Appendix: Rendering Instructions

**Local rendering.** Paste any diagram code block into [mermaid.live](https://mermaid.live) for immediate preview and export. No account required.

**VS Code.** Install the Markdown Preview Mermaid Support extension. Open any `.md` file and toggle the preview pane — diagrams render inline.

**GitHub.** GitHub renders Mermaid natively in `.md` files on any branch or PR. Fenced code blocks tagged `mermaid` are rendered automatically.

**Export.** From mermaid.live: export as SVG for vector fidelity (recommended for docs), PNG for presentations, or copy the diagram definition for embedding. SVG is preferred — it scales without loss and supports dark backgrounds.

**Regeneration.** Each diagram section contains a self-contained generation prompt. Feed the prompt to any capable LLM to regenerate, extend, or adapt the diagram. The prompts are written to produce valid Mermaid output without additional context beyond the prompt text.

**Color palette.** The six-layer color scheme is consistent across all diagrams:

| Layer                 | Fill                    | Border    |
| --------------------- | ----------------------- | --------- |
| L1 Raw Corpus         | `#2d4a22` (dark green)  | `#4caf50` |
| L2 Semantic Knowledge | `#1a3a5c` (dark blue)   | `#42a5f5` |
| L3 Episodic Tasks     | `#4a2d00` (dark amber)  | `#ffa726` |
| L4 Artifacts          | `#3a1a5c` (dark purple) | `#ab47bc` |
| L5 Recall             | `#1a4a3a` (dark teal)   | `#26a69a` |
| L6 Audit & Policy     | `#4a1a1a` (dark red)    | `#ef5350` |
