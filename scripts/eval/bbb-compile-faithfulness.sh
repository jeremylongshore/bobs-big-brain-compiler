#!/usr/bin/env bash
# bbb-compile-faithfulness.sh — scheduled compile-quality (faithfulness) eval
# against the LIVE governed brain (bead intentional-cognition-os-l13.10).
#
# WHAT IT DOES
# Runs the sampled compile-faithfulness (groundedness) eval —
# evals/faithfulness/nightly-compile-faithfulness.eval.yaml (sample 10, seed 1,
# threshold 0.8) — via the REAL `ico eval run` CLI against the live brain
# workspace (~/.teamkb/brain), then compares the mean groundedness score
# against the COMMITTED floor (evals/faithfulness/faithfulness-floor.json —
# measured, never invented: the first real run's score seeded it).
#
# The judge is an LLM (MiniMax-M3 by default — the spec's original DeepSeek
# judge is unfunded, HTTP 402 verified 2026-07-20, and MiniMax-M3 is the
# estate's compile-time model per l13.9; override via ICO_PROVIDER); its
# only durable writes into the brain are the eval's OWN outputs — eval traces,
# an audit-log line, and the compilations.faithfulness_tokens_used meter (the
# explicit carve-out in l13.10's ops half). It writes NO knowledge. The
# semantic tables are untouched.
#
# EXIT CODES
#   0  floor held (or an honest, logged SKIP — degrade, never crash)
#   1  regression: mean groundedness fell below the committed floor
#   2  infrastructure failure (build broke, eval crashed, no score in output)
#
# The ~/bin caller (bbb-compile-faithfulness.sh in ~/bin, installed alongside
# the bbb-compile-faithfulness.timer systemd user unit) arms notify-lib's
# arm_fail_trap, so any nonzero exit here becomes one plain-English line in
# Slack #cron-failures. Success is silent — signal, not chatter.
#
# ENV (all optional):
#   BBB_FAITHFULNESS_WORKSPACE  brain workspace (default ~/.teamkb/brain)
#   ICO_PROVIDER                judge provider (default minimax)
#   <PROVIDER>_API_KEY          judge key; else decrypted in-process from the
#                               sops-encrypted estate dotenv (never to disk)
#   BBB_FAITHFULNESS_SOPS_FILE  the estate dotenv (default intent-eval-lab/.env.sops)
set -uo pipefail
umask 077

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Absolute: `ico eval run --spec` resolves relative paths against the
# WORKSPACE (the live brain), not the repo.
SPEC="$(cd "$SCRIPT_DIR/../.." && pwd)/evals/faithfulness/nightly-compile-faithfulness.eval.yaml"
FLOOR_FILE="$REPO/evals/faithfulness/faithfulness-floor.json"
WORKSPACE="${BBB_FAITHFULNESS_WORKSPACE:-$HOME/.teamkb/brain}"
PROVIDER="${ICO_PROVIDER:-minimax}"
# MiniMax judge runs over the Anthropic-compatible wire: its OpenAI wire
# inlines `<think>…` reasoning into message content, which can corrupt the
# judge's JSON-extraction; the Anthropic wire keeps text blocks clean.
# (Both wires verified live 2026-07-20.) Explicit env overrides still win.
if [ "$PROVIDER" = "minimax" ]; then
  export ICO_PROVIDER_WIRE="${ICO_PROVIDER_WIRE:-anthropic}"
  export ICO_BASE_URL="${ICO_BASE_URL:-https://api.minimax.io/anthropic}"
fi
SOPS_FILE="${BBB_FAITHFULNESS_SOPS_FILE:-$HOME/000-projects/intent-eval-platform/intent-eval-lab/.env.sops}"
STATE_DIR="$HOME/.local/state/bbb-compile-faithfulness"
HISTORY="$STATE_DIR/history.log"
REPORT="$STATE_DIR/last-report.json"
EVAL_TIMEOUT="${BBB_FAITHFULNESS_TIMEOUT:-900}"
mkdir -p "$STATE_DIR"

ts() { date -u +%FT%TZ; }
note() { echo "$(ts) $*"; echo "$(ts) $*" >> "$HISTORY"; }

# ── Skip guards (degrade-not-crash: logged SKIP, exit 0) ─────────────────────
if [ ! -f "$WORKSPACE/.ico/state.db" ]; then
  note "SKIP: no brain workspace at $WORKSPACE (.ico/state.db missing)"
  exit 0
fi

# Judge key: env wins; else decrypt the estate dotenv via a sops PIPE
# (in-process only — never written to disk, never logged).
KEY_ENV_NAME="$(echo "$PROVIDER" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_' | sed 's/_$//')_API_KEY"
JUDGE_KEY="$(printenv "$KEY_ENV_NAME" 2>/dev/null || true)"
if [ -z "$JUDGE_KEY" ] && command -v sops >/dev/null 2>&1 && [ -f "$SOPS_FILE" ]; then
  JUDGE_KEY="$(sops -d --input-type dotenv --output-type dotenv "$SOPS_FILE" 2>/dev/null \
    | sed -nE "s/^${KEY_ENV_NAME}=(.*)$/\1/p" | head -1)"
fi
if [ -z "$JUDGE_KEY" ]; then
  note "SKIP: no $KEY_ENV_NAME in env or $SOPS_FILE — judge cannot run (env-gated degrade)"
  exit 0
fi

cd "$REPO" || { note "FAIL: cannot cd $REPO"; exit 2; }

# ── Build (mirrors the bbb-eval-governed anchor) ─────────────────────────────
if ! pnpm install --frozen-lockfile >/dev/null 2>&1; then
  note "FAIL: pnpm install --frozen-lockfile failed in $REPO"
  exit 2
fi
if ! pnpm -r --workspace-concurrency=1 build >/dev/null 2>&1; then
  note "FAIL: pnpm build failed in $REPO"
  exit 2
fi

# ── Run the eval (READ-mostly on the brain; writes only its own eval outputs) ─
# The key is exported ONLY into this invocation's environment.
OUT="$STATE_DIR/last-run.json"
set +e
env "$KEY_ENV_NAME=$JUDGE_KEY" ICO_PROVIDER="$PROVIDER" \
  /usr/bin/timeout "$EVAL_TIMEOUT" \
  node packages/cli/dist/index.js --workspace "$WORKSPACE" --json eval run --spec "$SPEC" \
  > "$OUT" 2> "$STATE_DIR/last-run.stderr"
EVAL_RC=$?

# Extract the faithfulness result regardless of the eval's own pass/fail exit
# (exit 1 legitimately means "score below the spec threshold" — that is a
# REPORTED signal here, not an infrastructure failure).
SCORE_LINE="$(node -e '
  const fs = require("fs");
  try {
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
    const r = (j.batch?.results ?? []).find((x) => x.spec?.type === "faithfulness");
    if (!r) { process.exit(3); }
    console.log(JSON.stringify({ score: r.score, passed: r.passed, threshold: r.threshold, details: r.details }));
  } catch { process.exit(3); }
' "$OUT" 2>/dev/null)"
if [ -z "$SCORE_LINE" ]; then
  note "FAIL: eval produced no faithfulness result (rc=$EVAL_RC) — see $OUT / $STATE_DIR/last-run.stderr"
  exit 2
fi
printf '%s\n' "$SCORE_LINE" > "$REPORT"
# process.stdout.write(String(...)) — console.log(number) would inject ANSI
# color codes when FORCE_COLOR is in the caller's environment.
SCORE="$(printf '%s' "$SCORE_LINE" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(String(JSON.parse(d).score)))')"
DETAILS="$(printf '%s' "$SCORE_LINE" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(String(JSON.parse(d).details)))')"

# ── Floor comparison (measured floor; regression alerts) ─────────────────────
if [ ! -f "$FLOOR_FILE" ]; then
  note "NO FLOOR YET: measured score=$SCORE · $DETAILS — commit evals/faithfulness/faithfulness-floor.json from this measurement"
  exit 0
fi
FLOOR="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).floor))' "$FLOOR_FILE" 2>/dev/null)"
if [ -z "$FLOOR" ]; then
  note "FAIL: floor file unreadable at $FLOOR_FILE"
  exit 2
fi

BELOW_FLOOR="$(node -e 'process.stdout.write(Number(process.argv[1]) < Number(process.argv[2]) ? "1" : "0")' "$SCORE" "$FLOOR")"
BELOW_SPEC="$(printf '%s' "$SCORE_LINE" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).passed?"0":"1"))')"

if [ "$BELOW_FLOOR" = "1" ]; then
  note "REGRESSION: faithfulness score=$SCORE fell below committed floor=$FLOOR · $DETAILS"
  exit 1
fi
if [ "$BELOW_SPEC" = "1" ]; then
  # Below the spec's 0.8 promotion-gating threshold but not below the measured
  # floor: reported loudly in the history (the promotion-gating SIGNAL the bead
  # names), alerting only on floor regression so the alert stays a ratchet.
  note "WARN: score=$SCORE holds floor=$FLOOR but is below the 0.8 spec threshold (promotion-gating signal) · $DETAILS"
  exit 0
fi
note "PASS: faithfulness score=$SCORE >= floor=$FLOOR · $DETAILS"
exit 0
