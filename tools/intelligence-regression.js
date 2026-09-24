/* Nested GNOME integration probe; fixture output only. */
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import { captureFocusedContext, releaseContext } from './src/intelligence/ServiceClient.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
  resolve(); return GLib.SOURCE_REMOVE;
}));

/* Phase 4 native actions: rows, immediate execution, confirmation policy,
 * graceful unavailability, bounded multi-step plans and the model fallback. */
export async function validateActions(palette, report) {
  const until = async predicate => {
    for (let i = 0; i < 140; i++) {
      if (predicate()) return;
      await pause(50);
    }
    throw new Error(`action check timed out in mode ${palette._mode}`);
  };
  const bodyText = () => palette._writingContent.get_children()
    .map(child => child.text ?? '').join('\n');
  const reopen = async query => {
    palette.close(); await pause(180);
    palette.open();
    palette._entry.set_text(query);
  };
  const appearance = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
  const originalScheme = appearance.get_string('color-scheme');

  // A read-only action runs immediately and answers with structured text.
  palette.open();
  palette._entry.set_text('disk space');
  await until(() => palette._items[0]?.type === 'action');
  report('action-row-disk', palette._items[0].plan?.steps?.[0]?.id === 'system.diskUsage');
  palette._activateItem(0);
  await until(() => palette._mode === 'action-result');
  report('disk-info-result', bodyText().includes('free of'));

  await reopen('memory usage');
  await until(() => palette._items[0]?.type === 'action');
  palette._activateItem(0);
  await until(() => palette._mode === 'action-result');
  report('memory-info-result', bodyText().includes('used of'));

  // Appearance is a direct reversible state change in the disposable profile.
  const targetScheme = originalScheme === 'prefer-dark' ? 'default' : 'prefer-dark';
  await reopen(targetScheme === 'prefer-dark' ? 'dark mode' : 'light mode');
  await until(() => palette._items[0]?.type === 'action');
  palette._activateItem(0);
  await until(() => palette._mode === 'action-result');
  report('color-scheme-action', appearance.get_string('color-scheme') === targetScheme &&
    bodyText().includes('✓'));
  appearance.set_string('color-scheme', originalScheme);

  // Audio has no pipewire socket in the nested runtime: it must fail closed
  // with a readable result, never crash or hang the palette.
  await reopen('volume 30');
  await until(() => palette._items[0]?.type === 'action');
  palette._activateItem(0);
  await until(() => palette._mode === 'action-result');
  report('audio-unavailable-graceful', bodyText().includes('✗'));

  // Disabling Wi-Fi always plans a confirmation first and never executes.
  await reopen('turn wifi off');
  await until(() => palette._items[0]?.type === 'action');
  report('wifi-off-plans-confirmation', palette._items[0].plan?.needsConfirmation === true);
  palette._activateItem(0);
  report('confirmation-view', palette._mode === 'action-confirm' &&
    palette._writingControls.get_first_child()?.label === 'Cancel' &&
    palette._writingContent.get_children().some(child =>
      (child.text ?? '').includes('may disconnect')));
  palette._writingControls.get_first_child().emit('clicked', 1);
  report('confirmation-cancel-closes', !palette._isOpen);

  // Read-only host state through the system bus.
  await reopen('bluetooth status');
  await until(() => palette._items[0]?.type === 'action');
  palette._activateItem(0);
  await until(() => palette._mode === 'action-result');
  report('bluetooth-state-readable', bodyText().includes('Bluetooth'));

  await reopen('power profile');
  await until(() => palette._items[0]?.type === 'action');
  palette._activateItem(0);
  await until(() => palette._mode === 'action-result');
  report('power-profile-readable', bodyText().includes('profile'));

  await reopen('show my ip');
  await until(() => palette._items[0]?.type === 'action');
  palette._activateItem(0);
  await until(() => palette._mode === 'action-result');
  report('network-status-readable', bodyText().length > 0);

  // Bounded multi-step plans execute in order with one line per step.
  await reopen('dark mode and disk space');
  await until(() => palette._items[0]?.type === 'action');
  report('multi-step-row', palette._items[0].name.includes('+'));
  palette._activateItem(0);
  await until(() => palette._mode === 'action-result');
  report('multi-step-executed', palette._writingContent.get_children()
    .filter(child => (child.text ?? '').startsWith('✓')).length === 2);
  appearance.set_string('color-scheme', originalScheme);

  // The routing model may only suggest registry actions; the echo fixture
  // proves exactly which payload the service returned to the Shell. The
  // marker must end the line — the mock echoes through the end of it.
  const mockEndpoint = `http://127.0.0.1:${GLib.getenv('GDI_MOCK_PORT')}`;
  palette._settings.set_string('model-endpoint', mockEndpoint);
  await reopen('volume EchoFixture:{"action":"audio.setVolume","args":{"percent":30}}');
  await until(() => palette._items[0]?.type === 'action' && palette._items[0].suggested === true);
  report('model-suggested-action-validated',
    palette._items[0].plan?.steps?.[0]?.id === 'audio.setVolume');
  await reopen('volume EchoFixture:{"action":"system.runCommand","args":{}}');
  await until(() => palette._items[0]?.type === 'ask');
  report('invalid-model-tool-call-falls-back-to-ask', true);
  palette.close(); await pause(180);
}


export async function validateIntelligence(palette, report) {
  const capture = async name => {
    await pause(160);
    const [x, y] = palette._palette.get_transformed_position();
    const stream = Gio.File.new_for_path(`${GLib.getenv('GDI_TEST_ROOT')}/build/validation/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const shot = new Shell.Screenshot();
    await new Promise((resolve, reject) => shot.screenshot_area(Math.round(x), Math.round(y), Math.round(palette._palette.width), Math.round(palette._palette.height), stream, (object, result) => {
      try { object.screenshot_area_finish(result); stream.close(null); resolve(); } catch (error) { reject(error); }
    }));
  };
  const nativeKey = key => new Promise((resolve, reject) => {
    const process = Gio.Subprocess.new(['/usr/bin/python3', `${GLib.getenv('GDI_TEST_ROOT')}/tools/press-key.py`, key], Gio.SubprocessFlags.NONE);
    process.wait_check_async(null, (object, result) => {
      try { object.wait_check_finish(result); resolve(); } catch (error) { reject(error); }
    });
  });
  const until = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await pause(50);
    }
    throw new Error(`Intelligence check timed out in ${palette._mode}`);
  };
  palette.close();
  await pause(180);
  palette._settings.set_string('model-endpoint', `http://127.0.0.1:${GLib.getenv('GDI_MOCK_PORT')}`);
  palette.open();
  palette._entry.set_text('Explain this uniquely worded fixture request');
  await until(() => palette._items[0]?.type === 'ask');
  report('ask-fallback', palette._items[0].name === 'Ask Intelligence');
  palette._activateItem(0);
  report('ask-loading-cancellable', palette._mode === 'writing-loading' &&
    palette._writingControls.get_first_child()?.label === 'Cancel');
  await until(() => palette._streamText?.length > 0);
  report('incremental-streaming', palette._mode === 'writing-loading');
  await until(() => palette._mode === 'writing-result' || palette._mode === 'writing-error');
  report('ask-response', palette._mode === 'writing-result' && palette._writingSuggestion.includes('Fixture answer'));
  const buttons = palette._writingControls.get_children();
  report('ask-no-replace', buttons.map(b => b.label).join(',') === 'Copy,Retry,Clear');
  palette._copyWritingResult();
  const copied = await new Promise(resolve => St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => resolve(text)));
  report('copy-response', copied === palette._writingSuggestion);
  palette._writingControls.get_children().find(b => b.label === 'Retry').emit('clicked', 1);
  report('retry-loading', palette._mode === 'writing-loading');
  await until(() => palette._mode === 'writing-result');
  await pause(120);
  const monitor = Main.layoutManager.currentMonitor;
  const [x, y] = palette._palette.get_transformed_position();
  const stream = Gio.File.new_for_path(`${GLib.getenv('GDI_TEST_ROOT')}/build/validation/ask-preview.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
  const screenshot = new Shell.Screenshot();
  await new Promise((resolve, reject) => screenshot.screenshot_area(Math.round(x), Math.round(y), Math.round(palette._palette.width), Math.round(palette._palette.height), stream, (object, result) => {
    try { object.screenshot_area_finish(result); stream.close(null); resolve(); } catch (error) { reject(error); }
  }));
  const labelStats = palette._writingContent.get_children().map(child =>
    `${(child.text ?? '').slice(0, 20)}|${child.clutter_text ? child.clutter_text.get_layout().get_line_count() : 0}`);
  console.log('GDI_DEBUG retry-render', JSON.stringify([palette._writingSuggestion.length, labelStats]));
  report('long-answer-wrapped', palette._writingContent.get_children().some(child =>
    child.clutter_text && child.clutter_text.get_layout().get_line_count() > 2));
  report('long-answer-bounded', palette._palette.height < monitor.height - 48 &&
    y + palette._palette.height <= monitor.y + monitor.height && palette._palette.width === 500);
  palette._followup.set_text('Markdown fixture');
  palette._followup.clutter_text.emit('activate');
  await until(() => palette._mode === 'writing-result');
  report('markdown-heading-code-link', palette._writingContent.get_children().some(c => c.has_style_class_name('gdi-markdown-code')) &&
    palette._writingContent.get_children().some(c => c.accessible_name === 'Open link https://www.gnome.org/'));
  await capture('phase35-markdown');
  report('temporary-followup-context', palette._conversation.length === 4 && palette._requestHistory.length === 2);
  palette._followup.set_text('Follow-up fixture');
  palette._followup.clutter_text.emit('activate');
  await until(() => palette._mode === 'writing-result');
  report('followup-response', palette._writingSuggestion.includes('previous answer') && palette._conversation.length === 6);
  palette._writingControls.get_children().find(b => b.label === 'Clear').emit('clicked', 1);
  report('clear-forgets-conversation', palette._mode === 'launcher' && palette._conversation.length === 0 && palette._writingContext === null);
  // Ask semantics: a bare 'ask' enters the empty prompt and never requests.
  palette._entry.set_text('ask');
  await until(() => palette._items[0]?.type === 'ask' && palette._items[0].promptOnly === true);
  report('ask-bare-row-prompt-only', true);
  palette._activateItem(0);
  report('ask-bare-enters-empty-prompt', palette._mode === 'writing-question' &&
    !palette._disposeStream && !palette._streamTimer);
  await nativeKey('enter');
  await pause(150);
  report('ask-empty-enter-no-request', palette._mode === 'writing-question' && !palette._disposeStream);
  palette._entry.set_text('EchoFixture: hello there');
  await nativeKey('enter');
  await until(() => palette._mode === 'writing-result');
  report('ask-prompt-sends-only-question', palette._writingSuggestion === 'hello there');
  // 'ask <question>' submits only the question; the prefix never reaches the provider.
  palette._writingControls.get_children().find(b => b.label === 'Clear').emit('clicked', 1);
  await pause(120);
  palette._entry.set_text('ask EchoFixture: what is gradient descent');
  await until(() => palette._items[0]?.type === 'ask' && !palette._items[0].promptOnly);
  palette._activateItem(0);
  await until(() => palette._mode === 'writing-result');
  report('ask-prefix-stripped-for-provider', palette._writingSuggestion === 'what is gradient descent');
  // A natural question still reaches Ask verbatim.
  palette._writingControls.get_children().find(b => b.label === 'Clear').emit('clicked', 1);
  await pause(120);
  palette._entry.set_text('EchoFixture: why does attention use scaling');
  await until(() => palette._items[0]?.type === 'ask' && !palette._items[0].promptOnly);
  palette._activateItem(0);
  await until(() => palette._mode === 'writing-result');
  report('natural-question-verbatim', palette._writingSuggestion === 'why does attention use scaling');
  palette._writingControls.get_children().find(b => b.label === 'Clear').emit('clicked', 1);
  await pause(120);
  // Same interaction, superseded stream: no late completion can overwrite it.
  palette._writingContext = {token: GLib.uuid_string_random(), selected: '', nearby: '', editable: false};
  palette._startWritingRequest({key: 'assistant', label: 'Ask Intelligence'}, 'slow fixture question');
  await pause(80);
  palette._startWritingRequest({key: 'assistant', label: 'Ask Intelligence'}, 'Follow-up fixture');
  await until(() => palette._mode === 'writing-result');
  await pause(3200);
  report('obsolete-stream-cannot-overwrite', palette._writingSuggestion === 'The previous answer discussed attention.' && !palette._disposeStream && !palette._streamTimer);
  palette.close(); await pause(180);
  palette.open(); palette._entry.set_text('slow fixture question');
  await until(() => palette._items[0]?.type === 'ask');
  palette._activateItem(0); await pause(100);
  report('generating-shell-responsive', palette._mode === 'writing-loading');
  await nativeKey('escape');
  await pause(200);
  report('cancel-clears-context', !palette._isOpen && palette._writingContext === null);
  palette.open(); palette._entry.set_text('GDI Alpha');
  await until(() => palette._items[0]?.type === 'app');
  report('launcher-after-cancel', palette._mode === 'launcher');
  palette.close(); await pause(180);
  palette._settings.set_string('model-endpoint', 'http://127.0.0.1:1');
  palette.open(); palette._entry.set_text('Explain this uniquely worded fixture request');
  await until(() => palette._items[0]?.type === 'ask');
  palette._activateItem(0);
  await until(() => palette._mode === 'writing-error');
  report('ask-provider-error-visible', palette._writingContent.get_children().some(child => child.text?.includes('Could not reach Ollama')));
  palette.close(); await pause(180);
  palette._settings.set_string('model-endpoint', `http://127.0.0.1:${GLib.getenv('GDI_MOCK_PORT')}`);
  const path = `${GLib.getenv('HOME')}/gdi-ui-fixture`;
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
  launcher.setenv('WAYLAND_DISPLAY', GLib.getenv('GDI_NESTED_DISPLAY'), true);
  launcher.setenv('GTK_A11Y', 'atspi', true);
  launcher.setenv('GDK_BACKEND', 'wayland', true);
  const fixture = launcher.spawnv(['/usr/bin/python3', `${GLib.getenv('GDI_TEST_ROOT')}/tools/atspi-fixture.py`, path]);
  try {
    await until(() => GLib.file_test(path + '.ready', GLib.FileTest.EXISTS));
    await pause(500);
    const pid = Number(fixture.get_identifier());
    const context = await new Promise((resolve, reject) => captureFocusedContext(pid, (reply, error) => {
      if (error) { reject(error); return; }
      const [token, selected, nearby, application, role, start, end, caret, editable] = reply;
      let capabilities = null;
      try { capabilities = JSON.parse(reply[9] ?? 'null'); } catch { capabilities = null; }
      resolve({ token, selected, nearby, application, role, start, end, caret, editable, capabilities });
    }));
    if (!context.selected) {
      releaseContext(context.token);
      throw new Error('UI fixture selection was not captured');
    }
    report('capture-capabilities', context.capabilities?.canReplaceSelection === true &&
      context.capabilities.canReadSelection === true && context.capabilities.role.length > 0);
    palette.open(context);
    await pause(180);
    palette._entry.set_text('explain this');
    await until(() => palette._items[0]?.type === 'selection-intent');
    report('selection-natural-intent', palette._items[0]?.actionKey === 'explain');
    palette._activateItem(0);
    await until(() => palette._mode === 'writing-result');
    report('selection-context-transparent', palette._writingContent.get_children().some(c => c.text?.includes('Using selected text')));
    palette._showWritingActions();
    palette._entry.set_text('explain EchoFixture: explain-remainder');
    await until(() => palette._items[0]?.type === 'selection-intent' &&
      palette._items[0].query === 'EchoFixture: explain-remainder');
    palette._activateItem(0);
    await until(() => palette._mode === 'writing-result');
    report('selection-intent-verb-stripped', palette._writingSuggestion === 'explain-remainder');
    palette._showWritingActions();
    palette._entry.set_text('ask');
    await until(() => palette._items[0]?.type === 'selection-intent' && palette._items[0].promptOnly === true);
    palette._activateItem(0);
    report('selection-ask-bare-enters-question-prompt', palette._mode === 'writing-question');
    palette._showWritingActions();
    palette._activateItem(0);
    await until(() => palette._mode === 'writing-result' || palette._mode === 'writing-error');
    await capture('phase35-writing-diff');
    report('writing-preview-replace', palette._mode === 'writing-result' && palette._writingControls.get_first_child().label === 'Replace');
    await nativeKey('tab'); await pause(80);
    report('preview-tab-navigation', global.stage.get_key_focus()?.label === 'Copy');
    await nativeKey('backtab'); await pause(80);
    report('preview-backtab-navigation', global.stage.get_key_focus()?.label === 'Replace');
    await nativeKey('enter');
    await until(() => palette._mode === 'writing-done');
    report('preview-enter-replaces', palette._undoAvailable);
    const contents = () => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    report('preview-preserves-surroundings', contents() === `Before café. ${palette._writingSuggestion} after.`);
    await nativeKey('enter');
    await until(() => !palette._undoAvailable);
    report('preview-undo', contents() === 'Before café. selected phrase 🌙 after.');
    await nativeKey('escape'); await pause(180);
    report('preview-escape-closes', !palette._isOpen && palette._writingContext === null);
    global.get_window_actors().find(actor => actor.meta_window.get_pid() === pid)?.meta_window.activate(global.get_current_time());
    await pause(180);
    GLib.file_set_contents(path + '.command', 'caret');
    await pause(200);
    const insertContext = await new Promise((resolve, reject) => captureFocusedContext(pid, (reply, error) => {
      if (error) { reject(error); return; }
      const [token, selected, nearby, application, role, start, end, caret, editable] = reply;
      resolve({token, selected, nearby, application, role, start, end, caret, editable});
    }));
    report('insertion-caret-snapshot', insertContext.editable && insertContext.start === insertContext.end && !insertContext.selected && !insertContext.nearby);
    palette.open(insertContext);
    palette._entry.set_text('Markdown fixture');
    await until(() => palette._items[0]?.type === 'ask');
    palette._activateItem(0);
    await until(() => palette._mode === 'writing-result');
    report('insert-action-available', palette._writingControls.get_children().some(b => b.label === 'Insert at caret'));
    palette._writingControls.get_children().find(b => b.label === 'Insert at caret').emit('clicked', 1);
    await until(() => palette._mode === 'writing-done' || palette._mode === 'writing-error');
    if (palette._mode === 'writing-error') console.log('GDI_INSERT_DIAGNOSTIC', palette._writingContent.get_children().map(c => c.text ?? '').join('|'));
    report('insert-exact-caret', palette._mode === 'writing-done' && contents() === `Before café. ${palette._writingSuggestion}selected phrase 🌙 after.`);
    if (palette._mode === 'writing-done') {
      await pause(100);
      palette._writingControls.get_first_child().emit('clicked', 1);
      await until(() => !palette._undoAvailable);
      report('insert-undo', contents() === 'Before café. selected phrase 🌙 after.');
    }
    palette.close(); await pause(180);
    global.get_window_actors().find(actor => actor.meta_window.get_pid() === pid)?.meta_window.activate(global.get_current_time());
    await pause(180);
    GLib.file_set_contents(path + '.command', 'caret'); await pause(160);
    const staleInsert = await new Promise((resolve, reject) => captureFocusedContext(pid, (reply, error) => {
      if (error) { reject(error); return; }
      const [token, selected, nearby, application, role, start, end, caret, editable] = reply;
      resolve({token, selected, nearby, application, role, start, end, caret, editable});
    }));
    GLib.file_set_contents(path + '.command', 'change-back'); await pause(160);
    palette.open(staleInsert);
    palette._entry.set_text('Markdown fixture');
    await until(() => palette._items[0]?.type === 'ask'); palette._activateItem(0);
    await until(() => palette._mode === 'writing-result');
    palette._writingControls.get_children().find(b => b.label === 'Insert at caret').emit('clicked', 1);
    await until(() => palette._mode === 'writing-error');
    report('stale-insertion-refused', contents() === 'Before café. selected phrase 🌙 after.');

  } finally {
    fixture.force_exit();
    palette.close();
  }

}
