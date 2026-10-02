import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ART_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'music-flyout', 'art']);

function cacheStats() {
    let count = 0, bytes = 0;
    try {
        const en = Gio.File.new_for_path(ART_DIR).enumerate_children(
            'standard::name,standard::size,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null))) {
            if (info.get_file_type() === Gio.FileType.REGULAR) {
                count++;
                bytes += info.get_size();
            }
        }
        en.close(null);
    } catch (e) { /* no cache yet */ }
    return {count, bytes};
}

function clearCache() {
    try {
        const dir = Gio.File.new_for_path(ART_DIR);
        const en = dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null))) {
            if (info.get_file_type() === Gio.FileType.REGULAR)
                dir.get_child(info.get_name()).delete(null);
        }
        en.close(null);
    } catch (e) { /* nothing to clear */ }
}

function fmtBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function confirm(window, heading, body, actionLabel, onConfirm) {
    const Dialog = Adw.AlertDialog ?? Adw.MessageDialog;
    const dialog = new Dialog({heading, body});
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('confirm', actionLabel);
    dialog.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_d, id) => { if (id === 'confirm') onConfirm(); });
    if (Adw.AlertDialog) {
        dialog.present(window);
    } else {
        dialog.transient_for = window;
        dialog.modal = true;
        dialog.present();
    }
}

// A full-width, centred, red action row (like the "Clear Cache…" row).
function dangerRow(title, onClick) {
    if (Adw.ButtonRow) {
        const row = new Adw.ButtonRow({title});
        row.add_css_class('destructive-action');
        row.connect('activated', onClick);
        return row;
    }
    const btn = new Gtk.Button({label: title, hexpand: true});
    btn.add_css_class('flat');
    btn.add_css_class('error');
    btn.connect('clicked', onClick);
    return new Adw.PreferencesRow({child: btn});
}

export default class MusicFlyoutPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const handlerIds = [];
        window.connect('close-request', () => {
            handlerIds.forEach(id => settings.disconnect(id));
            return false;
        });
        window.set_default_size(560, 780);

        // ---- row helpers -------------------------------------------------
        const toggle = (key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const spin = (key, title, lower, upper, step, subtitle = '') => {
            const row = new Adw.SpinRow({
                title, subtitle,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const choice = (key, title, values, labels, subtitle = '') => {
            const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels)});
            const sync = () => {
                const i = values.indexOf(settings.get_string(key));
                const sel = i >= 0 ? i : 0;
                if (row.selected !== sel) row.selected = sel;
            };
            sync();
            row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
            handlerIds.push(settings.connect(`changed::${key}`, sync));
            return row;
        };
        const group = (title, description, rows) => {
            const g = new Adw.PreferencesGroup({title, description});
            rows.forEach(r => g.add(r));
            return g;
        };
        const page = (title, icon, groups) => {
            const p = new Adw.PreferencesPage({title, icon_name: icon});
            groups.forEach(g => p.add(g));
            return p;
        };

        // ---- Panel page --------------------------------------------------
        const panelPage = page('Panel', 'go-home-symbolic', [
            group('Placement', 'Where the indicator appears in the top panel.', [
                choice('panel-position', 'Position', ['left', 'center', 'right'], ['Left', 'Center', 'Right']),
                toggle('controls-first', 'Show controls before track information',
                    'Place the playback buttons to the left of the player icon and text.'),
                toggle('hide-when-idle', 'Hide when nothing is playing',
                    'Remove the indicator from the panel while no media player is running.'),
            ]),
            group('Playback controls', 'Which buttons appear in the panel.', [
                toggle('panel-shuffle', 'Shuffle', 'Requires a player that supports shuffle.'),
                toggle('panel-previous', 'Previous track'),
                toggle('panel-skip-back', 'Skip backward', 'Requires a player that supports seeking.'),
                toggle('panel-play-pause', 'Play and pause'),
                toggle('panel-skip-forward', 'Skip forward', 'Requires a player that supports seeking.'),
                toggle('panel-next', 'Next track'),
                toggle('panel-loop', 'Loop',
                    'Cycles between off, the whole queue, and one track. Requires a player that supports looping.'),
            ]),
            group('Track information', 'What the indicator shows about the current track.', [
                toggle('show-player-icon', 'Player icon'),
                toggle('show-title', 'Track title'),
                toggle('show-artist', 'Artist'),
                spin('text-width', 'Text width', 40, 600, 10,
                    'Width reserved for the track text, in pixels. The indicator keeps this width whatever is playing.'),
            ]),
            group('Scrolling text', 'What happens when the track text is wider than the reserved width.', [
                toggle('scroll-text', 'Scroll the text',
                    'When off, text that does not fit is shortened with an ellipsis.'),
                toggle('scroll-repeat', 'Repeat',
                    'Scroll continuously. When off, the text scrolls once for each new track.'),
                choice('scroll-direction', 'Direction', ['left-to-right', 'right-to-left'],
                    ['Left to right', 'Right to left'],
                    'The way the text is read as it scrolls past.'),
                spin('scroll-speed', 'Speed', 5, 300, 5, 'Pixels per second.'),
            ]),
            group('Visualizer', 'The animated bars in the panel indicator.', [
                toggle('show-visualizer', 'Show visualizer'),
                spin('bar-count', 'Bars', 3, 9, 1),
                toggle('use-cava', 'Real audio visualizer',
                    'Uses the "cava" package. Falls back to animated bars if it is not installed.'),
                choice('cava-method', 'cava input method', ['pulse', 'pipewire'],
                    ['PulseAudio / PipeWire-Pulse', 'PipeWire'], 'Try PipeWire if the bars stay flat.'),
            ]),
        ]);

        // ---- Card page ---------------------------------------------------
        const cardPage = page('Card', 'audio-x-generic-symbolic', [
            group('Appearance', 'The card is shown when you click the panel indicator.', [
                toggle('card-album-art', 'Album art', 'Falls back to the player icon when the track has no artwork.'),
                choice('album-art-size', 'Album art size', ['small', 'medium', 'large'], ['Small', 'Medium', 'Large']),
                spin('card-width', 'Card width', 280, 640, 10, 'Measured in pixels.'),
                toggle('enable-blur', 'Blur background', 'Acrylic blur behind the card. Turn off if it looks odd at the corners.'),
            ]),
            group('Multiple players', 'What happens when more than one media player is running.', [
                toggle('player-switcher', 'Player switcher',
                    'Player icons beside the settings button, for choosing which player the card and panel follow.'),
                toggle('single-player', 'Play one player at a time',
                    'When a player starts playing, pause whichever other player was playing. Players already running when the extension starts are left alone.'),
            ]),
            group('Playback', 'Optional controls the card offers alongside play, pause and track switching.', [
                toggle('seek-bar', 'Seek bar', 'Requires a player that reports the track length.'),
                toggle('card-skip-buttons', 'Skip buttons', 'Requires a player that supports seeking.'),
                spin('skip-amount', 'Skip amount', 1, 120, 1,
                    'How far the skip buttons jump, in seconds. Shared with the panel skip buttons.'),
                toggle('card-shuffle', 'Shuffle button',
                    'Shown at the left edge of the controls. Requires a player that supports shuffle.'),
                toggle('card-loop', 'Loop button',
                    'Shown at the right edge of the controls. Cycles between off, the whole queue, and one track.'),
            ]),
        ]);

        // ---- Maintenance page ----------------------------------------------
        const cacheRow = new Adw.ActionRow({title: 'Cached artwork'});
        const refreshCache = () => {
            const {count, bytes} = cacheStats();
            cacheRow.subtitle = `${count} ${count === 1 ? 'file' : 'files'} · ${fmtBytes(bytes)}`;
        };
        refreshCache();

        const clearRow = dangerRow('Clear Cache…', () => confirm(window,
            'Clear the album art cache?',
            'Cached artwork is removed. Anything still needed is downloaded again the next time it is played.',
            'Clear Cache', () => { clearCache(); refreshCache(); }));

        const resetRow = dangerRow('Reset All Settings…', () => confirm(window,
            'Reset all settings?',
            'Every setting on the Panel and Card pages returns to the value it shipped with.',
            'Reset', () => settings.list_keys().forEach(k => settings.reset(k))));

        const maintenancePage = page('Maintenance', 'emblem-system-symbolic', [
            group('Album art cache',
                'Artwork downloaded from players that publish it over the web is stored on disk so it is not fetched again. Removing it is safe; anything still needed is downloaded once more.',
                [cacheRow, clearRow]),
            group('Reset', 'Return every setting on the Panel and Card pages to the value it shipped with.', [resetRow]),
        ]);

        window.add(panelPage);
        window.add(cardPage);
        window.add(maintenancePage);
    }
}
