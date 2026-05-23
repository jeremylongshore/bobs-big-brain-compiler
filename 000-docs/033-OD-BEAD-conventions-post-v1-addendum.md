# 033-OD-BEAD — Bead conventions post-v1 addendum (plain English only)

**Status:** Active — supersedes naming convention in [014-OD-BEAD](014-OD-BEAD-bead-conventions.md) for all new work.
**Date:** 2026-05-22
**Author:** Jeremy Longshore

## Why this addendum exists

The original 014-OD-BEAD v1.0.0 convention used coded titles like `E11-B07 — stryker baseline gate` and labels like `epic:11`, `type:test`. Those codes were legible while the 10-epic execution plan was active — every session, the author was holding the epic map in their head. Post-v1.0.0, that map is no longer the working frame. Beads created during dog-fooding, follow-up audits, and operational hygiene work do not slot into the original 10 epics, and giving them invented epic codes confuses both humans and future agents who didn't write the original plan.

**The fix**: any bead a human or agent looks at in passing should self-describe. Plain English in the title, plain English in the labels, plain English in the parent epic's title. No code prefixes, no abbreviations. The system ID (e.g. `intentional-cognition-os-er2`) is the auto-generated hash beads issues — it stays as the command-line handle but is never quoted in conversation, commit messages, or issue bodies as a reference. Use the title or a short paraphrase instead.

## The rule

1. **Every bead title is a complete sentence describing the work being done.** Imperative mood. No code prefix, no `E#-B##`, no abbreviation that only the author can decode.
   - ❌ `E11-B07 — stryker baseline gate`
   - ✅ `Lock the Stryker mutation baseline and gate it as a required check.`

2. **Every bead has a parent epic (type `epic`) whose title also describes its cluster in plain English.** Standalone beads outside any epic are allowed only for one-off chores under 15 minutes of work.
   - ❌ Parent epic titled `Epic 11 — Test hygiene`
   - ✅ Parent epic titled `Test hygiene cleanup`

3. **Labels are 1–3 plain-English topic words.** No `epic:N`, no `type:X`. Topic words describe what the bead is about, not where it sits in a numbered structure.
   - ❌ `epic:11`, `type:test`, `area:ci`
   - ✅ `test-hygiene`, `mutation`, `coverage`, `gherkin`, `ci-lint`, `bead-tooling`, `gh-mirror`

4. **Every bead with deliverable code gets a matching GitHub issue, and a matching Plane issue when the project has Plane mapped.** Use `bd-sync link <bead> --gh OWNER/REPO#N --plane PROJECT-N` to plant the cross-refs in all three records. ICOS maps to Plane project `ICOS` (UUID in [reference_plane_setup.md](../../.claude/projects/-home-jeremy-000-projects-intentional-cognition-os/memory/reference_plane_setup.md), not committed).

5. **Use `bd-sync note <bead> "..."` mid-flight to record milestones, surprises, and decisions.** A bead that opens silent, sits silent, and closes silent is an anti-pattern — it leaves no audit trail for the next reader. Note the moment-of-discovery facts, not the routine work.

## What this changes about 014-OD-BEAD

014-OD-BEAD v1.0.0 remains historically valid for the original 10 epics (E1 through E10, ~133 beads). Those titles are part of the historical record and the master blueprint's execution plan. **Do not retroactively rename** old beads.

For **all new beads created after 2026-05-22**, this addendum is canonical. Where 014 and 033 conflict, 033 wins.

Specifically retired from 014:

- ❌ The `E{N}-B{NN}` title prefix convention.
- ❌ The `epic:N` and `type:X` label conventions.
- ❌ The naming convention that required cross-referencing the master blueprint to decode a bead title.

Retained from 014:

- ✅ The bead state machine (open → in_progress → closed) and `bd close -r "<evidence>"` discipline.
- ✅ Dependency declaration via `bd dep add`.
- ✅ Definition of done — evidence in the close reason, not "done" alone.
- ✅ The general principle that beads cluster under epics, just with plain-English epic titles.

## Migration notes

The six v0.2-era beads with autogen-only titles (`er2`, `ytq`, `7xp`, `p6w`, `nwh`, `x5r`) were retitled or superseded on 2026-05-22 as part of bringing this convention into force. The audit trail is preserved via `bd supersede` and `bd close --reason`. No history was rewritten.

The plain-English convention will propagate to other Intent Solutions projects (braves, claude-code-plugins, kobiton, etc.) on their next refresh — they are not required to retitle existing beads, but new beads in those projects should follow this rule once the global default in `~/.claude/CLAUDE.md` has the addendum landed.

## Cross-references

- [014-OD-BEAD-bead-conventions.md](014-OD-BEAD-bead-conventions.md) — Original v1.0.0 convention (historical).
- [BEADS-SETUP-PROMPT.md](../../BEADS-SETUP-PROMPT.md) — Repo-bootstrap prompt; should be updated to teach this rule from day one for new projects.
- `~/.claude/CLAUDE.md` § "Bead naming — plain English only" — The global default that this addendum mirrors at the project level.
- `~/bin/bd-sync` — The three-layer mirror tool that uses bead notes to fan operations across GitHub + Plane.
