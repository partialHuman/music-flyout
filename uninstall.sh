#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UUID="$(python3 -c 'import json; print(json.load(open("'"$SCRIPT_DIR/metadata.json"'"))["uuid"])')"

if [[ -z "$UUID" || "$UUID" == */* ]]; then
    echo "Error: Invalid extension UUID in metadata.json" >&2
    exit 1
fi

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [[ ! -d "$EXT_DIR" ]]; then
    echo "Music Flyout is not installed at $EXT_DIR"
    exit 0
fi

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
fi

rm -rf -- "$EXT_DIR"
echo "Music Flyout ($UUID) removed."
