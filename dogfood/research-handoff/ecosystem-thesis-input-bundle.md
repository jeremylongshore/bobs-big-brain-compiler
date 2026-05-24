---
title: Ecosystem Thesis — Input Bundle for /academic-pipeline
filing_code: dogfood/research-handoff
date: 2026-05-23
status: handoff dossier — feeds /deep-research + /academic-paper
parent_bead: intentional-cognition-os-ziz
target_artifact: 034-AT-NTRP-ecosystem-thesis.md (in ICO + INTKB, byte-identical)
audience: engineering managers, platform-team leads, team-knowledge stewards
---

# Ecosystem Thesis — Input Bundle

This bundle exists so `/academic-pipeline` does not re-discover material we already
have. Every fragment cited below is a **first-class source** for the resulting thesis
paper — the paper should cite these, not paraphrase them, not regenerate them.

---

## 1. Working hypothesis (the thesis the paper must defend or revise)

**ICO + INTKB are a downstream-coupled local-first knowledge stack that becomes
industry-defining when teams and team leaders adopt "compile then govern" as the
standard for institutional memory.**

The compilation/governance split is the new abstraction. Everything else — search,
retrieval, presentation, recall — is pluggable around that core. Specifically:

```
ICO (compile)  →  spool  →  INTKB (govern, dedupe, score)  →  qmd (retrieve)  →  MCP/REST
```

ICO produces compiled L2 / L4 artifacts from raw corpus. INTKB consumes those
artifacts via a spool intake, runs them through a deterministic governance pipeline
(secret detection, dedup, tenant isolation, policy evaluation), and emits curated
team memory queryable via qmd (local, millisecond) or REST/MCP (cross-team).

The corollary claim: **teams currently rely on either (a) personal LLM memory that
doesn't share, or (b) RAG pipelines that hide knowledge in vector blobs with no
inspectability, no provenance, no lifecycle.** Neither serves a team's actual need —
which is _governed, shared, auditable institutional memory_ that survives session
turnover and personnel turnover. The ICO + INTKB stack is the first reference
implementation of an alternative: compile, then govern, then retrieve.

### What the paper must answer (with Semantic Scholar grounding where possible)

1. Is "compile then govern" empirically better than RAG for team-knowledge use cases?
   What is the evidence base in the published literature?
2. What does the academic literature say about _deterministic governance over
   probabilistic outputs_ (the LLM-proposes / deterministic-system-decides pattern)?
3. What is the academic precedent for _filesystem-as-protocol_ for agents (CoALA,
   AgentFS, MemOS, Letta)? Which of those are closest to ICO + INTKB and how?
4. What evidence exists for spaced-repetition / recall-loop in team-knowledge
   contexts (vs. individual-learning contexts where SRS literature is mature)?
5. What audit-trail / compliance requirements will teams face (EU AI Act August
   2026, US state AI laws, sector-specific compliance regimes)? How does the L6
   trace + integrity-chain approach in ICO + INTKB map to those?

---

## 2. The downstream pipeline diagram (load-bearing visual for the paper)

```
┌─────────────────────────────────────────────────────────────────────┐
│ ICO (intentional-cognition-os)                                      │
│ ── compiles raw corpus → L2 wiki + L4 artifacts                     │
│ ── deterministic kernel owns state, provenance, traces              │
│ ── multi-agent research produces evidence + critique + integration  │
│ ── recall loop produces flashcards from compiled wiki               │
│ ── output: markdown + frontmatter + SQLite state + JSONL audit      │
└─────────────────────────┬───────────────────────────────────────────┘
                          │  spool file (markdown + governance metadata)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ INTKB (qmd-team-intent-kb)                                          │
│ ── ingestFromSpool: reads + validates schema                        │
│ ── policy-engine: secret detection / dedup / tenant isolation       │
│ ── inbox → curator review → promote → "Active" lifecycle            │
│ ── git-exporter mirrors curated memory to git for browsing          │
│ ── edge-daemon keeps qmd indexes synchronized                       │
└─────────────────────────┬───────────────────────────────────────────┘
                          │  curated memory + indexed metadata
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ qmd (upstream)                                                      │
│ ── local full-text search index                                     │
│ ── millisecond retrieval, no network round-trips                    │
│ ── CLI-friendly, integrates into developer workflows                │
└─────────────────────────┬───────────────────────────────────────────┘
                          │  ranked results
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Consumers: MCP tool ↔ REST API ↔ developer CLI ↔ Claude Code        │
└─────────────────────────────────────────────────────────────────────┘
```

**Reference for the journey step** that names this pipeline in production:
`qmd-team-intent-kb/tests/JOURNEYS.md` — Journey: memory-capture, step 2:

> "ICOS compiles candidate to L2 / L4 artifact and writes to spool" (L4 layer,
> external — ICOS Epic 16 wires this end). Currently deferred bead
> `qmd-team-intent-kb-pw9` → `vj6` is the active build path for the bridge.

This is not a hypothetical diagram. The pipeline is already partially wired in code.

---

## 3. Prior research fragments (cite these, do not regenerate)

The paper's References section should cite each of these as primary sources for
claims about the ICO + INTKB ecosystem.

### 3.1 `intentional-cognition-os/000-docs/IDEA-CHANGELOG.md`

The single most concentrated record of ICO's design decisions. Key passages the
paper should cite verbatim or near-verbatim:

- **8 differentiators (validated against 2026 competitive landscape):**
  compilation, semantic FS, deterministic control, provenance, multi-agent research,
  recall, CLI-first, local-first. Cited against Karpathy LLM-KB, qmd, Onyx, Mem0,
  Fabric. (From the "Competitive landscape research" section, dated entry under
  Standards Freeze v1.)

- **ICO moat ordering:** (1) deterministic control plane (hardest to replicate),
  (2) provenance chain (painful to retrofit), (3) multi-agent research (complex
  orchestration), (4) recall/retention (nobody else is thinking about this).
  Compilation itself is reproducible and NOT the moat. (Decision Notes block.)

- **7 future scenario analyses** with probability assignments through Q4 2026:
  Karpathy open-sourcing his KB (70%), Claude native persistent memory (40%), MCP
  as universal agent protocol (80%, already happening), vector search mandatory
  (50%), AI provenance legally required (90%), knowledge compiler category gets
  crowded (30% in 2027), model costs drop 10x (60%). These are calibrated forecasts
  the paper should disclose, not internal opinions to hide.

- **EU AI Act enforcement (August 2026)** is named as making the L6 trace audit
  a _compliance gate equivalent to the release gate_. This connects technical
  architecture to regulatory reality.

- **Three-layer learning model** (v2.2.0 entry): context (configurable knowledge,
  Phases 1–4), harness (runtime, trace/eval-driven, Phase 3+), model (foundation
  weights, explicitly not near-term scope). The paper should cite this as ICO's
  stated learning posture and contrast with end-to-end fine-tuning approaches.

- **Schema & agent contract layer** (v2.1.0): the agent operates _under a schema
  contract_ composed of `CLAUDE.md`, frontmatter conventions, file policies,
  lifecycle rules, compilation schemas. This is the "deterministic governance
  over probabilistic outputs" insight made concrete.

### 3.2 `intentional-cognition-os/000-docs/essays/filesystem-is-the-agent-protocol.md`

The thesis essay (2026-04-09). Cite directly, especially:

- The **historical addressability arc**: assemblers → compilers → Unix → Plan 9 →
  (next?) agent cognitive workspace. This is the rhetorical spine the paper should
  preserve.

- The **gap diagnosis**: MCP gave us syscalls but not a filesystem. LangGraph /
  CrewAI / AutoGen / Claude tool_use each invent their own opaque coordination
  substrate. (See "The Gap: MCP Gave Us Syscalls But Not a Filesystem.")

- The **honest reframe**: "SQLite is the real coordination substrate, not the
  filesystem." The paper should adopt this honesty — the _combined_ state-DB +
  content-FS is the right characterization, not pure filesystem primacy.

- The **mistakes-we-made** section: procfs analogy was premature, triple-write is
  over-engineered, 7-state task machine encodes opinions, 11-error promotion engine
  is over-engineered, filesystem permissions are conventions-not-security. The
  paper's _Limitations_ section should pull from this directly.

- The **References** block already cites: Sumers et al. (CoALA, 2023), Park et al.
  (Generative Agents, UIST 2023), Hu et al. (MemOS, 2025), AgentFS, Git Context
  Controller, Letta / MemGPT, AgentSight, Anthropic MCP spec. **All eight of these
  must be cross-checked against Semantic Scholar** in Stage 1 / Stage 2.5 and
  resolved to proper bibliographic entries.

### 3.3 `intentional-cognition-os/000-docs/reports/adversarial-engineering-review.md`

The 7-panel decade-by-decade critique (2026-04-09). The paper should cite this as
its _adversarial validation_, not as an internal QA artifact. Key passages:

- **Unanimous agreements across all 7 panels:** the gap is real; the
  deterministic/probabilistic boundary is genuine engineering discipline;
  Result<T,E> non-throwing error handling is correct; atomic writes are sound;
  filesystem layout is good Unix design.

- **Unanimous criticisms:** triple-write is over-engineering; MUST/SHOULD/MAY
  spec for one implementation is premature standardization; "paradigm shift"
  framing before user validation is overreach; zero multi-agent execution makes
  coordination protocol design premature; the Plan 9 comparison is aspirational.

- **The hidden discovery:** "SQLite is the actual coordination substrate, not
  the filesystem." Every coordination operation goes through SQLite transactions;
  the filesystem stores results. This is the correct architecture but the thesis
  should be honest about it.

- **Updated probability assessment table** (Hopper/Dijkstra → Chase/Askell):
  "Would this change the world?" went from 10%/50% → 5%/35% post-review.
  "Need users first." The paper should preserve this calibration discipline.

### 3.4 `intentional-cognition-os/000-docs/001-PP-BCASE-business-case.md`

Cite the **competitive matrix** (Table: ICO vs NotebookLM vs Obsidian+AI vs Mem.ai
vs Generic RAG) and the **ROI calculation table** (research synthesis 8–12 h → 1–2 h;
knowledge onboarding 2–4 weeks → days; report generation 4–6 h → 30 min; knowledge
decay detection manual → automated). These are first-party operator claims the
paper can ground against published time-on-task literature.

### 3.5 `intentional-cognition-os/000-docs/002-PP-PRD-product-requirements.md`

Cite the **target-customer segmentation** and **non-goals list**. The non-goals
list (what ICO is explicitly _not_) is as important as the goals for positioning.

### 3.6 `intentional-cognition-os/dogfood/JOURNAL.md`, session 1 (2026-05-21)

The "taxonomy IS the ecosystem coupling layer" insight. Excerpt:

> "Surveyed the abbreviation system (Document Filing Standard v4.3) across 12+
> Intent Solutions repos. The taxonomy IS the ecosystem coupling layer."
>
> Aggregate usage of the top 15 codes (AA-AACR: 61, DR-GUID: 37, RA-REPT: 32,
> AT-ARCH: 17, ..., AT-DECR: 6).
>
> "That's a real shared dialect. Every cited source in our v1 bank follows the
> NNN-CC-ABCD-... convention. ICO will see filenames that encode what kind of
> document each is — AT-ARCH is architecture, AT-STND is standards, AA-AACR
> is an AAR."

This is the empirical answer to "how do real teams actually share knowledge
across repos?" The paper should treat this as field evidence: cross-repo shared
_documentation taxonomy_ + _binding decision records_ (DR-010 council-session
lock pattern) is how a 12-repo ecosystem coheres without shared code. Both ICO's
governance contract and INTKB's tenant-isolation map cleanly onto this taxonomy.

### 3.7 `qmd-team-intent-kb/000-docs/003-AT-DSGN-system-thesis.md`

INTKB's own design thesis. Cite the **7 thesis properties** verbatim:

1. Automatic capture from Claude Code sessions
2. Deterministic governance pipeline (not LLM judgment)
3. Local-first search via qmd
4. Canonical control plane
5. Git as distribution mirror (one-way push, never feeds back)
6. Curated-only default search
7. Tenant isolation by default

And the **7 design principles**: determinism over LLM judgment for governance,
curated-only default search, explicit lifecycle (Active/Deprecated/Superseded/
Archived), tenant isolation by default, auditability of all memory operations,
local-first retrieval via qmd, git as distribution not truth.

The paper must reconcile INTKB's "Why Not Just Git?" and "Why Not Just Prompt
Memory?" arguments with ICO's compilation thesis — they are co-justifying
arguments for the same overall stack.

### 3.8 `qmd-team-intent-kb/tests/JOURNEYS.md`

Cite the **memory-capture journey** (10 steps, persona: developer → curator).
This is the empirical specification of the ICO → INTKB → qmd pipeline. Step 2
("ICOS compiles candidate to L2 / L4 artifact and writes to spool") is the
hand-off contract.

Also cite the **memory-retrieval journey** (8 steps, persona: developer →
bot-agent) — this is the consumer-side spec for what teams actually do with
the governed memory.

### 3.9 `intent-eval-platform/intent-eval-lab/research/000-RR-COMP-ecosystem-landscape-2026-05-20.md`

Out-of-scope as an authoring repo for the thesis paper (per operator direction),
but cite as a **first-party landscape audit**. Key claims to ground:

- OpenTelemetry GenAI SIG is the only live standards body for agent observability.
- OpenInference (Arize, Apache 2.0) is the closest analog for cross-tool trace
  portability.
- Inspect AI (UK AISI, MIT) is the strongest standards-track precedent for
  evaluation schemas, "government-backed, MIT, multi-surface."
- Phoenix (Arize, Elastic License 2.0) is license-incompatible with Apache 2.0 /
  MIT downstream — a "look but don't import" reference.
- Frontier-lab research (Anthropic, OpenAI, DeepMind, METR, UK AISI, Apollo,
  Redwood) is dense on Areas #2/#6/#9/#11/#19 and sparse on Areas #1/#5/#10/#12/
  #17/#18/#20/#21 of the 21-area landscape — contribution surface is open.

---

## 4. Competitors and adjacent work already identified

Stage 1 (`/deep-research`) should ground each of these against Semantic Scholar.
This list is starting context — the deep-research pass is welcome to add more,
but should not waste tokens re-discovering these.

**Compilation / knowledge-base systems:**

- Karpathy's "LLM Knowledge Bases" (concept, 2026) — confirms the compilation
  category as a real industry direction.
- NotebookLM (Google, 2024+) — chat-with-docs with summary generation. Partial
  compilation; cloud-only; no semantic FS; no audit.
- Obsidian + AI plugins — local-first markdown notes with plugin-dependent AI.
  No native compilation, no audit, no episodic-task workspaces.
- Mem.ai — cloud-only personal memory; partial compilation; no audit; not team-scope.
- Fabric (Daniel Miessler) — prompt-pattern library. Adjacent, not a knowledge
  compiler.
- Onyx (Danswer rebrand) — open-source enterprise search + chat. RAG-flavored,
  not compilation-first.

**Agent memory / cognitive architecture systems:**

- CoALA — Cognitive Architectures for Language Agents (Sumers, Yao, Narasimhan,
  Griffiths, 2023, arXiv:2309.02427). Theoretical framework: working / episodic
  / semantic / procedural memory.
- MemOS — Operating System for LLM Memory Management (Hu et al., 2025, arXiv).
  Explicit memory modules and lifecycle.
- Letta (formerly MemGPT) — tiered memory; agents page context to external storage.
- Generative Agents (Park et al., UIST 2023) — structured retrievable memory with
  timestamps and importance scores.
- AgentFS — virtual filesystem for agent persistent storage.
- Git Context Controller — git repos as multi-agent coordination substrate.
- AgentSight — observability for agent internal state.

**Agent orchestration frameworks (the "syscalls but no filesystem" contrast set):**

- LangGraph — checkpointer-based state; no convention for evidence vs conclusions.
- CrewAI — task-object state passing; in-memory intermediate state.
- AutoGen — conversation history as coordination mechanism.
- OpenHands — agent execution environment; deep on agent loops, shallow on memory.
- Continue — IDE-integrated agent; session-scoped state.
- LangChain / Langfuse / Opik — orchestration + observability layer.
- SOUL.md — agent persona spec.

**Team-knowledge / governance-adjacent systems:**

- Notion AI / Confluence AI — collaborative knowledge bases with AI overlays.
  No deterministic governance pipeline; LLM-dependent organization.
- Glean — enterprise search + AI assistant; RAG-flavored; no compilation.
- Slab / Tettra — team wiki with AI assist; no audit; no lifecycle states.

**Observability / eval / standards-track:**

- OpenTelemetry GenAI SIG (CNCF, Apache 2.0) — active spec development.
- OpenInference (Arize, Apache 2.0) — AI-specific semantic conventions.
- Inspect AI (UK AISI, MIT) — eval framework, government-backed precedent.
- Promptfoo (OpenAI, MIT) — prompt testing + redteam.
- DSPy (Stanford, MIT) — programming-not-prompting; Assertions for self-refinement.

---

## 5. Audience targeting (critical for the paper's voice)

**Primary audience: engineering managers, platform-team leads, team-knowledge
stewards.**

Not academic AI researchers (they're a _secondary_ audience that gets the
references and rigor for free). Not individual developers (they have personal
tools that work). The decisive reader is the person who has watched their team
re-discover the same insights every quarter and is responsible for fixing it.

**What this audience cares about (frame the paper around these):**

- Will my team's institutional knowledge survive personnel turnover?
- Can I audit what my team actually knows / what the AI told them / what they
  acted on?
- Will this satisfy the compliance requirements coming in 2026 (EU AI Act, US
  state laws)?
- Is the LLM helping or hallucinating? Can I tell?
- Can I plug this into the developer workflow without forcing process change?

**What this audience does NOT care about** (do not anchor on these):

- Whether the prompt template uses XML or JSON delimiters.
- Which embedding model is "best" this quarter.
- Whether agents should be "single" vs "multi" — they care about outcomes, not
  architecture purity.

The paper's tone should be: _operator-grade systems analysis with academic rigor_.
Think: a Brendan-Gregg systems-performance book, written by someone who has
actually run the system in production, with proper citations.

---

## 6. The 8 ICO differentiators + INTKB's complementary contributions

**ICO (compilation layer):**

1. Knowledge compilation (vs. RAG indexing) — Karpathy LLM-KB confirms category.
2. Semantic filesystem (vs. opaque vector blob) — addressable cognitive state.
3. Deterministic control plane (vs. LLM-as-router) — kernel owns state.
4. Provenance chain (vs. attribution-as-bibliography) — SHA-256 integrity.
5. Multi-agent research workspaces (vs. single-shot chat) — collector / summarizer
   / skeptic / integrator / orchestrator with explicit state machine.
6. Recall loop (vs. "search again") — flashcards + spaced repetition over compiled
   wiki.
7. CLI-first (vs. web app lock-in) — `ico` command surface; scriptable.
8. Local-first (vs. cloud-only) — filesystem + SQLite; zero cloud deps in
   Phase 1–4.

**INTKB (governance layer — extends ICO downstream):**

A. Spool-based intake (vs. direct API write) — ICO writes spool files, INTKB
reads + validates. Crash-resilient, idempotent, inspectable boundary.
B. Deterministic policy pipeline (vs. LLM-as-curator) — secret detection,
dedup, tenant isolation; rules are code, version-controlled and testable.
C. Explicit lifecycle states (vs. flat "memory") — Active / Deprecated /
Superseded / Archived; transitions logged with timestamp + actor + reason.
D. Tenant isolation by default (vs. shared-by-default) — cross-project
contamination blocked at every layer.
E. Curated-only default search (vs. all-memory-equal) — inbox + archive
excluded unless explicitly requested.
F. qmd-backed retrieval (vs. server-side search) — local index, ms response.
G. Git-as-distribution (vs. git-as-truth) — one-way push from canonical store.
H. Auditability of all memory operations (vs. fire-and-forget) — every
promote / demote / supersede / archive logged with full before/after.

**The combined claim:** No other system in the field exhibits _all sixteen_ of
these properties together. The paper should treat the 8+8 list as a tested
positioning frame, not a marketing claim — each item has a code / doc reference.

---

## 7. Constraints + non-goals for the paper itself

- **Length**: 6,000–10,000 words. NOT a 12,000-word epic. NOT a 1,500-word blog
  post. This is a thesis paper, not a position paper or a press release.
- **Toulmin structure or IMRaD** — `/academic-paper` defaults are fine.
- **Bilingual abstract** (zh-TW + EN) is automatic via `/academic-paper`; full
  bilingual paper is NOT in scope.
- **No marketing positioning** — explicitly out of scope per operator direction.
  CMO seat in Phase 5 council is muted. No "buy now" messaging.
- **No bilingual full paper** — abstract only.
- **No IEP (intent-eval-platform) authoring** — IEP's landscape audit is a
  cited source, not a co-authored repo. The paper lands in ICO + INTKB only.
- **No upstream qmd contribution filing** — that's deferred to a separate
  session under `intentional-cognition-os-nhj`.
- **No "team-leader white paper" deliverable** — different artifact, not
  selected by operator.
- **Honest about limitations** — the adversarial review's mistakes-we-made
  section must be reflected in the paper's Limitations section. No glossing.

---

## 8. Hand-off

`/deep-research` Stage 1 should:

- Consume this entire bundle as input context.
- Generate the RQ Brief from the 5 open questions in §1.
- Methodology pass should ground each of the §4 named systems against Semantic
  Scholar (paper_relevance_search + paper_title_search).
- Annotated Bibliography must include every fragment in §3 plus every system in
  §4 plus the legal/compliance references implied by §1Q5.
- Synthesis Report goes to `/academic-paper` Stage 2.

`/academic-paper` Stage 2 should:

- Adopt the working hypothesis from §1 as the paper's thesis (revise if
  evidence contradicts, but do not abandon without operator input).
- Use §2 as a load-bearing figure.
- Cite §3 directly.
- Position against §4.
- Voice + audience per §5.
- Differentiators per §6.
- Constraints per §7.

Stages 2.5 + 4.5 integrity gates must show 100% PASS before delivery.

— bundle assembled 2026-05-23 for cross-repo epic `intentional-cognition-os-ziz`.
