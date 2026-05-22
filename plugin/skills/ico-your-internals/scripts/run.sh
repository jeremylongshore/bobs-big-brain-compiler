#!/usr/bin/env bash
# run.sh — orchestrate a dog-food session.
#
# Usage:
#   run.sh --target <path> --bank <bank.yaml> [--repo-root <path>] [--dry]
#
# Creates:
#   ~/.cache/ico-your-internals/runs/<run-id>/workspace/      (ICO writes here)
#   ~/.cache/ico-your-internals/runs/<run-id>/receipts.jsonl  (raw Q/A — local only)
#   ~/.cache/ico-your-internals/runs/<run-id>/friction.jsonl  (errors)
#
# The skill's verify.py + render-summary.py turn these into the public
# artifacts in <repo-root>/dogfood/runs/<run-id>/.

set -euo pipefail

usage() {
  cat <<EOF >&2
usage: $(basename "$0") --target <path> --bank <bank.yaml> [--repo-root <path>] [--dry]

  --target     Absolute or ~-relative path to the project being dog-fooded.
  --bank       Path to a question-bank YAML.
  --repo-root  Path to the intentional-cognition-os repo root.
               Defaults to the parent of this script's plugin/ directory.
  --dry        Plan + budget estimate only; no Claude calls, no writes.
EOF
  exit 2
}

# --- args ---
TARGET="" BANK="" REPO_ROOT="" DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)    TARGET="$2"; shift 2 ;;
    --bank)      BANK="$2"; shift 2 ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --dry)       DRY=1; shift ;;
    -h|--help)   usage ;;
    *)           echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -n "$TARGET" ] && [ -n "$BANK" ] || usage

# Resolve script dir / repo root if not given
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$REPO_ROOT" ]; then
  # plugin/skills/ico-your-internals/scripts/run.sh → ../../../../ = repo root
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
fi
TARGET="$(cd "$TARGET" 2>/dev/null && pwd)" || { echo "target not found: $TARGET" >&2; exit 1; }
BANK="$(realpath "$BANK")" || { echo "bank not found: $BANK" >&2; exit 1; }

# --- preflight ---
echo "[ico-your-internals] preflight…" >&2
command -v ico >/dev/null   || { echo "ico not installed. npm install -g intentional-cognition-os" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }
command -v jq >/dev/null      || { echo "jq required" >&2; exit 1; }
[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "ANTHROPIC_API_KEY not set" >&2; exit 1; }

# Bank shape check — must declare a non-empty questions list
if ! python3 -c "
import sys, yaml, pathlib
data = yaml.safe_load(pathlib.Path(r'$BANK').read_text())
qs = data.get('questions') or []
if not qs:
    print('bank has no questions — author them per the YAML schema', file=sys.stderr)
    sys.exit(3)
" 2>&1; then
  echo "bank validation failed" >&2
  exit 3
fi

# --- ids and paths ---
# IMPORTANT: pipe the basename through `printf %s` to strip its trailing
# newline BEFORE the tr pipeline. Without that, `tr -cs 'a-z0-9' '-'`
# converts the newline to a trailing dash, contaminating the slug and the
# run-id (e.g. "intent-eval-core" → "intent-eval-core-" → run id has
# "intent-eval-core--v1" with a double dash). Caught in the v0.1 first
# real run; the regression test in tests/test_run_sh.sh pins this.
TARGET_SLUG="$(printf '%s' "$(basename "$TARGET")" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
# Trim trailing dashes that can still result from leading/trailing
# non-alphanum bytes in oddly-named target dirs.
TARGET_SLUG="${TARGET_SLUG%-}"
TARGET_SLUG="${TARGET_SLUG#-}"

BANK_VERSION="$(grep -E '^version:' "$BANK" | head -1 | awk '{print $2}' | tr -d '\"')"
TS="$(date -u +%Y-%m-%dT%H%MZ)"
RUN_ID="${TS}-${TARGET_SLUG}-${BANK_VERSION:-vX}"
CACHE_ROOT="$HOME/.cache/ico-your-internals/runs/$RUN_ID"
# `ico init <name> --path <parent>` creates the workspace at
# <parent>/<name>/, NOT at <parent>/workspace/. WS must match where ico
# actually puts it, otherwise downstream --workspace pointers miss the
# state.db and every command fails with "Cannot open database".
WS="$CACHE_ROOT/$TARGET_SLUG"
PUB_DIR="$REPO_ROOT/dogfood/runs/$RUN_ID"

mkdir -p "$CACHE_ROOT" "$PUB_DIR"

# --- budget estimate ---
echo "[ico-your-internals] estimating budget…" >&2
BUDGET_JSON="$("$SCRIPT_DIR/estimate-budget.sh" "$TARGET" "$BANK")"
echo "$BUDGET_JSON" | tee "$CACHE_ROOT/budget.json" >&2

if [ "$DRY" -eq 1 ]; then
  echo "[ico-your-internals] --dry: stopping after budget estimate" >&2
  echo "{\"run_id\":\"$RUN_ID\",\"target\":\"$TARGET\",\"bank\":\"$BANK\",\"workspace\":\"$WS\",\"dry\":true}"
  exit 0
fi

# --- manifest ---
cat > "$CACHE_ROOT/manifest.json" <<EOF
{
  "run_id": "$RUN_ID",
  "target": "$TARGET",
  "target_slug": "$TARGET_SLUG",
  "bank_path": "$BANK",
  "bank_version": "${BANK_VERSION:-unknown}",
  "ico_version": "$(ico --version 2>/dev/null || echo unknown)",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "workspace": "$WS",
  "public_dir": "$PUB_DIR"
}
EOF
cp "$CACHE_ROOT/manifest.json" "$PUB_DIR/manifest.json"

# --- ingest + compile ---
# IMPORTANT: --workspace is a GLOBAL flag on `ico`, not a subcommand option.
# Order matters: `ico --workspace <ws> <subcommand> <args>` works;
# `ico <subcommand> <args> --workspace <ws>` is silently ignored, and ico
# falls back to looking for a default workspace which doesn't exist.
# Caught in the v0.1 first real run; reflected in the constant below.

echo "[ico-your-internals] ico init + mount + ingest…" >&2
ico init "$TARGET_SLUG" --path "$CACHE_ROOT" || {
  jq -nc --arg msg "ico init failed" --arg stage init --arg run "$RUN_ID" \
    '{run_id:$run, stage:$stage, severity:"error", message:$msg, recommend_bead:true}' \
    >> "$PUB_DIR/friction.jsonl"
  exit 1
}

# ico mount add — read-only intent (mount records a pointer; does not copy)
ico --workspace "$WS" mount add target "$TARGET" || {
  jq -nc --arg msg "ico mount add failed" --arg stage mount --arg run "$RUN_ID" \
    '{run_id:$run, stage:$stage, severity:"error", message:$msg, recommend_bead:true}' \
    >> "$PUB_DIR/friction.jsonl"
  exit 1
}

# ico ingest accepts a single file at a time. For a directory of .md files,
# walk and ingest each. Skips non-.md (PDFs/web-clips would need adapter
# config beyond v0.1 scope).
while IFS= read -r -d '' f; do
  ico --workspace "$WS" ingest "$f" --yes 2>> "$CACHE_ROOT/ingest.stderr" || {
    jq -nc --arg msg "ico ingest failed on $f" --arg stage ingest --arg run "$RUN_ID" --arg file "$f" \
      '{run_id:$run, stage:$stage, severity:"warning", message:$msg, file:$file, recommend_bead:false}' \
      >> "$PUB_DIR/friction.jsonl"
  }
done < <(find "$TARGET" -type f -name "*.md" \
  -not -path "*/node_modules/*" -not -path "*/.git/*" \
  -not -path "*/dist/*" -not -path "*/coverage/*" \
  -print0)

# `ico compile` does NOT accept "all" — it takes one of:
# sources | concepts | topics | links | contradictions | gaps
# Loop through the 6 passes in order. Each pass depends on its predecessor.
echo "[ico-your-internals] ico compile (6 passes)…" >&2
for pass in sources concepts topics links contradictions gaps; do
  echo "[ico-your-internals]   pass: $pass" >&2
  ico --workspace "$WS" compile "$pass" 2>> "$CACHE_ROOT/compile.stderr" || {
    msg="$(tail -1 "$CACHE_ROOT/compile.stderr" 2>/dev/null || echo "ico compile $pass failed")"
    jq -nc --arg msg "$msg" --arg stage compile --arg pass "$pass" --arg run "$RUN_ID" \
      '{run_id:$run, stage:$stage, pass:$pass, severity:"error", message:$msg, recommend_bead:true}' \
      >> "$PUB_DIR/friction.jsonl"
    exit 1
  }
done

# --- ask loop ---
echo "[ico-your-internals] ask loop…" >&2

python3 - "$BANK" "$WS" "$CACHE_ROOT" "$PUB_DIR" "$RUN_ID" <<'PY'
import json, pathlib, subprocess, sys, time, yaml

bank_path, ws, cache_root, pub_dir, run_id = sys.argv[1:6]
bank = yaml.safe_load(pathlib.Path(bank_path).read_text())

receipts_path = pathlib.Path(cache_root) / "receipts.jsonl"
friction_path = pathlib.Path(pub_dir) / "friction.jsonl"

for q in bank.get("questions", []):
    q_id = q["id"]
    question = q["question"]
    started = time.time()
    try:
        # IMPORTANT: --workspace and --json are GLOBAL flags. They go BEFORE
        # the subcommand. `ico ask "..." --workspace ... --json` silently
        # drops both flags and falls back to defaults.
        result = subprocess.run(
            ["ico", "--workspace", ws, "--json", "ask", question],
            capture_output=True, text=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        friction_path.open("a").write(json.dumps({
            "run_id": run_id, "q_id": q_id, "stage": "ask",
            "severity": "error", "message": "ico ask timed out (>180s)",
            "recommend_bead": True,
        }) + "\n")
        continue
    elapsed_ms = int((time.time() - started) * 1000)

    if result.returncode != 0:
        friction_path.open("a").write(json.dumps({
            "run_id": run_id, "q_id": q_id, "stage": "ask",
            "severity": "error",
            "message": (result.stderr or "ico ask non-zero exit").strip().splitlines()[-1],
            "exit_code": result.returncode, "recommend_bead": True,
        }) + "\n")
        continue

    # Parse the JSON response. The exact shape depends on ico's --json output;
    # the receipt below is defensive against unknown fields.
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        friction_path.open("a").write(json.dumps({
            "run_id": run_id, "q_id": q_id, "stage": "ask",
            "severity": "error", "message": "ico ask returned non-JSON stdout",
            "recommend_bead": True,
        }) + "\n")
        continue

    receipt = {
        "run_id": run_id,
        "q_id": q_id,
        "question": question,
        "answer": payload.get("answer", ""),
        "citations": payload.get("citations", []),
        "trace_correlation_id": payload.get("correlation_id"),
        "tokens_in": payload.get("tokens_in"),
        "tokens_out": payload.get("tokens_out"),
        "latency_ms": elapsed_ms,
        "model": payload.get("model"),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "expected_substrings": q.get("expected_substrings", []),
        "expected_sources": q.get("expected_sources", []),
    }
    receipts_path.open("a").write(json.dumps(receipt) + "\n")
PY

echo "[ico-your-internals] receipts written → $CACHE_ROOT/receipts.jsonl" >&2
echo "[ico-your-internals] next: $SCRIPT_DIR/verify.py $RUN_ID" >&2
echo "{\"run_id\":\"$RUN_ID\",\"cache_root\":\"$CACHE_ROOT\",\"public_dir\":\"$PUB_DIR\",\"status\":\"receipts_written\"}"
