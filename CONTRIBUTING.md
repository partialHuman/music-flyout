# Contributing

Thanks for contributing to Music Flyout.

## Before submitting changes

Run:

```bash
node --check extension.js
node --check prefs.js
```

If you have GNOME Shell available, also test the extension itself and check:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i "music flyout"
```

## Pull requests

Please describe:

- what changed
- why it changed
- GNOME Shell version tested
- whether the change affects the settings schema
- whether the change was tested with CAVA/MPRIS

Avoid changing generated `schemas/gschemas.compiled` manually; regenerate it with:

```bash
glib-compile-schemas schemas
```
