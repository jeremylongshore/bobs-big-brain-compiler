# Review-agent runtime measurements

Bead: `compile-then-govern-6ps.14`. Status: source implementation and hermetic
tests; not installed or live verified. The historical July estimate of nightly
Opus calls is not a current usage audit. The wrapper supports MiniMax, Grok and
Claude; configured support does not prove any provider is currently running.

## Measurement boundary

The canonical `scripts/distiller/teamkb-compile-daily.sh` records a local
`bbb-review-metrics/v1` JSON observation for each call to `run_inbox_review`,
including token/config skips. `review-metrics.py` is a sibling standard-library
helper. It does not call a model, brain, API, email transport, or billing service.
The wrapper's existing token provisioning, mode, permission, provider selection,
timeout and best-effort review behavior remain in place. A metrics failure logs
a generic unavailable message and does not turn a successful compile into a failure.

Records are atomically published as unique `review-metrics-*.json` files in the
existing compile log directory, with mode 0600. Their contents include:

- Record time and a validated target date when available; malformed target values
  are omitted as null rather than echoed.
- Configured provider versus the provider selected for an invocation; skipped
  reviews have no invoked provider. Only closed provider names are retained.
- `MiniMax-M3` as the selected model only when that literal invocation setting is
  present. Arbitrary model strings and implicit Claude/Grok model defaults are
  unavailable. Selection does not prove the server actually served that model.
- Monotonic wrapper-phase elapsed milliseconds, including review setup and the
  wrapped client process; this is not server inference latency.
- Success, failure, timeout or skip with exit code/closed skip reason. Code 124 is
  interpreted using the wrapper's GNU timeout convention; code 137 remains an
  ambiguous failed/killed outcome rather than proof of a deadline.
- Agent-reported textual candidate tallies when present. These are claims, not
  reconciled inbox size, accepted governance outcomes or independent ground truth.
- Supported terminal client-reported input/output/cache token counters and
  `total_cost_usd`, or explicit null/unavailable values. These are not provider
  invoices, account spending totals, pricing calculations or verified billing.

Default text-only client output may have no structured usage at all. The wrapper
does not change agent output format, switch models, add requests or estimate cost.
Unavailable is not zero: an explicitly reported numeric zero stays available,
while an absent, boolean, negative, nonfinite or over-limit value becomes null.
Counters require integers; all numeric observations are bounded by 10^12.

## Transcript and privacy treatment

Before the agent starts, the wrapper snapshots the appended transcript byte size.
The helper examines at most the final 1 MiB of that invocation's suffix, dropping
an initial partial line when the bounded tail starts mid-line. Earlier appended
attempts cannot supply this attempt's counts or usage. Missing/truncated files or
unsupported output produce unavailable observations. This is bounded inspection,
not complete transcript coverage.

Text tallies use a fixed numeric grammar. Only one-line JSON objects whose type
is `result` are considered for usage. The latest supported terminal object replaces
earlier objects; streaming fragments and repeated results are never summed. A
failed client may still report usage; that does not change its failed outcome.
Client output is untrusted, including apparently structured reports.

The JSON observation never copies transcript content, result text, arbitrary
configuration strings, credentials, URLs or local paths. Existing raw transcripts
and digest handling remain separate surfaces with their existing controls; this
change does not certify them. Measurements are operational observations, not
tamper-evident audit receipts or independent attestations.

## Distribution and validation

The umbrella currently enforces a six-file Compiler release manifest that omits
the new helper. Until its installer and launcher contract are updated and tested,
adopting this source revision with that installer would leave telemetry unavailable.
The integration is tracked as `compile-then-govern-6ps.14.1`; the parent remains open.
No installed bundle, `current` symlink, cron, admin token or activation state was
changed for this implementation.

Hermetic tests extract the real review functions without sourcing the wrapper's
main path, use an isolated HOME and fake agent executable, and exercise all three
provider branches, success, failure, timeout, token/config skips, unavailable
usage, stale appended transcripts, malformed/huge values, arbitrary model strings
and failed telemetry writes. Existing nightly compile proofs run separately.

```bash
python3 -m unittest discover -s scripts/distiller -p 'test_*.py' -v
bash -n scripts/distiller/teamkb-compile-daily.sh
shellcheck --severity=error scripts/distiller/teamkb-compile-daily.sh
ruff check scripts/distiller/review-metrics.py scripts/distiller/test_review_metrics.py
```

Rollback is reverting the source calls and helper before distribution. No data
migration or runtime rollback was exercised. Scaling and actual provider billing
reconciliation remain outside this source change.
