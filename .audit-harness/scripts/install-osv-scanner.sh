#!/usr/bin/env bash
# Install the repository-pinned OSV-Scanner binary into an explicit directory.
# Intended for ephemeral CI runners. Network-touching and filesystem-mutating by
# design; `audit-harness scan` itself remains read-only.

set -euo pipefail

VERSION="2.5.1"
DEST_DIR="${1:-}"

if [ -z "$DEST_DIR" ]; then
  echo "usage: install-osv-scanner.sh BIN_DIR" >&2
  exit 2
fi

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64)
    ASSET="osv-scanner_linux_amd64"
    SHA256="f9f25499a2c8cc367b3af45df2ea7eeca7fbccceab9c35079968f4b3652194be"
    ;;
  Linux:aarch64|Linux:arm64)
    ASSET="osv-scanner_linux_arm64"
    SHA256="3d0f5aa5a6baa8eb32bcef247388e149ef6030a6634ccae6fa0d62681fb27a6d"
    ;;
  Darwin:x86_64|Darwin:amd64)
    ASSET="osv-scanner_darwin_amd64"
    SHA256="9f89beb6c3d784893cb1cae0a3d56c529bfe91075418c2f9440c45b79654198b"
    ;;
  Darwin:arm64)
    ASSET="osv-scanner_darwin_arm64"
    SHA256="75c44d6332f892a1e56286f4105a98ed751ae28d215ca0a8b65cc00d84103054"
    ;;
  *)
    echo "install-osv-scanner: unsupported platform $(uname -s)/$(uname -m)" >&2
    exit 2
    ;;
esac

command -v curl >/dev/null || {
  echo "install-osv-scanner: curl is required" >&2
  exit 2
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
URL="https://github.com/google/osv-scanner/releases/download/v${VERSION}/${ASSET}"

curl --fail --location --silent --show-error --retry 3 --output "$TMP_DIR/osv-scanner" "$URL"

if command -v sha256sum >/dev/null; then
  printf '%s  %s\n' "$SHA256" "$TMP_DIR/osv-scanner" | sha256sum --check --status
elif command -v shasum >/dev/null; then
  printf '%s  %s\n' "$SHA256" "$TMP_DIR/osv-scanner" | shasum -a 256 --check --status
else
  echo "install-osv-scanner: sha256sum or shasum is required" >&2
  exit 2
fi

mkdir -p "$DEST_DIR"
install -m 0755 "$TMP_DIR/osv-scanner" "$DEST_DIR/osv-scanner"
"$DEST_DIR/osv-scanner" --version
echo "install-osv-scanner: installed verified v${VERSION} at $DEST_DIR/osv-scanner" >&2
