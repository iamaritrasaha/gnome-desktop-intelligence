/* Latency probes for the nested GNOME session; fixture output only.
 *
 * Measures the paths a user actually waits on and reports milliseconds on
 * GDI_PERF lines (informational) plus generous boolean gates so a genuine
 * regression fails the suite instead of hiding behind a number:
 *
 *   shortcut → palette visible   (the real keybinding path, including the
 *                                 captureFocusedContext D-Bus round trip)
 *   keypress  → launcher results (synchronous in-memory stage)
 *   keypress  → action row       (deterministic parse + plan preparation)
 *   keypress  → file result      (90 ms debounce + bounded home scan)
 *   activate  → Ask first delta  (mock provider; first streamed content)
 *
 * Never installed or packaged.
 */
import GLib from 'gi://GLib';

const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
  resolve(); return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, tries = 200) {
  const start = GLib.get_monotonic_time();
  for (let i = 0; i < tries; i++) {
    if (predicate())
      return (GLib.get_monotonic_time() - start) / 1000;
    await pause(10);
  }
  return -1;
}

function shellRssKb() {
  try {
    const status = new TextDecoder().decode(GLib.file_get_contents('/proc/self/status')[1]);
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

export async function validatePerf(palette, triggerShortcut, report) {
  const ms = value => Math.round(value);
  try {
    /* Leak baseline for the whole nested probe storm: validatePointer
     * reports the matching end sample after the pointer suite finishes. */
    globalThis.__gdiPerfRssKb = shellRssKb();
    console.log(`GDI_PERF shell_rss_kb_start=${globalThis.__gdiPerfRssKb}`);
    /* 1. Shortcut → palette visible through the real capture path. */
    palette.close();
    await pause(200);
    let opened = 0;
    const startOpen = GLib.get_monotonic_time();
    triggerShortcut();
    opened = await waitFor(() => palette._isOpen && palette._overlay.visible, 300);
    const openMs = (GLib.get_monotonic_time() - startOpen) / 1000;
    console.log(`GDI_PERF shortcut_to_visible_ms=${ms(openMs)}`);
    report('perf-shortcut-opens-palette', opened >= 0);
    report('perf-shortcut-under-600ms', opened >= 0 && openMs < 600);
    palette.close();
    await pause(200);

    /* 2. Keystroke → in-memory launcher results (synchronous stage). */
    palette.open();
    await pause(200);
    const startKey = GLib.get_monotonic_time();
    palette._entry.set_text('GDI Utility 3');
    const appSettled = await waitFor(() => palette._items.length > 0, 40);
    const keyMs = (GLib.get_monotonic_time() - startKey) / 1000;
    console.log(`GDI_PERF keypress_to_results_ms=${ms(keyMs)} settled=${ms(appSettled)}`);
    report('perf-keystroke-results-immediate', appSettled >= 0 && keyMs < 60);

    /* 3. Keystroke → deterministic action row. */
    const startAction = GLib.get_monotonic_time();
    palette._entry.set_text('disk space');
    const actionMs = await waitFor(() =>
      palette._items[0]?.type === 'action', 200);
    console.log(`GDI_PERF keypress_to_action_row_ms=${ms(actionMs)}`);
    report('perf-action-row-under-500ms', actionMs >= 0 && actionMs < 500);

    /* 4. Keystroke → file search result (debounced async stage). */
    const startFile = GLib.get_monotonic_time();
    palette._entry.set_text('file gdi-migration-fixture');
    const fileMs = await waitFor(() =>
      palette._items.some(item => item.type === 'file'), 300);
    console.log(`GDI_PERF keypress_to_file_result_ms=${ms(fileMs)}`);
    report('perf-file-result-under-2000ms', fileMs >= 0 && fileMs < 2000);
    palette.close();
    await pause(200);

    /* 5. Ask activation → first streamed delta (mock provider). */
    palette.open();
    palette._entry.set_text('ask EchoFixture: perf first delta');
    await waitFor(() => palette._items.some(item => item.type === 'ask'));
    palette._activateItem(palette._items.findIndex(item => item.type === 'ask'));
    const startAsk = GLib.get_monotonic_time();
    const firstDelta = await waitFor(() => (palette._streamText ?? '').length > 0, 300);
    const askMs = (GLib.get_monotonic_time() - startAsk) / 1000;
    console.log(`GDI_PERF ask_first_delta_ms=${ms(askMs)} found=${ms(firstDelta)}`);
    report('perf-ask-first-delta-under-2500ms',
      firstDelta >= 0 && askMs < 2500);
    palette.close();
    await pause(200);
  } catch (error) {
    report('perf-probe-error', String(error.message ?? error));
    palette.close();
  }
}
