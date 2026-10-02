#!/usr/bin/env bash
set -euo pipefail

UUID="music-flyout@local"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "Installing Music Flyout to:"
echo "  $EXT_DIR"

rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"

cp extension.js metadata.json prefs.js stylesheet.css "$EXT_DIR/"

if [ -d icons ]; then
    cp -r icons "$EXT_DIR/"
fi

mkdir -p "$EXT_DIR/schemas"
cp schemas/org.gnome.shell.extensions.music-flyout.gschema.xml "$EXT_DIR/schemas/"
glib-compile-schemas "$EXT_DIR/schemas"

echo
echo "Installation complete."
echo "Enable with:"
echo "  gnome-extensions enable $UUID"
echo "Open preferences with:"
echo "  gnome-extensions prefs $UUID"
