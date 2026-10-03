import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CLICK_VALUES = ['play-pause', 'open-card', 'next', 'previous', 'none'];
const CLICK_LABELS = ['Play / Pause', 'Open card', 'Next track', 'Previous track', 'Nothing'];
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

        // ---- Custom icon image picker ------------------------------------
        const iconPreview = new Gtk.Image({pixel_size: 40, icon_name: 'image-x-generic-symbolic'});
        const imageRow = new Adw.ActionRow({title: 'Image file'});
        imageRow.add_prefix(iconPreview);
        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Remove image',
        });
        const pickBtn = new Gtk.Button({
            icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Choose image…',
        });
        clearBtn.add_css_class('flat');
        pickBtn.add_css_class('flat');
        imageRow.add_suffix(clearBtn);
        imageRow.add_suffix(pickBtn);

        const syncImage = () => {
            const path = settings.get_string('custom-icon-path');
            imageRow.subtitle = path ? GLib.path_get_basename(path) : 'No file selected';
            clearBtn.visible = !!path;
            if (path && GLib.file_test(path, GLib.FileTest.EXISTS)) iconPreview.set_from_file(path);
            else iconPreview.set_from_icon_name('image-x-generic-symbolic');
        };
        syncImage();
        handlerIds.push(settings.connect('changed::custom-icon-path', syncImage));
        clearBtn.connect('clicked', () => settings.set_string('custom-icon-path', ''));
        pickBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Choose an image'});
            const filter = new Gtk.FileFilter();
            filter.name = 'Images';
            filter.add_mime_type('image/*');
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
            filters.append(filter);
            dialog.filters = filters;
            dialog.open(window, null, (d, res) => {
                try {
                    const file = d.open_finish(res);
                    if (file) settings.set_string('custom-icon-path', file.get_path());
                } catch (e) { /* cancelled */ }
            });
        });

        // ---- Scroll controls rows (greyed out while disabled) -------------
        const scrollEnable = toggle('scroll-controls', 'Enable scroll controls',
            'Change tracks, volume or media player using the scroll wheel or touchpad.');
        const scrollRows = [
            choice('scroll-action', 'Scroll action',
                ['change-track', 'change-volume', 'switch-player', 'seek'],
                ['Change Track', 'Change Volume', 'Switch Player', 'Seek'],
                'Choose what scrolling on the pill should do. Seek uses the skip amount from the Card page.'),
            choice('volume-scroll-target', 'Volume scroll target', ['system', 'player'],
                ['System Master', 'Active Player'],
                'Choose which sound source to control when scrolling volume.'),
            toggle('invert-scroll-animation', 'Invert scroll animation',
                'Direction of the jump effect (Natural vs Traditional).'),
            toggle('invert-scroll-direction', 'Invert scroll direction',
                'Swap up/down for track and volume actions.'),
        ];
        scrollRows.forEach(r => scrollEnable.bind_property('active', r, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE));

        // ---- Secondary scroll action (modifier + scroll) ------------------
        const SCROLL_ACTIONS = ['change-track', 'change-volume', 'switch-player', 'seek'];
        const SCROLL_LABELS = ['Change Track', 'Change Volume', 'Switch Player', 'Seek'];
        const secondEnable = toggle('secondary-scroll', 'Enable secondary scroll action',
            'Hold a modifier key while scrolling to run a different action.');
        const secondRows = [
            choice('secondary-scroll-action', 'Secondary scroll action', SCROLL_ACTIONS, SCROLL_LABELS,
                'Used while the modifier key below is held.'),
            choice('secondary-scroll-modifier', 'Modifier key',
                ['ctrl', 'alt', 'shift', 'super', 'ctrl-shift', 'ctrl-alt', 'alt-shift', 'super-ctrl'],
                ['Ctrl', 'Alt', 'Shift', 'Super (Win)', 'Ctrl + Shift', 'Ctrl + Alt', 'Alt + Shift', 'Super + Ctrl'],
                'Hold this key while scrolling. The Fn key is handled inside the keyboard itself, so the desktop cannot detect it.'),
        ];
        const updateSecondary = () => {
            secondEnable.sensitive = scrollEnable.active;
            secondRows.forEach(r => { r.sensitive = scrollEnable.active && secondEnable.active; });
        };
        scrollEnable.connect('notify::active', updateSecondary);
        secondEnable.connect('notify::active', updateSecondary);
        updateSecondary();

        // ---- Start playback when nothing is running -----------------------
        const launchToggle = toggle('launch-on-play', 'Start a player on play',
            'Pressing any play/pause button (panel, card or left click) opens the application below and starts playback.');
        const launchApp = new Adw.EntryRow({title: 'Application to open (name or desktop id)'});
        settings.bind('launch-app', launchApp, 'text', Gio.SettingsBindFlags.DEFAULT);
        launchToggle.bind_property('active', launchApp, 'sensitive', GObject.BindingFlags.SYNC_CREATE);

        // ---- Panel page --------------------------------------------------
        const panelPage = page('Panel', 'go-home-symbolic', [
            group('Placement', 'Where the indicator appears in the top panel.', [
                choice('panel-position', 'Position',
                    ['far-left', 'left', 'center', 'right', 'far-right'],
                    ['Far left', 'Left', 'Center', 'Right', 'Far right'],
                    'Far left / far right are the outermost spots of the panel; Left / Right sit next to the panel centre.'),
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
            group('Icon', 'How Music Flyout represents the currently playing media in the panel.', [
                choice('icon-source', 'Icon source',
                    ['app-icon', 'album-art', 'playing-status', 'custom-image', 'none'],
                    ['App icon', 'Album art', 'Playing status', 'Custom image', 'None'],
                    'Album art, app icon or any icon.'),
                spin('icon-size', 'Icon size', 8, 64, 1, 'Size in pixels.'),
                spin('icon-spacing', 'Icon spacing', 0, 32, 1, 'Space between the icon and text in pixels.'),
            ]),
            group('Custom image', 'Pick an image to use when the icon source is set to Custom image.', [imageRow]),
            group('Track information', 'What the indicator shows about the current track.', [
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
            group('Scroll wheel controls', 'Control playback by scrolling over the panel indicator.',
                [scrollEnable, ...scrollRows, secondEnable, ...secondRows]),
            group('Mouse buttons', 'What clicking the panel indicator does.', [
                choice('click-left', 'Left click', CLICK_VALUES, CLICK_LABELS),
                choice('click-middle', 'Middle click', CLICK_VALUES, CLICK_LABELS),
                choice('click-right', 'Right click', CLICK_VALUES, CLICK_LABELS),
            ]),
            group('When nothing is playing', 'What the play button does while no media player is running.', [
                launchToggle,
                launchApp,
            ]),
            group('Hover', 'Show the card when the pointer rests on the panel indicator.', [
                toggle('hover-open', 'Show card on hover',
                    'The card closes again when the pointer leaves it. Right-clicking while it is shown keeps it open.'),
                spin('hover-open-delay', 'Open delay', 0, 3000, 50, 'Milliseconds the pointer must rest on the indicator.'),
                spin('hover-close-delay', 'Close delay', 100, 3000, 50,
                    'Milliseconds before the card closes after the pointer leaves.'),
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
                choice('card-style', 'Card style', ['default', 'compact'], ['Default', 'Compact'],
                    'Compact puts a small thumbnail beside the track details, like a media notification.'),
                toggle('card-album-art', 'Album art', 'Falls back to the player icon when the track has no artwork.'),
                choice('album-art-size', 'Album art size', ['small', 'medium', 'large'], ['Small', 'Medium', 'Large'],
                    'Compact style uses 56, 72 or 88 px thumbnails.'),
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
