# User Journey: intentional-cognition-os

> Compile knowledge for the machine. Distill understanding for the human.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-02
**Status:** Active

## Persona

| Field            | Value                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Name             | Alex — independent AI researcher                                                                     |
| Role             | Technical researcher building a knowledge system for ongoing AI safety work                          |
| Goal             | Turn 200+ papers, articles, and notes into a maintained, queryable, auditable knowledge base         |
| Experience Level | Intermediate — comfortable with CLI, uses Claude Code daily, familiar with markdown workflows        |
| Current Pain     | Re-reads papers constantly, loses synthesis across sessions, can't trace conclusions back to sources |

## Prerequisites

- [x] Node.js 22+ installed
- [x] pnpm installed
- [x] Claude API key (set in .env as ANTHROPIC_API_KEY)
- [x] Source material ready (PDFs, markdown files, or URLs)

## Walkthrough

### Step 1: Initialize a Workspace

Alex creates a new knowledge workspace for their AI safety research.

```bash
ico init ai-safety-research
cd ai-safety-research
```

**Expected Result:** A workspace directory is created:

```
ai-safety-research/
├── workspace/
│   ├── raw/
│   ├── wiki/
│   ├── tasks/
│   ├── outputs/
│   ├── recall/
│   └── audit/
├── mounts/
├── .env.example
└── ico.config.yaml
```

SQLite database initialized. Audit trace started.

### Step 2: Ingest Source Material

Alex ingests their collection of papers, articles, and personal notes.

```bash
# Ingest a directory of PDFs
ico ingest ~/papers/ai-safety/ --type pdf

# Ingest markdown notes
ico ingest ~/notes/alignment-notes/

# Ingest a specific web article
ico ingest https://example.com/interpretability-survey-2026.html

# Check what's been ingested
ico status
```

**Expected Result:**

- Files copied to `workspace/raw/` with original structure preserved
- Metadata extracted (title, author, date, word count, type)
- Provenance record created in `workspace/audit/provenance/`
- Status shows: "47 sources ingested, 0 compiled, 0 tasks"

### Step 3: Mount a Corpus

Alex mounts their raw directory for the compiler to operate on.

```bash
ico mount ./workspace/raw --name "ai-safety-corpus"
```

**Expected Result:** Mount registered in SQLite. Compiler can now index and compile against this corpus.

### Step 4: Compile Knowledge

Alex runs the compiler to generate semantic knowledge from ingested sources.

```bash
# Compile summaries for all sources
ico compile sources

# Compile a specific topic
ico compile topic "mechanistic interpretability"

# Compile concept pages
ico compile concepts
```

**Expected Result:**

- Source summaries appear in `workspace/wiki/sources/`
- Topic page created at `workspace/wiki/topics/mechanistic-interpretability.md`
- Concept pages extracted to `workspace/wiki/concepts/`
- Backlinks maintained between pages
- Contradictions flagged in `workspace/wiki/contradictions/`
- Compilation events logged in `workspace/audit/traces/`

### Step 5: Ask Questions

Alex queries the compiled knowledge base.

```bash
# Simple question
ico ask "What are the main approaches to mechanistic interpretability?"

# Comparative question
ico ask "Compare feature circuits vs sparse autoencoders for interpretability"

# Evidence-gathering question
ico ask "What evidence exists that RLHF reduces model honesty?"
```

**Expected Result:**

- Answer returned with inline citations: `[source: circuits-paper-2025.pdf, p.12]`
- Provenance chain traceable: answer -> compiled concept -> source summary -> raw file
- For simple questions: direct answer in < 10 seconds
- For complex questions: system suggests `ico research` instead

### Step 6: Conduct Scoped Research

Alex has a hard question that needs structured investigation.

```bash
ico research "Build a briefing on the relationship between scaling laws and alignment difficulty"
```

**Expected Result:**
A temporary research workspace is created:

```
workspace/tasks/task-20260402-001/
├── evidence/          # Gathered source excerpts
├── notes/             # Intermediate summaries
├── drafts/            # Working synthesis
├── critique/          # Skeptical review
└── output/            # Final briefing
```

Multiple agents work the task:

1. **Collector** gathers relevant evidence from compiled knowledge
2. **Summarizer** distills findings into working notes
3. **Skeptic** challenges conclusions, flags weak evidence
4. **Integrator** synthesizes final briefing

Task trace logged in `workspace/audit/traces/task-20260402-001.jsonl`

### Step 7: Render Artifacts

Alex generates durable outputs from the research.

```bash
# Generate a markdown report
ico render report --task task-20260402-001

# Generate a slide deck
ico render slides --task task-20260402-001 --title "Scaling & Alignment"

# Generate from a specific topic
ico render report --topic "mechanistic interpretability"
```

**Expected Result:**

- Report saved to `workspace/outputs/reports/scaling-alignment-briefing.md`
- Slides saved to `workspace/outputs/slides/scaling-alignment.md` (Marp format)
- Files are self-contained, inspectable, shareable

### Step 8: Promote Useful Outputs

Alex promotes the briefing back into the knowledge layer.

```bash
ico promote workspace/outputs/reports/scaling-alignment-briefing.md --as topic
```

**Expected Result:** Briefing filed into `workspace/wiki/topics/` as a maintained knowledge page. Promotion event logged in `workspace/audit/promotions/`.

### Step 9: Lint and Refine

Alex runs quality checks on the knowledge base.

```bash
ico lint knowledge
```

**Expected Result:**

```
Knowledge Health Report:
  Sources: 47 ingested, 42 compiled (5 pending)
  Topics: 12 pages, 3 with stale sources
  Concepts: 34 pages, 2 with no backlinks
  Contradictions: 4 flagged, 1 resolved
  Gaps: "reward hacking" referenced 8 times but has no concept page
  Suggestions:
    - Compile concept page for "reward hacking"
    - Update topic "RLHF safety" (3 new sources since last compile)
    - Review contradiction: scaling-vs-alignment claims in [paper-A] vs [paper-B]
```

### Step 10: Generate Recall Material (Phase 4)

Alex generates study material to reinforce understanding.

```bash
ico recall generate --topic "mechanistic interpretability"
ico recall quiz
```

**Expected Result:**

- Flashcards saved to `workspace/recall/cards/`
- Quiz questions generated from compiled knowledge
- After quiz: weak areas identified and logged
- Future summaries adapted to reinforce weak concepts

## Error Scenarios

| Scenario               | Error Message                                                  | Resolution                           |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------ |
| No API key             | `ANTHROPIC_API_KEY not set. Set it in .env`                    | Add key to `.env`                    |
| Empty workspace        | `No sources ingested. Run 'ico ingest <path>' first`           | Ingest source material               |
| PDF extraction failure | `Failed to extract text from X.pdf (image-only PDF)`           | Use OCR-capable PDF or convert first |
| Compilation failure    | `Compilation failed for source X: rate limit exceeded`         | Wait and retry, or reduce batch size |
| No compiled knowledge  | `No compiled knowledge found. Run 'ico compile sources' first` | Run compiler before asking questions |

## FAQ

**Q: Can I use this without an API key?**
A: The deterministic layers (ingest, mount, status, lint structure checks) work offline. Compilation, reasoning, and recall generation require a Claude API key.

**Q: Does this replace Obsidian?**
A: No. The wiki/ output is standard markdown with frontmatter — fully Obsidian-compatible. They complement each other. Use ICO to compile and maintain, use Obsidian to browse and annotate.

**Q: How much does it cost to run?**
A: Depends on corpus size and compilation frequency. A typical 50-source compilation run costs ~$2-5 in API calls. Asking questions costs ~$0.05-0.50 each depending on complexity.

**Q: Can I use a different LLM?**
A: The architecture supports it, but Claude is the primary target. The deterministic/probabilistic boundary means swapping the model layer is possible without touching state or audit logic.
