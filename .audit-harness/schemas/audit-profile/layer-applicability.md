# Layer Applicability — GENERATED from `registry.v1.json`

> ⚠️ **GENERATED FILE — do not edit by hand.**
> Source of truth: [`registry.v1.json`](registry.v1.json) (the canonical dimension→gate datum; `classify` resolves against it).
> Regenerate: `audit-harness gen-layer-applicability --write` (or `python3 scripts/gen-layer-applicability.py --write`).
> CI gate `layer-applicability-drift` fails the build if this file drifts from the registry.
>
> registry `sha256:ffbc75700fb5eb501cb47f1e4038f47ab95ae1fba534b38095e1fe7820c80ed1`

THE canonical dimension-to-gate registry: the single datum that answers 'which gates apply to repo-type X, in which dimension, at what applicability'. layer-applicability.md and each repo's TESTING.md are PROJECTIONS of this datum. `classify` resolves the UNION of a repo's detected classifications against this registry and records its sha256 as the audit-profile's registry_hash. Every gate defaults to enforcement=advisory; blocking is earned (engineer-pinned in TESTING.md, FP-rate-gated). applicability mirrors the matrix glyphs: required(✅) recommended(⭕) conditional(⚠) waived(❌).

**Legend (applicability):** ✅ required · ⭕ recommended · ⚠ conditional · ❌ waived

Every gate defaults to `enforcement: advisory`. Blocking is **earned** — engineer-pinned in the target repo's `tests/TESTING.md`, FP-rate-gated (see [`gate-promotion.md`](../../docs/gate-promotion.md)).

## Base gates (apply to every repo)

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:hygiene-links` | hygiene | ⭕ recommended | advisory | `lychee` |
| `audit-harness:local:hygiene-markdown` | hygiene | ⭕ recommended | advisory | `markdownlint` |
| `audit-harness:local:hygiene-readme` | hygiene | ⭕ recommended | advisory | — |
| `audit-harness:ci:cve-osv` | security | ⭕ recommended | advisory | `osv-scanner` |
| `audit-harness:ci:secrets-gitleaks` | security | ⭕ recommended | advisory | `gitleaks` |

## By classification

A repo carries the **UNION** of every classification it matches (`classify` never picks a single winner). Gates dedup by `gate_id`, keeping the highest applicability.

### `action`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:conform-action` | conformance | ✅ required | advisory | `yamllint` |
| `audit-harness:ci:smoke` | testing-depth | ⭕ recommended | advisory | — |

### `agent`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:conform-agent` | conformance | ✅ required | advisory | `validate-agent` |

### `api`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:conform-openapi` | conformance | ✅ required | advisory | `spectral` |
| `audit-harness:ci:sast` | security | ✅ required | advisory | `semgrep` |
| `audit-harness:ci:contract` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:crap-score` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:integration` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:unit` | testing-depth | ✅ required | advisory | — |

### `cli`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:ci:crap-score` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:smoke` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:unit` | testing-depth | ✅ required | advisory | — |

### `embedded`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:ci:fuzz` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:sanitizers` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:unit` | testing-depth | ✅ required | advisory | — |

### `frontend`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:ci:a11y` | testing-depth | ✅ required | advisory | `axe` |
| `audit-harness:ci:contract` | testing-depth | ⚠ conditional | advisory | — |
| `audit-harness:ci:crap-score` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:e2e` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:unit` | testing-depth | ✅ required | advisory | — |

### `hook`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:conform-hook` | conformance | ✅ required | advisory | `validate-hook` |

### `library`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:ci:cve-osv` | security | ✅ required | advisory | `osv-scanner` |
| `audit-harness:ci:crap-score` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:property-based` | testing-depth | ⭕ recommended | advisory | — |
| `audit-harness:ci:unit` | testing-depth | ✅ required | advisory | — |

### `marketplace`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:conform-marketplace` | conformance | ✅ required | advisory | `validate-marketplace` |

### `mcp`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:conform-mcp` | conformance | ✅ required | advisory | `validate-mcp` |

### `monorepo`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:per-package-classify` | testing-depth | ✅ required | advisory | — |

### `plugin`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:conform-plugin` | conformance | ✅ required | advisory | `validate-plugin` |
| `audit-harness:server:skill-behavioral` | skill-quality | ⭕ recommended | advisory | `j-rig` |

### `service`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:ci:sast` | security | ✅ required | advisory | `semgrep` |
| `audit-harness:ci:sbom-syft` | security | ⭕ recommended | advisory | `syft` |
| `audit-harness:ci:contract` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:crap-score` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:integration` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:migration` | testing-depth | ✅ required | advisory | — |
| `audit-harness:ci:perf` | testing-depth | ⭕ recommended | advisory | — |
| `audit-harness:ci:unit` | testing-depth | ✅ required | advisory | — |

### `skill`

| Gate | Dimension | Applicability | Enforcement | Tool |
|---|---|---|---|---|
| `audit-harness:local:conform-skillmd` | conformance | ✅ required | advisory | `validate-skillmd` |
| `audit-harness:server:skill-behavioral` | skill-quality | ⭕ recommended | advisory | `j-rig` |

## Overlays

### `regulated`

Compliance overlay (HIPAA/SOX/PCI-DSS/SOC2/GDPR/FedRAMP markers). Promotes recommended security + conformance gates to required and escalates uncovered SHOULD requirements.

Promotes to **required**: `security`, `conformance`.
