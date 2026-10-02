import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ---- Tweakables -----------------------------------------------------------
const ENABLE_BLUR = true;      // acrylic blur behind the flyout (set false if it looks odd)
const USE_CAVA = true;         // real spectrum via `cava`; falls back to fake bars if missing
const CAVA_METHOD = 'pulse';   // 'pulse' works on PipeWire too; try 'pipewire' if bars stay flat
const BAR_COUNT = 5;
const BAR_MIN = 3;
const BAR_MAX = 18;
const ART_SIZE = 264;
const PROGRESS_W = 264;
// ---------------------------------------------------------------------------

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'music-flyout']);

const CAVA_CONFIG = `[general]
bars = ${BAR_COUNT}
framerate = 30

[input]
method = ${CAVA_METHOD}
source = auto

[output]
method = raw
raw_target = /dev/stdout
data_format = ascii
ascii_max_range = 100
bar_delimiter = 59
frame_delimiter = 10
channels = mono

[smoothing]
noise_reduction = 60
`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
  </interface>
</node>`);

function fmtTime(us) {
    const s = Math.max(0, Math.floor(us / 1e6));
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function playerLabel(busName) {
    const n = busName.slice(MPRIS_PREFIX.length).replace(/\.instance[_\d]+$/, '');
    return n.charAt(0).toUpperCase() + n.slice(1);
}

const MusicIndicator = GObject.registerClass(
class MusicIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Music Flyout', false);
        this.add_style_class_name('mf-pill');

        this._players = new Map();
        this._selected = null;
        this._destroyed = false;
        this._bars = [];
        this._artUrl = null;
        this._trackId = null;
        this._length = 0;
        this._position = 0;
        this._chipsKey = '';
        this._cava = null;
        this._cavaFailed = false;
        this._session = new Soup.Session({timeout: 10});

        this._buildPanel();
        this._buildFlyout();
        this._applyAcrylic();

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) this._startPolling();
            else this._stopPolling();
        });

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

        // Fallback "fake" visualizer tick (used only when cava isn't running)
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            this._fallbackTick();
            return GLib.SOURCE_CONTINUE;
        });

        this._update();
    }

    // ------------------------------------------------------------ UI: panel
    _buildPanel() {
        const box = new St.BoxLayout({style_class: 'mf-pill-box', y_align: Clutter.ActorAlign.CENTER});

        this._thumb = new St.Widget({style_class: 'mf-thumb', y_align: Clutter.ActorAlign.CENTER, visible: false});
        box.add_child(this._thumb);

        this._panelLabel = new St.Label({style_class: 'mf-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._panelLabel);

        const bars = new St.BoxLayout({style_class: 'mf-bars', y_align: Clutter.ActorAlign.CENTER});
        for (let i = 0; i < BAR_COUNT; i++) {
            const bar = new St.Widget({style_class: 'mf-bar', y_align: Clutter.ActorAlign.CENTER, height: BAR_MIN});
            this._bars.push(bar);
            bars.add_child(bar);
        }
        box.add_child(bars);
        this.add_child(box);
    }

    // Middle-click the pill = play/pause
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_MIDDLE) {
            this._active()?.PlayPauseRemote();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    // ----------------------------------------------------------- UI: flyout
    _buildFlyout() {
        const content = new St.BoxLayout({vertical: true, style_class: 'mf-content'});

        this._chips = new St.BoxLayout({style_class: 'mf-chips', x_align: Clutter.ActorAlign.CENTER, visible: false});
        content.add_child(this._chips);

        this._artIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic', icon_size: 96, style_class: 'mf-art-icon',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this._art = new St.Bin({style_class: 'mf-art', child: this._artIcon});
        content.add_child(this._art);

        this._title = new St.Label({style_class: 'mf-title'});
        this._artist = new St.Label({style_class: 'mf-artist'});
        content.add_child(this._title);
        content.add_child(this._artist);

        // Progress bar (click to seek)
        this._track = new St.Widget({style_class: 'mf-track', reactive: true, track_hover: true,
            width: PROGRESS_W, height: 6});
        this._fill = new St.Widget({style_class: 'mf-fill', width: 0, height: 6});
        this._track.add_child(this._fill);
        this._track.connect('button-press-event', (_a, event) => {
            this._seekFromEvent(event);
            return Clutter.EVENT_STOP;
        });
        content.add_child(this._track);

        const times = new St.BoxLayout({width: PROGRESS_W});
        this._elapsed = new St.Label({style_class: 'mf-time', text: '0:00', x_expand: true});
        this._remaining = new St.Label({style_class: 'mf-time', text: '-0:00'});
        times.add_child(this._elapsed);
        times.add_child(this._remaining);
        content.add_child(times);

        const controls = new St.BoxLayout({style_class: 'mf-controls', x_align: Clutter.ActorAlign.CENTER});
        controls.add_child(this._makeButton('media-skip-backward-symbolic', 22, '', () => this._active()?.PreviousRemote()));
        this._playBtn = this._makeButton('media-playback-start-symbolic', 26, 'mf-play', () => this._active()?.PlayPauseRemote());
        controls.add_child(this._playBtn);
        controls.add_child(this._makeButton('media-skip-forward-symbolic', 22, '', () => this._active()?.NextRemote()));
        content.add_child(controls);

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('mf-item');
        item.add_child(content);
        this.menu.addMenuItem(item);
    }

    _makeButton(iconName, size, extraClass, onClick) {
        const btn = new St.Button({
            style_class: `mf-btn ${extraClass}`.trim(),
            child: new St.Icon({icon_name: iconName, icon_size: size}),
            reactive: true, track_hover: true, can_focus: true,
        });
        btn.set_pivot_point(0.5, 0.5);
        const animate = () => {
            const s = btn.pressed ? 0.92 : (btn.hover ? 1.12 : 1.0);
            btn.ease({scale_x: s, scale_y: s, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };
        btn.connect('notify::hover', animate);
        btn.connect('notify::pressed', animate);
        btn.connect('clicked', onClick);
        return btn;
    }

    _applyAcrylic() {
        const actor = this.menu.actor ?? this.menu._boxPointer;
        actor.add_style_class_name('mf-menu');
        if (!ENABLE_BLUR) return;
        try {
            const blur = new Shell.BlurEffect({
                brightness: 0.75, sigma: 30, mode: Shell.BlurMode.BACKGROUND,
            });
            actor.add_effect_with_name('mf-blur', blur);
        } catch (e) {
            logError(e, 'Music Flyout: blur unavailable');
        }
    }

    // --------------------------------------------------------- MPRIS players
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
            if (this._destroyed || this._players.has(name)) return;
            proxy.connect('g-properties-changed', (_p, changed) => {
                const c = changed.deepUnpack();
                // The player that most recently started playing takes over the flyout
                if (c.PlaybackStatus && c.PlaybackStatus.unpack() === 'Playing')
                    this._selected = name;
                this._update();
            });
            this._players.set(name, proxy);
            if (proxy.PlaybackStatus === 'Playing' || !this._selected)
                this._selected = name;
            this._update();
        });
    }

    _removePlayer(name) {
        this._players.delete(name);
        if (this._selected === name) this._selected = null;
        this._update();
    }

    _activeName() {
        if (this._selected && this._players.has(this._selected)) return this._selected;
        for (const [n, p] of this._players)
            if (p.PlaybackStatus === 'Playing') return n;
        return this._players.keys().next().value ?? null;
    }

    _active() {
        const n = this._activeName();
        return n ? this._players.get(n) : null;
    }

    _rebuildChips() {
        const names = [...this._players.keys()];
        const active = this._activeName();
        const key = `${names.join('|')}#${active}`;
        if (key === this._chipsKey) return;
        this._chipsKey = key;

        this._chips.destroy_all_children();
        this._chips.visible = names.length > 1;
        if (names.length < 2) return;
        for (const n of names) {
            const chip = new St.Button({
                label: playerLabel(n),
                style_class: n === active ? 'mf-chip mf-chip-active' : 'mf-chip',
                reactive: true, track_hover: true,
            });
            chip.connect('clicked', () => { this._selected = n; this._update(); });
            this._chips.add_child(chip);
        }
    }

    // ---------------------------------------------------------------- update
    _update() {
        if (this._destroyed) return;
        const p = this._active();
        this.visible = !!p;
        this._rebuildChips();
        if (!p) {
            this._stopCava();
            this._dropBars();
            return;
        }

        const md = p.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        const title = md['xesam:title'] ?? 'Unknown title';
        const artist = (md['xesam:artist'] ?? []).join(', ');
        this._trackId = md['mpris:trackid'] ?? null;
        this._length = Number(md['mpris:length'] ?? 0);

        this._title.text = title;
        this._artist.text = artist;
        this._panelLabel.text = artist ? `${artist} – ${title}` : title;

        const playing = p.PlaybackStatus === 'Playing';
        this._playBtn.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        this._setArt(md['mpris:artUrl'] ?? null);
        this._syncVisualizer(playing);
        if (this.menu.isOpen) this._pollPosition();
        else this._renderProgress();
    }

    // ------------------------------------------------------------ album art
    _setArt(url) {
        if (url === this._artUrl) return;
        this._artUrl = url;
        this._artCancellable?.cancel();
        this._artCancellable = null;

        if (!url) { this._applyArt(null); return; }
        if (url.startsWith('file://')) {
            this._applyArt(Gio.File.new_for_uri(url).get_path());
            return;
        }
        if (!/^https?:\/\//.test(url)) { this._applyArt(null); return; }

        const cached = GLib.build_filenamev([
            CACHE_DIR, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1),
        ]);
        if (GLib.file_test(cached, GLib.FileTest.EXISTS)) { this._applyArt(cached); return; }

        this._applyArt(null);
        const msg = Soup.Message.new('GET', url);
        if (!msg) return;
        const cancellable = new Gio.Cancellable();
        this._artCancellable = cancellable;
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) return;
                if (this._destroyed || this._artUrl !== url) return;
                GLib.mkdir_with_parents(CACHE_DIR, 0o755);
                GLib.file_set_contents(cached, bytes.get_data());
                this._applyArt(cached);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'Music Flyout: album art');
            }
        });
    }

    _applyArt(path) {
        if (path) {
            const uri = GLib.filename_to_uri(path, null);
            const css = `background-image: url("${uri}"); background-size: cover;`;
            this._art.style = css;
            this._thumb.style = css;
            this._artIcon.hide();
            this._thumb.show();
        } else {
            this._art.style = '';
            this._thumb.style = '';
            this._artIcon.show();
            this._thumb.hide();
        }
    }

    // ------------------------------------------------------------- progress
    _startPolling() {
        this._pollPosition();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._pollPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._pollId) { GLib.source_remove(this._pollId); this._pollId = 0; }
    }

    _pollPosition() {
        const name = this._activeName();
        if (!name) return;
        Gio.DBus.session.call(name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            GLib.VariantType.new('(v)'), Gio.DBusCallFlags.NONE, 500, null,
            (conn, res) => {
                try {
                    const [pos] = conn.call_finish(res).recursiveUnpack();
                    if (this._destroyed) return;
                    this._position = Number(pos);
                    this._renderProgress();
                } catch (e) { /* player may not expose Position */ }
            });
    }

    _renderProgress() {
        const frac = this._length > 0 ? Math.min(1, Math.max(0, this._position / this._length)) : 0;
        this._fill.width = Math.round(PROGRESS_W * frac);
        this._elapsed.text = fmtTime(this._position);
        this._remaining.text = this._length > 0 ? `-${fmtTime(this._length - this._position)}` : '';
    }

    _seekFromEvent(event) {
        const p = this._active();
        if (!p || !this._trackId || this._length <= 0) return;
        const [sx] = event.get_coords();
        const [tx] = this._track.get_transformed_position();
        const frac = Math.min(1, Math.max(0, (sx - tx) / PROGRESS_W));
        const pos = Math.floor(frac * this._length);
        p.SetPositionRemote(this._trackId, pos);
        this._position = pos;
        this._renderProgress();
    }

    // ------------------------------------------------------------ visualizer
    _syncVisualizer(playing) {
        if (playing && USE_CAVA) this._startCava();
        else this._stopCava();
        if (!playing) this._dropBars();
    }

    _startCava() {
        if (this._cava || this._cavaFailed) return;
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o755);
            const conf = GLib.build_filenamev([CACHE_DIR, 'cava.conf']);
            GLib.file_set_contents(conf, CAVA_CONFIG);
            this._cava = Gio.Subprocess.new(['cava', '-p', conf],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._cavaCancellable = new Gio.Cancellable();
            const stream = new Gio.DataInputStream({base_stream: this._cava.get_stdout_pipe()});
            this._readCava(stream, this._cavaCancellable);
        } catch (e) {
            logError(e, 'Music Flyout: cava unavailable, using fallback bars');
            this._cava = null;
            this._cavaFailed = true;
        }
    }

    _readCava(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                const [line] = s.read_line_finish_utf8(res);
                if (line === null) {            // cava exited on its own
                    this._cava = null;
                    this._cavaFailed = true;
                    return;
                }
                const vals = line.split(';').filter(v => v !== '').map(Number);
                for (let i = 0; i < this._bars.length && i < vals.length; i++) {
                    const v = Math.min(100, Math.max(0, vals[i]));
                    this._bars[i].height = Math.round(BAR_MIN + (v / 100) * (BAR_MAX - BAR_MIN));
                }
                this._readCava(s, cancellable);
            } catch (e) { /* cancelled */ }
        });
    }

    _stopCava() {
        this._cavaCancellable?.cancel();
        this._cavaCancellable = null;
        if (this._cava) {
            try { this._cava.force_exit(); } catch (e) { /* already gone */ }
            this._cava = null;
        }
    }

    _fallbackTick() {
        if (this._cava) return;
        if (this._active()?.PlaybackStatus !== 'Playing') return;
        for (const bar of this._bars) {
            const h = BAR_MIN + Math.floor(Math.random() * (BAR_MAX - BAR_MIN));
            bar.ease({height: h, duration: 130, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _dropBars() {
        for (const bar of this._bars)
            bar.ease({height: BAR_MIN, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // --------------------------------------------------------------- cleanup
    cleanup() {
        this._destroyed = true;
        this._stopCava();
        this._stopPolling();
        this._artCancellable?.cancel();
        this._session?.abort();
        this._session = null;
        if (this._tickId) { GLib.source_remove(this._tickId); this._tickId = 0; }
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
