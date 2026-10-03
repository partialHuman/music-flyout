# Music Flyout

A Fluent-style GNOME Shell top-panel music controller with album art, playback controls, MPRIS player switching, a CAVA audio visualizer, acrylic styling, and compact/default media cards.

## Features

- Top-panel music pill
- Album art and track information
- Play/pause, previous/next and optional skip controls
- Shuffle and repeat
- MPRIS player switching
- Real-time CAVA visualizer with fallback animation
- PipeWire/PulseAudio CAVA input options
- Click, scroll and hover controls
- Acrylic/blur flyout
- Seek bar with elapsed/remaining time
- Compact, default and Spotify Playlists card layouts
- Spotify playlist browsing through the Web API
- Cached playlist loading and configurable playlist list height
- Launch-and-play fallback when no media player is running
- Five panel positions: Far left, Left, Center, Right and Far right
- Custom panel icon
- GNOME Shell 45–50 metadata

## Requirements

- GNOME Shell 45–50
- GSettings
- Optional: `cava` for the real audio visualizer
- Optional: a Spotify Premium account and your own Spotify Developer app for the Playlists card

Install CAVA on Ubuntu:

```bash
sudo apt install cava
```

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/music-flyout.git
cd music-flyout
./install.sh
```

Then enable the extension:

```bash
gnome-extensions enable music-flyout@local
```

Open preferences:

```bash
gnome-extensions prefs music-flyout@local
```

After replacing extension code or changing the schema, log out and back in if GNOME continues using cached extension code.

## Development

The repository preserves the development history as versioned snapshots (`v0` through `v14`). Each historical version is tagged.

### Spotify Playlists setup

The Playlists card uses Spotify's Web API. In extension preferences, open the Spotify playlists settings, create/configure a Spotify Web API app, enter its Client ID, and use the displayed redirect URI. The extension stores its local authentication data under `~/.config/music-flyout/spotify.json`.

The Spotify desktop application must be installed for playlist playback actions.

Syntax checks can be run with:

```bash
node --check extension.js
node --check prefs.js
```

These checks validate JavaScript syntax only; they do not replace testing inside GNOME Shell.

## Troubleshooting

Follow GNOME Shell logs with:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i "music flyout"
```

If the CAVA bars stay flat, try the PipeWire input method in the extension preferences.

## License

MIT
