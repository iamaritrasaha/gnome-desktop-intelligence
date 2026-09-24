/* Test-only observer installed in the isolated --check session, never shipped. */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {visual} from './visual-probe.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
const XML = '<node><interface name="org.gnome.GdiSettingsTest"><method name="Snapshot"><arg type="s" direction="out"/></method><method name="Focus"><arg type="i" direction="in"/></method><method name="Passive"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method><method name="Visual"><arg type="s" direction="in"/><arg type="s" direction="out"/></method></interface></node>';
export default class SettingsProbe extends Extension {
  enable() {
    this._object = Gio.DBusExportedObject.wrapJSObject(XML, {
      VisualAsync([request], invocation) {
        visual(request).then(result => invocation.return_value(new GLib.Variant('(s)', [result])))
          .catch(error => invocation.return_dbus_error('org.gnome.GdiSettingsTest.Error', error.stack));
      },
      PassiveAsync([method, token], invocation) {
        if (!['AcceptPassive', 'UndoPassive'].includes(method)) throw new Error('Unknown test operation');
        Gio.DBus.session.call('org.gnome.DesktopIntelligence1', '/org/gnome/DesktopIntelligence1',
          'org.gnome.DesktopIntelligence1', method, new GLib.Variant('(s)', [token]), null,
          Gio.DBusCallFlags.NONE, 5000, null, (bus, result) => {
            try { invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(bus.call_finish(result).deep_unpack())])); }
            catch (error) { invocation.return_dbus_error('org.gnome.GdiSettingsTest.Error', error.message); }
          });
      },
      Focus(pid) {
        const actor = global.get_window_actors().find(item => item.meta_window.get_pid() === pid);
        actor?.meta_window.activate(global.get_current_time());
      },
      Snapshot() {
        const extension = Main.extensionManager.lookup('gdi@gnome.desktop.intelligence');
        const instance = extension?.stateObj;
        return JSON.stringify({
          state: extension?.state,
          input: {ibusSensitive: instance?._passive?.ibusSensitive, focus: !!Main.inputMethod.currentFocus, hints: Main.inputMethod.content_hints, purpose: Main.inputMethod.content_purpose},
          caret: instance?._passive?.caret ? {x:instance._passive.caret.x,y:instance._passive.caret.y,height:instance._passive.caret.height} : null,
          passiveVisible: instance?._passive?.actor.visible ?? false,
          passiveUndo: instance?._passive?.undoMode ?? false,
          passiveBindings: instance?._passive?.bindings ?? [],
          passiveToken: instance?._passive?.data?.token ?? '',
          focusedPid: global.display.focus_window?.get_pid() ?? 0,
          windows: global.get_window_actors().map(actor => ({pid: actor.meta_window.get_pid(), app: actor.meta_window.get_wm_class()})),
          path: extension?.path,
          schema: instance?._settings?.settings_schema.get_id(),
          shortcut: instance?._settings?.get_strv('shortcut'),
          timeout: instance?._settings?.get_int('request-timeout'),
          bound: instance?._shortcutBound ?? false,
          action: instance?._shortcutAction ?? 0,
          open: instance?._palette?.isOpen ?? false,
          errors: extension?.errors ?? [],
        });
      },
    });
    this._object.export(Gio.DBus.session, '/org/gnome/GdiSettingsTest');
    Main.overview.hide();
  }
  disable() {
    this._object?.unexport();
    this._object = null;
  }
}
