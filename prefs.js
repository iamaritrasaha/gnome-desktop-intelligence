/* GNOME Desktop Intelligence extension preferences. */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from
  'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { clearLearning, errorMessage, historyClear, providerStatus, learningStats, purgeLearningExamples } from './src/intelligence/ServiceClient.js';

export default class GdiPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings('org.gnome.shell.extensions.gdi');
    if (!settings.get_strv('shortcut').some(value => value.trim()))
      settings.reset('shortcut');
    const defaultShortcut = this._shortcutLabel(settings.get_default_value('shortcut').deep_unpack()[0]);
    window.set_default_size(620, 640);
    window.search_enabled = true;
    Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(
      this.dir.get_child('icons').get_path());

    const page = new Adw.PreferencesPage({
      title: _('General'),
      icon_name: 'preferences-system-symbolic',
    });
    window.add(page);

    const group = new Adw.PreferencesGroup({
      title: _('Shortcuts'),
    });
    page.add(group);

    const row = new Adw.ActionRow({
      title: _('Keyboard shortcut'),
      subtitle: _('Default: %s. Press to change.').format(defaultShortcut),
    });
    group.add(row);

    const shortcutButton = new Gtk.Button({
      valign: Gtk.Align.CENTER,
      label: this._shortcutLabel(settings.get_strv('shortcut')[0]),
    });
    row.add_suffix(shortcutButton);
    row.activatable_widget = shortcutButton;

    shortcutButton.connect('clicked', () => {
      shortcutButton.label = _('Press shortcut…');
      shortcutButton.grab_focus();

      const controller = new Gtk.EventControllerKey();
      controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
      controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        if (keyval === Gdk.KEY_Escape) {
          shortcutButton.label = this._shortcutLabel(settings.get_strv('shortcut')[0]);
          shortcutButton.remove_controller(controller);
          return true;
        }

        const modifiers = state & Gtk.accelerator_get_default_mod_mask();
        if (modifiers === 0)
          return true;

        const accelerator = Gtk.accelerator_name(keyval, modifiers);
        settings.set_strv('shortcut', [accelerator]);
        shortcutButton.label = this._shortcutLabel(accelerator);
        shortcutButton.remove_controller(controller);
        return true;
      });
      shortcutButton.add_controller(controller);
    });

    const search = new Adw.PreferencesGroup({ title: _('Search') });
    search.add(new Adw.ActionRow({
      title: _('Applications, files and the web'),
      subtitle: _('Works without AI. Type “search” followed by a web query.'),
    }));
    page.add(search);
    const writingTools = new Adw.PreferencesGroup({ title: _('Writing') });
    writingTools.add(new Adw.ActionRow({
      title: _('Writing intelligence'),
      subtitle: _('Select text, open Intelligence, then choose a writing tool. Review before replacing.'),
    }));
    const passive = new Adw.SwitchRow({
      title: _('Passive writing assistance'),
      subtitle: _('English sentences in supported multiline GTK editors. Suggestions follow a short pause. Off by default.'),
    });
    settings.bind('enable-passive-writing', passive, 'active', Gio.SettingsBindFlags.DEFAULT);
    writingTools.add(passive);
    const predictive = new Adw.SwitchRow({
      title: _('Predictive writing suggestions'),
      subtitle: _('After a typing pause, offer a short continuation as subdued ghost text. Tab accepts it, Right accepts one word, Escape dismisses. Off by default.'),
    });
    settings.bind('enable-predictive-writing', predictive, 'active', Gio.SettingsBindFlags.DEFAULT);
    writingTools.add(predictive);
    const tab = new Adw.SwitchRow({
      title: _('Use Tab for visible corrections'),
      subtitle: _('Optional in supported multiline GTK editors. Temporarily replaces indentation. Ctrl+Alt+Enter remains available.'),
    });
    settings.bind('passive-tab-accept', tab, 'active', Gio.SettingsBindFlags.DEFAULT);
    writingTools.add(tab);
    page.add(writingTools);

    const aiPage = new Adw.PreferencesPage({
      title: _('AI & Models'), icon_name: 'gdi-intelligence-symbolic',
    });
    window.add(aiPage);
    const provider = new Adw.PreferencesGroup({ title: _('Provider') });
    aiPage.add(provider);
    const writing = new Adw.PreferencesGroup({ title: _('Models') });
    aiPage.add(writing);
    this._addEntry(provider, settings, 'model-provider', _('Provider'));

    this._addEntry(provider, settings, 'model-endpoint', _('Endpoint'));
    this._addEntry(writing, settings, 'model-quick-writing', _('Quick writing model'));
    this._addEntry(writing, settings, 'model-assistant', _('Assistant model'));
    this._addEntry(writing, settings, 'model-reasoning', _('Reasoning model'));

    const resource = new Adw.PreferencesGroup({
      title: _('Resource usage'),
      description: _('How long local models stay warm after use. Models are only loaded when Intelligence features need them and expire on their own; GDI never unloads models belonging to other applications.'),
    });
    aiPage.add(resource);
    const modeModel = new Gtk.StringList();
    for (const [value, label] of [
      ['low-gpu', _('Low GPU · shortest warm periods, no preloading')],
      ['balanced', _('Balanced · brief warm periods, Ask preloading')],
      ['performance', _('Performance · longer warm periods')],
    ])
      modeModel.append(label);
    const modeRow = new Adw.ComboRow({ title: _('Resource mode'), model: modeModel });
    const MODES = ['low-gpu', 'balanced', 'performance'];
    const applyMode = () => {
      const current = settings.get_string('resource-mode');
      const index = Math.max(0, MODES.indexOf(current));
      modeRow.selected = index;
    };
    applyMode();
    settings.connect('changed::resource-mode', applyMode);
    modeRow.connect('notify::selected', () => {
      const value = MODES[modeRow.selected] ?? 'balanced';
      if (settings.get_string('resource-mode') !== value)
        settings.set_string('resource-mode', value);
    });
    resource.add(modeRow);

    const limits = new Adw.PreferencesGroup({ title: _('Request limits') });
    aiPage.add(limits);
    for (const [key, title, lower, upper] of [
      ['request-timeout', _('Timeout (seconds)'), 5, 600],
      ['context-tokens', _('Context token limit'), 2048, 32768],
      ['output-tokens', _('Output token limit'), 64, 4096],
    ]) {
      const limit = new Adw.SpinRow({
        title, adjustment: new Gtk.Adjustment({ lower, upper, step_increment: 1 }),
      });
      settings.bind(key, limit, 'value', Gio.SettingsBindFlags.DEFAULT);
      limits.add(limit);
    }
    const status = new Adw.ActionRow({ title: _('Provider status'), subtitle: _('Not checked') });
    const check = new Gtk.Button({ label: _('Check'), valign: Gtk.Align.CENTER });
    let closed = false;
    window.connect('close-request', () => { closed = true; return false; });
    check.connect('clicked', () => {
      check.sensitive = false;
      status.subtitle = _('Checking…');
      providerStatus(settings.get_string('model-provider'), settings.get_string('model-endpoint'), (result, error) => {
        if (closed)
          return;
        check.sensitive = true;
        status.subtitle = error ? errorMessage(error) : !result.available
          ? result.error : result.models.length ? _('Available · %s').format(result.models.join(', '))
            : _('Ollama is available, but no text models are installed.');
      });
    });
    status.add_suffix(check);
    provider.add(status);
    status.activatable_widget = check;

    const privacy = new Adw.PreferencesPage({
      title: _('Privacy'), icon_name: 'preferences-system-privacy-symbolic',
    });
    window.add(privacy);
    const context = new Adw.PreferencesGroup({ title: _('Selected text') });
    context.add(new Adw.ActionRow({
      title: _('You control observation'),
      subtitle: _('Explicit actions send selected text. If passive assistance is enabled, only a completed nearby sentence is sent. Password and sensitive fields are excluded.'),
    }));
    context.add(new Adw.ActionRow({
      title: _('Conversations stay on this computer'),
      subtitle: _('Ask Intelligence history is local only, never synced, and can be turned off or cleared below.'),
    }));
    privacy.add(context);
    const history = new Adw.PreferencesGroup({
      title: _('Intelligence history'),
      description: _('Completed Ask Intelligence conversations saved in a local database on this computer.'),
    });
    privacy.add(history);
    const historySwitch = new Adw.SwitchRow({
      title: _('Save Intelligence History'),
      subtitle: _('New Ask interactions become resumable conversations. Turning this off keeps new interactions temporary; existing history is not deleted.'),
    });
    settings.bind('save-intelligence-history', historySwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
    history.add(historySwitch);
    const historyPath = GLib.build_filenamev([
      GLib.get_user_data_dir(), 'gnome-desktop-intelligence', 'history.sqlite3',
    ]);
    history.add(new Adw.ActionRow({
      title: _('History location'),
      subtitle: historyPath,
    }));
    const historyClearRow = new Adw.ActionRow({
      title: _('Clear Intelligence History'),
      subtitle: _('Permanently remove every saved Ask Intelligence conversation from this computer.'),
    });
    const historyClearButton = new Gtk.Button({label: _('Clear…'), valign: Gtk.Align.CENTER});
    historyClearRow.add_suffix(historyClearButton);
    historyClearRow.activatable_widget = historyClearButton;
    historyClearButton.connect('clicked', () => this._confirmClearHistory(window));
    history.add(historyClearRow);
    const learning = new Adw.PreferencesGroup({
      title: _('Local learning'),
      description: _('Optional action, application and outcome signals. Text examples require separate consent.'),
    });
    privacy.add(learning);

    const learningSwitch = new Adw.SwitchRow({
      title: _('Personalize writing suggestions'),
      subtitle: _('Off by default'),
    });
    settings.bind('enable-learning', learningSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
    learning.add(learningSwitch);
    const examples = new Adw.SwitchRow({
      title: _('Save accepted edit examples'),
      subtitle: _('Requires personalization. Stores short original, suggestion and final edits locally. Turning off deletes saved examples.'),
    });
    settings.bind('retain-learning-examples', examples, 'active', Gio.SettingsBindFlags.DEFAULT);
    examples.connect('notify::active', () => { if (!examples.active) purgeLearningExamples(); });
    learning.add(examples);
    const stats = new Adw.ActionRow({title: _('Learning statistics'), subtitle: _('Local metadata only by default')});
    const inspect = new Gtk.Button({label: _('Inspect'), valign: Gtk.Align.CENTER});
    inspect.connect('clicked', () => learningStats((result, error) => {
      if (closed) return;
      stats.subtitle = error ? errorMessage(error) :
        Object.entries(result.outcomes).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(' · ') || _('No learning signals yet');
      if (result) {
        stats.subtitle += ` · ${result.examples} saved examples`;
        if (result.preferences) stats.subtitle += ` · Tone: ${result.preferences.tone} · Length: ${result.preferences.verbosity}`;
        for (const [category, value] of Object.entries(result.categories ?? {}))
          stats.subtitle += ` · ${category}: ${value.count} signals, score ${value.score}`;
      }
    }));
    stats.add_suffix(inspect);
    stats.activatable_widget = inspect;
    learning.add(stats);

    const dataPath = GLib.build_filenamev([
      GLib.get_user_data_dir(), 'gnome-desktop-intelligence', 'learning.sqlite3',
    ]);
    const dataLocation = new Adw.ActionRow({
      title: _('Learning data location'),
      subtitle: dataPath,
    });
    learning.add(dataLocation);

    const clearRow = new Adw.ActionRow({
      title: _('Clear learning data'),
      subtitle: _('Permanently remove local signals, preferences and saved edit examples.'),
    });
    const clearButton = new Gtk.Button({
      label: _('Clear…'),
      valign: Gtk.Align.CENTER,
    });
    clearRow.add_suffix(clearButton);
    clearRow.activatable_widget = clearButton;
    clearButton.connect('clicked', () => this._confirmClear(window));
    learning.add(clearRow);

    const about = new Adw.PreferencesPage({
      title: _('About'), icon_name: 'help-about-symbolic',
    });
    window.add(about);
    const identity = new Adw.PreferencesGroup();
    const mark = new Gtk.Image({
      icon_name: 'gdi-intelligence-symbolic', pixel_size: 48,
      margin_top: 12, margin_bottom: 12, margin_end: 12,
      accessible_role: Gtk.AccessibleRole.PRESENTATION,
    });
    const product = new Adw.ActionRow({
      title: _('GNOME Desktop Intelligence'),
      subtitle: _('A native launcher and local intelligence for GNOME'),
    });
    product.add_prefix(mark);
    identity.add(product);
    identity.add(new Adw.ActionRow({
      title: _('Version'), subtitle: String(this.metadata.version),
    }));
    identity.add(new Adw.ActionRow({
      title: _('License'), subtitle: 'GNU GPL 3.0 or later',
    }));
    about.add(identity);
  }

  _addEntry(group, settings, key, title) {
    const row = new Adw.EntryRow({ title });
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
  }

  _confirmClearHistory(window) {
    const dialog = new Adw.MessageDialog({
      transient_for: window,
      modal: true,
      heading: _('Clear Intelligence History?'),
      body: _('This permanently removes all saved Ask Intelligence conversations from the local history database.'),
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('clear', _('Clear history'));
    dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) => {
      if (response !== 'clear')
        return;
      historyClear((reply, error) => {
        if (error || !reply[0]) {
          const failure = new Adw.MessageDialog({
            transient_for: window,
            modal: true,
            heading: _('Could not clear Intelligence History'),
            body: error ? errorMessage(error) : _('The local history database could not be removed.'),
          });
          failure.add_response('close', _('Close'));
          failure.present();
        }
      });
    });
    dialog.present();
  }

  _confirmClear(window) {
    const dialog = new Adw.MessageDialog({
      transient_for: window,
      modal: true,
      heading: _('Clear GDI learning data?'),
      body: _('This removes the local SQLite database, including learned preferences and saved edit examples.'),
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('clear', _('Clear data'));
    dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) => {
      if (response !== 'clear')
        return;
      clearLearning((reply, error) => {
        if (error || !reply[0]) {
          const failure = new Adw.MessageDialog({
            transient_for: window,
            modal: true,
            heading: _('Could not clear learning data'),
            body: error ? errorMessage(error) : _('The local data file could not be removed.'),
          });
          failure.add_response('close', _('Close'));
          failure.present();
        }
      });
    });
    dialog.present();
  }

  _shortcutLabel(accelerator) {
    if (!accelerator)
      return _('Not set');
    const [valid, key, modifiers] = Gtk.accelerator_parse(accelerator);
    return valid ? Gtk.accelerator_get_label(key, modifiers) : accelerator;
  }
}
