#!/usr/bin/env bash
# Build and install ICO as a commit-addressed, independently restartable release.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_ROOT="${ICO_INSTALL_ROOT:-$HOME/.local/opt/ico}"
BIN_DIR="${ICO_BIN_DIR:-$HOME/.local/bin}"

for command_name in git jq npm pnpm; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "FATAL: required command is missing: $command_name" >&2
    exit 1
  }
done

cd "$REPO_ROOT"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "FATAL: install only from a committed tree" >&2
  exit 1
fi

commit_sha="$(git rev-parse HEAD)"
release_dir="$INSTALL_ROOT/releases/$commit_sha"
mkdir -p "$INSTALL_ROOT/releases" "$BIN_DIR"

stage_dir="$(mktemp -d "$INSTALL_ROOT/.install-${commit_sha:0:12}.XXXXXX")"
candidate_dir="$INSTALL_ROOT/releases/.${commit_sha}.candidate-$$"
cleanup() {
  if [ -d "$stage_dir" ]; then
    find "$stage_dir" -depth -delete 2>/dev/null || true
  fi
  if [ -d "$candidate_dir" ]; then
    find "$candidate_dir" -depth -delete 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [ ! -x "$release_dir/node_modules/.bin/ico" ]; then
  pnpm build
  pnpm --dir packages/cli pack --pack-destination "$stage_dir" >/dev/null
  package_tarball="$(find "$stage_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
  [ -n "$package_tarball" ] || {
    echo "FATAL: pnpm pack did not produce a tarball" >&2
    exit 1
  }

  mkdir -p "$candidate_dir"
  # npm 12 blocks dependency install scripts unless the root project records an
  # approval. better-sqlite3 is the one reviewed native dependency in this
  # package; pin the approval and fail if any new script-bearing dependency
  # appears instead of silently producing a CLI that cannot open its database.
  jq -n \
    '{private:true,allowScripts:{"better-sqlite3@11.10.0":true}}' \
    > "$candidate_dir/package.json"
  npm install \
    --package-lock=false \
    --omit=dev \
    --strict-allow-scripts \
    --prefix "$candidate_dir" \
    "$package_tarball" >/dev/null

  candidate_bin="$candidate_dir/node_modules/.bin/ico"
  [ -x "$candidate_bin" ] || {
    echo "FATAL: candidate ICO binary is missing" >&2
    exit 1
  }
  "$candidate_bin" --version >/dev/null
  "$candidate_bin" maintain --help >/dev/null
  preflight_parent="$stage_dir/database-preflight"
  mkdir -p "$preflight_parent"
  "$candidate_bin" init package-smoke --path "$preflight_parent" >/dev/null
  "$candidate_bin" --workspace "$preflight_parent/package-smoke" status >/dev/null
  if find "$candidate_dir" -type f -name package.json -size 0 -print -quit | grep -q .; then
    echo "FATAL: candidate contains a zero-byte package manifest" >&2
    exit 1
  fi

  jq -n \
    --arg commit "$commit_sha" \
    --arg installedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg packageVersion "$($candidate_bin --version)" \
    '{schemaVersion:1,commit:$commit,installedAt:$installedAt,packageVersion:$packageVersion}' \
    > "$candidate_dir/release.json"
  mv "$candidate_dir" "$release_dir"
fi

"$release_dir/node_modules/.bin/ico" --version >/dev/null
"$release_dir/node_modules/.bin/ico" --help >/dev/null

current_tmp="$INSTALL_ROOT/.current-$$"
bin_tmp="$BIN_DIR/.ico-$$"
ln -s "$release_dir" "$current_tmp"
mv -Tf "$current_tmp" "$INSTALL_ROOT/current"
ln -s "$INSTALL_ROOT/current/node_modules/.bin/ico" "$bin_tmp"
mv -Tf "$bin_tmp" "$BIN_DIR/ico"

installed_version="$("$BIN_DIR/ico" --version)"
echo "Installed ICO $installed_version from $commit_sha"
echo "Binary: $BIN_DIR/ico"
echo "Release: $release_dir"
