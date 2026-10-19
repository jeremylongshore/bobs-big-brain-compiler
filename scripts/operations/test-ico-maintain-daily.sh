#!/usr/bin/env bash
# Contract test for the nightly ICO maintenance wrapper's mount-clone refresh.
# Uses a local bare repository as origin, a stub `ico`, and a fake alert
# floor, so it touches no network, credential, or live brain.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/ico-maintain-daily.sh"
TEST_ROOT="$(mktemp -d -t ico-maintain-test.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

git init -q --bare -b main "$TEST_ROOT/origin.git"
git clone -q "$TEST_ROOT/origin.git" "$TEST_ROOT/seed" 2>/dev/null
commit() { git -C "$TEST_ROOT/seed" commit -q --allow-empty -m "$1"; git -C "$TEST_ROOT/seed" push -q origin main; }
commit one
mkdir -p "$TEST_ROOT/mounts" "$TEST_ROOT/ws/.ico/maintenance" "$TEST_ROOT/state"
git clone -q "$TEST_ROOT/origin.git" "$TEST_ROOT/mounts/repo"
# A directory that is not a git clone is ignored, not refreshed.
mkdir -p "$TEST_ROOT/mounts/not-a-clone"
commit two

cat > "$TEST_ROOT/ico" <<'EOF'
#!/usr/bin/env bash
printf 'ico ran\n' >> "$STUB_CAPTURE"
printf '{"status":"verified_noop","errorCode":null}\n' > "$STUB_WS/.ico/maintenance/latest.json"
EOF
chmod +x "$TEST_ROOT/ico"
cat > "$TEST_ROOT/alert-floor.sh" <<'EOF'
af_dispatch() { printf 'alert %s\n' "$1" >> "$STUB_CAPTURE"; }
EOF

capture="$TEST_ROOT/capture.log"
run_wrapper() {
  : > "$capture"
  env STUB_CAPTURE="$capture" STUB_WS="$TEST_ROOT/ws" \
    ICO_BIN="$TEST_ROOT/ico" ICO_WORKSPACE="$TEST_ROOT/ws" \
    ICO_PROVIDER_FILE=/nonexistent ICO_MAINTAIN_STATE_DIR="$TEST_ROOT/state" \
    AF_LIB="$TEST_ROOT/alert-floor.sh" ICO_MOUNT_CHECKOUT_ROOT="$TEST_ROOT/mounts" \
    MINIMAX_API_KEY=stub bash "$WRAPPER" >/dev/null 2>&1
}

# 1. A clean clone fast-forwards to origin/main before ico runs, and the
#    compiled head is recorded in last.ok.
run_wrapper || fail 'clean clone run failed'
expected="$(git -C "$TEST_ROOT/seed" rev-parse HEAD)"
[ "$(git -C "$TEST_ROOT/mounts/repo" rev-parse HEAD)" = "$expected" ] || fail 'clone was not fast-forwarded'
[ "$(jq -r '.mountHeads.repo' "$TEST_ROOT/state/last.ok")" = "$expected" ] || fail 'last.ok lacks the compiled head'
[ "$(jq -r '.mountHeads | keys | length' "$TEST_ROOT/state/last.ok")" = 1 ] || fail 'a non-clone directory was treated as a mount clone'
grep -q '^ico ran$' "$capture" || fail 'ico did not run'

# Each refusal must alert, exit non-zero, and never run ico.
expect_refusal() {
  local label="$1" pattern="$2"
  rm -f "$TEST_ROOT/state/last.ok"
  if run_wrapper; then fail "$label: wrapper succeeded"; fi
  grep -q "^alert .*mount clone repo $pattern" "$capture" || fail "$label: no matching alert"
  ! grep -q '^ico ran$' "$capture" || fail "$label: ico ran on an unrefreshed clone"
  [ ! -e "$TEST_ROOT/state/last.ok" ] || fail "$label: last.ok was written"
}

# 2. Local edits (tracked or untracked) refuse.
touch "$TEST_ROOT/mounts/repo/stray.md"
expect_refusal 'dirty clone' 'has local changes'
rm "$TEST_ROOT/mounts/repo/stray.md"

# 3. A clone moved off main refuses.
git -C "$TEST_ROOT/mounts/repo" checkout -q --detach
expect_refusal 'detached clone' 'not on branch main'
git -C "$TEST_ROOT/mounts/repo" checkout -q main

# 4. A clone that diverged from origin/main refuses rather than merging.
git -C "$TEST_ROOT/mounts/repo" commit -q --allow-empty -m local
commit three
expect_refusal 'diverged clone' 'cannot fast-forward'
git -C "$TEST_ROOT/mounts/repo" reset -q --hard origin/main

# 5. An unreachable origin refuses.
git -C "$TEST_ROOT/mounts/repo" remote set-url origin "$TEST_ROOT/missing.git"
expect_refusal 'unreachable origin' 'fetch from origin failed'

printf 'PASS: ico-maintain-daily mount-clone refresh\n'
