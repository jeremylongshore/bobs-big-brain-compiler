#!/usr/bin/env bash
# run-golden-corpus.sh — real six-pass compile-quality evidence run.
#
# This is intentionally a workflow_dispatch-only lane. Unit tests exercise the
# compiler with mocked Claude clients; this runner exercises the shipped CLI
# against the committed populated fixture and asks the live provider to score
# the resulting source, concept, and topic pages.
#
# The runner fails closed when MINIMAX_API_KEY is missing. A missing secret is
# an infrastructure failure, never an honest-looking skipped quality result.
# The key is passed only to child processes and is never written to the receipt.
set -uo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$REPO/packages/cli/dist/index.js"
FIXTURE="$REPO/tests/fixtures/populated/raw"
TIMEOUT_SECONDS="${GOLDEN_CORPUS_TIMEOUT:-1800}"
PROVIDER="${ICO_PROVIDER:-minimax}"
MODEL="${ICO_MODEL:-MiniMax-M3}"
BATCH_SIZE="${GOLDEN_CORPUS_BATCH_SIZE:-5}"
MAX_TOKENS="${GOLDEN_CORPUS_MAX_TOKENS:-8000}"
SOPS_FILE="${GOLDEN_CORPUS_SOPS_FILE:-}"

if [ -n "${GOLDEN_CORPUS_ROOT:-}" ]; then
  RUN_ROOT="$GOLDEN_CORPUS_ROOT"
  mkdir -p "$RUN_ROOT"
else
  RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ico-golden-corpus.XXXXXX")"
fi

WORKSPACE="$RUN_ROOT/golden-corpus"
RECEIPT="$RUN_ROOT/golden-corpus-receipt.json"
MANIFEST="$RUN_ROOT/evals.tsv"
mkdir -p "$RUN_ROOT"
: > "$MANIFEST"

KEY="${MINIMAX_API_KEY:-}"
if [ -z "$KEY" ] && [ -n "$SOPS_FILE" ] && [ -r "$SOPS_FILE" ] && command -v sops >/dev/null 2>&1; then
  KEY="$(sops -d --input-type dotenv --output-type dotenv "$SOPS_FILE" 2>/dev/null \
    | sed -n 's/^MINIMAX_API_KEY=//p' | head -n 1)"
fi

write_failure_receipt() {
  local failure="$1"
  node --input-type=module - "$RECEIPT" "$failure" "$PROVIDER" "$MODEL" "$RUN_ROOT" <<'NODE'
import { writeFileSync } from 'node:fs';

const [receipt, failure, provider, model, runRoot] = process.argv.slice(2);
writeFileSync(
  receipt,
  JSON.stringify(
    {
      schema_version: 1,
      status: 'failed',
      failure,
      provider,
      model,
      fixture: 'tests/fixtures/populated/raw',
      run_root: runRoot,
      evals: [],
    },
    null,
    2,
  ) + '\n',
  'utf8',
);
NODE
}

if [ "$PROVIDER" != "minimax" ]; then
  echo "[golden-corpus] refusing provider=$PROVIDER; this lane is pinned to MiniMax-M3" >&2
  write_failure_receipt "unsupported-provider"
  exit 2
fi

if [ -z "$KEY" ]; then
  echo "[golden-corpus] MINIMAX_API_KEY is required; refusing to report a skipped quality run" >&2
  write_failure_receipt "missing-provider-key"
  exit 2
fi

if [ ! -x "$(command -v node)" ] || [ ! -f "$CLI" ]; then
  echo "[golden-corpus] built CLI not found at $CLI" >&2
  write_failure_receipt "missing-built-cli"
  exit 2
fi

if [ ! -d "$FIXTURE" ]; then
  echo "[golden-corpus] fixture directory not found at $FIXTURE" >&2
  write_failure_receipt "missing-fixture"
  exit 2
fi

set +e
node "$CLI" init golden-corpus --path "$RUN_ROOT" > "$RUN_ROOT/init.stdout" 2> "$RUN_ROOT/init.stderr"
INIT_RC=$?
set -e
cat "$RUN_ROOT/init.stdout"
[ ! -s "$RUN_ROOT/init.stderr" ] || cat "$RUN_ROOT/init.stderr" >&2

INGEST_RC=2
if [ "$INIT_RC" -eq 0 ]; then
  set +e
  node "$CLI" --workspace "$WORKSPACE" ingest "$FIXTURE" --yes \
    > "$RUN_ROOT/ingest.stdout" 2> "$RUN_ROOT/ingest.stderr"
  INGEST_RC=$?
  set -e
  cat "$RUN_ROOT/ingest.stdout"
  [ ! -s "$RUN_ROOT/ingest.stderr" ] || cat "$RUN_ROOT/ingest.stderr" >&2
fi

COMPILE_RC=2
if [ "$INIT_RC" -eq 0 ] && [ "$INGEST_RC" -eq 0 ]; then
  set +e
  env MINIMAX_API_KEY="$KEY" \
    ICO_PROVIDER=minimax \
    ICO_PROVIDER_WIRE="${ICO_PROVIDER_WIRE:-anthropic}" \
    ICO_BASE_URL="${ICO_BASE_URL:-https://api.minimax.io/anthropic}" \
    ICO_MODEL="$MODEL" \
    ICO_BATCH_SIZE="$BATCH_SIZE" \
    MAX_TOKENS_PER_OPERATION="$MAX_TOKENS" \
    timeout "$TIMEOUT_SECONDS" node "$CLI" --workspace "$WORKSPACE" compile all \
    > "$RUN_ROOT/compile.stdout" 2> "$RUN_ROOT/compile.stderr"
  COMPILE_RC=$?
  set -e
  cat "$RUN_ROOT/compile.stdout"
  [ ! -s "$RUN_ROOT/compile.stderr" ] || cat "$RUN_ROOT/compile.stderr" >&2
fi

pick_target() {
  local subdir="$1"
  local preferred="$2"
  if [ -f "$WORKSPACE/wiki/$subdir/$preferred" ]; then
    printf '%s/%s\n' "$subdir" "$preferred"
    return 0
  fi
  find "$WORKSPACE/wiki/$subdir" -maxdepth 1 -type f -name '*.md' -printf '%s/%f\n' "$subdir" \
    2>/dev/null | sort | head -n 1
}

run_eval() {
  local pass="$1"
  local source_spec="$2"
  local target="$3"
  local eval_id="$4"
  local temp_spec="$RUN_ROOT/${eval_id}.eval.yaml"
  local output="$RUN_ROOT/${eval_id}.json"
  local error="$RUN_ROOT/${eval_id}.stderr"

  # target is selected from compiler output and contains only a wiki-relative
  # path. Reusing the committed spec keeps the rubric authoritative while
  # avoiding a brittle dependency on a model's exact concept/topic title.
  sed "s|^target_page: .*|target_page: $target|" "$source_spec" > "$temp_spec"

  set +e
  env MINIMAX_API_KEY="$KEY" \
    ICO_PROVIDER=minimax \
    ICO_PROVIDER_WIRE="${ICO_PROVIDER_WIRE:-anthropic}" \
    ICO_BASE_URL="${ICO_BASE_URL:-https://api.minimax.io/anthropic}" \
    ICO_MODEL="$MODEL" \
    MAX_TOKENS_PER_OPERATION="$MAX_TOKENS" \
    timeout "$TIMEOUT_SECONDS" node "$CLI" --workspace "$WORKSPACE" --json eval run \
    --spec "$temp_spec" > "$output" 2> "$error"
  local rc=$?
  set -e
  if [ -s "$output" ]; then
    cat "$output"
  fi
  if [ -s "$error" ]; then
    cat "$error" >&2
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$pass" "$target" "$output" "$error" "$rc" >> "$MANIFEST"
  return 0
}

if [ "$COMPILE_RC" -eq 0 ]; then
  summarize_target="$(pick_target sources sample-article.md)"
  extract_target="$(pick_target concepts knowledge-compilation.md)"
  synthesize_target="$(pick_target topics knowledge-compilation-as-a-category-defining-operation.md)"

  if [ -n "$summarize_target" ]; then
    run_eval summarize "$REPO/evals/compilation-quality/summarize-attention.eval.yaml" \
      "$summarize_target" compile-summarize-attention-001
  fi
  if [ -n "$extract_target" ]; then
    run_eval extract "$REPO/evals/compilation-quality/extract-concepts.eval.yaml" \
      "$extract_target" compile-extract-concept-001
  fi
  if [ -n "$synthesize_target" ]; then
    run_eval synthesize "$REPO/evals/compilation-quality/synthesize-topic.eval.yaml" \
      "$synthesize_target" compile-synthesize-topic-001
  fi
fi

set +e
node --input-type=module - "$RECEIPT" "$MANIFEST" "$INIT_RC" "$INGEST_RC" "$COMPILE_RC" \
  "$PROVIDER" "$MODEL" "$RUN_ROOT" "$WORKSPACE" <<'NODE'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [receiptPath, manifestPath, initRaw, ingestRaw, compileRaw, provider, model, runRoot, workspace] =
  process.argv.slice(2);
const phase = {
  init: Number(initRaw),
  ingest: Number(ingestRaw),
  compile: Number(compileRaw),
};

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function countWikiPages() {
  const counts = {};
  const wiki = join(workspace, 'wiki');
  if (!existsSync(wiki)) return counts;
  for (const entry of readdirSync(wiki, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(wiki, entry.name);
    counts[entry.name] = readdirSync(dir).filter((name) => {
      try {
        return name.endsWith('.md') && statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    }).length;
  }
  return counts;
}

function readCompileIntegrity() {
  const stdout = existsSync(join(runRoot, 'compile.stdout'))
    ? readFileSync(join(runRoot, 'compile.stdout'), 'utf8')
    : '';
  const stderr = existsSync(join(runRoot, 'compile.stderr'))
    ? readFileSync(join(runRoot, 'compile.stderr'), 'utf8')
    : '';
  const output = `${stdout}\n${stderr}`;
  return {
    truncation_warnings: (output.match(/response hit the \d+-token ceiling/g) ?? []).length,
    validation_skip_warnings: (output.match(/model-emitted page\(s\) failed deterministic validation/g) ?? [])
      .length,
  };
}

const evals = [];
if (existsSync(manifestPath)) {
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const [pass, target, output, error, rcRaw] = line.split('\t');
    const parsed = loadJson(output);
    const result = parsed?.batch?.results?.[0] ?? null;
    evals.push({
      pass,
      target_page: target,
      exit_code: Number(rcRaw),
      result,
      stderr_path: error,
    });
  }
}

const phaseFailed = Object.values(phase).some((rc) => rc !== 0);
const compileIntegrity = readCompileIntegrity();
const compileIntegrityFailed =
  compileIntegrity.truncation_warnings > 0 || compileIntegrity.validation_skip_warnings > 0;
const evalInfrastructureFailed = evals.length !== 3 || evals.some((entry) => entry.result === null);
const qualityFailed = evals.some((entry) => entry.result?.passed !== true);
const status =
  phaseFailed || compileIntegrityFailed || evalInfrastructureFailed || qualityFailed
    ? 'failed'
    : 'passed';
const failure = phaseFailed
  ? 'pipeline-phase'
  : compileIntegrityFailed
    ? 'compile-integrity'
  : evalInfrastructureFailed
    ? 'eval-infrastructure'
    : qualityFailed
      ? 'quality-threshold'
      : null;

writeFileSync(
  receiptPath,
  JSON.stringify(
    {
      schema_version: 1,
      status,
      failure,
      provider,
      model,
      provider_wire: 'anthropic',
      fixture: 'tests/fixtures/populated/raw',
      run_root: runRoot,
      workspace,
      phases: phase,
      compile_integrity: compileIntegrity,
      compiled_pages: countWikiPages(),
      evals,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);
process.exit(status === 'passed' ? 0 : 1);
NODE
RECEIPT_RC=$?
set -e

echo "[golden-corpus] receipt: $RECEIPT"
exit "$RECEIPT_RC"
