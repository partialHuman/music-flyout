import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import Gvc from 'gi://Gvc';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BAR_MIN = 3;
const BAR_MAX = 18;
const CARD_PAD = 14;
const SCROLL_GAP = 40;
const SCROLL_PAUSE_MS = 1500;
const STARTUP_GRACE_US = 1500000;
const VOLUME_STEP = 0.05;
const ICON_SOURCES = ['app-icon', 'album-art', 'playing-status', 'custom-image', 'none'];

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'music-flyout']);
const ART_DIR = GLib.build_filenamev([CACHE_DIR, 'art']);
const LOOP_ORDER = ['None', 'Playlist', 'Track'];
const FALLBACK_ICON = 'audio-x-generic-symbolic';

function readConfig(s) {
    const b = k => s.get_boolean(k);
    const i = k => s.get_int(k);
    const str = k => s.get_string(k);
    return {
        controlsFirst: b('controls-first'),
        hideWhenIdle: b('hide-when-idle'),
        panelShuffle: b('panel-shuffle'),
        panelPrevious: b('panel-previous'),
        panelSkipBack: b('panel-skip-back'),
        panelPlayPause: b('panel-play-pause'),
        panelSkipForward: b('panel-skip-forward'),
        panelNext: b('panel-next'),
        panelLoop: b('panel-loop'),
        iconSource: ICON_SOURCES.includes(str('icon-source')) ? str('icon-source') : 'app-icon',
        iconSize: i('icon-size'),
        iconSpacing: i('icon-spacing'),
        customIconPath: str('custom-icon-path'),
        showTitle: b('show-title'),
        showArtist: b('show-artist'),
        textWidth: i('text-width'),
        scrollText: b('scroll-text'),
        scrollRepeat: b('scroll-repeat'),
        scrollReverse: str('scroll-direction') === 'right-to-left',
        scrollSpeed: Math.max(1, i('scroll-speed')),
        scrollControls: b('scroll-controls'),
        scrollAction: str('scroll-action'),
        volumeTarget: str('volume-scroll-target'),
        invertScrollAnim: b('invert-scroll-animation'),
        invertScroll: b('invert-scroll-direction'),
        secondaryScroll: b('secondary-scroll'),
        secondaryAction: str('secondary-scroll-action'),
        secondaryModifier: str('secondary-scroll-modifier'),
        clickLeft: str('click-left'),
        clickMiddle: str('click-middle'),
        clickRight: str('click-right'),
        hoverOpen: b('hover-open'),
        hoverOpenDelay: i('hover-open-delay'),
        hoverCloseDelay: i('hover-close-delay'),
        showVisualizer: b('show-visualizer'),
        barCount: i('bar-count'),
        useCava: b('use-cava'),
        cavaMethod: str('cava-method') === 'pipewire' ? 'pipewire' : 'pulse',
        cardAlbumArt: b('card-album-art'),
        albumArtSize: str('album-art-size'),
        cardWidth: i('card-width'),
        blur: b('enable-blur'),
        playerSwitcher: b('player-switcher'),
        singlePlayer: b('single-player'),
        seekBar: b('seek-bar'),
        cardSkip: b('card-skip-buttons'),
        skipAmount: i('skip-amount'),
        cardShuffle: b('card-shuffle'),
        cardLoop: b('card-loop'),
    };
}

function cavaConfig(bars, method) {
    return `[general]
bars = ${bars}
framerate = 30

[input]
method = ${method}
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
}

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek"><arg type="x" direction="in" name="Offset"/></method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Volume" type="d" access="readwrite"/>
  </interface>
</node>`);

function fmtTime(us) {
    const s = Math.max(0, Math.floor(us / 1e6));
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function busId(busName) {
    return busName.slice(MPRIS_PREFIX.length).replace(/\.instance[_\d]+$/, '');
}

const MusicIndicator = GObject.registerClass(
class MusicIndicator extends PanelMenu.Button {
    _init(settings, extension) {
        super._init(0.5, 'Music Flyout', false);
        this.add_style_class_name('mf-pill');

        this._ext = extension;
        this._cfg = readConfig(settings);

        // The default "any click toggles the menu" behaviour is replaced by configurable click actions.
        this._allowToggle = false;
        const origToggle = this.menu.toggle.bind(this.menu);
        this.menu.toggle = () => { if (this._allowToggle) origToggle(); };
        this._openedByHover = false;
        this._hoverOpenId = 0;
        this._hoverWatchId = 0;
        this._outsideSince = 0;
        this._iconCache = new Map();
        this._innerW = this._cfg.cardWidth - 2 * CARD_PAD;

        this._players = new Map();
        this._meta = new Map();
        this._selected = null;
        this._destroyed = false;
        this._startedAt = GLib.get_monotonic_time();
        this._bars = [];
        this._shuffleBtns = [];
        this._loopBtns = [];
        this._skipBtns = [];
        this._playBtns = [];
        this._artUrl = null;
        this._trackId = null;
        this._length = 0;
        this._position = 0;
        this._text = null;
        this._switchKey = '';
        this._cava = null;
        this._cavaFailed = false;
        this._session = new Soup.Session({timeout: 10});

        this._buildPanel();
        if (this._controlsBox) {
            this._controlsBox.add_style_class_name(this._cfg.controlsFirst ? 'mf-join-left' : 'mf-join-right');
            this.add_style_class_name(this._cfg.controlsFirst ? 'mf-join-right' : 'mf-join-left');
        }
        this._buildCard();
        this._applyAcrylic();

        this._scrollAcc = 0;
        this._lastScroll = 0;
        this.connect('scroll-event', (_a, event) => this._onScroll(event));
        this._controlsBox?.connect('scroll-event', (_a, event) => this._onScroll(event));
        this._setupHover();
        this.connect('key-press-event', (_a, ev) => {
            const sym = ev.get_key_symbol();
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_space) {
                this._toggleCard();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const c0 = this._cfg;
        const usesVolume = c0.scrollAction === 'change-volume' ||
            (c0.secondaryScroll && c0.secondaryAction === 'change-volume');
        if (c0.scrollControls && usesVolume && c0.volumeTarget === 'system')
            this._openMixer();

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._startPolling();
            } else {
                this._stopPolling();
                this._openedByHover = false;
                this._stopHoverWatch();
            }
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

        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            this._fallbackTick();
            return GLib.SOURCE_CONTINUE;
        });

        this._update();
    }

    // ================================================================ PANEL
    _buildPanel() {
        const c = this._cfg;
        const box = new St.BoxLayout({style_class: 'mf-pill-box', y_align: Clutter.ActorAlign.CENTER});

        // Panel controls live in their own panel item (a sibling of this button), NOT inside it:
        // St.Buttons nested in a PanelMenu.Button lose their clicks to the parent's click handling.
        this._controlsBox = this._buildPanelControls();

        if (c.iconSource !== 'none') {
            const size = c.iconSize;
            this._iconWrap = new St.Widget({
                width: size, height: size, y_align: Clutter.ActorAlign.CENTER,
                style: `margin-right: ${c.iconSpacing}px;`,
            });
            this._pIcon = new St.Icon({icon_name: FALLBACK_ICON, icon_size: size});
            this._pArt = new St.Widget({width: size, height: size, visible: false});
            this._iconWrap.add_child(this._pIcon);
            this._iconWrap.add_child(this._pArt);
            box.add_child(this._iconWrap);
        }

        if (c.showTitle || c.showArtist) {
            this._textClip = new St.Widget({
                clip_to_allocation: true, width: c.textWidth, y_align: Clutter.ActorAlign.CENTER,
                style: c.showVisualizer ? 'margin-right: 6px;' : '',
            });
            this._scroller = new St.Widget();
            this._label1 = new St.Label({style_class: 'mf-label'});
            this._label2 = new St.Label({style_class: 'mf-label', visible: false});
            this._scroller.add_child(this._label1);
            this._scroller.add_child(this._label2);
            this._textClip.add_child(this._scroller);
            box.add_child(this._textClip);
        }

        if (c.showVisualizer) {
            const bars = new St.BoxLayout({style_class: 'mf-bars', y_align: Clutter.ActorAlign.CENTER});
            for (let i = 0; i < c.barCount; i++) {
                const bar = new St.Widget({style_class: 'mf-bar', y_align: Clutter.ActorAlign.CENTER, height: BAR_MIN});
                this._bars.push(bar);
                bars.add_child(bar);
            }
            box.add_child(bars);
        }

        if (box.get_n_children() === 0) {   // never leave an empty pill
            this._pIcon = new St.Icon({icon_name: FALLBACK_ICON, icon_size: 16});
            box.add_child(this._pIcon);
        }
        this.add_child(box);
    }

    _buildPanelControls() {
        const c = this._cfg;
        const inner = new St.BoxLayout({style_class: 'mf-pcontrols', y_align: Clutter.ActorAlign.CENTER});
        const add = (enabled, icon, fn, registry) => {
            if (!enabled) return;
            const btn = this._makeButton(icon, 14, 'mf-pbtn', fn);
            registry?.push(btn);
            inner.add_child(btn);
        };
        add(c.panelShuffle, 'media-playlist-shuffle-symbolic', () => this._toggleShuffle(), this._shuffleBtns);
        add(c.panelPrevious, 'media-skip-backward-symbolic', () => this._active()?.PreviousRemote());
        add(c.panelSkipBack, 'media-seek-backward-symbolic', () => this._skip(-1), this._skipBtns);
        add(c.panelPlayPause, 'media-playback-start-symbolic', () => this._active()?.PlayPauseRemote(), this._playBtns);
        add(c.panelSkipForward, 'media-seek-forward-symbolic', () => this._skip(1), this._skipBtns);
        add(c.panelNext, 'media-skip-forward-symbolic', () => this._active()?.NextRemote());
        add(c.panelLoop, 'media-playlist-repeat-symbolic', () => this._cycleLoop(), this._loopBtns);
        if (inner.get_n_children() === 0) return null;

        // addToStatusArea() only accepts PanelMenu.Button; `true` = no popup menu for this one
        const box = new PanelMenu.Button(0.5, 'Music Flyout Controls', true);
        box.add_style_class_name('mf-pill');
        box.add_child(inner);
        return box;
    }

    get controlsBox() {
        return this._controlsBox ?? null;
    }

    // Left / middle / right click actions (defaults: play-pause / none / open card)
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            const c = this._cfg;
            const b = event.get_button();
            const action = b === Clutter.BUTTON_PRIMARY ? c.clickLeft
                : b === Clutter.BUTTON_MIDDLE ? c.clickMiddle
                : b === Clutter.BUTTON_SECONDARY ? c.clickRight : 'none';
            this._runClickAction(action);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.TOUCH_BEGIN) {   // touch screens: tap opens the card
            this._toggleCard();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    _runClickAction(action) {
        switch (action) {
        case 'play-pause': this._active()?.PlayPauseRemote(); break;
        case 'open-card': this._toggleCard(); break;
        case 'next': this._active()?.NextRemote(); break;
        case 'previous': this._active()?.PreviousRemote(); break;
        default: break;
        }
    }

    _toggleCard() {
        if (this.menu.isOpen && this._openedByHover) {   // opened by hover: pin it open
            this._openedByHover = false;
            this._stopHoverWatch();
            return;
        }
        this._allowToggle = true;
        this.menu.toggle();
        this._allowToggle = false;
    }

    // ================================================================= CARD
    _buildCard() {
        const c = this._cfg;
        const W = this._innerW;
        const content = new St.BoxLayout({vertical: true, style_class: 'mf-content', width: c.cardWidth});

        // Album art
        const sizes = {small: 120, medium: 200, large: W};
        this._artSize = Math.min(sizes[c.albumArtSize] ?? W, W);
        this._artIcon = new St.Icon({
            icon_name: FALLBACK_ICON, icon_size: Math.min(128, Math.round(this._artSize / 2)),
            style_class: 'mf-art-icon', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this._art = new St.Bin({
            style_class: 'mf-art', width: this._artSize, height: this._artSize,
            x_align: Clutter.ActorAlign.CENTER, child: this._artIcon, visible: c.cardAlbumArt,
        });
        content.add_child(this._art);

        this._title = new St.Label({style_class: 'mf-title', width: W});
        this._artist = new St.Label({style_class: 'mf-artist', width: W});
        content.add_child(this._title);
        content.add_child(this._artist);

        // Seek bar
        this._progressBox = new St.BoxLayout({vertical: true, visible: false});
        this._track = new St.Widget({style_class: 'mf-track', reactive: true, track_hover: true, width: W, height: 6});
        this._fill = new St.Widget({style_class: 'mf-fill', width: 0, height: 6});
        this._track.add_child(this._fill);
        this._track.connect('button-press-event', (_a, event) => {
            this._seekFromEvent(event);
            return Clutter.EVENT_STOP;
        });
        this._progressBox.add_child(this._track);
        const times = new St.BoxLayout({width: W});
        this._elapsed = new St.Label({style_class: 'mf-time', text: '0:00', x_expand: true});
        this._remaining = new St.Label({style_class: 'mf-time', text: '-0:00'});
        times.add_child(this._elapsed);
        times.add_child(this._remaining);
        this._progressBox.add_child(times);
        content.add_child(this._progressBox);

        // Controls: [shuffle]  [skip-back prev PLAY next skip-fwd]  [loop]
        const controls = new St.BoxLayout({style_class: 'mf-controls', width: W});
        const slot = (btn) => new St.Bin({width: 40, child: btn, x_align: Clutter.ActorAlign.CENTER});

        const left = slot(c.cardShuffle ? this._reg(this._shuffleBtns,
            this._makeButton('media-playlist-shuffle-symbolic', 18, '', () => this._toggleShuffle())) : null);
        const right = slot(c.cardLoop ? this._reg(this._loopBtns,
            this._makeButton('media-playlist-repeat-symbolic', 18, '', () => this._cycleLoop())) : null);

        const mid = new St.BoxLayout({style_class: 'mf-mid', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        if (c.cardSkip)
            mid.add_child(this._reg(this._skipBtns, this._makeButton('media-seek-backward-symbolic', 18, '', () => this._skip(-1))));
        mid.add_child(this._makeButton('media-skip-backward-symbolic', 22, '', () => this._active()?.PreviousRemote()));
        mid.add_child(this._reg(this._playBtns,
            this._makeButton('media-playback-start-symbolic', 26, 'mf-play', () => this._active()?.PlayPauseRemote())));
        mid.add_child(this._makeButton('media-skip-forward-symbolic', 22, '', () => this._active()?.NextRemote()));
        if (c.cardSkip)
            mid.add_child(this._reg(this._skipBtns, this._makeButton('media-seek-forward-symbolic', 18, '', () => this._skip(1))));

        controls.add_child(left);
        controls.add_child(mid);
        controls.add_child(right);
        content.add_child(controls);

        // Bottom row: player switcher + settings button
        const bottom = new St.BoxLayout({style_class: 'mf-bottom', width: W});
        this._switcher = new St.BoxLayout({style_class: 'mf-switcher', x_expand: true});
        bottom.add_child(this._switcher);
        const gear = new St.Button({
            style_class: 'mf-gear', reactive: true, track_hover: true, can_focus: true,
            child: new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 16}),
        });
        gear.connect('clicked', () => {
            this.menu.close();
            this._ext.openPreferences();
        });
        bottom.add_child(gear);
        content.add_child(bottom);

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('mf-item');
        item.add_child(content);
        this.menu.addMenuItem(item);
    }

    _reg(list, btn) {
        list.push(btn);
        return btn;
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

    _setToggle(btn, on) {
        if (on) btn.add_style_class_name('mf-toggle-on');
        else btn.remove_style_class_name('mf-toggle-on');
    }

    _applyAcrylic() {
        const actor = this.menu.actor ?? this.menu._boxPointer;
        actor.add_style_class_name('mf-menu');
        if (!this._cfg.blur) return;
        try {
            const blur = new Shell.BlurEffect({
                brightness: 0.75, sigma: 30, mode: Shell.BlurMode.BACKGROUND,
            });
            actor.add_effect_with_name('mf-blur', blur);
        } catch (e) {
            logError(e, 'Music Flyout: blur unavailable');
        }
    }

    // ============================================================ ACTIONS
    _toggleShuffle() {
        const p = this._active();
        if (!p || p.Shuffle === null || p.Shuffle === undefined) return;
        try { p.Shuffle = !p.Shuffle; } catch (e) { logError(e); }
    }

    _cycleLoop() {
        const p = this._active();
        if (!p || !p.LoopStatus) return;
        const next = LOOP_ORDER[(LOOP_ORDER.indexOf(p.LoopStatus) + 1) % LOOP_ORDER.length];
        try { p.LoopStatus = next; } catch (e) { logError(e); }
    }

    _skip(direction) {
        this._active()?.SeekRemote(direction * this._cfg.skipAmount * 1000000);
    }

    _pauseOthers(except) {
        for (const [n, p] of this._players)
            if (n !== except && p.PlaybackStatus === 'Playing') p.PauseRemote();
    }

    // ======================================================== SCROLL CONTROLS
    _onScroll(event) {
        if (!this._cfg.scrollControls) return Clutter.EVENT_PROPAGATE;

        let dir = 0;                                   // +1 = scrolled up, -1 = down
        const d = event.get_scroll_direction();
        if (d === Clutter.ScrollDirection.UP) {
            dir = 1;
        } else if (d === Clutter.ScrollDirection.DOWN) {
            dir = -1;
        } else if (d === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            if (event.get_scroll_source() === Clutter.ScrollSource.WHEEL) {
                dir = dy < 0 ? 1 : (dy > 0 ? -1 : 0);
            } else {                                   // touchpad: accumulate small deltas
                this._scrollAcc += dy;
                if (Math.abs(this._scrollAcc) >= 15) {
                    dir = this._scrollAcc < 0 ? 1 : -1;
                    this._scrollAcc = 0;
                }
            }
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        if (dir === 0) return Clutter.EVENT_STOP;

        const now = GLib.get_monotonic_time();
        if (now - this._lastScroll < 80000) return Clutter.EVENT_STOP;
        this._lastScroll = now;

        this._jump(dir);
        this._doScroll(this._cfg.invertScroll ? -dir : dir, this._scrollActionFor(event));
        return Clutter.EVENT_STOP;
    }

    // Modifier keys currently held, as a Set of 'ctrl' | 'alt' | 'shift' | 'super'
    _heldModifiers(event) {
        let state = 0;
        try { state = event.get_state(); } catch (e) { state = global.get_pointer()[2]; }
        const T = Clutter.ModifierType;
        const held = new Set();
        if (state & T.CONTROL_MASK) held.add('ctrl');
        if (state & T.MOD1_MASK) held.add('alt');
        if (state & T.SHIFT_MASK) held.add('shift');
        if (state & ((T.SUPER_MASK ?? 0) | T.MOD4_MASK)) held.add('super');
        return held;
    }

    _scrollActionFor(event) {
        const c = this._cfg;
        if (!c.secondaryScroll) return c.scrollAction;
        const want = new Set(c.secondaryModifier.split('-'));
        const held = this._heldModifiers(event);
        const match = want.size === held.size && [...want].every(m => held.has(m));
        return match ? c.secondaryAction : c.scrollAction;
    }

    _doScroll(dir, action) {
        switch (action) {
        case 'change-track':
            if (dir > 0) this._active()?.NextRemote();
            else this._active()?.PreviousRemote();
            break;
        case 'change-volume':
            if (this._cfg.volumeTarget === 'player') this._scrollPlayerVolume(dir);
            else this._scrollSystemVolume(dir);
            break;
        case 'switch-player':
            this._switchPlayer(dir);
            break;
        case 'seek':
            this._skip(dir > 0 ? 1 : -1);
            break;
        }
    }

    _switchPlayer(dir) {
        const names = [...this._players.keys()];
        if (names.length < 2) return;
        const i = names.indexOf(this._activeName());
        this._selected = names[(i + (dir > 0 ? 1 : -1) + names.length) % names.length];
        this._update();
    }

    _scrollPlayerVolume(dir) {
        const p = this._active();
        if (!p || p.Volume === null || p.Volume === undefined) return;
        try {
            p.Volume = Math.min(1, Math.max(0, p.Volume + dir * VOLUME_STEP));
        } catch (e) { logError(e); }
    }

    _openMixer() {
        if (this._mixer) return;
        try {
            this._mixer = new Gvc.MixerControl({name: 'Music Flyout'});
            this._mixer.open();
        } catch (e) {
            logError(e, 'Music Flyout: volume control unavailable');
            this._mixer = null;
        }
    }

    _closeMixer() {
        if (!this._mixer) return;
        try { this._mixer.close(); } catch (e) { /* ignore */ }
        this._mixer = null;
    }

    _scrollSystemVolume(dir) {
        this._openMixer();
        const mixer = this._mixer;
        if (!mixer || mixer.get_state() !== Gvc.MixerControlState.READY) return;
        const sink = mixer.get_default_sink();
        if (!sink) return;
        const max = mixer.get_vol_max_norm();
        const next = Math.min(max, Math.max(0, sink.volume + dir * VOLUME_STEP * max));
        if (dir > 0 && sink.is_muted) sink.change_is_muted(false);
        sink.volume = next;
        sink.push_volume();
    }

    // Small "jump" of the pill in the scroll direction
    _jump(dir) {
        const sign = (dir > 0 ? -1 : 1) * (this._cfg.invertScrollAnim ? -1 : 1);
        for (const actor of [this, this._controlsBox]) {
            if (!actor) continue;
            actor.ease({
                translation_y: sign * 3, duration: 70, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._destroyed) return;
                    actor.ease({translation_y: 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                },
            });
        }
    }

    // ================================================================= HOVER
    _setupHover() {
        const onHover = () => this._onPillHover();
        this.connect('notify::hover', onHover);
        this._controlsBox?.connect('notify::hover', onHover);
    }

    _pillHovered() {
        return this.hover || (this._controlsBox?.hover ?? false);
    }

    _onPillHover() {
        if (!this._cfg.hoverOpen || this._destroyed) return;
        if (this._pillHovered()) {
            if (this.menu.isOpen || this._hoverOpenId) return;
            this._hoverOpenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._cfg.hoverOpenDelay, () => {
                this._hoverOpenId = 0;
                if (!this._destroyed && this._pillHovered() && !this.menu.isOpen) {
                    this._openedByHover = true;
                    this._allowToggle = true;
                    this.menu.toggle();
                    this._allowToggle = false;
                    this._startHoverWatch();
                }
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._hoverOpenId) {
            GLib.source_remove(this._hoverOpenId);
            this._hoverOpenId = 0;
        }
    }

    // While the card is open the menu holds a grab, so hover signals are unreliable:
    // watch the pointer position instead and close once it has left pill + card for a while.
    _startHoverWatch() {
        this._stopHoverWatch();
        this._outsideSince = 0;
        this._hoverWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            if (this._destroyed || !this.menu.isOpen || !this._openedByHover) {
                this._hoverWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._pointerInside()) {
                this._outsideSince = 0;
            } else {
                const now = GLib.get_monotonic_time();
                if (!this._outsideSince) {
                    this._outsideSince = now;
                } else if (now - this._outsideSince >= this._cfg.hoverCloseDelay * 1000) {
                    this._hoverWatchId = 0;
                    this.menu.close();
                    return GLib.SOURCE_REMOVE;
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopHoverWatch() {
        if (this._hoverWatchId) { GLib.source_remove(this._hoverWatchId); this._hoverWatchId = 0; }
        this._outsideSince = 0;
    }

    _pointerInside() {
        const [x, y] = global.get_pointer();
        const rects = [];
        for (const a of [this, this._controlsBox, this.menu.actor ?? this.menu._boxPointer]) {
            if (!a || !a.visible) continue;
            const [ax, ay] = a.get_transformed_position();
            const [w, h] = a.get_transformed_size();
            rects.push([ax, ay, ax + w, ay + h]);
        }
        if (!rects.length) return false;
        const m = 6;   // forgiving margin; the bounding box also bridges the gap between pill and card
        const x0 = Math.min(...rects.map(r => r[0])) - m;
        const y0 = Math.min(...rects.map(r => r[1])) - m;
        const x1 = Math.max(...rects.map(r => r[2])) + m;
        const y1 = Math.max(...rects.map(r => r[3])) + m;
        return x >= x0 && x <= x1 && y >= y0 && y <= y1;
    }

    // ============================================================ PANEL ICON
    _updatePanelIcon() {
        if (!this._pIcon) return;
        const c = this._cfg;
        const name = this._activeName();
        let showArt = false;

        switch (c.iconSource) {
        case 'album-art':
            if (this._artPath) showArt = true;
            else this._applyPlayerIcon(this._pIcon, name);
            break;
        case 'playing-status': {
            const st = this._active()?.PlaybackStatus;
            this._pIcon.gicon = null;
            this._pIcon.icon_name = st === 'Playing' ? 'media-playback-start-symbolic'
                : st === 'Paused' ? 'media-playback-pause-symbolic' : 'media-playback-stop-symbolic';
            break;
        }
        case 'custom-image':
            if (c.customIconPath && GLib.file_test(c.customIconPath, GLib.FileTest.EXISTS)) {
                this._pIcon.gicon = new Gio.FileIcon({file: Gio.File.new_for_path(c.customIconPath)});
            } else {
                this._pIcon.gicon = null;
                this._pIcon.icon_name = FALLBACK_ICON;
            }
            break;
        default:
            this._applyPlayerIcon(this._pIcon, name);
        }

        this._pIcon.visible = !showArt;
        if (this._pArt) {
            this._pArt.visible = showArt;
            if (showArt) {
                const uri = GLib.filename_to_uri(this._artPath, null);
                this._pArt.style = `border-radius: ${Math.round(c.iconSize / 4)}px; ` +
                    `background-image: url("${uri}"); background-size: cover;`;
            }
        }
    }

    // ============================================================= PLAYERS
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
                if (c.PlaybackStatus && c.PlaybackStatus.unpack() === 'Playing') {
                    this._selected = name;
                    // "Play one player at a time" – but leave players that were already running at startup alone
                    if (this._cfg.singlePlayer &&
                        GLib.get_monotonic_time() - this._startedAt > STARTUP_GRACE_US)
                        this._pauseOthers(name);
                }
                this._update();
            });
            this._players.set(name, proxy);
            this._meta.set(name, {entry: null});
            this._fetchDesktopEntry(name);
            if (proxy.PlaybackStatus === 'Playing' || !this._selected)
                this._selected = name;
            this._update();
        });
    }

    _fetchDesktopEntry(name) {
        Gio.DBus.session.call(name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [ROOT_IFACE, 'DesktopEntry']),
            GLib.VariantType.new('(v)'), Gio.DBusCallFlags.NONE, 1000, null,
            (conn, res) => {
                try {
                    const [entry] = conn.call_finish(res).recursiveUnpack();
                    if (this._destroyed || !this._players.has(name)) return;
                    this._meta.set(name, {entry});
                    this._switchKey = '';
                    this._update();
                } catch (e) { /* player has no DesktopEntry */ }
            });
    }

    _removePlayer(name) {
        this._players.delete(name);
        this._meta.delete(name);
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

    _iconUsable(icon) {
        try {
            if (icon instanceof Gio.FileIcon) return icon.get_file().query_exists(null);
            if (icon instanceof Gio.ThemedIcon) {
                this._iconTheme ??= new St.IconTheme();
                return icon.get_names().some(n => this._iconTheme.has_icon(n));
            }
        } catch (e) { /* can't verify: assume it works */ }
        return true;
    }

    _playerGIcon(name) {
        const entry = this._meta.get(name)?.entry ?? '';
        const id = busId(name);
        const key = `${entry}|${id}`;
        if (this._iconCache.has(key)) return this._iconCache.get(key);

        const wants = [entry, id].filter(x => x && x.length >= 4).map(x => x.toLowerCase());
        const candidates = [];
        try {
            // 1) exact desktop ids (deb: spotify.desktop, snap: spotify_spotify.desktop)
            const sys = Shell.AppSystem.get_default();
            for (const x of [entry, id, `${id}_${id}`]) {
                const icon = x ? sys.lookup_app(`${x}.desktop`)?.get_icon() : null;
                if (icon) candidates.push(icon);
            }
            // 2) fuzzy match over every installed app (flatpak: com.spotify.Client.desktop, ...)
            for (const info of Gio.AppInfo.get_all()) {
                const aid = (info.get_id() ?? '').replace(/\.desktop$/, '').toLowerCase();
                if (wants.some(w => aid === w || aid.includes(w))) {
                    const icon = info.get_icon();
                    if (icon) candidates.push(icon);
                }
            }
        } catch (e) {
            logError(e, 'Music Flyout: app icon lookup');
        }
        // 3) icon-theme names
        for (const n of [entry, id, `${id}-client`])
            if (n) candidates.push(new Gio.ThemedIcon({name: n}));

        let result = candidates.find(i => this._iconUsable(i)) ?? null;

        // 4) bundled fallback for well-known players whose own icon can't be resolved
        if (!result && wants.some(w => w.includes('spotify'))) {
            const file = Gio.File.new_for_path(`${this._ext.path}/icons/spotify.svg`);
            if (file.query_exists(null)) result = new Gio.FileIcon({file});
        }

        this._iconCache.set(key, result);
        return result;
    }

    _applyPlayerIcon(widget, name) {
        const gicon = name ? this._playerGIcon(name) : null;
        if (gicon) {
            widget.gicon = gicon;
        } else {
            widget.gicon = null;
            widget.icon_name = FALLBACK_ICON;
        }
    }

    _rebuildSwitcher() {
        if (!this._cfg.playerSwitcher) return;
        const names = [...this._players.keys()];
        const active = this._activeName();
        const key = `${names.join('|')}#${active}#${[...this._meta.values()].map(m => m.entry).join(',')}`;
        if (key === this._switchKey) return;
        this._switchKey = key;

        this._switcher.destroy_all_children();
        if (names.length < 2) return;
        for (const n of names) {
            const icon = new St.Icon({icon_size: 18});
            this._applyPlayerIcon(icon, n);
            const btn = new St.Button({
                style_class: n === active ? 'mf-chip mf-chip-active' : 'mf-chip',
                child: icon, reactive: true, track_hover: true,
            });
            btn.connect('clicked', () => { this._selected = n; this._update(); });
            this._switcher.add_child(btn);
        }
    }

    // ============================================================== UPDATE
    _update() {
        if (this._destroyed) return;
        const c = this._cfg;
        const p = this._active();
        const name = this._activeName();

        this.visible = !!p || !c.hideWhenIdle;
        if (this._controlsBox) this._controlsBox.visible = this.visible;
        this._rebuildSwitcher();
        this._updatePanelIcon();
        this._applyPlayerIcon(this._artIcon, name);

        if (!p) {
            this._stopCava();
            this._dropBars();
            this._trackId = null;
            this._length = 0;
            this._position = 0;
            this._title.text = 'Nothing playing';
            this._artist.text = '';
            this._setText('Nothing playing');
            this._setArt(null);
            this._syncControls(null);
            this._renderProgress();
            return;
        }

        const md = p.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        const title = md['xesam:title'] ?? 'Unknown title';
        const artist = (md['xesam:artist'] ?? []).join(', ');
        this._trackId = md['mpris:trackid'] ?? null;
        this._length = Number(md['mpris:length'] ?? 0);

        this._title.text = title;
        this._artist.text = artist;

        const parts = [];
        if (c.showArtist && artist) parts.push(artist);
        if (c.showTitle) parts.push(title);
        this._setText(parts.join(' – '));

        this._syncControls(p);
        if (c.cardAlbumArt || c.iconSource === 'album-art') this._setArt(md['mpris:artUrl'] ?? null);
        this._syncVisualizer(p.PlaybackStatus === 'Playing');
        if (this.menu.isOpen) this._pollPosition();
        else this._renderProgress();
    }

    _syncControls(p) {
        const hasShuffle = !!p && p.Shuffle !== null && p.Shuffle !== undefined;
        const hasLoop = !!p?.LoopStatus;
        const canSeek = !!p?.CanSeek;
        const playing = p?.PlaybackStatus === 'Playing';

        for (const b of this._shuffleBtns) {
            b.visible = hasShuffle;
            this._setToggle(b, hasShuffle && p.Shuffle === true);
        }
        for (const b of this._loopBtns) {
            b.visible = hasLoop;
            this._setToggle(b, hasLoop && p.LoopStatus !== 'None');
            b.child.icon_name = p?.LoopStatus === 'Track'
                ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        }
        for (const b of this._skipBtns) b.visible = canSeek;
        for (const b of this._playBtns)
            b.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
    }

    // ======================================================== SCROLLING TEXT
    _setText(text) {
        if (!this._label1 || text === this._text) return;
        this._text = text;
        this._layoutText(true);
    }

    _stopScroll() {
        this._scroller?.remove_all_transitions();
        if (this._scroller) this._scroller.translation_x = 0;
    }

    _layoutText(allowRetry) {
        if (this._destroyed || !this._label1) return;
        const c = this._cfg;
        this._stopScroll();

        const text = this._text ?? '';
        this._label1.text = text;
        this._label1.set_width(-1);
        this._label1.x = 0;
        this._label2.hide();

        const [, nat] = this._label1.get_preferred_width(-1);
        if (nat === 0 && text && allowRetry) {   // not styled yet: measure again once idle
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._layoutText(false);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (nat <= c.textWidth) return;

        if (!c.scrollText) {                      // shorten with an ellipsis
            this._label1.set_width(c.textWidth);
            return;
        }

        if (c.scrollRepeat) {
            this._label2.text = text;
            this._label2.x = nat + SCROLL_GAP;
            this._label2.show();
            this._runScroll(nat + SCROLL_GAP, true);
        } else {
            this._runScroll(nat - c.textWidth, false);
        }
    }

    _runScroll(dist, loop) {
        const c = this._cfg;
        const duration = Math.max(300, Math.round(dist / c.scrollSpeed * 1000));
        const from = c.scrollReverse ? -dist : 0;
        const to = c.scrollReverse ? 0 : -dist;
        const step = (first) => {
            if (this._destroyed) return;
            this._scroller.translation_x = from;
            this._scroller.ease({
                translation_x: to, duration,
                delay: first ? SCROLL_PAUSE_MS : 0,
                mode: Clutter.AnimationMode.LINEAR,
                onComplete: () => { if (loop) step(false); },
            });
        };
        step(true);
    }

    // ============================================================ ALBUM ART
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
            ART_DIR, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1),
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
                GLib.mkdir_with_parents(ART_DIR, 0o755);
                GLib.file_set_contents(cached, bytes.get_data());
                this._applyArt(cached);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'Music Flyout: album art');
            }
        });
    }

    _applyArt(path) {
        this._artPath = path ?? null;
        this._updatePanelIcon();
        if (path) {
            const uri = GLib.filename_to_uri(path, null);
            this._art.style = `background-image: url("${uri}"); background-size: cover;`;
            this._artIcon.hide();
        } else {
            this._art.style = '';
            this._artIcon.show();
        }
    }

    // ============================================================ PROGRESS
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
        this._progressBox.visible = this._cfg.seekBar && this._length > 0;
        const frac = this._length > 0 ? Math.min(1, Math.max(0, this._position / this._length)) : 0;
        this._fill.width = Math.round(this._innerW * frac);
        this._elapsed.text = fmtTime(this._position);
        this._remaining.text = this._length > 0 ? `-${fmtTime(this._length - this._position)}` : '';
    }

    _seekFromEvent(event) {
        const p = this._active();
        if (!p || !this._trackId || this._length <= 0) return;
        const [sx] = event.get_coords();
        const [tx] = this._track.get_transformed_position();
        const frac = Math.min(1, Math.max(0, (sx - tx) / this._innerW));
        const pos = Math.floor(frac * this._length);
        p.SetPositionRemote(this._trackId, pos);
        this._position = pos;
        this._renderProgress();
    }

    // ========================================================== VISUALIZER
    _syncVisualizer(playing) {
        if (!this._cfg.showVisualizer) return;
        if (playing && this._cfg.useCava) this._startCava();
        else this._stopCava();
        if (!playing) this._dropBars();
    }

    _startCava() {
        if (this._cava || this._cavaFailed) return;
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o755);
            const conf = GLib.build_filenamev([CACHE_DIR, 'cava.conf']);
            GLib.file_set_contents(conf, cavaConfig(this._cfg.barCount, this._cfg.cavaMethod));
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
        if (this._cava || !this._bars.length) return;
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

    // ============================================================= CLEANUP
    cleanup() {
        this._destroyed = true;
        this._stopCava();
        this._stopPolling();
        this._stopScroll();
        this._closeMixer();
        this._stopHoverWatch();
        if (this._hoverOpenId) { GLib.source_remove(this._hoverOpenId); this._hoverOpenId = 0; }
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
        this._settings = this.getSettings();
        this._settingsId = this._settings.connect('changed', () => this._scheduleRebuild());
        this._create();
    }

    disable() {
        if (this._rebuildId) { GLib.source_remove(this._rebuildId); this._rebuildId = 0; }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._destroyIndicator();
        this._settings = null;
    }

    _create() {
        const pos = this._settings.get_string('panel-position');
        const box = ['left', 'center', 'right'].includes(pos) ? pos : 'center';
        this._indicator = new MusicIndicator(this._settings, this);
        const controls = this._indicator.controlsBox;
        const first = this._settings.get_boolean('controls-first');
        const addControls = () =>
            Main.panel.addToStatusArea(`${this.uuid}-controls`, controls, 0, box);

        // Each addToStatusArea() inserts at index 0, so the item added last ends up leftmost.
        if (controls && !first) addControls();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, box);
        if (controls && first) addControls();
    }

    _destroyIndicator() {
        const controls = this._indicator?.controlsBox;
        this._indicator?.cleanup();
        this._indicator?.destroy();
        controls?.destroy();
        this._indicator = null;
    }

    // Any preference change rebuilds the indicator (debounced, so "Reset" doesn't rebuild 30 times).
    _scheduleRebuild() {
        if (this._rebuildId) GLib.source_remove(this._rebuildId);
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._rebuildId = 0;
            this._destroyIndicator();
            this._create();
            return GLib.SOURCE_REMOVE;
        });
    }
}
