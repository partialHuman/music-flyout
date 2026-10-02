#!/usr/bin/env bash
set -euo pipefail

UUID="music-flyout@local"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$EXT_DIR"

echo "Music Flyout removed."
