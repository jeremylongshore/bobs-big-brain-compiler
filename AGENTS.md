# AGENTS.md — AI Agent Operations for intentional-cognition-os

## Beads (bd) Issue Tracking

This project uses [beads](https://github.com/gastownhall/beads) for AI-friendly task tracking.
Tasks are stored in `.beads/` and tracked via the `bd` CLI.

## Quick Reference

```bash
bd ready                              # Find available work
bd show <id>                          # View issue details
bd update <id> --status in_progress   # Claim work
bd close <id> -r "Evidence"           # Complete work (or: bd done)
bd note <id> "Progress update"        # Append a note
bd prime                              # LLM-optimized context
bd doctor                             # Health check
```

## Core Workflow

### Session Start

1. Run `/beads` or `bd prime` to recover context
2. Run `bd ready` to see available tasks
3. Pick a task and claim it: `bd update <id> --status in_progress`

### During Work

- Keep notes: `bd note <id> "what I did"`
- Create subtasks: `bd create "Subtask" --parent <id> -p 2`
- Check blockers: `bd blocked`

### Session End (Landing the Plane)

1. Close finished tasks: `bd close <id> -r "Evidence of completion"`
2. Update in-progress tasks with status notes
3. Run quality gates (tests, linters, builds)
4. **PUSH TO REMOTE** (mandatory):
   ```bash
   git push
   git status  # MUST show "up to date with origin"
   ```
5. Hand off context for next session

## Priority Levels

| Priority | Label    | Meaning                               |
| -------- | -------- | ------------------------------------- |
| P0       | Critical | Blocks everything, fix immediately    |
| P1       | High     | Important, address this session       |
| P2       | Normal   | Standard priority                     |
| P3       | Low      | Nice-to-have, address when convenient |

## Critical Rules

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing — leaves work stranded locally
- NEVER say "ready to push when you are" — YOU must push
- Always close beads when work is done
- Always start sessions with `bd prime` or `/beads`

## Creating Tasks

```bash
# Simple task
bd create "Implement knowledge compiler" -t task -p 1 -d "Build the concept extraction pipeline"

# Bug report
bd create "Ingest fails on large PDFs" -t bug -p 0 -d "Steps to reproduce..."

# Feature request
bd create "Add Marp slide generation" -t feature -p 2

# With dependencies
bd create "Write compiler tests" --parent <epic-id> -p 2
```

## Advanced Commands

```bash
bd list --status in_progress    # What am I working on?
bd statuses                     # List valid statuses
bd search "compiler"            # Search by text
bd stale                        # Find stale issues
bd dep add <child> <parent>     # Add dependency
bd graph <id>                   # View dependency graph
```

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
