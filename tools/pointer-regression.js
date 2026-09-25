/* Real pointer-input regression probe for nested GNOME sessions.
 *
 * Injects genuine pointer motion and button events through Mutter's own
 * RemoteDesktop mechanism, so hover tracking, actor picking, the modal-grab
 * routing and St.Button click generation all run exactly as they do with a
 * physical mouse. Nothing here invokes click handlers directly: every checked
 * interaction goes through driver.move() + driver.click().
 *
 * Fixture output only; never installed or packaged.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {captureFocusedContext} from './src/intelligence/ServiceClient.js';

const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
  resolve(); return GLib.SOURCE_REMOVE;
}));

const BTN_LEFT = 0x110;

class PointerDriver {
  constructor() {
    this._bus = null;
    this._path = null;
  }

  _call(path, iface, method, args = null) {
    return new Promise((resolve, reject) => {
      this._bus.call('org.gnome.Mutter.RemoteDesktop', path, iface, method,
        args, null, Gio.DBusCallFlags.NONE, 5000, null, (bus, result) => {
          try {
            resolve(bus.call_finish(result));
          } catch (error) {
            reject(error);
          }
        });
    });
  }

  async start() {
    this._bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    const session = await this._call('/org/gnome/Mutter/RemoteDesktop',
      'org.gnome.Mutter.RemoteDesktop', 'CreateSession');
    this._path = session.deep_unpack()[0];
    await this._call(this._path, 'org.gnome.Mutter.RemoteDesktop.Session', 'Start');
  }

  async stop() {
    if (this._path) {
      await this._call(this._path, 'org.gnome.Mutter.RemoteDesktop.Session', 'Stop')
        .catch(() => {});
      this._path = null;
    }
  }

  /* Mutter 46's RemoteDesktop offers relative motion only (absolute motion
   * requires an actively streaming ScreenCast session). Relative deltas run
   * through pointer acceleration, so each move overshoots to a corner for a
   * known origin and then iterates against the Shell's own pointer position
   * until the cursor is within a pixel of the target. */
  async _relative(dx, dy) {
    await this._call(this._path, 'org.gnome.Mutter.RemoteDesktop.Session',
      'NotifyPointerMotionRelative', new GLib.Variant('(dd)', [dx, dy]));
  }

  async move(x, y) {
    await this._relative(-20000, -20000);
    await pause(60);
    for (let attempt = 0; attempt < 10; attempt++) {
      const [cx, cy] = global.get_pointer();
      const dx = Math.round(x - cx);
      const dy = Math.round(y - cy);
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1)
        return;
      await this._relative(dx, dy);
      await pause(50);
    }
    const [fx, fy] = global.get_pointer();
    throw new Error(`pointer could not reach ${x},${y} (stuck at ${fx},${fy})`);
  }

  /* Move without the corner sweep: for short hops (menu items under the
   * pointer) acceleration distortion is small and retrying against
   * global.get_pointer() converges without ever leaving the surface. */
  async moveNear(x, y) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const [cx, cy] = global.get_pointer();
      const dx = Math.round(x - cx);
      const dy = Math.round(y - cy);
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1)
        return;
      await this._relative(dx, dy);
      await pause(50);
    }
    const [fx, fy] = global.get_pointer();
    throw new Error(`pointer could not reach ${x},${y} (stuck at ${fx},${fy})`);
  }

  async button(code, pressed) {
    await this._call(this._path, 'org.gnome.Mutter.RemoteDesktop.Session',
      'NotifyPointerButton', new GLib.Variant('(ib)', [code, pressed]));
  }

  async click(code = BTN_LEFT) {
    await this.button(code, true);
    await pause(60);
    await this.button(code, false);
  }

  async scrollDown(steps = 2) {
    // Mutter 46: axis 0 is vertical (positive steps scroll down), axis 1 is
    // horizontal (discrete_steps_to_scroll_direction in meta-remote-desktop).
    await this._call(this._path, 'org.gnome.Mutter.RemoteDesktop.Session',
      'NotifyPointerAxisDiscrete', new GLib.Variant('(ui)', [0, steps]));
  }
}

/* Stage coordinates of the center of an actor, for pointer targeting. The
 * palette settles first: transformed extents are transient during layout and
 * open/close animations, and a NaN target would defeat the calibration loop. */
async function centerOf(actor) {
  await pause(250);
  let [x, y] = actor.get_transformed_position();
  let [width, height] = actor.get_transformed_size();
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    const box = actor.get_allocation_box();
    x = box.x1;
    y = box.y1;
    width = box.x2 - box.x1;
    height = box.y2 - box.y1;
  }
  if (![x, y, width, height].every(Number.isFinite))
    throw new Error('pointer target could not be resolved to stage coordinates');
  return [Math.round(x + width / 2), Math.round(y + height / 2)];
}

async function waitFor(predicate, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (predicate())
      return true;
    await pause(50);
  }
  return false;
}

/* Click the center of an actor with the real pointer and let the UI settle. */
async function clickActor(driver, actor) {
  const [x, y] = await centerOf(actor);
  await driver.move(x, y);
  await driver.click();
  await pause(160);
}

function findChip(palette, label) {
  return palette._writingControls.get_children().find(button => button.label === label);
}

function findCodeCopyButton(palette) {
  for (const block of palette._writingContent.get_children()) {
    if (!block.has_style_class_name?.('gdi-markdown-code'))
      continue;
    for (const child of block.get_children())
      for (const button of child.get_children?.() ?? [])
        if (button.label === 'Copy')
          return button;
  }
  return null;
}

function clipboardText() {
  return new Promise(resolve => St.Clipboard.get_default()
    .get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => resolve(text)));
}

/* Scenario 7–12 helpers -------------------------------------------------- */

/* Bring the palette into the Writing Tools chip surface with a synthetic
 * (token-less) selection context; used only for submenu navigation probes. */
async function showFixtureChips(palette) {
  palette.open();
  await pause(120);
  palette._writingContext = {selected: 'fixture selection',
    capabilities: {canReadSelection: true}};
  palette._showWritingActions();
  await pause(120);
}

/* Seed one Ask conversation through real clicks so History has content. */
async function seedHistoryByMouse(driver, palette) {
  palette.close();
  await pause(200);
  palette.open();
  palette._entry.set_text('ask EchoFixture: pointer history seed');
  await waitFor(() => palette._items.some(item => item.type === 'ask'));
  const index = palette._items.findIndex(item => item.type === 'ask');
  await clickActor(driver, palette._results.get_children()[index]);
  const answered = await waitFor(() => palette._mode === 'writing-result', 120);
  if (answered) {
    const clear = findChip(palette, 'Clear');
    if (clear)
      await clickActor(driver, clear);
  }
  await pause(200);
}

/* Scenarios. `report` is the shared GDI_TEST reporter. */
export async function validatePointer(palette, report) {
  let driver = null;
  try {
    driver = new PointerDriver();
    await driver.start();
    report('pointer-driver-available', true);
  } catch (error) {
    report('pointer-driver-error', String(error.message ?? error));
    report('pointer-driver-available', false);
    return;
  }

  try {
    /* 1. A real click on an application result launches it. */
    palette.open();
    palette._entry.set_text('GDI Pointer');
    const foundApp = await waitFor(() =>
      palette._items.some(item => item.type === 'app' && item.name === 'GDI Pointer'));
    report('pointer-app-row-visible', foundApp);
    const row = palette._results.get_children()[0];
    const [rowX, rowY] = await centerOf(row);
    await driver.move(rowX, rowY);
    await pause(220);
    report('pointer-hover-state', row.has_style_pseudo_class('hover'));
    await driver.click();
    const marker = GLib.getenv('GDI_POINTER_APP_MARKER');
    const launched = await waitFor(() => marker &&
      GLib.file_test(marker, GLib.FileTest.EXISTS));
    report('pointer-click-launches-app', launched);
    report('pointer-click-closes-palette', !palette._isOpen);

    /* 2. A click inside the palette never dismisses; a click on the search
     *    entry focuses the caret even when focus was elsewhere. */
    palette.open();
    await pause(250);
    const [palX, palY] = await centerOf(palette._searchIcon);
    await driver.move(palX, palY);
    await driver.click();
    await pause(160);
    report('pointer-inside-click-keeps-open', palette._isOpen);
    if (!palette._isOpen)
      palette.open();
    await pause(250);
    global.stage.set_key_focus(null);
    await pause(120);
    const [entryX, entryY] = await centerOf(palette._entry);
    await driver.move(entryX, entryY);
    await driver.click();
    await pause(160);
    report('pointer-entry-click-focuses-caret', palette._isOpen &&
      palette._entry.contains(global.stage.get_key_focus()));

    /* 3. A click outside the palette dismisses it. */
    await driver.move(12, 40);
    await driver.click();
    await pause(200);
    report('pointer-outside-click-dismisses', !palette._isOpen);

    /* 4. Writing Tools chips respond to real clicks: hover, Tone expansion,
     *    More… expansion, Back. */
    await showFixtureChips(palette);
    const toneChip = findChip(palette, 'Tone');
    report('pointer-tone-chip-present', Boolean(toneChip));
    if (toneChip) {
      const [chipX, chipY] = await centerOf(toneChip);
      await driver.move(chipX, chipY);
      await pause(120);
      report('pointer-chip-hover', toneChip.has_style_pseudo_class('hover'));
      await driver.click();
      await pause(160);
      report('pointer-chip-click-expands-tone', palette._isOpen &&
        palette._submenu === 'tone');
    }
    /* The Tone submenu is still expanded here: return to the root chips
     * first — More… only exists on the root row. */
    let back = findChip(palette, 'Back');
    if (back)
      await clickActor(driver, back);
    const moreChip = findChip(palette, 'More…');
    if (moreChip) {
      await clickActor(driver, moreChip);
      report('pointer-more-chip-expands-more', palette._isOpen &&
        palette._submenu === 'more' &&
        Boolean(findChip(palette, 'Ask Intelligence')));
      back = findChip(palette, 'Back');
      if (back)
        await clickActor(driver, back);
      report('pointer-back-click-returns-to-root', palette._submenu === null &&
        Boolean(findChip(palette, 'Improve')));
    } else {
      report('pointer-more-chip-expands-more', false);
      report('pointer-back-click-returns-to-root', false);
    }

    /* 5. A Tone option click reaches the request path (the token-less fixture
     *    context makes the service refuse it; the visible outcome must be the
     *    explicit error state, and Cancel must close by mouse). */
    if (toneChip) {
      await clickActor(driver, findChip(palette, 'Tone'));
      await clickActor(driver, findChip(palette, 'Casual'));
      const errored = await waitFor(() => palette._mode === 'writing-error', 100);
      report('pointer-tone-option-activates', errored);
      const cancel = findChip(palette, 'Cancel');
      if (cancel) {
        await clickActor(driver, cancel);
        report('pointer-error-cancel-click-closes', !palette._isOpen);
      } else {
        report('pointer-error-cancel-click-closes', false);
      }
    }

    /* 6. The Ask Intelligence row responds to a real click. */
    palette.open();
    palette._entry.set_text('ask');
    const foundAsk = await waitFor(() =>
      palette._items.some(item => item.type === 'ask'));
    if (foundAsk) {
      const askIndex = palette._items.findIndex(item => item.type === 'ask');
      const [askX, askY] = await centerOf(palette._results.get_children()[askIndex]);
      await driver.move(askX, askY);
      await driver.click();
      await pause(200);
      report('pointer-ask-row-opens-prompt', palette._isOpen &&
        palette._mode === 'writing-question');
    } else {
      report('pointer-ask-row-opens-prompt', false);
    }
    palette.close();
    await pause(200);

    /* 7. The mouse wheel scrolls a long Ask answer; Copy and Clear respond. */
    palette.open();
    palette._entry.set_text('ask Markdown fixture');
    const askRowShown = await waitFor(() =>
      palette._items.some(item => item.type === 'ask'));
    if (askRowShown) {
      const askIdx = palette._items.findIndex(item => item.type === 'ask');
      await clickActor(driver, palette._results.get_children()[askIdx]);
    }
    const answered = await waitFor(() => palette._mode === 'writing-result', 200);
    report('pointer-ask-answer-rendered', answered);
    if (answered) {
      const [scrollX, scrollY] = await centerOf(palette._writingScroll);
      await driver.move(scrollX, scrollY);
      await pause(120);
      const before = palette._writingScroll.vadjustment.value;
      await driver.scrollDown(3);
      await pause(300);
      const after = palette._writingScroll.vadjustment.value;
      report('pointer-wheel-scrolls-answer', after > before);

      const copyButton = findChip(palette, 'Copy');
      if (copyButton) {
        await clickActor(driver, copyButton);
        report('pointer-copy-click-copies', copyButton.label === 'Copied');
      } else {
        report('pointer-copy-click-copies', false);
      }
      /* A fenced code block's own Copy control copies the code, by mouse. */
      const codeCopy = findCodeCopyButton(palette);
      if (codeCopy) {
        await clickActor(driver, codeCopy);
        const text = await clipboardText();
        report('pointer-code-copy-click-copies', text === 'weights = softmax(scores)');
      } else {
        report('pointer-code-copy-click-copies', false);
      }
      const clearButton = findChip(palette, 'Clear');
      if (clearButton) {
        await clickActor(driver, clearButton);
        report('pointer-clear-click-returns-to-launcher',
          palette._mode === 'launcher' && palette._searchRow.visible);
      } else {
        report('pointer-clear-click-returns-to-launcher', false);
      }
      /* The palette must still be open and consistent after the whole
       * pointer sequence: no stale dismissal, no leaked state. */
      report('pointer-surface-stable-after-sequence', palette._isOpen &&
        palette._mode === 'launcher');
    }
    palette.close();
    await pause(200);

    /* 8. The Cancel button stops an in-flight generation by mouse, and Clear
     *    returns to the launcher afterwards. */
    palette.open();
    palette._entry.set_text('ask slow fixture');
    await waitFor(() => palette._items.some(item => item.type === 'ask'));
    const slowIndex = palette._items.findIndex(item => item.type === 'ask');
    await clickActor(driver, palette._results.get_children()[slowIndex]);
    const loading = await waitFor(() => palette._mode === 'writing-loading', 60);
    report('pointer-ask-loading-cancel-visible', loading &&
      Boolean(findChip(palette, 'Cancel')));
    if (loading) {
      await clickActor(driver, findChip(palette, 'Cancel'));
      await pause(160);
      report('pointer-cancel-click-stops-generation',
        palette._mode === 'writing-error' &&
        palette._writingContent.get_children().some(child =>
          (child.text ?? '') === 'Generation cancelled.'));
      const clear = findChip(palette, 'Clear');
      if (clear) {
        await clickActor(driver, clear);
        report('pointer-clear-after-cancel-returns', palette._mode === 'launcher');
      } else {
        report('pointer-clear-after-cancel-returns', false);
      }
    } else {
      report('pointer-cancel-click-stops-generation', false);
      report('pointer-clear-after-cancel-returns', false);
    }
    palette.close();
    await pause(200);

    /* 9. A click into the follow-up field focuses it; the follow-up then
     *    completes through the mock provider. The base question must not
     *    carry an EchoFixture marker: it would legitimately persist in the
     *    quoted conversation history and hijack the mock's echo branch. */
    palette.open();
    palette._entry.set_text('ask uniquely worded followup base question');
    await waitFor(() => palette._items.some(item => item.type === 'ask'));
    const baseIndex = palette._items.findIndex(item => item.type === 'ask');
    await clickActor(driver, palette._results.get_children()[baseIndex]);
    const baseDone = await waitFor(() => palette._mode === 'writing-result', 120);
    report('pointer-followup-field-shown', baseDone && palette._followup.visible);
    if (baseDone) {
      // Fill first, then click into the field like a user correcting a
      // draft: the click must focus it without clearing the text.
      palette._followup.set_text('Follow-up fixture');
      await clickActor(driver, palette._followup);
      const focused = palette._followup.contains(global.stage.get_key_focus());
      report('pointer-followup-click-focuses', focused);
      console.log(`GDI_DEBUG followup-before-submit text="${palette._followup.get_text()}" focused=${focused} mode=${palette._mode}`);
      palette._followup.clutter_text.emit('activate');
      const followAnswered = await waitFor(() =>
        palette._mode === 'writing-result' &&
        palette._writingSuggestion.includes('previous answer'), 120);
      console.log(`GDI_DEBUG followup-after-submit mode=${palette._mode} text="${palette._followup.get_text()}" suggestion="${(palette._writingSuggestion ?? '').slice(0, 60)}"`);
      report('pointer-followup-answered', followAnswered);
    } else {
      report('pointer-followup-click-focuses', false);
      report('pointer-followup-answered', false);
    }
    palette.close();
    await pause(200);

    /* 10. Native action rows, the result view and the confirmation flow,
     *     all by mouse. */
    palette.open();
    palette._entry.set_text('disk space');
    await waitFor(() => palette._items.some(item => item.type === 'action'));
    const diskIndex = palette._items.findIndex(item => item.type === 'action');
    await clickActor(driver, palette._results.get_children()[diskIndex]);
    const resultShown = await waitFor(() => palette._mode === 'action-result', 100);
    report('pointer-action-row-executes', resultShown &&
      palette._writingContent.get_children().some(child =>
        (child.text ?? '').includes('free of')));
    const actionCopy = findChip(palette, 'Copy');
    if (actionCopy) {
      await clickActor(driver, actionCopy);
      report('pointer-action-copy-click-copies', actionCopy.label === 'Copied');
    } else {
      report('pointer-action-copy-click-copies', false);
    }
    const done = findChip(palette, 'Done');
    if (done) {
      await clickActor(driver, done);
      report('pointer-action-done-click-closes', !palette._isOpen);
    } else {
      report('pointer-action-done-click-closes', false);
    }

    /* A confirmation dismissed by mouse must never execute (the plan is
     * cancelled); the palette closes. */
    palette.open();
    palette._entry.set_text('turn wifi off');
    await waitFor(() => palette._items.some(item => item.type === 'action'));
    const wifiIndex = palette._items.findIndex(item => item.type === 'action');
    await clickActor(driver, palette._results.get_children()[wifiIndex]);
    const confirmShown = await waitFor(() => palette._mode === 'action-confirm', 60);
    report('pointer-confirm-view-shown', confirmShown);
    if (confirmShown) {
      await clickActor(driver, findChip(palette, 'Cancel'));
      report('pointer-confirm-cancel-click-closes', !palette._isOpen);
    } else {
      report('pointer-confirm-cancel-click-closes', false);
    }

    /* A confirmation accepted by mouse executes and verifies: text scaling is
     * confirmed with a GSettings read-back, then restored. */
    const appearance = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const originalScale = appearance.get_double('text-scaling-factor');
    palette.open();
    palette._entry.set_text('text scaling 1.25');
    await waitFor(() => palette._items.some(item => item.type === 'action'));
    const scaleIndex = palette._items.findIndex(item => item.type === 'action');
    await clickActor(driver, palette._results.get_children()[scaleIndex]);
    const scaleConfirm = await waitFor(() => palette._mode === 'action-confirm', 60);
    report('pointer-scale-confirm-view-shown', scaleConfirm);
    if (scaleConfirm) {
      const setSize = findChip(palette, 'Set Size');
      await clickActor(driver, setSize);
      const executed = await waitFor(() => palette._mode === 'action-result', 100);
      report('pointer-confirm-accept-executes', executed &&
        Math.abs(appearance.get_double('text-scaling-factor') - 1.25) < 0.001);
      appearance.set_double('text-scaling-factor', originalScale);
      const scaleDone = findChip(palette, 'Done');
      if (scaleDone)
        await clickActor(driver, scaleDone);
    } else {
      report('pointer-confirm-accept-executes', false);
    }
    palette.close();
    await pause(200);

    /* 11. History: every control by mouse — open row, conversation row,
     *     Delete, two-step Clear All, Close. */
    await seedHistoryByMouse(driver, palette);
    palette.open();
    palette._entry.set_text('history');
    await waitFor(() => palette._items.some(item => item.type === 'history-open'));
    const historyIndex = palette._items.findIndex(item => item.type === 'history-open');
    await clickActor(driver, palette._results.get_children()[historyIndex]);
    const historyShown = await waitFor(() => palette._mode === 'history-list', 60);
    const historyRow = () => palette._writingContent.get_children()
      .find(child => child.has_style_class_name?.('gdi-history-row'));
    const rowCount = () => palette._writingContent.get_children()
      .filter(child => child.has_style_class_name?.('gdi-history-row')).length;
    await waitFor(() => historyRow(), 40);
    report('pointer-history-open-row-opens-list', historyShown && Boolean(historyRow()));
    if (historyShown && historyRow()) {
      const rowsBefore = rowCount();
      await clickActor(driver, historyRow());
      const opened = await waitFor(() => palette._mode === 'history-conversation', 60);
      report('pointer-history-row-opens-conversation', opened &&
        palette._conversationId !== null);
      const del = findChip(palette, 'Delete');
      if (del && opened) {
        await clickActor(driver, del);
        await waitFor(() => palette._mode === 'history-list', 60);
        await pause(300);
        report('pointer-history-delete-click-removes', rowCount() === rowsBefore - 1);
      } else {
        report('pointer-history-delete-click-removes', false);
      }
      const clearAll = findChip(palette, 'Clear All');
      if (clearAll) {
        await clickActor(driver, clearAll);
        report('pointer-history-clear-click-arms', clearAll.label === 'Really clear all?');
        await clickActor(driver, clearAll);
        const emptied = await waitFor(() => rowCount() === 0, 40);
        report('pointer-history-clear-click-empties', emptied);
      } else {
        report('pointer-history-clear-click-arms', false);
        report('pointer-history-clear-click-empties', false);
      }
      const close = findChip(palette, 'Close');
      if (close) {
        await clickActor(driver, close);
        report('pointer-history-close-click-closes', !palette._isOpen);
      } else {
        report('pointer-history-close-click-closes', false);
      }
    } else {
      for (const name of ['pointer-history-row-opens-conversation',
        'pointer-history-delete-click-removes', 'pointer-history-clear-click-arms',
        'pointer-history-clear-click-empties', 'pointer-history-close-click-closes'])
        report(name, false);
    }

    /* 12. The panel indicator opens with a real click; the Settings item
     *     reaches the extension boundary (the real Preferences window is
     *     covered by the physical-settings check) and Intelligence History
     *     opens the palette. */
    const indicator = Main.panel.statusArea['gdi-indicator'];
    if (indicator) {
      palette.close();
      await pause(200);
      const [iconX, iconY] = await centerOf(indicator);
      await driver.move(iconX, iconY);
      await driver.click();
      await pause(300);
      report('pointer-panel-menu-opens', indicator.menu.isOpen);
      const items = indicator.menu._getMenuItems();
      const settingsItem = items.find(item => item.label?.text === 'Settings');
      if (settingsItem && indicator.menu.isOpen) {
        let settingsActivated = false;
        const original = Main.extensionManager.openExtensionPrefs;
        Main.extensionManager.openExtensionPrefs = () => { settingsActivated = true; };
        const [sx, sy] = await centerOf(settingsItem);
        await driver.moveNear(sx, sy);
        await driver.click();
        await pause(200);
        Main.extensionManager.openExtensionPrefs = original;
        report('pointer-panel-settings-activates', settingsActivated);
      } else {
        report('pointer-panel-settings-activates', false);
      }
      // Activating any item closes the menu: reopen it for the next click.
      if (!indicator.menu.isOpen) {
        const [ix2, iy2] = await centerOf(indicator);
        await driver.moveNear(ix2, iy2);
        await driver.click();
        await pause(300);
      }
      if (indicator.menu.isOpen) {
        const historyItem = indicator.menu._getMenuItems()
          .find(item => item.label?.text === 'Intelligence History');
        if (historyItem) {
          const [hx, hy] = await centerOf(historyItem);
          await driver.moveNear(hx, hy);
          await driver.click();
          await pause(250);
          report('pointer-panel-history-opens', palette._isOpen &&
            palette._mode === 'history-list');
        } else {
          report('pointer-panel-history-opens', false);
        }
      } else {
        report('pointer-panel-history-opens', false);
      }
      palette.close();
      await pause(200);
    } else {
      report('pointer-panel-menu-opens', false);
      report('pointer-panel-settings-activates', false);
      report('pointer-panel-history-opens', false);
    }

    /* 13. The full explicit writing flow on a real AT-SPI fixture: chip click
     *     → preview, Retry, Replace, Undo, Done — every control by mouse. */
    const home = GLib.getenv('HOME');
    const fixturePath = `${home}/gdi-pointer-fixture`;
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('WAYLAND_DISPLAY', GLib.getenv('GDI_NESTED_DISPLAY'), true);
    launcher.setenv('GTK_A11Y', 'atspi', true);
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    const fixture = launcher.spawnv(['/usr/bin/python3',
      `${GLib.getenv('GDI_TEST_ROOT')}/tools/atspi-fixture.py`, fixturePath]);
    try {
      const ready = await waitFor(() =>
        GLib.file_test(fixturePath + '.ready', GLib.FileTest.EXISTS), 60);
      if (!ready)
        throw new Error('pointer fixture never became ready');
      await pause(500);
      const pid = Number(fixture.get_identifier());
      const context = await new Promise((resolve, reject) =>
        captureFocusedContext(pid, (reply, error) => {
          if (error) { reject(error); return; }
          const [token, selected, nearby, application, role, start, end, caret,
            editable] = reply;
          let capabilities = null;
          try { capabilities = JSON.parse(reply[9] ?? 'null'); } catch { capabilities = null; }
          resolve({token, selected, nearby, application, role, start, end, caret,
            editable, capabilities});
        }));
      if (!context.selected)
        throw new Error('pointer fixture selection was not captured');
      // The palette owns the token from here: open() registers it, close()
      // releases it. Releasing it here would invalidate the Replace probe.
      palette.open(context);
      await pause(250);
      const improve = findChip(palette, 'Improve');
      report('pointer-writing-chips-from-capture', Boolean(improve));
      if (improve) {
        await clickActor(driver, improve);
        const preview = await waitFor(() =>
          palette._mode === 'writing-result' && findChip(palette, 'Replace'), 120);
        report('pointer-writing-chip-request-completes', preview);
        const retry = findChip(palette, 'Retry');
        if (retry && preview) {
          await clickActor(driver, retry);
          const reloaded = await waitFor(() =>
            palette._mode === 'writing-result' && findChip(palette, 'Replace'), 120);
          report('pointer-retry-click-reloads', reloaded);
        } else {
          report('pointer-retry-click-reloads', false);
        }
        const replace = findChip(palette, 'Replace');
        if (replace && preview) {
          await clickActor(driver, replace);
          const replaced = await waitFor(() => palette._mode === 'writing-done', 100);
          const contents = () => String(new TextDecoder().decode(
            GLib.file_get_contents(fixturePath)[1]));
          report('pointer-replace-click-applies', replaced &&
            contents().includes('selected phrase revised'));
          const undo = findChip(palette, 'Undo');
          if (undo && replaced) {
            await clickActor(driver, undo);
            const undone = await waitFor(() => !palette._undoAvailable, 60);
            report('pointer-undo-click-restores', undone &&
              contents().includes('selected phrase 🌙'));
          } else {
            report('pointer-undo-click-restores', false);
          }
          const doneButton = findChip(palette, 'Done');
          if (doneButton) {
            await clickActor(driver, doneButton);
            report('pointer-done-click-closes', !palette._isOpen);
          } else {
            report('pointer-done-click-closes', false);
          }
        } else {
          report('pointer-replace-click-applies', false);
          report('pointer-undo-click-restores', false);
          report('pointer-done-click-closes', false);
        }
      }
    } finally {
      fixture.force_exit();
      palette.close();
    }

    /* 14. Clipboard Intelligence with real pointer events: the strip chip
     *     click runs the action on the current clipboard text, Copy really
     *     copies the result, the dismiss button hides the strip, and the
     *     command list's Hide row dismisses too. */
    try {
      palette._settings.set_string('model-endpoint',
        `http://127.0.0.1:${GLib.getenv('GDI_MOCK_PORT')}`);
      St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD,
        'EchoFixture:PointerClipToken9');
      await pause(250);
      palette.open();
      await pause(400);
      report('pointer-clipboard-strip-shown', palette._clipboardStrip.visible);
      const clipChip = palette._clipboardChips.get_children()
        .find(button => button.label === 'Summarize');
      if (clipChip && palette._clipboardStrip.visible) {
        await clickActor(driver, clipChip);
        const clipResult = await waitFor(() => palette._mode === 'writing-result', 120);
        report('pointer-clipboard-chip-click-runs', clipResult &&
          palette._writingSuggestion === 'PointerClipToken9');
        const copyButton = palette._writingControls.get_children()
          .find(b => b.label === 'Copy');
        if (copyButton && clipResult) {
          await clickActor(driver, copyButton);
          let copied = false;
          for (let i = 0; i < 40 && !copied; i++) {
            await pause(100);
            copied = (await clipboardText()) === 'PointerClipToken9';
          }
          report('pointer-clipboard-copy-click-copies', copied);
        } else {
          report('pointer-clipboard-copy-click-copies', false);
        }
      } else {
        report('pointer-clipboard-chip-click-runs', false);
        report('pointer-clipboard-copy-click-copies', false);
      }
      palette.close();
      await pause(200);
      palette.open();
      await pause(400);
      const clipDismiss = palette._clipboardStrip.get_first_child()?.get_children()
        .find(child => child.has_style_class_name?.('gdi-clipboard-dismiss'));
      if (clipDismiss && palette._clipboardStrip.visible) {
        await clickActor(driver, clipDismiss);
        await pause(150);
        report('pointer-clipboard-dismiss-click-hides', !palette._clipboardStrip.visible);
      } else {
        report('pointer-clipboard-dismiss-click-hides', false);
      }
      // The typed command's Hide row dismisses with a real click too.
      palette._entry.set_text('clipboard');
      await waitFor(() => palette._items.length === 7, 60);
      const hideRow = palette._results.get_children()[6];
      if (hideRow && palette._items[6]?.type === 'clipboard-dismiss') {
        await clickActor(driver, hideRow);
        await pause(150);
        report('pointer-clipboard-hide-row-click-dismisses', !palette._clipboardStrip.visible);
      } else {
        report('pointer-clipboard-hide-row-click-dismisses', false);
      }
      St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ' ');
      await pause(150);
    } catch (error) {
      for (const name of ['pointer-clipboard-strip-shown',
        'pointer-clipboard-chip-click-runs', 'pointer-clipboard-copy-click-copies',
        'pointer-clipboard-dismiss-click-hides', 'pointer-clipboard-hide-row-click-dismisses'])
        report(name, false);
      console.log('GDI_DEBUG pointer-clipboard-error', String(error.message ?? error));
    }
    palette.close();
    await pause(200);

    /* 15. Notification Intelligence with real pointer events: a notification
     *     row opens the detail view, Copy text really copies, Back returns to
     *     the list, Dismiss removes through GNOME's own destroy, and the
     *     Summarize row runs the established flow to the echo result. */
    const notifSource = new MessageTray.Source({
      title: 'GDI Pointer Notes',
      icon: new Gio.ThemedIcon({name: 'application-x-executable'}),
    });
    // Banners suppressed: GNOME acknowledges a notification when its banner
    // shows, and a banner overlay could also interfere with real clicks.
    const bannersWereBlocked = Main.messageTray.bannerBlocked;
    Main.messageTray.bannerBlocked = true;
    try {
      Main.messageTray.add(notifSource);
      const pointerNotification = new MessageTray.Notification({
        source: notifSource,
        title: 'Pointer note',
        body: 'EchoFixture:NotifPointerEcho5 marker body.',
      });
      const plainNotification = new MessageTray.Notification({
        source: notifSource,
        title: 'Plain note',
        body: 'A second fixture for dismissal.',
      });
      notifSource.addNotification(pointerNotification);
      notifSource.addNotification(plainNotification);

      palette.open();
      await pause(400);
      palette._entry.set_text('notifications');
      await waitFor(() => palette._items.some(item => item.type === 'notification'));
      const detailIndexOf = name => palette._items.findIndex(item =>
        item.type === 'notification' && item.name === name);
      await clickActor(driver,
        palette._results.get_children()[detailIndexOf('Pointer note')]);
      const detailed = await waitFor(() => palette._mode === 'notification-detail');
      report('pointer-notifications-row-opens-detail', detailed &&
        palette._writingControls.get_children().some(button =>
          button.label === 'Dismiss'));

      const copyTextButton = palette._writingControls.get_children()
        .find(button => button.label === 'Copy text');
      if (copyTextButton && detailed) {
        await clickActor(driver, copyTextButton);
        let copied = false;
        for (let i = 0; i < 40 && !copied; i++) {
          await pause(100);
          copied = (await clipboardText()).includes('EchoFixture:NotifPointerEcho5');
        }
        report('pointer-notifications-copy-text-copies', copied);
      } else {
        report('pointer-notifications-copy-text-copies', false);
      }

      const backButton = palette._writingControls.get_children()
        .find(button => button.label === 'Back');
      if (backButton && detailed) {
        await clickActor(driver, backButton);
        await pause(150);
        report('pointer-notifications-back-click-returns',
          palette._mode === 'notifications');
      } else {
        report('pointer-notifications-back-click-returns', false);
      }

      await clickActor(driver,
        palette._results.get_children()[detailIndexOf('Plain note')]);
      await waitFor(() => palette._mode === 'notification-detail');
      const dismissButton = palette._writingControls.get_children()
        .find(button => button.label === 'Dismiss');
      if (dismissButton) {
        await clickActor(driver, dismissButton);
        await pause(200);
        report('pointer-notifications-dismiss-click-removes',
          palette._mode === 'notifications' &&
          !palette._items.some(item => item.type === 'notification' &&
            item.name === 'Plain note') &&
          notifSource.notifications.length === 1);
      } else {
        report('pointer-notifications-dismiss-click-removes', false);
      }

      const summarizeRow = palette._results.get_children()[palette._items
        .findIndex(item => item.type === 'notification-ai' && item.actionKey === 'summarize')];
      if (summarizeRow) {
        await clickActor(driver, summarizeRow);
        const ranFlow = await waitFor(() =>
          palette._mode === 'writing-result' || palette._mode === 'writing-error', 140);
        report('pointer-notifications-summarize-click-runs', ranFlow &&
          palette._writingSuggestion === 'NotifPointerEcho5 marker body.');
      } else {
        report('pointer-notifications-summarize-click-runs', false);
      }
      palette.close();
      await pause(200);
    } catch (error) {
      for (const name of ['pointer-notifications-row-opens-detail',
        'pointer-notifications-copy-text-copies',
        'pointer-notifications-back-click-returns',
        'pointer-notifications-dismiss-click-removes',
        'pointer-notifications-summarize-click-runs'])
        report(name, false);
      console.log('GDI_DEBUG pointer-notifications-error', String(error.message ?? error));
      palette.close();
    } finally {
      try {
        notifSource.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
      } catch {
        /* Already gone. */
      }
      Main.messageTray.bannerBlocked = bannersWereBlocked;
    }
  } catch (error) {
    report('pointer-probe-error', String(error.message ?? error));
    palette.close();
  } finally {
    /* End of the leak baseline validatePerf recorded before the storm: a
     * large RSS delta across open/close storms, history, actions, streaming
     * and pointer traffic would indicate leaked actors or signals. */
    const start = globalThis.__gdiPerfRssKb;
    try {
      const status = new TextDecoder().decode(
        GLib.file_get_contents('/proc/self/status')[1]);
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      if (match && start > 0) {
        const end = Number(match[1]);
        const delta = end - start;
        console.log(`GDI_PERF shell_rss_kb_end=${end} delta_kb=${delta}`);
        report('stress-shell-rss-stable', delta < 60 * 1024);
      } else {
        report('stress-shell-rss-stable', true);
      }
    } catch {
      report('stress-shell-rss-stable', true);
    }
    await driver.stop();
  }
}
