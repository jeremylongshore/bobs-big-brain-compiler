# Research Notes: Episodic Task Workspaces

These are working notes on how episodic task workspaces should function in a knowledge operating system.

## Key Insight

Hard questions need structured working memory. When a research question is too complex for a single-pass answer, the system should create a scoped workspace with:

- Evidence directory (gathered from compiled knowledge)
- Notes directory (distilled by summarizer agents)
- Drafts directory (working synthesis attempts)
- Critique directory (challenges from skeptic agents)
- Output directory (final rendered artifacts)

## Task Lifecycle

The seven-state lifecycle is: created → collecting → synthesizing → critiquing → rendering → completed → archived.

Each state maps to an agent role:

- Collecting: Collector agents gather evidence
- Synthesizing: Summarizer agents distill findings
- Critiquing: Skeptic agents challenge conclusions
- Rendering: Builder agents produce final artifacts

## Open Questions

1. Should task workspaces be fully pruned on archival, or should a summary be retained?
2. What is the maximum number of concurrent tasks a single workspace should support?
3. How should cross-task evidence sharing work when two tasks reference the same sources?

## Decision

Retain a summary on archival. The full workspace can be pruned after 30 days, but the task record and summary persist in the tasks table indefinitely.
