import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const POSITIONS = ['left', 'center', 'right'];
const METHODS = ['pulse', 'pipewire'];

export default class MusicFlyoutPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const bind = (key, widget, prop) =>
            settings.bind(key, widget, prop, Gio.SettingsBindFlags.DEFAULT);

        const spin = (title, key, lower, upper, step = 1) => {
            const row = new Adw.SpinRow({
                title,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
            });
            bind(key, row, 'value');
            return row;
        };
        const toggle = (title, key, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            bind(key, row, 'active');
            return row;
        };
        const choice = (title, key, values, labels, subtitle = '') => {
            const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels)});
            const idx = values.indexOf(settings.get_string(key));
            row.selected = idx >= 0 ? idx : 0;
            row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
            return row;
        };

        const page = new Adw.PreferencesPage({title: 'Music Flyout', icon_name: 'multimedia-player-symbolic'});

        const panel = new Adw.PreferencesGroup({title: 'Panel pill'});
        panel.add(choice('Position', 'panel-position', POSITIONS, ['Left', 'Center', 'Right']));
        panel.add(toggle('Show album thumbnail', 'show-thumbnail'));
        panel.add(toggle('Show track label', 'show-label'));
        panel.add(spin('Label max width (px)', 'label-max-width', 80, 400, 10));
        page.add(panel);

        const vis = new Adw.PreferencesGroup({title: 'Visualizer'});
        vis.add(spin('Bars', 'bar-count', 3, 9));
        vis.add(toggle('Real audio visualizer', 'use-cava', 'Requires the "cava" package. Falls back to animated bars if missing.'));
        vis.add(choice('cava input method', 'cava-method', METHODS, ['PulseAudio / PipeWire-Pulse', 'PipeWire'],
            'Try PipeWire if the bars stay flat.'));
        page.add(vis);

        const look = new Adw.PreferencesGroup({title: 'Flyout'});
        look.add(toggle('Blur background (acrylic)', 'enable-blur', 'Turn off if the blur looks odd at the corners.'));
        page.add(look);

        window.add(page);
    }
}
