#!/usr/bin/env bash
# Install the scheduled ICO maintenance wrapper and user-systemd units.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${ICO_MAINTAIN_LIB_DIR:-$HOME/.local/lib/ico}"
UNIT_DIR="${ICO_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"

mkdir -p "$LIB_DIR" "$UNIT_DIR"
install -m 0755 "$SCRIPT_DIR/ico-maintain-daily.sh" "$LIB_DIR/ico-maintain-daily.sh"
install -m 0644 "$SCRIPT_DIR/systemd/ico-maintain.service" "$UNIT_DIR/ico-maintain.service"
install -m 0644 "$SCRIPT_DIR/systemd/ico-maintain.timer" "$UNIT_DIR/ico-maintain.timer"

systemctl --user daemon-reload
systemctl --user enable --now ico-maintain.timer
systemctl --user status ico-maintain.timer --no-pager
