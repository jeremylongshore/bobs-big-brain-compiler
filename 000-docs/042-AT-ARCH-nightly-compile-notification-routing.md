# Nightly compile notification routing

**Doc:** 042-AT-ARCH · **Date:** 2026-08-02 · **Track:** ICO l13.15 · **Status:**
Authoritative for the compiler caller; the shared notification implementation remains
owned by Intent OS.

## Ownership boundary

The public repository name is `bobs-big-brain-compiler`, while the npm package and
bead prefix retain the historical `intentional-cognition-os` identity. That historical
prefix does not make the compiler the owner of estate-wide notifications.

| Layer                                          | Owner                          | Contract                                                                                                                                    |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Nightly compile caller                         | `bobs-big-brain-compiler`      | Supplies the raw event and a deterministic plain-English fallback.                                                                          |
| Normalization, evidence, retry, floor, receipt | `intent-os` `ops/alert-floor/` | MiniMax-M3 formats a redacted copy first; deterministic facts remain authoritative.                                                         |
| Buzz transport and topic taxonomy              | Intent OS/Buzz                 | Delivers to canonical `sys-*`/content topics; callers do not use retired channel aliases.                                                   |
| Cross-repo tracking                            | umbrella + each owning repo    | The compiler bead is a caller child; Intent OS `spine-8fl.2` owns semantic hardening and `spine-8fl.3` owns estate-wide migration/deletion. |

## Caller contract

`scripts/distiller/teamkb-compile-daily.sh` never contacts ntfy, Slack, or Buzz
directly. It loads the deployed alert-floor library when available and calls
`af_dispatch(raw, fallback, severity, topic)`. The alert-floor path owns:

- redaction before any model call;
- MiniMax-M3-first wording with bounded timeout;
- validation that status, numbers, and named service/job facts survive formatting;
- one concise visible summary plus recoverable raw evidence;
- canonical Buzz topic resolution, bounded retry, floor, spool, and honest receipts.

The wrapper's deterministic fallbacks are readable without a model:

- success → `sys-automation`;
- failure → `sys-automation`;
- abnormal early exit → `sys-incidents`.

There is no Slack/ntfy/`notify-lib` compatibility path in this caller. If the
governed library is absent in a fresh clone, the missing seam is logged and the
compile result is unchanged; delivery is never silently redirected to a retired
transport.

## Verification

`bash scripts/distiller/test-notification-routing.sh` proves that the wrapper has no
ntfy dependency, prefers `af_dispatch`, passes the expected topic and severity, runs
normalization before the visible Buzz message, does not expose the raw agent dump as
the visible message, and logs a missing-seam fallback. The shared semantic formatter
contract is tested in Intent OS `ops/alert-floor/tests/run-tests.sh`.

This separation is deliberate: compiler code changes are reviewed in the compiler
PR, while alert wording and estate-wide transport behavior are reviewed in the Intent
OS notification PR. Neither repository silently becomes the other's source of truth.
