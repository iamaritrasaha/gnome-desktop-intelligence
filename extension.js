/*
 * GNOME Desktop Intelligence — GNOME Shell integration.
 * Copyright (C) 2026 GDI contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from
  'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { LauncherPalette } from './palette.js';
import { PassiveController } from './src/intelligence/PassiveController.js';
import { captureFocusedContext, releaseContext } from './src/intelligence/ServiceClient.js';
import { cleanupAppSearch } from './src/search/AppSearch.js';
import { cancelFileSearch } from './src/search/FileSearch.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.gdi';
const SHORTCUT_KEY = 'shortcut';

export default class GdiExtension extends Extension {
  enable() {
    // GNOME Shell loads/unloads stylesheet.css with the extension lifecycle.
    // Loading it again here leaves duplicate theme rules across live updates.
    this._settings = this.getSettings(SETTINGS_SCHEMA);
    this._settings.connectObject(
      `changed::${SHORTCUT_KEY}`, () => this._updateShortcut(),
      this,
    );

    this._intelligenceIcon = new Gio.FileIcon({
      file: this.dir.resolve_relative_path('icons/hicolor/scalable/apps/gdi-intelligence-symbolic.svg'),
    });
    this._palette = new LauncherPalette(this._settings, this._intelligenceIcon, () => this._passive?.resume(), () => this.openPreferences());
    this._passive = new PassiveController(this._settings, this._intelligenceIcon, this._palette);
    this._createPanelIndicator();
    this._updateShortcut();
  }

  disable() {
    this._shortcutCaptureGeneration = (this._shortcutCaptureGeneration ?? 0) + 1;
    if (this._shortcutBound) {
      Main.wm.removeKeybinding(SHORTCUT_KEY);
      this._shortcutBound = false;
    }

    this._passive?.destroy();
    this._passive = null;
    this._palette?.destroy();
    this._palette = null;
    cancelFileSearch();
    cleanupAppSearch();

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    this._settings?.disconnectObject(this);
    this._settings = null;
    this._intelligenceIcon = null;
  }

  _updateShortcut() {
    if (this._shortcutBound) {
      Main.wm.removeKeybinding(SHORTCUT_KEY);
      this._shortcutBound = false;
    }

    if (!this._settings || !this._palette)
      return;

    if (!this._settings.get_strv(SHORTCUT_KEY).some(value => value.trim())) {
      // Reset an empty override to the schema default. The changed signal
      // re-enters this method with the default, so do not register twice.
      this._settings.reset(SHORTCUT_KEY);
      return;
    }

    this._shortcutAction = Main.wm.addKeybinding(
      SHORTCUT_KEY,
      this._settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.ALL,
      () => this._onShortcutPressed(),
    );
    this._shortcutBound = this._shortcutAction !== Meta.KeyBindingAction.NONE;
    if (!this._shortcutBound)
      console.error('GDI could not register the Intelligence shortcut');
  }

  _onShortcutPressed() {
    if (!this._palette)
      return;
    if (this._palette.isOpen) {
      this._shortcutCaptureGeneration = (this._shortcutCaptureGeneration ?? 0) + 1;
      this._palette.close();
      return;
    }

    this._passive?.suspend();
    const generation = (this._shortcutCaptureGeneration ?? 0) + 1;
    this._shortcutCaptureGeneration = generation;
    const focusedWindow = global.display.focus_window;
    const pid = focusedWindow?.get_pid() ?? 0;
    captureFocusedContext(pid, (reply, error) => {
      if (generation !== this._shortcutCaptureGeneration || !this._palette ||
          global.display.focus_window !== focusedWindow) {
        if (reply)
          releaseContext(reply[0]);
        this._passive?.resume();
        return;
      }
      if (error) {
        // Search/launch/Ask still work; the capability notice explains the rest.
        this._palette.open({ captureError: true });
        return;
      }
      const [token, selected, nearby, application, role, start, end, caret, editable, capabilities] = reply;
      this._palette.open({
        token,
        selected,
        nearby,
        application,
        role,
        start,
        end,
        caret,
        editable,
        capabilities: capabilities ? JSON.parse(capabilities) : null,
      });
    });
  }

  _createPanelIndicator() {
    this._indicator = new PanelMenu.Button(0.0, _('GNOME Desktop Intelligence'));
    this._indicator.add_child(new St.Icon({
      gicon: this._intelligenceIcon,
      style_class: 'system-status-icon',
    }));

    const status = new PopupMenu.PopupMenuItem(_('Launcher ready'), {
      reactive: false,
      can_focus: false,
    });
    status.add_style_class_name('gdi-status-item');
    this._indicator.menu.addMenuItem(status);
    this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
    settingsItem.connect('activate', () => {
      Main.extensionManager.openExtensionPrefs(this.uuid, '', {});
    });
    this._indicator.menu.addMenuItem(settingsItem);

    const historyItem = new PopupMenu.PopupMenuItem(_('Intelligence History'));
    historyItem.connect('activate', () => {
      this._palette?.openHistory();
    });
    this._indicator.menu.addMenuItem(historyItem);

    const quitItem = new PopupMenu.PopupMenuItem(_('Quit Intelligence'));
    quitItem.connect('activate', () => {
      Main.extensionManager.disableExtension(this.uuid);
    });
    this._indicator.menu.addMenuItem(quitItem);

    Main.panel.addToStatusArea('gdi-indicator', this._indicator);
  }
}
