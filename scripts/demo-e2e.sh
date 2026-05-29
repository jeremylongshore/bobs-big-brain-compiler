#!/usr/bin/env bash
#
# scripts/demo-e2e.sh — end-to-end proof-of-work demo for the
# Compile-Then-Govern architecture (ICO → INTKB → qmd → audit verify).
#
# Drives the full chain against a sample corpus, captures per-stage timing
# and pass/fail in a machine-readable JSON summary, and doubles as the
# nightly CI smoke that prevents regression of any link in the chain.
#
# Per the bead description (intentional-cognition-os-1at), the 7 stages are:
#   1. ICO init + mount + ingest sample corpus
#   2. ICO compile all (6 compiler passes)
#   3. ICO spool emit (writes JSONL to spool dir)
#   4. INTKB curator-cli ingest (ingest → policy → promote, cross-repo wire)
#   5. INTKB edge-daemon sync to qmd index
#   6. qmd MCP query returns curated memory with source citation
#   7. ICO audit verify confirms hash chain intact
#
# Stages 5 and 6 are currently DEFERRED — they depend on bead 9jx (INTKB
# curator CLI) shipping a clean entry point. v1 of this demo exercises
# stages 1-4 + 7 end-to-end and reports 5-6 as `deferred` in the JSON
# summary. When 9jx lands, those stages get wired and this comment block
# updates accordingly.
#
# Usage:
#   scripts/demo-e2e.sh                              # run with defaults
#   scripts/demo-e2e.sh --corpus /path/to/corpus     # override sample corpus
#   scripts/demo-e2e.sh --intkb-repo /path/to/intkb  # override INTKB clone
#   scripts/demo-e2e.sh --keep                       # keep workspace/spool tmpdirs
#
# Exit codes:
#   0 — all non-deferred stages passed
#   1 — at least one non-deferred stage failed
#   2 — preflight check failed (missing deps, bad paths)

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults (env- and flag-overridable)
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_CORPUS="$REPO_ROOT/dogfood/experiments/compile-vs-rag/corpus"
DEFAULT_INTKB="${HOME}/000-projects/qmd-team-intent-kb"

CORPUS="${DEMO_CORPUS:-$DEFAULT_CORPUS}"
INTKB_REPO="${INTKB_REPO:-$DEFAULT_INTKB}"
TENANT_ID="${TENANT_ID:-demo-e2e}"
KEEP_TMP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus)       CORPUS="$2"; shift 2 ;;
    --intkb-repo)   INTKB_REPO="$2"; shift 2 ;;
    --tenant)       TENANT_ID="$2"; shift 2 ;;
    --keep)         KEEP_TMP=1; shift ;;
    -h|--help)
      sed -n '3,28p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

RUN_ID="demo-$(date -u +%Y-%m-%dT%H%M%SZ)"
RUN_DIR="$REPO_ROOT/dogfood/runs/$RUN_ID"
SUMMARY_JSON="$RUN_DIR/summary.json"
LOG_FILE="$RUN_DIR/log.txt"
mkdir -p "$RUN_DIR"

# Workspace + spool live outside the repo in tmp — never pollute the tree.
# Spool dir must be INSIDE the workspace per ICO's --out path-safety check
# (refuses out-of-workspace paths unless TEAMKB_HOME is set).
WORKSPACE="$(mktemp -d -t ico-demo-ws-XXXXXX)"
WS_PATH="$WORKSPACE/demo"
SPOOL_DIR="$WS_PATH/spool"

# Cleanup unless --keep
cleanup() {
  local rc=$?
  if [[ "$KEEP_TMP" -eq 0 ]]; then
    rm -rf "$WORKSPACE"
  else
    echo "[demo-e2e] workspace preserved at $WORKSPACE" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Stage harness — accumulates per-stage status into JSON
# ---------------------------------------------------------------------------

STAGES_JSON="[]"
OVERALL_RC=0
# Once any stage fails, downstream stages are marked `skip` rather than
# attempted — running compile after init failed produces meaningless errors.
FAILED_STAGE=""

# Append a stage result to STAGES_JSON. Args:
#   $1 — stage_id (1..7)
#   $2 — stage_name
#   $3 — status (pass|fail|deferred|skip)
#   $4 — duration_ms (integer)
#   $5 — detail (one-line summary or error message)
record_stage() {
  local id="$1" name="$2" status="$3" dur="$4" detail="$5"
  local entry
  entry=$(jq -n \
    --arg id "$id" \
    --arg name "$name" \
    --arg status "$status" \
    --argjson dur "$dur" \
    --arg detail "$detail" \
    '{id: $id, name: $name, status: $status, duration_ms: $dur, detail: $detail}')
  STAGES_JSON=$(echo "$STAGES_JSON" | jq --argjson e "$entry" '. + [$e]')
  if [[ "$status" == "fail" ]]; then
    OVERALL_RC=1
  fi
}

# Run a stage. Args:
#   $1 — stage_id
#   $2 — stage_name
#   $3 — command (passed to bash -c)
# Captures stdout+stderr to the run log; records pass/fail with timing.
run_stage() {
  local id="$1" name="$2" cmd="$3"
  local start_ms end_ms detail status
  # If a prior stage failed, skip cleanly with no command attempt.
  if [[ -n "$FAILED_STAGE" ]]; then
    record_stage "$id" "$name" "skip" 0 "skipped — stage $FAILED_STAGE failed upstream"
    echo "[demo-e2e] stage $id ($name): skip (upstream stage $FAILED_STAGE failed)"
    return 0
  fi
  echo "==[ stage $id: $name ]==" >> "$LOG_FILE"
  start_ms=$(date +%s%3N)
  if bash -c "$cmd" >> "$LOG_FILE" 2>&1; then
    status="pass"
    detail="ok"
  else
    status="fail"
    detail="see $LOG_FILE — last 5 lines: $(tail -5 "$LOG_FILE" | tr '\n' '|')"
    FAILED_STAGE="$id"
  fi
  end_ms=$(date +%s%3N)
  record_stage "$id" "$name" "$status" "$((end_ms - start_ms))" "$detail"
  echo "[demo-e2e] stage $id ($name): $status ($((end_ms - start_ms))ms)"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

preflight() {
  local missing=()
  command -v jq >/dev/null 2>&1 || missing+=("jq")
  command -v node >/dev/null 2>&1 || missing+=("node")
  command -v pnpm >/dev/null 2>&1 || missing+=("pnpm")

  if [[ ! -f "$REPO_ROOT/packages/cli/dist/index.js" ]]; then
    missing+=("ICO CLI not built — run 'pnpm build' first")
  fi
  if [[ ! -d "$CORPUS" ]]; then
    missing+=("corpus dir not found: $CORPUS")
  fi
  if [[ ! -d "$INTKB_REPO" ]]; then
    missing+=("INTKB repo not found: $INTKB_REPO (set INTKB_REPO env var)")
  fi
  if [[ ! -f "$INTKB_REPO/apps/curator/dist/index.js" ]]; then
    missing+=("INTKB curator not built — run 'pnpm -F @qmd-team-intent-kb/curator build' in $INTKB_REPO")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "[demo-e2e] preflight failed:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    exit 2
  fi
}
preflight

ICO="node $REPO_ROOT/packages/cli/dist/index.js"

# ---------------------------------------------------------------------------
# Stage 1 — ICO init + mount + ingest
# ---------------------------------------------------------------------------

run_stage 1 "ico init + mount + ingest" "
  $ICO init demo --path '$WORKSPACE' >/dev/null
  $ICO --workspace '$WS_PATH' mount add sample '$CORPUS' >/dev/null
  $ICO --workspace '$WS_PATH' ingest '$CORPUS' --yes >/dev/null
"

# ---------------------------------------------------------------------------
# Stage 2 — ICO compile all 6 passes
# ---------------------------------------------------------------------------

run_stage 2 "ico compile (6 passes)" "
  for pass in sources concepts topics links contradictions gaps; do
    $ICO --workspace '$WS_PATH' compile \$pass >/dev/null
  done
"

# ---------------------------------------------------------------------------
# Stage 3 — ICO spool emit
# ---------------------------------------------------------------------------

run_stage 3 "ico spool emit" "
  $ICO --workspace '$WS_PATH' spool emit \
    --out '$SPOOL_DIR' --scope all --tenant '$TENANT_ID' >/dev/null
  test -n \"\$(ls '$SPOOL_DIR'/spool-*.jsonl 2>/dev/null)\"
"

# ---------------------------------------------------------------------------
# Stage 4 — INTKB curator CLI: ingest → policy → promote (cross-repo wire)
# Drives the full curator pipeline via the curator-cli binary that ships with
# INTKB (bead 9jx). Replaces the v1 inline node helper that only exercised
# ingestFromSpool; this stage now closes ingest + policy + promote in one
# call and emits a structured JSON envelope of the batch results.
# ---------------------------------------------------------------------------

CURATOR_CLI="node $INTKB_REPO/apps/curator/dist/main.js"

run_stage 4 "INTKB curator-cli ingest (ingest → policy → promote, cross-repo wire)" "
  $CURATOR_CLI ingest '$SPOOL_DIR' --tenant '$TENANT_ID' --json > '$RUN_DIR/stage4-curator.json'
  test \"\$(jq -r .ok '$RUN_DIR/stage4-curator.json')\" = 'true'
"

# ---------------------------------------------------------------------------
# Stage 5 — DEFERRED (depends on git-exporter + edge-daemon orchestration)
# Curator now writes curated_memories into the in-memory SQLite. To reach
# the qmd index we'd need a running edge-daemon (apps/edge-daemon) plus the
# git-exporter to mirror curated memories to kb-export/ where qmd can pick
# them up. Wiring that into an unattended demo run is a follow-on bead.
# ---------------------------------------------------------------------------

record_stage 5 "INTKB edge-daemon sync to qmd index" "deferred" 0 \
  "needs edge-daemon + git-exporter orchestration in the demo runner; 9jx unblocked the curator pipeline but the qmd-index hand-off requires a separate harness"
echo "[demo-e2e] stage 5: DEFERRED (edge-daemon + git-exporter harness still TODO)"

# ---------------------------------------------------------------------------
# Stage 6 — DEFERRED (depends on stage 5)
# ---------------------------------------------------------------------------

record_stage 6 "qmd MCP query returns curated memory with citation" "deferred" 0 \
  "blocked on stage 5; will exercise once 9jx ships and curated memories reach qmd index"
echo "[demo-e2e] stage 6: DEFERRED (downstream of stage 5)"

# ---------------------------------------------------------------------------
# Stage 7 — ICO audit verify
# ---------------------------------------------------------------------------

run_stage 7 "ico audit verify (hash chain intact)" "
  $ICO --workspace '$WS_PATH' audit verify --json > '$RUN_DIR/stage7-audit-verify.json'
  test \"\$(jq -r .ok '$RUN_DIR/stage7-audit-verify.json')\" = 'true'
"

# ---------------------------------------------------------------------------
# Emit summary
# ---------------------------------------------------------------------------

jq -n \
  --arg run_id "$RUN_ID" \
  --arg corpus "$CORPUS" \
  --arg intkb_repo "$INTKB_REPO" \
  --arg tenant "$TENANT_ID" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson stages "$STAGES_JSON" \
  --arg overall "$([[ $OVERALL_RC -eq 0 ]] && echo pass || echo fail)" \
  '{
    run_id: $run_id,
    timestamp: $ts,
    corpus: $corpus,
    intkb_repo: $intkb_repo,
    tenant_id: $tenant,
    overall: $overall,
    stages: $stages,
    deferred_count: ($stages | map(select(.status == "deferred")) | length),
    pass_count: ($stages | map(select(.status == "pass")) | length),
    fail_count: ($stages | map(select(.status == "fail")) | length)
  }' > "$SUMMARY_JSON"

echo ""
echo "[demo-e2e] summary written to: $SUMMARY_JSON"
echo "[demo-e2e] full log:           $LOG_FILE"
jq -r '
  "overall:  " + .overall,
  "pass:     " + (.pass_count | tostring),
  "fail:     " + (.fail_count | tostring),
  "deferred: " + (.deferred_count | tostring)
' "$SUMMARY_JSON"

exit "$OVERALL_RC"
