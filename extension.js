import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const BAR_COUNT = 5;
const BAR_MAX = 16;
const BAR_MIN = 3;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
  </interface>
</node>`);

const MusicIndicator = GObject.registerClass(
class MusicIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Music Flyout', false);
        this._players = new Map();
        this._destroyed = false;
        this._timeoutId = 0;
        this._bars = [];

        // --- Panel: visualizer bars + short title ---
        const box = new St.BoxLayout({style_class: 'mf-panel-box'});
        for (let i = 0; i < BAR_COUNT; i++) {
            const bar = new St.Widget({
                style_class: 'mf-bar',
                y_align: Clutter.ActorAlign.CENTER,
                height: BAR_MIN,
            });
            this._bars.push(bar);
            box.add_child(bar);
        }
        this._panelLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 6px; max-width: 180px;',
        });
        box.add_child(this._panelLabel);
        this.add_child(box);

        // --- Flyout ---
        const content = new St.BoxLayout({vertical: true, style: 'min-width: 260px; padding: 8px;'});
        this._art = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 160,
            style_class: 'mf-art', x_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({style_class: 'mf-title', x_align: Clutter.ActorAlign.CENTER});
        this._artist = new St.Label({style_class: 'mf-artist', x_align: Clutter.ActorAlign.CENTER});
        content.add_child(this._art);
        content.add_child(this._title);
        content.add_child(this._artist);

        const controls = new St.BoxLayout({style_class: 'mf-controls', x_align: Clutter.ActorAlign.CENTER});
        controls.add_child(this._makeButton('media-skip-backward-symbolic', () => this._active()?.PreviousRemote()));
        this._playBtn = this._makeButton('media-playback-start-symbolic', () => this._active()?.PlayPauseRemote());
        controls.add_child(this._playBtn);
        controls.add_child(this._makeButton('media-skip-forward-symbolic', () => this._active()?.NextRemote()));
        content.add_child(controls);

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(content);
        this.menu.addMenuItem(item);

        // --- MPRIS discovery ---
        this._nameSub = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX)) return;
                if (newOwner) this._addPlayer(name);
                else this._removePlayer(name);
            });
        this._scanPlayers();

        // --- Visualizer tick ---
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            this._tickBars();
            return GLib.SOURCE_CONTINUE;
        });

        this._update();
    }

    _makeButton(iconName, onClick) {
        const btn = new St.Button({style_class: 'mf-btn', child: new St.Icon({icon_name: iconName, icon_size: 20})});
        btn.connect('clicked', onClick);
        return btn;
    }

    _scanPlayers() {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, GLib.VariantType.new('(as)'), Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) { logError(e); }
            });
    }

    _addPlayer(name) {
        if (this._players.has(name)) return;
        new PlayerProxy(Gio.DBus.session, name, MPRIS_PATH, (proxy, err) => {
            if (err) { logError(err); return; }
            if (this._destroyed) return;
            proxy.connect('g-properties-changed', () => this._update());
            this._players.set(name, proxy);
            this._update();
        });
    }

    _removePlayer(name) {
        this._players.delete(name);
        this._update();
    }

    _active() {
        const all = [...this._players.values()];
        return all.find(p => p.PlaybackStatus === 'Playing') ?? all[0] ?? null;
    }

    _update() {
        if (this._destroyed) return;
        const p = this._active();
        this.visible = !!p;
        if (!p) return;

        const md = p.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        const title = md['xesam:title'] ?? 'Unknown title';
        const artist = (md['xesam:artist'] ?? []).join(', ');
        this._title.text = title;
        this._artist.text = artist;
        this._panelLabel.text = artist ? `${artist} – ${title}` : title;

        const playing = p.PlaybackStatus === 'Playing';
        this._playBtn.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        const artUrl = md['mpris:artUrl'];
        if (artUrl?.startsWith('file://')) {
            this._art.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(artUrl)});
        } else {
            this._art.icon_name = 'audio-x-generic-symbolic'; // TODO: fetch http(s) art
        }
    }

    _tickBars() {
        const playing = this._active()?.PlaybackStatus === 'Playing';
        for (const bar of this._bars) {
            const h = playing
                ? BAR_MIN + Math.floor(Math.random() * (BAR_MAX - BAR_MIN))
                : BAR_MIN;
            bar.ease({height: h, duration: 130, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    cleanup() {
        this._destroyed = true;
        if (this._timeoutId) { GLib.source_remove(this._timeoutId); this._timeoutId = 0; }
        if (this._nameSub) { Gio.DBus.session.signal_unsubscribe(this._nameSub); this._nameSub = 0; }
        this._players.clear();
    }
});

export default class MusicFlyoutExtension extends Extension {
    enable() {
        this._indicator = new MusicIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
    }

    disable() {
        this._indicator?.cleanup();
        this._indicator?.destroy();
        this._indicator = null;
    }
}
