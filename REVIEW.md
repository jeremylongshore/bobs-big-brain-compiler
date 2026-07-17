# REVIEW.md

Repository-specific guidance for the advisory automated pull-request reviewer (MiniMax-M3, two
lanes — defect and adversarial; see `.github/workflows/minimax-review.yml`).

Catch defects, unsafe claims, and boundary drift that CI cannot judge. Report only findings
introduced by the pull request and verify each against surrounding source. The reviewer is
**advisory only** — it never blocks a merge; the deterministic gate is always the blocking CI jobs.

## Review objective

intentional-cognition-os (ICO) is the **compile engine** of Bob's Big Brain — the _probabilistic_
half. A deterministic kernel (SQLite + JSONL) owns durable state; a Claude-backed compiler runs six
passes (summarize / extract / synthesize / contradict / gap / link) over a raw corpus, derives wiki
pages, and emits a **spool of MemoryCandidates** that the downstream govern engine (INTKB) governs.
Review for: the compile/govern boundary holding, honest output-quality and status claims, spool and
manifest integrity, provenance from the first byte, audit honesty, and disclosure safety. ICO is not
the control plane — it never owns durable _governed_ state.

## Authority and truth hierarchy

Read `CLAUDE.md` and `AGENTS.md` first. For substantive changes, inspect the relevant standards docs
under `000-docs/` — the master blueprint (`007-PP-PLAN`), architecture (`003-AT-ARCH`), the glossary
(`008-AT-GLOS`), trace schema (`011-AT-TRSC`), prompt templates (`017-AT-PRMP`), promotion spec
(`018-AT-PROM`), security & scope (`021-AT-SECV`), the ecosystem thesis (`034-AT-NTRP`) — plus
`IDEA-CHANGELOG.md` and any relevant ADR/AAR.

1. Explicit owner decisions and ratified ADRs govern intended architecture.
2. Running reality and executable repository state decide implementation status.
3. Current canonical standards docs (`000-docs/008`–`021`, frozen for Phase 1) and code outrank
   summaries, handoffs, closed beads, PR descriptions, and chat assertions.
4. Historical records describe what was known then. Require a dated correction, an `IDEA-CHANGELOG.md`
   entry, or a named successor instead of rewriting them to fit today's narrative.
5. Green CI proves only the checks that ran — not architecture, live cross-repo integration,
   compile-output quality, or production readiness.

Flag silent boundary changes, a second source of truth, or a proposal presented as settled authority.

## The compile / govern boundary (core invariant)

**The model proposes; the deterministic kernel owns durable state and control.** This is the most
important constraint in the repo.

- ICO writes only its allowed surfaces: `wiki/` derivations, the spool of MemoryCandidates, and its
  own append-only trace/audit. It must **never** write durable _governed_ state directly — governance
  is INTKB's job downstream.
- `raw/` (Layer 1) stays raw and append-only. Flag any compiler pass that writes outside its allowed
  surface, mutates raw sources, or lets model output reach the wiki without validation.
- Deterministic (kernel + SQLite + JSONL): storage, mounts, provenance, policy, promotion rules,
  audit, eval execution. Probabilistic (compiler + Claude): summarization, synthesis, extraction,
  contradiction/gap detection, drafting. The model never writes audit, policy, or promotion tables.
- Flag any change that makes an LLM/agent mandatory in a path that must stay deterministic, or that
  routes model output around the kernel's validation into durable state.

## Compiler-pass output quality

Model output is untrusted until validated. The compiler must validate shape before it commits.

- Validate model output (schema / shape / refusal / length) **before** the atomic `.tmp` + `renameSync`
  write. Flag passes that trust model output blindly.
- A truncated or refused response is a failure, never a success — flag truncation handled as success,
  and empty or refusal candidates that reach the spool.
- All agent/pass inputs (brief / notes / critique / evidence / source text) are wrapped in
  XML-delimited tags with an injection-defense line; system prompts carry an explicit citation format
  and a no-invention rule. Flag regressions to that discipline.
- On a Claude API error a pass returns `err(...)` and leaves state in the prior status — never
  half-advances. Flag any partial-advance on error.

## The spool contract and trust boundary

The spool is ICO's hand-off to INTKB; its identifiers and atomicity are load-bearing.

- MemoryCandidate ids are **content-stable UUID-v5** derived over
  `workspaceId\x00relPath\x00bodySha256`. A one-byte drift in any input changes the id, which orphans
  the candidate downstream. Flag any change to the id derivation inputs or algorithm without an
  explicit migration and alias story.
- The manifest SHA-256 must be written **atomically with** the spool file
  (manifest-before-spool-rename), so a reader never sees a spool without its matching manifest, or a
  manifest describing a spool that isn't fully written. Flag any break in that ordering/atomicity.
- Do not flatten trust signals carried on candidates. Any spool schema change needs a `schemaVersion`
  story (version bump + consumer/fixture updates); flag a schema change without one.

## Provenance from the first byte

- Derived pages must carry **real** source provenance — never the literal placeholder `batch`.
- `compilation_sources` linkage, and `pass` + `model` + `prompt-hash` on receipts, must be preserved.
- Frontmatter on produced files records source-path references and token/model metadata. Flag any
  provenance regression that severs a derived page from the raw source it came from.

## Audit and honesty invariant

The compile-trace chains are **per-file hash chains** (`prev_hash = SHA-256(prev_line)`): they are
**tamper-EVIDENT** (edits/reordering are detectable), **not** tamper-proof. A local writer with write
access can edit an event _and_ re-hash forward, and verification passes again. Keep every claim honest.

**Forbidden words** — never introduce these anywhere in code or docs about the audit trail:
`tamper-proof`, `immutable`, `non-repudiation` (for local mode), `blockchain`.

- Flag any of the forbidden words on sight.
- Flag bare `append-only` / `immutable` claims about the audit trail that are not qualified — say
  _append-only by protocol_ or _hash-chain-evident_, or negate the over-claim.
- Trace/audit files are append-only by protocol; the `audit-chain-intact` smoke eval walks the chain.
  Flag hand-edits to trace JSONL and any regression of the FD-based append in
  `kernel/src/audit/writeTrace.ts` (must stay `openSync(O_CREAT|O_APPEND|O_WRONLY) → fstatSync →
writeSync`; regressing to `existsSync → statSync → appendFileSync` re-fires CodeQL `js/file-system-race`).

## Disclosure and secret safety

- Never permit personal compensation, credentials, tokens, API keys, or plaintext secrets in the diff.
- Trace payloads must run through `redactSecrets()` before writing; flag any new persistence or
  notification path that bypasses redaction.
- Never reproduce a suspected secret in a review comment — identify only its location and the required
  remediation, and flag the key for rotation.

## Cost and operational safety

- Bulk / large-corpus compile paths must be **cost-gated** (token-budget gate before a Claude call
  over the threshold — see the dogfood budget-math reference) **and receipted**. Flag any ungated
  model-spend path.
- Respect `ICO_MAX_RESEARCH_TOKENS` and per-operation caps; flag a change that removes or silently
  raises a spend ceiling.

## Status and evidence integrity (adversarial lane)

Judge completion and readiness against the standards docs and the actual diff, not the PR narrative.

- Documentation, merged code, fixtures, synthetic proofs, and green CI are **not** deployment, live
  cross-repo integration, production readiness, or phase completion.
- A **mocked-model unit test** (`ClaudeClient` via `vi.fn()`) is **not** proof of compile _output_
  quality — only a real dogfood run with a reported citation-verify rate is.
- Local embedded proof is **not** remote durability, nor the governed INTKB outcome downstream.
- A notification sent, or an exit-zero, is not an independently verified outcome.
- Flag unsupported terms such as `verified`, `production-ready`, `complete`; a diff that does
  materially more or less than the description; silent scope/authority expansion; and any new second
  source of truth. Tag `NEEDS-OWNER-DECISION` for a contradiction with recorded authority.

## File-specific rules

- `.beads/issues.jsonl` is a passive export — change beads through `bd`, never hand-edit the JSONL.
- `IDEA-CHANGELOG.md` and the `000-docs/008`–`021` standards are frozen for Phase 1; a change to them
  needs an explicit changelog entry / owner decision.
- `wiki/` is a derived, recompilable surface — it is excluded from review; do not treat a hand-edit
  there as authored source.
- `dogfood/JOURNAL.md`, `dogfood/progress.md`, and per-run artifacts are append-only receipts; a
  rewrite of past receipts (rather than a new dated entry) is a finding.

## Severity calibration

- **Critical:** a secret can persist; ICO writes durable governed state directly or mutates `raw/`;
  a spool/manifest atomicity or id-derivation break that silently orphans candidates; a forbidden
  audit-honesty word or a false completeness claim that could authorize unsafe downstream action;
  data loss with no recovery.
- **Warning:** unvalidated model output reaching an atomic write or the spool; truncation treated as
  success; provenance regression; a schema change without a `schemaVersion`/consumer story; an ungated
  model-spend path; a bare unqualified `append-only`/`immutable` audit claim; misleading status.
- **Info:** a concrete maintainability or documentation improvement with real future cost. Use
  sparingly, never for personal preference.

Do not flag formatting-only differences or failures already enforced by tooling (typecheck, lint,
mutation, OSV/gitleaks, markdownlint, nightly-smoke). Severity follows credible impact, not file
importance.

## Comments and summary

Comment on an exact changed line only when actionable, with enough surrounding context to prove the
issue. Explain the impact and the smallest safe correction. Do not post speculative or duplicate
findings, and do not restate CI output. Apply **anti-ratchet** on re-review: drop findings the update
resolved; do not raise fresh objections on unchanged lines you previously accepted. If no actionable
finding remains, respond with `lgtm` and nothing else.
