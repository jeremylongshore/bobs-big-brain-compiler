#!/usr/bin/env bash
# Nightly autonomous /teamkb-compile — compiles yesterday's work into the governed brain.
#
# REPO-CANONICAL COPY (bead intentional-cognition-os-l13.9). This is the versioned
# distiller wrapper: ~/bin/teamkb-compile-daily.sh is a thin shim that execs this
# file when the repo checkout carries it (enforcement travels with the code). Edit
# HERE, not in ~/bin.
#
# Runs LOCALLY (cloud Routines can't reach the tailnet-bound brain / local ~/.teamkb).
# Scheduled ~03:30 via crontab, BEFORE the 04:30 teamkb-backup.timer, so the night's
# new memories land in that night's backup.
#
# Agent: TEAMKB_AGENT=minimax|grok|claude (default: minimax — l13.9 provider swap).
#   minimax → the claude CLI pointed at MiniMax's Anthropic-compatible endpoint
#             (ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic, model MiniMax-M3,
#             x-api-key auth = MINIMAX_API_KEY). This is an OFFLINE compile-time role:
#             the model only PROPOSES candidates; the deterministic INTKB govern
#             kernel (dedupe → policy → promotion) still owns admission. Missing
#             key/binary DEGRADES to grok with a logged WARN — never a crash.
#   grok    → the previous durable headless runner (kept as the degrade path).
#   claude  → the original Anthropic path (weekly-rate-limit killed the 2026-07-14
#             nightly; kept as a manual override).
#
# Distiller eval (l13.9): after each run, eval-distiller-output.mjs (sibling file)
# runs DETERMINISTIC groundedness checks over the night's promoted candidates —
# citation well-formed → cited kb-export doc exists → title content-word overlap
# with the cited doc. No LLM, no key. Result is folded into the digest email; a
# failing eval never flips the compile status (diagnostic, loud, non-gating).
#
# Mode: digest-first by default; self-graduates to auto (see MODE section).
#
# Concurrency (bead compile-then-govern-e06.12 / risk 010-AT-RISK R13 / umbrella #27):
#   All ~/.teamkb writers serialize on flocks; this wrapper takes .compile.lock and
#   MUST NOT hold .write.lock across the agent run (deadlocks brain_govern —
#   incident 2026-07-12..14).

set -uo pipefail
# Scratch files (signal doc, transcripts, digest, candidates) can contain
# secret-bearing transcript material — keep everything we write owner-only.
umask 077

# Cron PATH is minimal — keep local tools reachable.
export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# ── Config ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR=$HOME/.claude/skills/teamkb-compile
MCP_CONFIG="$SKILL_DIR/scripts/brain-mcp-config.json"
DECISIONS="$SKILL_DIR/methodology/decisions.jsonl"
EMAIL_SCRIPT=$HOME/.claude/skills/email/scripts/send-email.cjs
EMAIL_TO=jeremy@intentsolutions.io
SCRATCH=/tmp/teamkb-compile
LOG_DIR=$HOME/.local/state/teamkb-compile-daily
NTFY_TOPIC_FILE=$HOME/.ntfy-topic

# Agent: minimax (default) | grok | claude. See header.
TEAMKB_AGENT="${TEAMKB_AGENT:-minimax}"
TEAMKB_MAX_TURNS="${TEAMKB_MAX_TURNS:-120}"
GROK_BIN="${GROK_BIN:-$(command -v grok 2>/dev/null || true)}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"

# MiniMax (l13.9): Anthropic-compatible endpoint + model. The key comes from env
# MINIMAX_API_KEY, else is decrypted IN-PROCESS from the sops-encrypted estate
# dotenv (never written to disk, never logged).
MINIMAX_BASE_URL="${MINIMAX_BASE_URL:-https://api.minimax.io/anthropic}"
MINIMAX_MODEL="${MINIMAX_MODEL:-MiniMax-M3}"
MINIMAX_SOPS_FILE="${MINIMAX_SOPS_FILE:-$HOME/000-projects/intent-eval-platform/intent-eval-lab/.env.sops}"
MINIMAX_KEY=""   # resolved by resolve_minimax_key; NEVER log or interpolate into command strings

# Distiller-output eval (l13.9): deterministic groundedness harness, sibling file.
DISTILLER_EVAL="${DISTILLER_EVAL:-$SCRIPT_DIR/eval-distiller-output.mjs}"
KB_EXPORT_DIR="${KB_EXPORT_DIR:-$HOME/.teamkb/kb-export}"

# ── Inbox review phase (jfv.8 / 014-AT-DECR) ──────────────────────────────────
# After compiling MY day, review the TEAM's quarantined proposals with the agent
# reviewer. Runs in the SAME flock (sequential — never overlaps the compile). Live
# vs dry-run is tied to the compile MODE: `auto` → live (brain_approve/reject),
# `digest` → --dry-run (print verdicts only). So the ONE self-graduation gates
# both — the review never writes until the compile is already trusted to. Skipped
# cleanly unless the dedicated teamkb-review-agent admin token is provisioned.
REVIEW_SKILL_DIR=$HOME/.claude/skills/teamkb-review
REVIEW_MCP_CONFIG="$REVIEW_SKILL_DIR/scripts/review-mcp-config.json"
REVIEW_TOKEN_FILE="${TEAMKB_REVIEW_TOKEN_FILE:-$HOME/.teamkb/.review-agent-token}"
REVIEW_API_URL="${TEAMKB_API_URL:-http://100.109.119.103:3847}"
REVIEW_TIMEOUT_SECS="${TEAMKB_REVIEW_TIMEOUT:-900}" # 15 min ceiling for the review pass

TIMEOUT_SECS="${TEAMKB_COMPILE_TIMEOUT:-1800}" # 30 min hard ceiling
TARGET="${TEAMKB_COMPILE_DATE:-$(date -d 'yesterday' +%Y-%m-%d)}"
NEXT="$(date -d "$TARGET +1 day" +%Y-%m-%d)"
MODE_STATE="$LOG_DIR/mode"                      # persisted, self-managed mode
SOAK_NIGHTS="${TEAMKB_COMPILE_SOAK_NIGHTS:-3}"  # clean digest nights before auto-graduation

mkdir -p "$LOG_DIR" "$SCRATCH"
chmod 700 "$SCRATCH" 2>/dev/null || true   # tighten even if it pre-existed loose
LOG="$LOG_DIR/run-${TARGET}.log"
DIGEST="$SCRATCH/digest-${TARGET}.md"

# Liveness markers for automation-liveness-sweep (own EXIT trap — don't use arm_fail_trap).
_BEATDIR="$HOME/.local/state/notify-lib"
mkdir -p "$_BEATDIR" 2>/dev/null || true
: > "$_BEATDIR/teamkb-compile-daily.beat" 2>/dev/null || true

log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

# ── MiniMax key resolution (l13.9) ───────────────────────────────────────────
# Env wins; else decrypt the estate dotenv via a sops PIPE (in-process only).
# Sets MINIMAX_KEY. Returns 1 (without logging any value) when unresolvable.
resolve_minimax_key() {
  if [ -n "${MINIMAX_API_KEY:-}" ]; then
    MINIMAX_KEY="$MINIMAX_API_KEY"
    return 0
  fi
  if command -v sops >/dev/null 2>&1 && [ -f "$MINIMAX_SOPS_FILE" ]; then
    # Anchored sed — only the real KEY=VALUE line, never a bare-export dump.
    MINIMAX_KEY="$(sops -d --input-type dotenv --output-type dotenv "$MINIMAX_SOPS_FILE" 2>/dev/null \
      | sed -nE 's/^MINIMAX_API_KEY=(.*)$/\1/p' | head -1)"
    [ -n "$MINIMAX_KEY" ] && return 0
  fi
  return 1
}

# Resolve which agent binary to use (honors TEAMKB_AGENT; falls back if missing).
resolve_agent() {
  case "${TEAMKB_AGENT}" in
    minimax|MiniMax|MINIMAX)
      if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] && resolve_minimax_key; then
        AGENT_NAME=minimax; AGENT_BIN="$CLAUDE_BIN"; return 0
      fi
      # Env-gated degrade: no key (or no claude binary) → grok, never a crash.
      log "WARN: TEAMKB_AGENT=minimax but claude binary or MINIMAX_API_KEY unavailable — degrading to grok"
      if [ -n "$GROK_BIN" ] && [ -x "$GROK_BIN" ]; then
        AGENT_NAME=grok; AGENT_BIN="$GROK_BIN"; return 0
      fi
      if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
        log "WARN: grok not on PATH either — falling back to claude (Anthropic)"
        AGENT_NAME=claude; AGENT_BIN="$CLAUDE_BIN"; return 0
      fi
      ;;
    grok|Grok|GROK)
      if [ -n "$GROK_BIN" ] && [ -x "$GROK_BIN" ]; then
        AGENT_NAME=grok; AGENT_BIN="$GROK_BIN"; return 0
      fi
      if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
        log "WARN: TEAMKB_AGENT=grok but grok not on PATH — falling back to claude"
        AGENT_NAME=claude; AGENT_BIN="$CLAUDE_BIN"; return 0
      fi
      ;;
    claude|Claude|CLAUDE)
      if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
        AGENT_NAME=claude; AGENT_BIN="$CLAUDE_BIN"; return 0
      fi
      if [ -n "$GROK_BIN" ] && [ -x "$GROK_BIN" ]; then
        log "WARN: TEAMKB_AGENT=claude but claude not on PATH — falling back to grok"
        AGENT_NAME=grok; AGENT_BIN="$GROK_BIN"; return 0
      fi
      ;;
    *)
      log "FATAL: unknown TEAMKB_AGENT=${TEAMKB_AGENT} (want minimax|grok|claude)"; return 1
      ;;
  esac
  log "FATAL: no agent binary found (grok=$GROK_BIN claude=$CLAUDE_BIN)"; return 1
}

# ── Inbox review (jfv.8 / 014-AT-DECR) ────────────────────────────────────────
# Sets the global REVIEW_SUMMARY (folded into the digest email). No-op + clear log
# line when the teamkb-review-agent token is not provisioned — that absence IS the
# deliberate activation gate (per the self-managing-rollout doctrine, nobody flips
# a switch; provisioning the token is the one deliberate step).
REVIEW_SUMMARY=""
run_inbox_review() {
  local tok=""
  if [ -n "${TEAMKB_REVIEW_AGENT_TOKEN:-}" ]; then
    tok="$TEAMKB_REVIEW_AGENT_TOKEN"
  elif [ -r "$REVIEW_TOKEN_FILE" ]; then
    tok="$(head -n1 "$REVIEW_TOKEN_FILE" 2>/dev/null)"
  fi
  if [ -z "$tok" ]; then
    log "inbox review SKIPPED — no teamkb-review-agent token ($REVIEW_TOKEN_FILE). Provision it to activate (see teamkb-review SKILL.md)."
    REVIEW_SUMMARY="Inbox review: skipped (no teamkb-review-agent token provisioned — the deliberate activation gate)."
    return 0
  fi
  if [ ! -f "$REVIEW_MCP_CONFIG" ]; then
    log "inbox review SKIPPED — review MCP config missing at $REVIEW_MCP_CONFIG"
    REVIEW_SUMMARY="Inbox review: skipped (review MCP config missing — run deploy-teamkb-compile.sh)."
    return 0
  fi
  # Live iff the compile is in auto (the single self-graduation gates both); digest → dry-run.
  local review_flag="--dry-run"; [ "$MODE" = "auto" ] && review_flag=""
  local rlog="$SCRATCH/review-${TARGET}.log"
  local review_cmd review_rc
  # Tokens/keys are exported ONLY into the invocation's environment — NEVER
  # interpolated into the `script -c` string (shell-injection risk if the token
  # had metacharacters). Never logged.
  case "${AGENT_NAME:-grok}" in
    grok)
      # Grok MCP governed-brain is already in ~/.grok/config.toml. Export team-mode
      # env so the MCP child inherits API URL + token (maps to remote/team mode).
      # CLAUDE_SKILL_DIR is what the skill docs reference for paths.
      review_cmd="$AGENT_BIN -p '/teamkb-review $review_flag' --always-approve --max-turns ${TEAMKB_MAX_TURNS} --cwd '$HOME' --rules 'CLAUDE_SKILL_DIR=$REVIEW_SKILL_DIR. Prefer brain_* MCP tools. Export-style path: use absolute skill dir above.'"
      log "Invoking: grok -p /teamkb-review ${review_flag:-（live）} (timeout ${REVIEW_TIMEOUT_SECS}s, max-turns ${TEAMKB_MAX_TURNS})"
      if TEAMKB_API_URL="$REVIEW_API_URL" \
         TEAMKB_API_TOKEN="$tok" \
         TEAMKB_REVIEW_AGENT_TOKEN="$tok" \
         CLAUDE_SKILL_DIR="$REVIEW_SKILL_DIR" \
         /usr/bin/timeout "$REVIEW_TIMEOUT_SECS" script -e -q -a \
           -c "$review_cmd" \
           "$rlog" >/dev/null 2>&1; then
        review_rc=0
      else
        review_rc=$?
      fi
      ;;
    minimax)
      # Same claude-CLI shape as the claude branch, but pointed at MiniMax's
      # Anthropic-compatible endpoint (x-api-key auth → ANTHROPIC_API_KEY).
      review_cmd="$AGENT_BIN -p '/teamkb-review $review_flag' --mcp-config '$REVIEW_MCP_CONFIG' --strict-mcp-config --dangerously-skip-permissions"
      log "Invoking: claude(minimax) -p /teamkb-review ${review_flag:-（live）} (timeout ${REVIEW_TIMEOUT_SECS}s, model ${MINIMAX_MODEL})"
      if TEAMKB_API_URL="$REVIEW_API_URL" TEAMKB_REVIEW_AGENT_TOKEN="$tok" \
         ANTHROPIC_BASE_URL="$MINIMAX_BASE_URL" \
         ANTHROPIC_API_KEY="$MINIMAX_KEY" \
         ANTHROPIC_AUTH_TOKEN="" \
         ANTHROPIC_MODEL="$MINIMAX_MODEL" \
         ANTHROPIC_SMALL_FAST_MODEL="$MINIMAX_MODEL" \
         /usr/bin/timeout "$REVIEW_TIMEOUT_SECS" script -e -q -a \
           -c "$review_cmd" \
           "$rlog" >/dev/null 2>&1; then
        review_rc=0
      else
        review_rc=$?
      fi
      ;;
    claude|*)
      review_cmd="claude -p '/teamkb-review $review_flag' --mcp-config '$REVIEW_MCP_CONFIG' --strict-mcp-config --dangerously-skip-permissions"
      log "Invoking: claude -p /teamkb-review ${review_flag:-（live）} (timeout ${REVIEW_TIMEOUT_SECS}s)"
      if TEAMKB_API_URL="$REVIEW_API_URL" TEAMKB_REVIEW_AGENT_TOKEN="$tok" \
         /usr/bin/timeout "$REVIEW_TIMEOUT_SECS" script -e -q -a \
           -c "$review_cmd" \
           "$rlog" >/dev/null 2>&1; then
        review_rc=0
      else
        review_rc=$?
      fi
      ;;
  esac
  if [ "$review_rc" -eq 0 ]; then
    # Pull the agent's one-line tallies out of the transcript for the digest.
    local tally
    tally="$(grep -oE 'reviewed [0-9]+ · promoted [0-9]+ · held [0-9]+ · rejected [0-9]+( · refused-by-rules [0-9]+)?' "$rlog" 2>/dev/null | tail -1)"
    REVIEW_SUMMARY="Inbox review (${review_flag:-live}, agent=${AGENT_NAME:-?}): ${tally:-completed (see $rlog)}."
    log "inbox review OK — ${REVIEW_SUMMARY}"
  else
    REVIEW_SUMMARY="Inbox review: FAILED (rc=$review_rc, ${review_flag:-live}, agent=${AGENT_NAME:-?}) — see $rlog. (The compile still succeeded; review is best-effort.)"
    log "inbox review FAILED (rc=$review_rc) — see $rlog"
  fi
  return 0
}

# ── Distiller-output eval (l13.9) ─────────────────────────────────────────────
# Deterministic groundedness checks over tonight's promoted candidates. Sets
# DISTILLER_EVAL_SUMMARY for the digest email. Diagnostic + loud, never gating:
# a failing (or missing) eval cannot flip the compile STATUS. Every skip path
# logs its reason (env-gated degrade, never a crash).
#
# TIER SPLIT (deliberate, not a bug): THIS distiller eval is the DIGEST-ONLY,
# NON-GATING tier — cheap, deterministic, runs every night, informs the operator
# email. The GATING tier is a SEPARATE, scheduled job: scripts/eval/
# bbb-compile-faithfulness.sh (l13.10), an LLM-judge groundedness check against
# a committed floor whose regression alerts #cron-failures. Two tiers on purpose:
# a nightly no-cost signal here, a weekly floor-check ratchet there.
DISTILLER_EVAL_SUMMARY=""
run_distiller_eval() {
  if ! command -v node >/dev/null 2>&1; then
    log "distiller eval SKIPPED — node not on PATH"
    DISTILLER_EVAL_SUMMARY="Distiller eval: skipped (node not on PATH)."
    return 0
  fi
  if [ ! -f "$DISTILLER_EVAL" ]; then
    log "distiller eval SKIPPED — harness missing at $DISTILLER_EVAL"
    DISTILLER_EVAL_SUMMARY="Distiller eval: skipped (harness missing at $DISTILLER_EVAL)."
    return 0
  fi
  local elog="$SCRATCH/distiller-eval-${TARGET}.log"
  if node "$DISTILLER_EVAL" \
       --decisions "$DECISIONS" --date "$TARGET" --kb-export "$KB_EXPORT_DIR" \
       > "$elog" 2>&1; then
    DISTILLER_EVAL_SUMMARY="Distiller eval: $(tail -1 "$elog" 2>/dev/null)"
    log "distiller eval OK — ${DISTILLER_EVAL_SUMMARY}"
  else
    local erc=$?
    DISTILLER_EVAL_SUMMARY="Distiller eval: FAILED (rc=$erc) — $(tail -1 "$elog" 2>/dev/null) (diagnostic only; see $elog)"
    log "distiller eval FAILED (rc=$erc) — see $elog"
  fi
  return 0
}

# ── compile-level lock (NOT .write.lock) ──────────────────────────────────────
# Serializes concurrent compile wrappers (nightly vs on-push) on .compile.lock.
# MUST NOT hold ~/.teamkb/.write.lock across the headless agent compile: that is
# the same flock brain_govern needs, and holding it for the whole run deadlocks
# AUTO-mode promotion (incident 2026-07-12..14 — spool grew, brain_after unchanged).
# Backup still takes .write.lock itself; govern takes .write.lock itself — they
# serialize at the brain layer without the wrapper joining that lock.
TEAMKB_HOME="${TEAMKB_HOME:-$HOME/.teamkb}"
LOCK="${TEAMKB_COMPILE_LOCK:-$TEAMKB_HOME/.compile.lock}"
LOCK_WAIT="${TEAMKB_LOCK_WAIT:-10}"
if command -v flock >/dev/null 2>&1; then
  mkdir -p "$TEAMKB_HOME"
  exec 9>"$LOCK"
  if ! flock -w "$LOCK_WAIT" 9; then
    # exit 0 BEFORE the fail-loud EXIT trap is installed, so a lock-skip is silent
    # (a deferred compile is expected, not an incident).
    log "another compile holds $LOCK — skipping this compile run (will retry next trigger)"
    exit 0
  fi
  log "compile lock acquired ($LOCK) — brain .write.lock left free for brain_govern"
else
  log "WARN: flock not on PATH — proceeding WITHOUT the compile lock"
fi

# ── Mode: self-managing (digest-first, AUTO-GRADUATES — no human flip) ─────────
# "I don't want to manage anything, the computer and AI should." The wrapper owns
# its own rollout: it soaks in digest mode, then graduates ITSELF to auto after
# SOAK_NIGHTS clean digest runs, and persists that decision. Resolution order:
#   1. explicit env override (TEAMKB_COMPILE_MODE) — escape hatch for test/revert
#   2. persisted state file ($MODE_STATE)
#   3. default: digest (seeds the state file)
MODE_SRC="default"
if [ -n "${TEAMKB_COMPILE_MODE:-}" ]; then
  MODE="$TEAMKB_COMPILE_MODE"; MODE_SRC="env-override"
elif [ -s "$MODE_STATE" ]; then
  MODE="$(tr -dc 'a-z' < "$MODE_STATE")"; MODE_SRC="state-file"
else
  MODE="digest"; echo digest > "$MODE_STATE"; MODE_SRC="default(seeded)"
fi
[ "$MODE" = "auto" ] || MODE="digest"           # sanitize anything unexpected → digest

# Auto-graduation: once enough clean digest nights have banked, flip to auto and
# persist it (one-way). Skipped when the mode came from an explicit env override.
GRADUATED=0; CLEAN_DIGESTS="n/a"
if [ "$MODE" = "digest" ] && [ "$MODE_SRC" != "env-override" ]; then
  CLEAN_DIGESTS=$(grep -cE '"mode"[[:space:]]*:[[:space:]]*"digest"' "$DECISIONS" 2>/dev/null) || CLEAN_DIGESTS=0
  if [ "$CLEAN_DIGESTS" -ge "$SOAK_NIGHTS" ]; then
    MODE="auto"; GRADUATED=1
    # Persist the one-way graduation — but never as a side effect of a dry run.
    [ -z "${TEAMKB_COMPILE_DRYRUN:-}" ] && echo auto > "$MODE_STATE"
  fi
fi

log "=== teamkb-compile-daily start (target=$TARGET mode=$MODE src=$MODE_SRC soak=$CLEAN_DIGESTS/$SOAK_NIGHTS graduated=$GRADUATED) ==="
[ "$GRADUATED" -eq 1 ] && log "🎓 SELF-GRADUATED digest→auto after ${CLEAN_DIGESTS} clean digest nights (>= soak ${SOAK_NIGHTS}). Auto-promoting nightly from now on."

# ── Fail-loud guard ──────────────────────────────────────────────────────────
# Any non-zero exit that bypassed the normal notify path must still alert.
NOTIFIED=0
notify_unexpected_exit() {
  local rc=$?
  [ "$rc" -eq 0 ] && return
  [ "$NOTIFIED" -eq 1 ] && return
  log "ABNORMAL EXIT (rc=$rc) before normal notification — sending fail-loud alert"
  local topic; topic=$(cat "$NTFY_TOPIC_FILE" 2>/dev/null)
  [ -n "$topic" ] && curl -s -H "Title: 🚨 teamkb-compile aborted early" -H "Priority: max" -H "Tags: rotating_light" \
    -d "${TARGET}: early exit rc=${rc} — brain may not be updated. Check ${LOG}" \
    "https://ntfy.sh/$topic" >/dev/null 2>&1 || true
  if command -v node >/dev/null 2>&1 && [ -f "$EMAIL_SCRIPT" ]; then
    node "$EMAIL_SCRIPT" --to "$EMAIL_TO" \
      --subject "🚨 teamkb-compile aborted early: ${TARGET} (rc=${rc})" \
      --body "$(printf 'teamkb-compile exited abnormally (rc=%s) BEFORE its normal summary.\nTarget: %s  Mode: %s\n\nLast 30 log lines:\n%s\n' \
        "$rc" "$TARGET" "$MODE" "$(tail -30 "$LOG" 2>/dev/null)")" >/dev/null 2>&1 || true
  fi
}
trap notify_unexpected_exit EXIT

# ── Idempotency ──────────────────────────────────────────────────────────────
# If an audit record for this date already exists, this night already ran — no-op.
if [ -f "$DECISIONS" ] && grep -qE "\"date\"[[:space:]]*:[[:space:]]*\"${TARGET}\"" "$DECISIONS" 2>/dev/null; then
  log "Audit record already exists for ${TARGET} — skipping (no-op)."
  NOTIFIED=1
  exit 0
fi


# C8-live preflight (intent-os ops/disclosure-policy/live — D88 Phase 2)
# Fail closed if C8 is not enforcing — never open a one-way door without the filter.
C8_LIVE_PREFLIGHT="/home/jeremy/000-projects/intent-os/ops/disclosure-policy/live/preflight.sh"
if [ -f "$C8_LIVE_PREFLIGHT" ]; then
  if ! bash "$C8_LIVE_PREFLIGHT" >> "$LOG" 2>&1; then
    log "FATAL: C8-live preflight failed — aborting compile (brain-ingest must not run without C8)"
    exit 2
  fi
  log "C8-live preflight OK — brain-ingest sink enforcing"
else
  log "FATAL: C8-live preflight script missing at $C8_LIVE_PREFLIGHT"
  exit 2
fi

# ── Preflight: brain reachable? ──────────────────────────────────────────────
if [ ! -f "$MCP_CONFIG" ]; then
  log "FATAL: MCP config missing at $MCP_CONFIG"; exit 1
fi

# ── Resolve agent before dry-run / invoke ────────────────────────────────────
if ! resolve_agent; then
  log "FATAL: cannot resolve agent"; exit 1
fi
log "agent resolved: name=${AGENT_NAME} bin=${AGENT_BIN} (TEAMKB_AGENT=${TEAMKB_AGENT})"

# ── Dry run: resolve mode + graduation, then stop (no agent, no writes) ──────
# For testing the self-management logic without a full ~9-min compile.
if [ -n "${TEAMKB_COMPILE_DRYRUN:-}" ]; then
  log "DRYRUN: would invoke ${AGENT_NAME} /teamkb-compile $TARGET $NEXT --$MODE (src=$MODE_SRC, graduated=$GRADUATED). No agent, no writes."
  NOTIFIED=1; exit 0
fi

# ── Run /teamkb-compile headlessly ───────────────────────────────────────────
# pty-wrap (script -e -q -a -c) so the CLI flushes incrementally instead of
# buffering until SIGKILL — keeps the log diagnosable on timeout.
#
# minimax: the claude CLI with MiniMax's Anthropic-compatible endpoint. The key
# is exported ONLY into the invocation env (never in the -c string, never
# logged). --strict-mcp-config loads ONLY governed-brain (local mode).
#
# Grok: skills load from ~/.claude/skills (compat); governed-brain MCP from
# ~/.grok/config.toml (local mode — no TEAMKB_API_URL). CLAUDE_SKILL_DIR is set
# so skill-doc path references resolve. max-turns bounds runaway tool loops.
#
# Claude: --strict-mcp-config loads ONLY governed-brain (local mode); the plugin
# is not in enabledPlugins so headless claude needs --mcp-config explicitly.
COMPILE_CMD=""
case "$AGENT_NAME" in
  grok)
    COMPILE_CMD="$AGENT_BIN -p '/teamkb-compile $TARGET $NEXT --$MODE' --always-approve --max-turns ${TEAMKB_MAX_TURNS} --cwd '$HOME' --rules 'CLAUDE_SKILL_DIR=$SKILL_DIR. Use absolute path $SKILL_DIR for gather-signals.sh and methodology/decisions.jsonl. Use brain_* MCP tools from governed-brain (local). Emit [phase: name] markers.'"
    # Ensure local-mode: strip any inherited API URL for the compile pass.
    unset TEAMKB_API_URL TEAMKB_API_TOKEN 2>/dev/null || true
    export CLAUDE_SKILL_DIR="$SKILL_DIR"
    ;;
  minimax|claude)
    COMPILE_CMD="$AGENT_BIN -p '/teamkb-compile $TARGET $NEXT --$MODE' --mcp-config '$MCP_CONFIG' --strict-mcp-config --dangerously-skip-permissions"
    ;;
esac

log "Invoking: ${AGENT_NAME} -p /teamkb-compile $TARGET $NEXT --$MODE (timeout ${TIMEOUT_SECS}s, max-turns ${TEAMKB_MAX_TURNS}, pty-wrapped)"
T0=$(date +%s)
if [ "$AGENT_NAME" = "minimax" ]; then
  # MiniMax env is scoped to this invocation only. x-api-key auth (verified
  # live 2026-07-20) → ANTHROPIC_API_KEY carries the MiniMax key.
  RUN_OK=0
  if CLAUDE_SKILL_DIR="$SKILL_DIR" \
     ANTHROPIC_BASE_URL="$MINIMAX_BASE_URL" \
     ANTHROPIC_API_KEY="$MINIMAX_KEY" \
     ANTHROPIC_AUTH_TOKEN="" \
     ANTHROPIC_MODEL="$MINIMAX_MODEL" \
     ANTHROPIC_SMALL_FAST_MODEL="$MINIMAX_MODEL" \
     /usr/bin/timeout "$TIMEOUT_SECS" script -e -q -a \
       -c "$COMPILE_CMD" \
       "$LOG" >/dev/null 2>&1; then RUN_OK=1; else EXIT=$?; fi
else
  RUN_OK=0
  if CLAUDE_SKILL_DIR="$SKILL_DIR" /usr/bin/timeout "$TIMEOUT_SECS" script -e -q -a \
       -c "$COMPILE_CMD" \
       "$LOG" >/dev/null 2>&1; then RUN_OK=1; else EXIT=$?; fi
fi
if [ "$RUN_OK" -eq 1 ]; then
  WALL=$(( $(date +%s) - T0 )); STATUS="OK"
  log "${AGENT_NAME} -p exited cleanly after ${WALL}s ($((WALL/60))m $((WALL%60))s)"
else
  WALL=$(( $(date +%s) - T0 ))
  if [ "${EXIT:-1}" = "124" ]; then STATUS="FAILED (timeout ${TIMEOUT_SECS}s)"; log "${AGENT_NAME} -p TIMED OUT after ${WALL}s"
  else STATUS="FAILED (exit ${EXIT:-1})"; log "${AGENT_NAME} -p exited non-zero (${EXIT:-1}) after ${WALL}s"; fi
fi

# ── Classify result ──────────────────────────────────────────────────────────
HAS_RECORD=0
grep -qE "\"date\"[[:space:]]*:[[:space:]]*\"${TARGET}\"" "$DECISIONS" 2>/dev/null && HAS_RECORD=1
if [ "$STATUS" = "OK" ] && [ "$HAS_RECORD" -eq 0 ]; then
  # Clean exit but no audit record → almost always a no-activity no-op.
  STATUS="OK (no activity — nothing to compile)"
fi

# ── Distiller-output groundedness eval (l13.9) ───────────────────────────────
# Deterministic, diagnostic, non-gating. Only meaningful when tonight actually
# produced a record.
if [ "$HAS_RECORD" -eq 1 ]; then
  run_distiller_eval
else
  DISTILLER_EVAL_SUMMARY="Distiller eval: skipped (no record for ${TARGET})."
fi

# ── Review the team's quarantined inbox (jfv.8 / 014-AT-DECR) ─────────────────
# After compiling my own day, review the team's held proposals. Best-effort — a
# review failure never changes the compile STATUS (the brain is already updated).
run_inbox_review

# ── Consecutive-failure escalation ───────────────────────────────────────────
CONSEC=0
while IFS= read -r f; do
  if grep -qE "FAILED|TIMED OUT|FATAL" "$f" 2>/dev/null; then CONSEC=$((CONSEC+1)); else break; fi
done < <(find "$LOG_DIR" -maxdepth 1 -name 'run-*.log' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -10 | awk '{print $2}')
ESC_PREFIX=""; ESC_PRIO="default"
case "$STATUS" in FAILED*) [ "$CONSEC" -ge 3 ] && { ESC_PREFIX="🚨 ${CONSEC}-DAY STREAK: "; ESC_PRIO="max"; } ;; esac

# Self-management footer: graduation banner, or soak progress (no manual flip).
GRAD_NOTE=""; SOAK_NOTE=""
if [ "$GRADUATED" -eq 1 ]; then
  GRAD_NOTE="🎓 Self-graduated to AUTO-PROMOTE this run (soak met). Nothing to do — the brain updates itself nightly from here."
elif [ "$MODE" = "digest" ] && [ "$MODE_SRC" != "env-override" ] && [ "$CLEAN_DIGESTS" != "n/a" ]; then
  SOAK_NOTE="Self-managed rollout: ${CLEAN_DIGESTS}/${SOAK_NIGHTS} clean digest nights banked. It auto-promotes on its own once the soak is met — nothing for you to flip."
fi

# ── Email: the digest (preferred) or the log tail ────────────────────────────
if [ -f "$DIGEST" ]; then
  BODY="$(cat "$DIGEST")

--------------------------------------------------------------------------------
Run: ${STATUS} · ${WALL}s · mode=${MODE} · agent=${AGENT_NAME} · full log: ${LOG}
${DISTILLER_EVAL_SUMMARY}
${REVIEW_SUMMARY}
${GRAD_NOTE}${SOAK_NOTE}"
  SUBJECT="${ESC_PREFIX}teamkb-compile ${TARGET} (${MODE}) — ${STATUS}"
else
  BODY="teamkb-compile ${TARGET} (mode=${MODE}, agent=${AGENT_NAME}) — ${STATUS}
No digest file was written ($DIGEST). Likely no activity, or the run failed before Phase 5.
${DISTILLER_EVAL_SUMMARY}
${REVIEW_SUMMARY}

Last 50 log lines (full log: ${LOG}):
================================================================================
$(tail -50 "$LOG" 2>/dev/null)"
  SUBJECT="${ESC_PREFIX}teamkb-compile ${TARGET} (${MODE}) — ${STATUS}"
fi

if command -v node >/dev/null 2>&1 && [ -f "$EMAIL_SCRIPT" ]; then
  node "$EMAIL_SCRIPT" --to "$EMAIL_TO" --subject "$SUBJECT" --body "$BODY" >> "$LOG" 2>&1 \
    || log "Email send failed — see log"
fi

# ── ntfy status push (content stays in the email) ────────────────────────────
NTFY_TOPIC=$(cat "$NTFY_TOPIC_FILE" 2>/dev/null)
if [ -n "$NTFY_TOPIC" ]; then
  case "$STATUS" in
    OK*) _t="teamkb-compile ${MODE} OK"; [ "$GRADUATED" -eq 1 ] && _t="🎓 teamkb-compile graduated → AUTO"
         curl -s -H "Title: ${_t}" -H "Priority: default" -H "Tags: brain" \
           -d "${TARGET}: ${STATUS}${GRAD_NOTE:+ — ${GRAD_NOTE}}" "https://ntfy.sh/$NTFY_TOPIC" >> "$LOG" 2>&1 || true ;;
    *)   _p="high"; [ "$ESC_PRIO" = "max" ] && _p="max"
         curl -s -H "Title: ${ESC_PREFIX}teamkb-compile FAILED" -H "Priority: ${_p}" -H "Tags: rotating_light" \
           -d "${TARGET}: ${STATUS} (${CONSEC}-day streak). Log: $LOG" "https://ntfy.sh/$NTFY_TOPIC" >> "$LOG" 2>&1 || true ;;
  esac
fi

NOTIFIED=1
log "=== teamkb-compile-daily end (${STATUS}) ==="
# .ok only on genuine success (rc 0 path). Independent of heartbeat.
case "$STATUS" in
  OK*)
    : > "$_BEATDIR/teamkb-compile-daily.ok" 2>/dev/null || true
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
