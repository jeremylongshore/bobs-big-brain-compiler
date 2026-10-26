# Document consistency audit report

Project: Bob's Big Brain Compiler. Source baseline: `9dc7488`, checked 2026-10-26.
Bead: `compile-then-govern-eqw.6.2`; parent: `compile-then-govern-eqw.6`.
Registry: `intent-os/sot-map.yaml` absent — bootstrap mode, all fact classes unowned.
This diagnostic lists paired observations; it does not adopt an authority registry.
The separate source-backed corrections implement the owner's reconciliation request.

## Executive summary

This is the Compiler slice of intent-os audit 244, dated 2026-10-25. Findings are
grouped below rather than presented as a re-count of that four-repository audit.
Historical measurements keep their dates. Source, release label and installed
payload are different evidence. Validation and configured review outcomes belong
to the owning PR and Bead; this report does not claim fresh live/model acceptance.

| Severity                | Grouped findings |
| ----------------------- | ---------------: |
| Critical, deterministic |                0 |
| Warning, deterministic  |               10 |
| Info, deterministic     |                3 |
| Advisory, judged        |                8 |
| Total                   |               21 |

## Part A — deterministic findings

### Category 1: status drift

| ID  | Severity / unowned fact class | Paired baseline observations                                                                                                                                                                                                                                                   | Auto-fixable |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| W1  | Warning, version-string       | README:54,182 and status006:6 say 1.22.0; CLAUDE:13 says 1.12.0; root/package CLI manifests say 1.23.1. Current entry points are corrected; historical006 gets a dated scope note.                                                                                             | Yes          |
| I1  | Info, version-identity        | `packages/compiler/src/version.ts:1` exports 0.1.0 and `index.test.ts:7` pins it; `release-please-config.json:9–16` updates package manifests and kernel version but not that constant. The observed independent value is documented, not changed or used as release identity. | No           |
| I2  | Info, test-count              | README:182 says 1,737; CONTRIBUTING:97 says 1100+. Those numbers are not current run evidence. Entry points now require a run/commit-bound result.                                                                                                                             | Yes          |
| I3  | Info, harness-version         | `.audit-harness/VERSION:1` is v0.1.0; the npm development dependency in package.json is separately versioned. Guidance distinguishes them and acknowledges existing TEST_AUDIT.md without calling it a fresh pass.                                                             | Yes          |

### Category 4: CI and validation drift

| ID  | Severity / unowned fact class | Paired baseline observations                                                                                                                                                                                                                                                    | Auto-fixable |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| W6  | Warning, ci-commands          | CLAUDE:183–185 names incomplete CI jobs, a missing release.yml and manual bump dispatch. Actual workflows are ci.yml, release-please.yml (push to main), minimax-review.yml and the other listed workflow files. README source install now uses the frozen lockfile as CI does. | Yes          |

### Category 6: cross-document contradiction

| ID  | Severity / unowned fact class    | Paired baseline observations                                                                                                                                                                                                                                                                                                                            | Auto-fixable |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| W2  | Warning, cli-command-count       | README:127,184 and CLAUDE:47 say 16/14; `packages/cli/src/index.ts:85–101` registers 17 top-level groups. Subcommands are counted separately from groups.                                                                                                                                                                                               | Yes          |
| W3  | Warning, workspace-package-count | CONTRIBUTING:87 says four; pnpm-workspace.yaml and packages/\*/package.json describe five, including benchmarks.                                                                                                                                                                                                                                        | Yes          |
| W4  | Warning, citation-format         | README:39 says filename; `packages/compiler/src/ask/generate.ts:48` requests the frontmatter page title. Reference verification does not establish factual truth.                                                                                                                                                                                       | Yes          |
| W5  | Warning, trace-event-schema      | CLAUDE:215,225–226, trace011:111–112,258–313, status006 and audit023 show an ask start/completion pair or citation details in traces. `packages/cli/src/commands/ask.ts:313–322` emits one ask event with integer counts; :335–365 emits separate JSON answer objects. Active011 is corrected; historical audit/status claims get explicit dated notes. | Yes          |
| W8  | Warning, thesis-doc-identity     | CLAUDE:82 and thesis034 frontmatter claim byte identity with the Registrar copy. Whole-file comparison at the audited source pins differs. Current guidance names separately maintained historical copies.                                                                                                                                              | Yes          |

### Category 7: index and reference drift

| ID  | Severity / fact class          | Paired baseline observations                                                                                                                                                                                                                                            | Auto-fixable |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| W7  | Warning, referential integrity | CLAUDE:13,15,184 names missing version.txt, kernel/src/audit/writeTrace.ts and release.yml; actual files are package manifests, packages/kernel/src/traces.ts and release-please.yml. Documentation/epic paths now include their actual directory and filename pattern. | Yes          |
| W9  | Warning, referential integrity | 033:27,59 links outside the repository to an operator home layout and an absent bootstrap prompt. Replace them with portable repository references or clearly external operator configuration.                                                                          | Yes          |
| W10 | Warning, mirror-relative-link  | CHANGELOG:516 links to packages/kernel/src/traces.ts, valid here but broken when copied verbatim into the umbrella changelog mirror. The owning source link becomes absolute; normal aggregation remains under parent eqw.6, without hand-editing mirrors.              | Yes          |

## Part B — advisory findings, never blocking

### Category 1: status drift

- A2, Advisory, unowned phase-status: CLAUDE's next-milestone spool/demo/audit
  language conflicts with their existing command/script implementations. Name
  delivered source separately from a fresh execution or release claim. Auto-fixable: yes.
- A6, Advisory, unowned trace-analysis: old guidance treats per-event catalog
  shapes, uniform correlation and every-operation tracing as current guarantees.
  Current emitters differ; answer details and trace counts need separate
  retention, and selected eval execution is not every-spec acceptance. Auto-fixable: yes.

### Category 3: capability and behavior drift

- A1, Advisory, unowned provider-contract: README/CLAUDE describe Anthropic-only
  calls and stale credential/config defaults. `packages/types/src/providers.ts`
  and kernel config support provider-aware defaults and environment/workspace
  .env resolution; LM Studio needs an explicit endpoint/model. No provider is
  changed or called by this correction. Auto-fixable: yes.
- A3, Advisory, unowned research-stages: five named stages differ from the old
  four-agent summary. Collector is deterministic; three reasoning agents call
  the client, and `agents/orchestrator.ts:550–555` calls the report renderer,
  whose `render/report.ts:238` calls the provider too. Auto-fixable: yes.
- A5, Advisory, unowned trace-enforcement: active011's daily-null genesis,
  runtime event/payload validation, deny-list stripping/warning and single
  process serialization descriptions conflict with writer traces.ts:184–292,
  config.ts:20–65 and schemas.ts:114–125. The corrected reference states the
  finite redaction matcher, cross-day chain, exclusive DB lock, permissive
  envelope and file/SQL atomicity limits. Existing compile lineage section6.21
  remains intact. Auto-fixable: yes.

### Category 5: planning versus implementation

- A4, Advisory, unowned planning-status: historical007/021/006 describe original
  phases, planned npm availability, extension/Agent SDK choices and pre-release
  work. Dated implementation notes distinguish the existing dog-food plugin and
  injected client from the general extension API or remote/multi-user Compiler.
  Original phase numbers and measurements are retained. Auto-fixable: yes.

### Category 6: description comparison

- A7, Advisory, unowned project-description: local-first workspace storage is
  compatible with remote model providers and the separate team Registrar/plugin;
  it does not establish a remote Compiler workspace service. Auto-fixable: yes.
- A8, Advisory, unowned competitor-comparison: README's current-looking product
  matrix had no fresh competitor evidence. Replace it with this implementation's
  mechanisms and limits; historical analysis stays historical. This correction
  is not a new comparative benchmark. Auto-fixable: yes.

## Check coverage

| Check                 | Applied scope                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 index/filesystem  | No 000-docs/000-INDEX.md exists; the index-specific check is inapplicable. Documentation paths are checked directly.                                                                                                                                |
| 3.2 versions          | All five manifests, root version, kernel/Compiler version exports, release config and current versus dated entry points.                                                                                                                            |
| 3.3 commands/CI       | CLI registration, source install/build/test commands and actual workflow jobs/triggers; examples are not executed model calls.                                                                                                                      |
| 3.4 CLAUDE references | Named source, workflow, standards and epic paths; example workspace paths remain examples.                                                                                                                                                          |
| 3.5 stale status      | Current entry points corrected; dated audits, original plans and metrics explicitly retain historical scope.                                                                                                                                        |
| 3.6 capabilities      | Ask, compile/link, spool, maintain, provider, report-render and trace/redaction boundaries inspected in source.                                                                                                                                     |
| 3.7 cross-doc facts   | Node22, manifests, package inventory, Apache2 code license, repo/npm identities and description boundaries.                                                                                                                                         |
| 3.8 links             | Repository Markdown targets inspected. Workspace examples and transcribed dog-food corpus links are distinguished from broken navigational links; corpus fixtures are not silently edited. External HTTP correctness is a separate validation lane. |
| 3.9 planning          | No planning/ directory exists; applicable blueprint/security/status/thesis plans were inspected instead, without promoting them to acceptance evidence.                                                                                             |

## Unowned fact classes — human adjudication needed

Version labels, release identity, command/package counts, citation/trace schema,
CI commands, test/harness versions, provider/stage/capability and phase/description
classes remain unowned in the missing registry. The paired paths and values above
are candidate evidence; referential existence does not require a registry owner.

## Proposed registry rows

Bootstrap draft for human adjudication only. No sot-map.yaml is written.

```yaml
version: 1
fact_classes:
  manifest-version:
    {
      owner: package-manifest,
      mirrors: [package-labels],
      determinism: deterministic,
      depth_tier: T1,
      staleness_bound: 0,
      criticality: high,
      volatile: false,
    }
  release-tag-version:
    {
      owner: git-release-tag,
      mirrors: [readme-release-table],
      determinism: deterministic,
      depth_tier: T1,
      staleness_bound: 0,
      criticality: high,
      volatile: false,
    }
  trace-event-schema:
    {
      owner: code,
      mirrors: [canonical-docs, readme],
      determinism: deterministic,
      depth_tier: T1,
      staleness_bound: 0,
      criticality: high,
      volatile: false,
    }
  capability-claims:
    {
      owner: code,
      mirrors: [canonical-docs, readme],
      determinism: llm-judged,
      depth_tier: T2,
      staleness_bound: 0,
      criticality: medium,
      volatile: false,
    }
```

## Priority actions

1. Reconcile the direct Compiler mismatches and verify the changed examples,
   references and owning documentation gates before closing eqw.6.2.
2. Keep the parent open for normal changelog aggregation and the Registrar,
   plugin and website-data slices (eqw.6.3–eqw.6.5).
3. Advisory: retain historical evidence and explicit provider, trace, release and
   installation boundaries; do not present a documentation pass as live proof.
