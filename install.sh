#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

UUID="$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')"

if [[ -z "$UUID" || "$UUID" == */* ]]; then
    echo "Error: Invalid extension UUID in metadata.json" >&2
    exit 1
fi

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "Installing Music Flyout ($UUID) to:"
echo "  $EXT_DIR"

mkdir -p "$EXT_DIR"
cp extension.js metadata.json prefs.js stylesheet.css LICENSE "$EXT_DIR/"
cp spotify.js "$EXT_DIR/"
mkdir -p "$EXT_DIR/icons" "$EXT_DIR/schemas"
cp icons/* "$EXT_DIR/icons/"
cp schemas/org.gnome.shell.extensions.music-flyout.gschema.xml "$EXT_DIR/schemas/"

glib-compile-schemas "$EXT_DIR/schemas"

echo
echo "Installation complete."
echo "Log out and back in on Wayland, then enable with:"
echo "  gnome-extensions enable $UUID"
echo "Open preferences with:"
echo "  gnome-extensions prefs $UUID"
