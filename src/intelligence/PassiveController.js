/* Small non-modal Shell surface. Observation, inference and edits stay in service. */
import Gio from 'gi://Gio';
import IBus from 'gi://IBus';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as IBusManager from 'resource:///org/gnome/shell/misc/ibusManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {addDiff} from './ResponseView.js';

const BUS = 'org.gnome.DesktopIntelligence1';
const PATH = '/org/gnome/DesktopIntelligence1';

export class PassiveController {
  constructor(settings, icon, palette) {
    this.settings = settings;
    this.palette = palette;
    this.bindings = [];
    this.subscriptions = [];
    this.destroyed = false;
    this.suspended = false;
    this.actor = new St.BoxLayout({
      style_class: 'popup-menu-content gdi-passive', vertical: true,
      visible: false, reactive: true, can_focus: false, width: 340,
    });
    this.header = new St.BoxLayout({style_class: 'gdi-passive-header'});
    this.header.add_child(new St.Icon({gicon: icon, icon_size: 14}));
    this.heading = new St.Label({text: 'Writing correction', x_expand: true});
    this.header.add_child(this.heading);
    this.actor.add_child(this.header);
    this.text = new St.Label({style_class: 'gdi-passive-text', x_expand: true});
    this.text.clutter_text.line_wrap = true;
    this.text.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    this.text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    this.diff = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'gdi-passive-diff'});
    this.actor.add_child(this.diff);
    this.actor.add_child(this.text);
    this.controls = new St.BoxLayout({style_class: 'gdi-passive-controls'});
    this.acceptButton = new St.Button({style_class: 'button default', label: 'Accept', can_focus: false});
    this.cancelButton = new St.Button({style_class: 'button flat', label: 'Esc', accessible_name: 'Dismiss suggestion (Escape)', can_focus: false});
    this.controls.add_child(this.acceptButton);
    this.controls.add_child(this.cancelButton);
    this.actor.add_child(this.controls);
    Main.uiGroup.add_child(this.actor);
    this.acceptButton.connect('clicked', () => this.accept());
    this.cancelButton.connect('clicked', () => this.dismiss());
    this.inputIds = ['notify::content-purpose', 'notify::content-hints'].map(signal =>
      Main.inputMethod.connect(signal, () => this.syncFocus()));
    this.cursorId = Main.inputMethod.connect('cursor-location-changed', (_method, rect) =>
      this.updateCaret({x: rect.get_x(), y: rect.get_y(), height: rect.get_height()}));
    this.ibus = IBusManager.getIBusManager();
    this.ibusPrivacyId = this.ibus.connect('set-content-type', (_manager, purpose, hints) => {
      const sensitive = purpose === IBus.InputPurpose.PASSWORD || purpose === IBus.InputPurpose.PIN ||
        !!(hints & IBus.InputHints.PRIVATE);
      if (sensitive !== this.ibusSensitive) {
        this.ibusSensitive = sensitive;
        this.syncFocus();
      }
    });
    this.ibusId = this.ibus.connect('set-cursor-location', (_manager, rect) => {
      if (!Main.inputMethod.currentFocus) this.updateCaret(rect);
    });
    this.focusId = global.display.connect('notify::focus-window', () => this.syncFocus());
    this.overviewIds = ['showing', 'hidden'].map(signal => Main.overview.connect(signal, () => this.syncFocus()));
    this.lockId = Main.sessionMode.connect('updated', () => this.syncFocus());
    this.settingsId = settings.connect('changed', (_s, key) => {
      if (key.startsWith('passive-') || key === 'enable-passive-writing') this.syncFocus();
    });
    Gio.bus_get(Gio.BusType.SESSION, null, (_source, result) => {
      if (this.destroyed) {
        try { this.bus = Gio.bus_get_finish(result); this._sendDisabled(); } catch { /* Service never knew about this controller. */ }
        return;
      }
      try { this.bus = Gio.bus_get_finish(result); } catch { return; }
      for (const signal of ['PassiveSuggestion', 'PassiveHidden', 'PassiveAnchorRequest']) {
        this.subscriptions.push(this.bus.signal_subscribe(BUS, BUS, signal, PATH, null,
          Gio.DBusSignalFlags.NONE, (_b, _s, _p, _i, name, parameters) => {
            if (name === 'PassiveAnchorRequest') {
              this.anchorPending = true;
              const rect = this.window?.get_frame_rect();
              const caret = this.caret;
              // The service may legitimately take several seconds (debounce,
              // AT-SPI latency, rate limiting) between the last keystroke and
              // this request. Any real caret movement emits a fresh cursor
              // event and focus changes clear the snapshot, so 8s is safe.
              const fresh = caret && caret.window === this.window && GLib.get_monotonic_time() - caret.time < 8000000;
              this.call('SetPassiveAnchor', '(ss)', [parameters.deep_unpack()[0], JSON.stringify(fresh && rect
                ? {x: caret.x - rect.x, y: caret.y - rect.y, height: caret.height} : {})]);
            } else if (name === 'PassiveHidden') this.hide();
            else {
              try { this.show(JSON.parse(parameters.deep_unpack()[0])); } catch { this.hide(); }
            }
          }));
      }
      this.subscriptions.push(this.bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
        'NameOwnerChanged', '/org/freedesktop/DBus', BUS, Gio.DBusSignalFlags.NONE,
        (_b, _s, _p, _i, _n, parameters) => {
          if (!parameters.deep_unpack()[2]) this.hide();
        }));
      this.syncFocus();
    });
  }

  call(method, signature, args, callback = () => {}) {
    if (!this.bus || this.destroyed) return;
    const flags = method === 'ConfigurePassive' && !args[0] ? Gio.DBusCallFlags.NO_AUTO_START : Gio.DBusCallFlags.NONE;
    this.bus.call(BUS, PATH, BUS, method, new GLib.Variant(signature, args), null,
      flags, 5000, null, (bus, result) => {
        let reply;
        try { reply = bus.call_finish(result).deep_unpack(); } catch {
          if (method === 'AcceptPassive' || method === 'UndoPassive') { this.applying = false; this.hide(); }
          return;
        }
        if (!this.destroyed) callback(reply);
      });
  }

  updateCaret(rect) {
    if (!this.settings.get_boolean('enable-passive-writing') || !this.window) return;
    if (!this.applying && GLib.get_monotonic_time() > (this.editSettlesAt ?? 0) &&
        this.caret && (this.caret.x !== rect.x || this.caret.y !== rect.y)) {
      if (this.data || this.anchorPending) this.call('DismissPassive', '(s)', ['focus']);
      this.hide();
    }
    this.caret = {x: rect.x, y: rect.y, height: rect.height,
      window: this.window, time: GLib.get_monotonic_time()};
  }

  syncFocus() {
    if (this.destroyed) return;
    this.hide();
    this.caret = null;
    const focused = global.display.focus_window;
    if (focused !== this.window) {
      if (this.window) for (const id of this.windowIds ?? []) this.window.disconnect(id);
      this.window = focused;
      this.windowIds = focused ? ['position-changed', 'size-changed'].map(signal =>
        focused.connect(signal, () => this.syncFocus())) : [];
    }
    const hints = Clutter.InputContentHintFlags;
    const sensitiveInput = Main.inputMethod.currentFocus &&
      (Main.inputMethod.content_purpose === Clutter.InputContentPurpose.PASSWORD ||
       !!(Main.inputMethod.content_hints & (hints.HIDDEN_TEXT | hints.SENSITIVE_DATA)));
    const active = !sensitiveInput && !this.ibusSensitive && this.settings.get_boolean('enable-passive-writing') && !!this.window &&
      !this.suspended && !this.palette.isOpen && !Main.overview.visible && !Main.sessionMode.isLocked;
    const rect = this.window?.get_frame_rect();
    this.call('ConfigurePassive', '(bis)', [active, this.window?.get_pid() ?? 0,
      JSON.stringify(rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : {})]);
  }

  suspend() { this.suspended = true; this.syncFocus(); }
  resume() { this.suspended = false; this.syncFocus(); }

  bind(name, action) {
    const id = Main.wm.addKeybinding(name, this.settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, action);
    if (id !== Meta.KeyBindingAction.NONE) { this.bindings.push(name); return true; }
    return false;
  }

  show(data) {
    this.hide();
    if (!this.settings.get_boolean('enable-passive-writing') || !this.window ||
        global.display.focus_window !== this.window || this.palette.isOpen || this.suspended ||
        Main.overview.visible || Main.sessionMode.isLocked) return;
    const rect = this.window.get_frame_rect();
    const monitor = Main.layoutManager.monitors[this.window.get_monitor()];
    if (!monitor || !data.anchor || data.anchor.x < 0 || data.anchor.y < 0 ||
        data.anchor.x > rect.width || data.anchor.y > rect.height) return;
    this.data = data;
    this.undoMode = false;
    this.failed = false;
    this.heading.text = data.larger ? 'Suggested correction' : 'Writing correction';
    this.text.hide();
    this.diff.destroy_all_children();
    addDiff(this.diff, data.before, data.after, true);
    this.diff.show();
    const tab = data.tab_safe && !data.larger && this.settings.get_boolean('passive-tab-accept');
    const bound = this.bind('passive-accept-key', () => this.accept());
    const tabBound = tab && this.bind('passive-tab-key', () => this.accept());
    this.acceptButton.label = tabBound ? 'Accept · Tab' : bound ? 'Accept · Ctrl+Alt+Enter' : 'Accept';
    this.bind('passive-dismiss-key', () => this.dismiss());
    const natural = Math.max(this.diff.get_preferred_width(-1)[1],
      this.header.get_preferred_width(-1)[1], this.controls.get_preferred_width(-1)[1]) + 24;
    this.actor.width = Math.min(340, monitor.width - 24, Math.max(220, natural));
    const height = this.actor.get_preferred_height(this.actor.width)[1];
    // Reject an unusable anchor rather than covering a large part of an editor.
    if (height > Math.min(200, rect.height / 2)) { this.dismiss(); return; }
    const x = Math.max(monitor.x + 12, Math.min(rect.x + data.anchor.x,
      monitor.x + monitor.width - this.actor.width - 12));
    let y = rect.y + data.anchor.y + data.anchor.height + 8;
    if (y + height > monitor.y + monitor.height - 12) y = rect.y + data.anchor.y - height - 8;
    if (y < monitor.y + Main.panel.height) { this.dismiss(); return; }
    this.actor.set_position(Math.round(x), Math.round(y));
    this.actor.opacity = this.palette._animationsEnabled ? 0 : 255;
    this.actor.show();
    if (this.palette._animationsEnabled)
      this.actor.ease({opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    Main.uiGroup.set_child_above_sibling(this.actor, null);
  }

  accept() {
    if (!this.data || global.display.focus_window !== this.window) return;
    if (this.failed) {
      St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this.data.source);
      this.dismiss();
      return;
    }
    const token = this.data.token;
    const method = this.undoMode ? 'UndoPassive' : 'AcceptPassive';
    this.applying = true;
    this.call(method, '(s)', [token], ([success, message]) => {
      this.applying = false;
      this.diff.hide();
      this.text.show();
      this.editSettlesAt = GLib.get_monotonic_time() + 150000;
      if (this.data?.token !== token) return;
      if (!success) {
        this.clearBindings();
        this.failed = true;
        this.heading.text = 'Correction could not be applied';
        this.text.text = message.includes('verify')
          ? 'Inspect the field before continuing. Copy the original text to recover it if needed.'
          : 'The text or focus changed. No new replacement was made.';
        this.acceptButton.label = 'Copy original';
        this.bind('passive-dismiss-key', () => this.dismiss());
        return;
      }
      if (method === 'UndoPassive') { this.hide(); return; }
      this.clearBindings();
      this.undoMode = true;
      this.heading.text = 'Correction applied';
      this.text.text = 'Undo is available while this text stays unchanged.';
      this.acceptButton.label = this.bind('passive-undo-key', () => this.accept()) ? 'Undo · Ctrl+Alt+Z' : 'Undo';
      this.bind('passive-dismiss-key', () => this.dismiss());
    });
  }

  dismiss() { this.call('DismissPassive', '(s)', ['dismissed']); this.hide(); }
  // The service must always learn that observation ended, even when the
  // palette controller is destroyed before its D-Bus connection finished.
  _sendDisabled() {
    if (!this.bus || this.disableSent) return;
    this.disableSent = true;
    try {
      this.bus.call(BUS, PATH, BUS, 'ConfigurePassive',
        new GLib.Variant('(bis)', [false, 0, '{}']), null,
        Gio.DBusCallFlags.NO_AUTO_START, 5000, null, null);
    } catch { /* The session bus is gone; the service will stop with it. */ }
  }
  clearBindings() {
    for (const name of this.bindings) Main.wm.removeKeybinding(name);
    this.bindings = [];
  }
  hide() { this.anchorPending = false; this.undoMode = false; this.failed = false; this.clearBindings(); this.actor.remove_all_transitions(); this.actor.hide(); this.data = null; }
  destroy() {
    this.destroyed = true;
    this._sendDisabled();
    this.hide();
    if (this.window) for (const id of this.windowIds ?? []) this.window.disconnect(id);
    global.display.disconnect(this.focusId);
    Main.inputMethod.disconnect(this.cursorId);
    for (const id of this.inputIds) Main.inputMethod.disconnect(id);
    this.ibus.disconnect(this.ibusId);
    this.ibus.disconnect(this.ibusPrivacyId);
    for (const id of this.overviewIds) Main.overview.disconnect(id);
    Main.sessionMode.disconnect(this.lockId);
    this.settings.disconnect(this.settingsId);
    for (const id of this.subscriptions) this.bus.signal_unsubscribe(id);
    this.actor.destroy();
  }
}
