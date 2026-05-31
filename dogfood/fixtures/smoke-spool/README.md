# smoke-spool fixture

A frozen ICO spool batch (`spool-*.jsonl`) used by the **key-free nightly CI
smoke** (`.github/workflows/nightly-smoke.yml`) via
`scripts/demo-e2e.sh --from-spool dogfood/fixtures/smoke-spool`.

The spool is ICO's cross-repo handoff artifact (the ICO → INTKB contract
boundary), so pinning one lets the nightly run exercise INTKB's
curator → export → qmd-search chain **without compiling** — i.e. with **zero
Claude API calls and no `ANTHROPIC_API_KEY`**.

## What's in it

Three `SpoolMemoryCandidate` lines (schema: `@ico/types` `SpoolMemoryCandidateSchema`),
`tenantId: demo-e2e` (must equal the demo's `--tenant`), categories
architecture / reference / troubleshooting. Content is synthetic prose derived
from the repo's own concepts — no secrets, deliberately searchable by the
demo's default query (`the`).

No `*.manifest.json` sidecar is committed on purpose: INTKB's `ingestFromSpool`
treats a manifest-less spool as `no_manifest` (can't-verify, still ingested) —
only a _mismatched_ manifest is refused as tamper. Omitting it avoids a
hand-maintained SHA-256.

## Regenerating from a real compile (optional)

To refresh from authentic compiled content instead of the hand-authored
fixture, run the full demo with a real key and copy the emitted spool:

```bash
ANTHROPIC_API_KEY=... scripts/demo-e2e.sh --keep
# then copy the kept workspace's spool-*.jsonl over this fixture, set every
# candidate tenantId to demo-e2e, and re-validate:
scripts/demo-e2e.sh --from-spool dogfood/fixtures/smoke-spool
```

Validation is just running the smoke locally — if stages 4-6 go green with no
key in the environment, the fixture is valid.
