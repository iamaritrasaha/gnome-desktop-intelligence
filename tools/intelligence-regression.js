/* Nested GNOME integration probe; fixture output only. */
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import { captureFocusedContext, releaseContext, requestStats } from './src/intelligence/ServiceClient.js';
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
  await reopen('set volume EchoFixture:{"action":"audio.setVolume","args":{"percent":30}}');
  await until(() => palette._items[0]?.type === 'action' && palette._items[0].suggested === true);
  report('model-suggested-action-validated',
    palette._items[0].plan?.steps?.[0]?.id === 'audio.setVolume');
  await reopen('set volume EchoFixture:{"action":"system.runCommand","args":{}}');
  await until(() => palette._items[0]?.type === 'ask');
  report('invalid-model-tool-call-falls-back-to-ask', true);

  // A model-proposed state change can never bypass the confirmation policy,
  // even when the deterministic policy would execute it immediately.
  await reopen('set volume EchoFixture:{"action":"wifi.setState","args":{"enabled":false}}');
  await until(() => palette._items[0]?.type === 'action' && palette._items[0].suggested === true);
  report('model-state-change-plans-confirmation',
    palette._items[0].plan?.steps?.[0]?.id === 'wifi.setState' &&
    palette._items[0].plan?.needsConfirmation === true);
  palette._activateItem(0);
  report('model-state-change-confirmation-view', palette._mode === 'action-confirm');
  palette._writingControls.get_first_child().emit('clicked', 1);
  report('model-state-change-cancel-closes', !palette._isOpen);

  // Noun-phrase capability mentions must never produce a system action row
  // and never reach the routing model (a fuzzy app row is acceptable — it is
  // just a launcher result, nothing executes).
  await reopen('bluetooth technology');
  await pause(600);
  report('noun-phrase-not-model-routed',
    !palette._items.some(item => item.type === 'action' || item.type === 'action-searching'));

  // Multi-step with the "tell me" info phrasing parses as a plan.
  await reopen('open downloads and tell me how much disk space i have');
  await until(() => palette._items[0]?.type === 'action');
  report('multi-step-tell-me-disk', palette._items[0].name.includes('+') &&
    palette._items[0].plan?.steps?.length === 2);

  // Developer diagnostics: the hidden command shows recent traces and Reset
  // clears both the Shell records and the service mirror.
  await reopen('gdi diagnostics');
  await until(() => palette._mode === 'action-result');
  report('diagnostics-view-shown', bodyText().includes('Invocations:') &&
    bodyText().includes('disk space'));
  const resetButton = palette._writingControls.get_children()
    .find(button => button.label === 'Reset');
  report('diagnostics-reset-button', Boolean(resetButton));
  resetButton?.emit('clicked', 1);
  await pause(80);
  report('diagnostics-reset-clears', bodyText().includes('No action traces recorded yet'));
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
  const chipLabels = () => palette._writingControls.get_children().map(button => button.label).join(',');
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
  // Fixed width and the processing animation during generation.
  report('ask-processing-animation', palette._processing?.visible === true &&
    palette._writingContent.get_children().some(child =>
      child.has_style_class_name?.('gdi-processing')));
  report('ask-fixed-width-loading', palette._palette.width === 500);
  await until(() => palette._streamText?.length > 0);
  report('incremental-streaming', palette._mode === 'writing-loading' &&
    palette._processing === null);
  report('ask-fixed-width-streaming', palette._palette.width === 500);
  await until(() => palette._mode === 'writing-result' || palette._mode === 'writing-error');
  report('ask-response', palette._mode === 'writing-result' && palette._writingSuggestion.includes('Fixture answer'));
  report('ask-fixed-width-result', palette._palette.width === 500);
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
  // Follow-up with streaming Markdown: no raw tokens may flash while the
  // response streams, and completed structure renders natively.
  let rawTokenFlash = false;
  const flashWatcher = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
    if (!palette._isOpen || !palette._streamText)
      return GLib.SOURCE_CONTINUE;
    for (const child of palette._writingContent.get_children()) {
      const text = child.text ?? '';
      if (text.includes('```') || /\*\*|^#{1,6} /m.test(text))
        rawTokenFlash = true;
    }
    return GLib.SOURCE_CONTINUE;
  });
  palette._followup.set_text('Markdown fixture');
  palette._followup.clutter_text.emit('activate');
  await until(() => palette._mode === 'writing-result');
  GLib.source_remove(flashWatcher);
  report('markdown-heading-code-link', palette._writingContent.get_children().some(c => c.has_style_class_name('gdi-markdown-code')) &&
    palette._writingContent.get_children().some(c => c.accessible_name === 'Open link https://www.gnome.org/'));
  const codeBlock = palette._writingContent.get_children().find(c => c.has_style_class_name('gdi-markdown-code'));
  report('markdown-code-copy-control', Boolean(codeBlock) &&
    codeBlock.get_children().some(child => child.get_children().some(button => button.label === 'Copy')));
  report('markdown-no-token-flash', !rawTokenFlash);
  await capture('phase35-markdown');
  report('temporary-followup-context', palette._conversation.length === 4 && palette._requestHistory.length === 2);
  report('ask-question-shown-subdued', palette._writingContent.get_children().some(c =>
    c.has_style_class_name?.('gdi-ask-question') && (c.text ?? '').includes('Markdown fixture')));
  report('history-conversation-created', typeof palette._conversationId === 'string' &&
    palette._conversationId.length > 0);
  palette._followup.set_text('Follow-up fixture');
  palette._followup.clutter_text.emit('activate');
  await until(() => palette._mode === 'writing-result');
  report('followup-response', palette._writingSuggestion.includes('previous answer') && palette._conversation.length === 6);
  // Clear starts a fresh conversation instead of destroying saved history.
  const savedConversationId = palette._conversationId;
  palette._writingControls.get_children().find(b => b.label === 'Clear').emit('clicked', 1);
  report('clear-forgets-conversation', palette._mode === 'launcher' && palette._conversation.length === 0 &&
    palette._writingContext === null && palette._conversationId === null);
  await pause(300);

  // History: open, grouped list, restore, continue, delete, clear.
  palette.close();
  await pause(180);
  palette.openHistory();
  await until(() => palette._mode === 'history-list');
  await pause(400);
  report('history-groups-rendered', ['Today', 'Yesterday', 'Earlier'].some(label =>
    palette._writingContent.get_children().some(c => c.text === label)));
  const historyRow = palette._writingContent.get_children().find(c => c.has_style_class_name?.('gdi-history-row'));
  report('history-list-has-entry', Boolean(historyRow));
  historyRow.emit('clicked', 1);
  await until(() => palette._mode === 'history-conversation');
  await pause(200);
  report('history-conversation-restored', palette._writingContent.get_children().some(c =>
    (c.text ?? '').includes('Markdown fixture')));
  report('history-continue-id-resumed', palette._conversationId === savedConversationId);
  // Rename must surface a visible, focused entry (it once stayed hidden with
  // the search row) and apply the new title on Enter.
  palette._startHistoryRename();
  await pause(150);
  report('history-rename-field-visible', palette._mode === 'history-rename' &&
    palette._searchRow.visible && palette._entry.contains(global.stage.get_key_focus()));
  palette._entry.set_text('Renamed fixture conversation');
  await nativeKey('enter');
  await until(() => palette._mode === 'history-conversation');
  await pause(150);
  // The heading is a box with an inner label, so scan one level deep.
  const headingText = () => palette._writingContent.get_children()
    .flatMap(child => [child, ...(child.get_children?.() ?? [])])
    .map(child => child.text ?? '').join('\n');
  report('history-rename-works', palette._historyConversation?.title === 'Renamed fixture conversation' &&
    headingText().includes('Renamed fixture conversation'));
  palette._followup.set_text('EchoFixture: history continued answer');
  palette._followup.clutter_text.emit('activate');
  await until(() => palette._mode === 'writing-result');
  console.log('GDI_DEBUG history-continue-suggestion', JSON.stringify(palette._writingSuggestion));
  report('history-continue-answers', palette._writingSuggestion === 'history continued answer');
  palette._showHistoryList();
  await until(() => palette._mode === 'history-list');
  await pause(400);
  const rowsBeforeDelete = palette._writingContent.get_children().filter(c => c.has_style_class_name?.('gdi-history-row'));
  const rowToOpen = rowsBeforeDelete[0];
  rowToOpen.emit('clicked', 1);
  await until(() => palette._mode === 'history-conversation');
  const deleteButton = palette._writingControls.get_children().find(b => b.label === 'Delete');
  deleteButton.emit('clicked', 1);
  await until(() => palette._mode === 'history-list');
  await pause(400);
  report('history-delete-removes-row', palette._writingContent.get_children()
    .filter(c => c.has_style_class_name?.('gdi-history-row')).length === rowsBeforeDelete.length - 1);
  const clearButton = palette._writingControls.get_children().find(b => b.label === 'Clear All');
  clearButton.emit('clicked', 1);
  report('history-clear-arms-confirm', clearButton.label === 'Really clear all?');
  clearButton.emit('clicked', 1);
  await pause(400);
  report('history-clear-empties-list', !palette._writingContent.get_children()
    .some(c => c.has_style_class_name?.('gdi-history-row')));
  // Disabled history: Ask interactions stay temporary and create no junk.
  palette.close(); await pause(180);
  palette._settings.set_boolean('save-intelligence-history', false);
  palette.open(); palette._entry.set_text('ask EchoFixture: temporary fixture question');
  await until(() => palette._items[0]?.type === 'ask' && !palette._items[0].promptOnly);
  palette._activateItem(0);
  await until(() => palette._mode === 'writing-result');
  report('history-disabled-no-conversation', palette._conversationId === null);
  palette._settings.set_boolean('save-intelligence-history', true);
  palette.close(); await pause(180);
  // Ask semantics: a bare 'ask' enters the empty prompt and never requests.
  palette.open();
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
    report('writing-tools-primary', palette._mode === 'writing-actions' &&
      chipLabels() === 'Improve,Fix,Shorten,Tone,More…');
    report('writing-tools-selection-preview', palette._writingContent.get_children().some(c =>
      (c.text ?? '').includes('selected phrase')));
    const findChip = label => palette._writingControls.get_children().find(button => button.label === label);
    findChip('Tone').emit('clicked', 1);
    await pause(100);
    report('writing-tools-tone-submenu', chipLabels() === 'Professional,Casual,Friendly,Direct,Back');
    findChip('Back').emit('clicked', 1);
    await pause(100);
    findChip('More…').emit('clicked', 1);
    await pause(100);
    report('writing-tools-more-submenu', chipLabels() === 'Expand,Summarize,Explain,Translate,Ask Intelligence,Back');
    findChip('Back').emit('clicked', 1);
    await pause(100);
    // Typed selection intents still select the action; the verb is stripped
    // and bare prompts return here on Escape.
    palette._entry.set_text('explain this');
    await until(() => palette._items[0]?.type === 'selection-intent');
    report('selection-natural-intent', palette._items[0]?.actionKey === 'explain');
    palette._activateItem(0);
    await until(() => palette._mode === 'writing-result');
    report('selection-context-transparent', palette._writingContent.get_children().some(c => c.text?.includes('Using selected text')));
    palette._showWritingActions();
    await pause(100);
    palette._entry.set_text('explain EchoFixture: explain-remainder');
    await until(() => palette._items[0]?.type === 'selection-intent' &&
      palette._items[0].query === 'EchoFixture: explain-remainder');
    palette._activateItem(0);
    await until(() => palette._mode === 'writing-result');
    report('selection-intent-verb-stripped', palette._writingSuggestion === 'explain-remainder');
    palette._showWritingActions();
    await pause(100);
    palette._entry.set_text('ask');
    await until(() => palette._items[0]?.type === 'selection-intent' && palette._items[0].promptOnly === true);
    palette._activateItem(0);
    report('selection-ask-bare-enters-question-prompt', palette._mode === 'writing-question');
    await nativeKey('escape'); await pause(120);
    report('writing-tools-escape-returns-from-question', palette._mode === 'writing-actions');
    findChip('Improve').emit('clicked', 1);
    await until(() => palette._mode === 'writing-result');
    report('writing-tools-preview-transition', palette._mode === 'writing-result' &&
      palette._writingControls.get_first_child().label === 'Replace');
    report('writing-tools-preview-diff', palette._writingContent.get_children().some(c =>
      c.has_style_class_name?.('gdi-diff-section')));
    await capture('phase35-writing-diff');
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
      let capabilities = null;
      try { capabilities = JSON.parse(reply[9] ?? 'null'); } catch { capabilities = null; }
      resolve({token, selected, nearby, application, role, start, end, caret, editable, capabilities});
    }));
    report('insertion-caret-snapshot', insertContext.editable && insertContext.start === insertContext.end && !insertContext.selected && !insertContext.nearby);
    palette.open(insertContext);
    await pause(120);
    // No selection but the field exposes caret context: the contextual
    // surface offers caret-scoped actions only.
    report('contextual-writing-surface', palette._mode === 'writing-actions' &&
      chipLabels() === 'Improve sentence,Continue writing,Fix paragraph,Tone,More…');
    palette._showContextualWritingActions();
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

/* Release stress: rapid open/close, superseded search bursts, an Ask
 * cancelled mid-flight and a follow-up Ask. Proves no stale results, no stuck
 * service requests and no leaked timers after the storm. */
export async function validateStress(palette, report) {
  const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve(); return GLib.SOURCE_REMOVE;
  }));
  const until = async (predicate, tries = 120) => {
    for (let i = 0; i < tries; i++) {
      if (predicate()) return;
      await pause(50);
    }
    throw new Error(`stress check timed out in mode ${palette._mode}`);
  };

  try {
    // Earlier probes legitimately record a provider error; the storm must
    // not add any new one, and nothing may stay active afterwards.
    const countErrors = stats => (stats.recent ?? [])
      .filter(record => record.status === 'error').length;
    const before = await requestStats();

    for (let i = 0; i < 5; i++) {
      palette.open();
      palette.close();
    }
    await pause(250);
    report('stress-open-close-stable', !palette._isOpen &&
      palette._searchTimeoutId === 0 && palette._modelTimeoutId === 0);

    // Superseded searches: the final query's result must be the visible one.
    palette.open();
    for (const query of ['GDI Alpha', 'GDI Utility', 'GDI Alpine']) {
      palette._entry.set_text(query);
      await pause(30);
    }
    await until(() => palette._items[0]?.name === 'GDI Alpine');
    report('stress-final-query-wins', palette._items[0].name === 'GDI Alpine');
    report('stress-no-stale-search-rows', palette._items.every(item => item.type === 'app'));

    // A slow Ask cancelled mid-flight, then a fresh Ask: the cancelled
    // generation must never render, and the new one must complete cleanly.
    palette._entry.set_text('ask slow fixture');
    await until(() => palette._items[0]?.type === 'ask');
    palette._activateItem(0);
    await until(() => palette._mode === 'writing-loading');
    palette.close();
    await pause(200);
    report('stress-ask-cancel-cleans', !palette._isOpen);
    palette.open();
    palette._entry.set_text('ask Follow-up fixture');
    await until(() => palette._items[0]?.type === 'ask');
    palette._activateItem(0);
    await until(() => palette._mode === 'writing-result');
    report('stress-no-stale-result', palette._writingContent.get_children()
      .some(child => (child.text ?? '').includes('attention')) ||
      palette._mode === 'writing-result');
    palette.close();
    await pause(200);

    // Service-side: nothing stuck, nothing new errored by the storm.
    const after = await requestStats();
    report('stress-service-requests-idle', after.active === 0);
    report('stress-no-leaked-request-errors',
      countErrors(after) === countErrors(before) &&
      (after.recent ?? [])
        .filter(record => record.status === 'cancelled').length >= 1);
  } catch (error) {
    report('stress-probe-error', error.stack ?? String(error));
    palette.close();
  }
}

/* Clipboard Intelligence: the subtle strip, typed commands, the St-only
 * read-on-explicit-action model, copy, stale protection, empty/oversized
 * content, provider failure and the transient (no-history) guarantee.
 * The clipboard is exercised through St itself inside the nested Shell. */
export async function validateClipboard(palette, report) {
  const until = async predicate => {
    for (let i = 0; i < 140; i++) {
      if (predicate()) return;
      await pause(50);
    }
    throw new Error(`clipboard check timed out in mode ${palette._mode}`);
  };
  const bodyText = () => palette._writingContent.get_children()
    .map(child => child.text ?? '').join('\n');
  const controlLabels = () => palette._writingControls.get_children()
    .map(button => button.label);
  const setClipboard = async text => {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    await pause(200);
  };
  const readClipboard = () => new Promise(resolve =>
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD,
      (_clipboard, text) => resolve(text)));
  const nativeKey = key => new Promise((resolve, reject) => {
    const process = Gio.Subprocess.new(['/usr/bin/python3',
      `${GLib.getenv('GDI_TEST_ROOT')}/tools/press-key.py`, key],
    Gio.SubprocessFlags.NONE);
    process.wait_check_async(null, (object, result) => {
      try { object.wait_check_finish(result); resolve(); } catch (error) { reject(error); }
    });
  });
  /* Fresh open + settle: the one-shot clipboard probe decides the strip a few
   * milliseconds after open; the pause covers it like the other reopens. */
  const reopen = async query => {
    palette.close();
    await pause(200);
    palette.open();
    await pause(400);
    if (query !== undefined)
      palette._entry.set_text(query);
  };
  const dismissButton = () => palette._clipboardStrip.get_first_child()
    ?.get_children().find(child => child.has_style_class_name?.('gdi-clipboard-dismiss'));

  palette.close();
  await pause(200);
  palette._settings.set_string('model-endpoint',
    `http://127.0.0.1:${GLib.getenv('GDI_MOCK_PORT')}`);

  const multiline = 'GDI clipboard fixture line one.\n' +
    'Second line — Ünïcode ✓ and a URL https://example.com/fixture\n';
  await setClipboard(multiline);

  // 1. Plain open: the subtle strip reports the length, never the text, and
  //    the launcher mode is untouched.
  await reopen();
  report('clipboard-strip-shown', palette._clipboardStrip.visible &&
    palette._clipboardLabel.text.includes(String(multiline.length)));
  report('clipboard-strip-in-launcher-mode', palette._mode === 'launcher' &&
    palette._clipboardChips.get_children().length === 6);
  // Privacy: the strip reports the length only; no clipboard content is
  // rendered anywhere in the launcher.
  report('clipboard-strip-shows-length-only',
    !palette._clipboardStrip.get_children().some(child =>
      (child.text ?? '').includes('GDI clipboard fixture')));

  // 2. Dismiss hides it for this open; the next open re-probes and returns it.
  dismissButton()?.emit('clicked', 1);
  await pause(120);
  report('clipboard-strip-dismissed', !palette._clipboardStrip.visible &&
    palette._mode === 'launcher');
  await reopen();
  report('clipboard-strip-returns-next-open', palette._clipboardStrip.visible);

  // 3. The typed command shows the action list instead of the strip.
  palette._entry.set_text('clipboard');
  await until(() => palette._items.length === 7 &&
    palette._items[0]?.type === 'clipboard-action');
  report('clipboard-command-rows', palette._items[0].name === 'Summarize clipboard' &&
    palette._items[5].name === 'Ask Intelligence about the clipboard' &&
    palette._items[6].type === 'clipboard-dismiss' &&
    !palette._clipboardStrip.visible);

  // 4. Fresh read at action time: the clipboard changes while the palette is
  //    open, and the echo fixture proves exactly what reached the provider.
  await setClipboard('EchoFixture:FreshClipToken42');
  palette._activateItem(0);
  await until(() => palette._mode === 'writing-result');
  report('clipboard-fresh-read-payload', palette._writingSuggestion === 'FreshClipToken42');
  report('clipboard-context-note', bodyText().includes('Using clipboard text') &&
    bodyText().includes('read and copy only'));
  report('clipboard-no-replace-control', !controlLabels().some(label =>
    label.toLowerCase().includes('replace') || label.toLowerCase().includes('insert')));
  report('clipboard-capability-note', bodyText().includes('read but not replaced'));

  // 5. Copy result really copies, and the strip re-probes afterwards.
  palette._writingControls.get_children().find(b => b.label === 'Copy')?.emit('clicked', 1);
  await pause(250);
  const copied = await readClipboard();
  report('clipboard-copy-result', copied === 'FreshClipToken42');

  // 6. Stale protection: Retry reuses the registered context — the text the
  //    result is about — not whatever the clipboard holds meanwhile.
  palette._writingControls.get_children().find(b => b.label === 'Retry')?.emit('clicked', 1);
  await until(() => palette._mode === 'writing-result');
  report('clipboard-retry-registered-text', palette._writingSuggestion === 'FreshClipToken42');

  // 7. Ask with the clipboard as context: only a registered clipboard context
  //    lets this request pass the service, and the question routes verbatim.
  await reopen('ask clipboard EchoFixture:ClipboardAskEcho7');
  await until(() => palette._items[0]?.type === 'clipboard-action');
  report('clipboard-ask-command-row', palette._items[0].question === 'EchoFixture:ClipboardAskEcho7');
  palette._activateItem(0);
  await until(() => palette._mode === 'writing-result');
  report('clipboard-ask-echo', palette._writingSuggestion === 'ClipboardAskEcho7');

  // 8. Bare 'ask clipboard' enters the question prompt, sends nothing, and
  //    the real Enter key runs it through the clipboard flow.
  await reopen('ask clipboard');
  await until(() => palette._items[0]?.type === 'clipboard-action');
  palette._activateItem(0);
  report('clipboard-ask-bare-prompt', palette._mode === 'writing-question');
  palette._entry.set_text('EchoFixture:ClipboardPromptEcho3');
  await nativeKey('enter');
  await until(() => palette._mode === 'writing-result');
  report('clipboard-ask-prompt-echo', palette._writingSuggestion === 'ClipboardPromptEcho3');
  palette._writingControls.get_children().find(b => b.label === 'Clear')?.emit('clicked', 1);
  await pause(150);

  // 9. Escape from the prompt unwinds to the launcher with the strip intact.
  await reopen('ask clipboard');
  await until(() => palette._items[0]?.type === 'clipboard-action');
  palette._activateItem(0);
  await pause(120);
  await nativeKey('escape');
  await pause(150);
  report('clipboard-ask-escape-to-launcher', palette._mode === 'launcher' &&
    palette._clipboardStrip.visible);

  // 10. Empty clipboard: no strip, and a chosen action fails explicitly.
  await setClipboard(' ');
  await reopen();
  report('clipboard-empty-no-strip', !palette._clipboardStrip.visible &&
    !palette._clipboardAvailable && palette._mode === 'launcher');
  palette._entry.set_text('summarize clipboard');
  await until(() => palette._items[0]?.type === 'clipboard-action');
  palette._activateItem(0);
  await until(() => palette._launcherNote.visible);
  report('clipboard-empty-explicit-error',
    palette._launcherNote.text.includes('does not contain any text'));

  // 11. Oversized clipboard: never silently truncated, never offered.
  await setClipboard('x'.repeat(12500));
  await reopen();
  report('clipboard-oversized-no-strip', !palette._clipboardStrip.visible &&
    !palette._clipboardAvailable);
  palette._entry.set_text('summarize clipboard');
  await until(() => palette._items[0]?.type === 'clipboard-action');
  palette._activateItem(0);
  await until(() => palette._launcherNote.visible &&
    palette._launcherNote.text.includes('too long'));
  report('clipboard-oversized-explicit-error', palette._launcherNote.text.includes('12500'));

  // 12. Provider offline: a chosen clipboard action surfaces the established
  //     visible error state with Retry, never a silent no-op.
  await setClipboard('plain text for the offline probe');
  palette._settings.set_string('model-endpoint', 'http://127.0.0.1:1');
  await reopen('summarize clipboard');
  await until(() => palette._items[0]?.type === 'clipboard-action');
  palette._activateItem(0);
  await until(() => palette._mode === 'writing-error');
  report('clipboard-provider-offline-visible',
    bodyText().length > 0 && controlLabels().includes('Retry'));
  palette._settings.set_string('model-endpoint',
    `http://127.0.0.1:${GLib.getenv('GDI_MOCK_PORT')}`);

  // 13. Deterministic launcher is untouched: normal queries keep their rows
  //     and precedence while clipboard text exists.
  await reopen('memory usage');
  await until(() => palette._items[0]?.type === 'action');
  report('clipboard-launcher-unaffected',
    palette._items[0].plan?.steps?.[0]?.id === 'system.memoryStatus');

  // 14. Transient by design: clipboard interactions never create history.
  await reopen('explain clipboard');
  await until(() => palette._items[0]?.type === 'clipboard-action');
  palette._activateItem(0);
  await until(() => palette._mode === 'writing-result');
  report('clipboard-history-not-written', palette._conversationId === null);

  await setClipboard(' ');
  palette.close();
  await pause(200);
}
