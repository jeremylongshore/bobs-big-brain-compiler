#!/usr/bin/env bash
#
# verify-npm-pack.sh (E10-B10)
#
# Builds the CLI, runs `npm pack` against packages/cli/, and asserts the
# resulting tarball is publishable:
#
#   1. Tarball exists and is non-trivially sized (>50 KB — the bundled
#      compiler + kernel are substantial).
#   2. Contains `package/dist/index.js` with a shebang.
#   3. Contains `package/package.json` with the published name
#      `intentional-cognition-os` and an `ico` bin entry.
#   4. Contains `package/README.md` and `package/LICENSE` so npmjs.com
#      renders the project page correctly.
#
# Exits non-zero with a clear message on any failure. Safe to run as a
# pre-publish smoke check or in CI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
PUBLISHED_NAME="intentional-cognition-os"

echo "→ Building CLI..."
(cd "$REPO_ROOT" && pnpm --filter "$PUBLISHED_NAME" build) >/dev/null

# README and LICENSE come from the repo root; the CLI package.json's `files`
# array lists them, so npm pack expects them inside the package dir. Copy
# them in (npm pack does NOT follow symlinks for `files` entries). Remove
# any stale copy first so re-runs don't fail with "same file" on a leftover
# symlink from a prior aborted run.
rm -f "$CLI_DIR/README.md" "$CLI_DIR/LICENSE"
cp "$REPO_ROOT/README.md" "$CLI_DIR/README.md"
cp "$REPO_ROOT/LICENSE" "$CLI_DIR/LICENSE"

echo "→ Running npm pack..."
PACK_OUT="$(cd "$CLI_DIR" && npm pack --silent)"
TARBALL="$CLI_DIR/$PACK_OUT"

if [ ! -f "$TARBALL" ]; then
  echo "✗ npm pack did not produce a tarball at $TARBALL" >&2
  exit 1
fi

SIZE=$(stat -c '%s' "$TARBALL" 2>/dev/null || stat -f '%z' "$TARBALL")
if [ "$SIZE" -lt 50000 ]; then
  echo "✗ Tarball is suspiciously small ($SIZE bytes) — bundled deps may be missing" >&2
  exit 1
fi
echo "  tarball: $PACK_OUT ($SIZE bytes)"

echo "→ Inspecting contents..."
CONTENTS=$(tar -tzf "$TARBALL")

REQUIRED=("package/dist/index.js" "package/package.json" "package/README.md" "package/LICENSE")
for f in "${REQUIRED[@]}"; do
  if ! echo "$CONTENTS" | grep -qx "$f"; then
    echo "✗ Tarball missing required file: $f" >&2
    exit 1
  fi
done

echo "→ Checking shebang on dist/index.js..."
# Extract to a temp file then read with awk so `set -o pipefail` doesn't
# trip on SIGPIPE from `head -1` closing the tar pipe early.
TMP_BIN="$(mktemp)"
tar -xzOf "$TARBALL" package/dist/index.js > "$TMP_BIN"
FIRST_LINE=$(awk 'NR==1{print; exit}' "$TMP_BIN")
rm -f "$TMP_BIN"
if [ "$FIRST_LINE" != "#!/usr/bin/env node" ]; then
  echo "✗ dist/index.js is missing the node shebang (got: $FIRST_LINE)" >&2
  exit 1
fi

echo "→ Checking package.json metadata..."
PKG_JSON=$(tar -xzOf "$TARBALL" package/package.json)
NAME=$(echo "$PKG_JSON" | grep '"name"' | head -1 | sed -E 's/.*"name":[[:space:]]*"([^"]+)".*/\1/')
BIN_ICO=$(echo "$PKG_JSON" | grep -E '"ico"' || true)

if [ "$NAME" != "$PUBLISHED_NAME" ]; then
  echo "✗ Published name is '$NAME', expected '$PUBLISHED_NAME'" >&2
  exit 1
fi
if [ -z "$BIN_ICO" ]; then
  echo "✗ package.json does not declare bin.ico" >&2
  exit 1
fi

# CRITICAL: a `workspace:` ref in the published `dependencies` block will
# break `npm install` for external users — workspace-private packages
# aren't on the public registry. tsup bundles the workspace deps into
# dist/, so they must be devDependencies (build-time only), not runtime
# deps. devDependencies are not installed by end users so it's fine to
# leave workspace: refs there.
DEPS_BLOCK=$(echo "$PKG_JSON" | awk '
  /^  "dependencies":/ { inblock=1; print; next }
  inblock && /^  },?$/  { inblock=0; print; next }
  inblock { print }
')
if echo "$DEPS_BLOCK" | grep -q '"workspace:'; then
  echo "✗ package.json runtime 'dependencies' contains workspace: refs:" >&2
  echo "$DEPS_BLOCK" | grep '"workspace:' | sed 's/^/    /' >&2
  echo "  Move @ico/* entries from 'dependencies' to 'devDependencies'." >&2
  exit 1
fi

echo "→ Cleaning up copied files..."
rm -f "$CLI_DIR/README.md" "$CLI_DIR/LICENSE"

echo ""
echo "✓ npm pack verification passed."
echo "  tarball:        $PACK_OUT"
echo "  size:           $SIZE bytes"
echo "  published name: $NAME"
echo "  bin:            ico → dist/index.js"
echo ""
echo "Next: \`cd packages/cli && npm install -g $PACK_OUT && ico --version\`"
