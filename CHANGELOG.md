# Changelog

## v14
- Added a third **Playlists** card style.
- Added Spotify Web API authentication and playlist retrieval.
- Added cached playlist loading with background refresh.
- Added playlist list height configuration.
- Added playlist artwork, owner and track-count display.
- Added playlist selection that opens the playlist in the Spotify desktop app and attempts playback.
- Added Spotify settings for Client ID, connect/disconnect, redirect URI and setup guidance.

## v13
- Added **Start a player on play** behavior when no MPRIS player is running.
- Added configurable application/desktop ID to launch, defaulting to `spotify`.
- Added startup status text and retry logic while waiting for the player to become available.
- Applied the behavior to panel, default-card and compact-card play controls.

## v12
- Fixed GNOME 46+ blur creation by trying `radius` first and retaining a `sigma` fallback for older GNOME versions.
- Added a log message when the blur effect cannot be created.
- Added five panel positions: Far left, Left, Center, Right and Far right.
- Added tighter card corners while the blur effect is enabled.

## v11
- Added Default / Compact card style.
- Added compact thumbnail, metadata, visualizer and controls layout.
- Added `card-style` GSettings key.

## v10
- Added GNOME 51-compatible vertical layout helper while retaining GNOME 45–50 metadata.
- Improved panel click handling with `Clutter.ClickGesture`.

## v9
- Refined preferences handling for secondary scroll controls.
- Updated Spotify icon asset.

## v8
- Added configurable mouse-button actions.
- Added secondary modifier + scroll actions.
- Added Spotify icon.

## v7
- Added custom panel icon support.
- Added configurable scroll controls and volume targets.
- Added more panel settings.

## v6
- Improved panel controls as a separate `PanelMenu.Button`.

## v5
- Improved grouped panel playback controls and pill joining.

## v4
- Development snapshot; no file changes from v3.

## v3
- Added comprehensive preferences.
- Added album-art caching.
- Added player switching.
- Added hover behavior.
- Added scroll controls.
- Added GNOME 45–50 metadata.

## v2
- Added GSettings schema and preferences UI.
- Added shuffle/repeat controls.
- Added configurable panel position and CAVA method.

## v1
- Added album art handling.
- Added acrylic styling and blur.
- Added CAVA-based visualizer.
- Added progress/seek support.

## v0
- Initial Music Flyout implementation.
