/* Real pointer-input regression probe for nested GNOME sessions.
 *
 * Injects genuine pointer motion and button events through Mutter's own
 * RemoteDesktop mechanism, so hover tracking, actor picking, the modal-grab
 * routing and St.Button click generation all run exactly as they do with a
 * physical mouse. Nothing here invokes click handlers directly.
 *
 * Fixture output only; never installed or packaged.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

    /* 4. Writing Tools chips respond to real clicks. */
    palette.open();
    await pause(120);
    palette._writingContext = {selected: 'fixture selection',
      capabilities: {canReadSelection: true}};
    palette._showWritingActions();
    await pause(120);
    const toneChip = palette._writingControls.get_children()
      .find(button => button.label === 'Tone');
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
    palette.close();
    await pause(200);

    /* 5. The Ask Intelligence row responds to a real click. */
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

    /* 6. The mouse wheel scrolls a long Ask answer. */
    palette.open();
    palette._entry.set_text('ask Markdown fixture');
    const askRowShown = await waitFor(() =>
      palette._items.some(item => item.type === 'ask'));
    if (askRowShown)
      palette._activateItem(0);
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

      /* Result-surface buttons: Copy updates its own label, Clear returns
       * to the launcher. */
      const copyButton = palette._writingControls.get_children()
        .find(button => button.label === 'Copy');
      if (copyButton) {
        const [copyX, copyY] = await centerOf(copyButton);
        await driver.move(copyX, copyY);
        await driver.click();
        await pause(160);
        report('pointer-copy-click-copies', copyButton.label === 'Copied');
      } else {
        report('pointer-copy-click-copies', false);
      }
      const clearButton = palette._writingControls.get_children()
        .find(button => button.label === 'Clear');
      if (clearButton) {
        const [clearX, clearY] = await centerOf(clearButton);
        await driver.move(clearX, clearY);
        await driver.click();
        await pause(200);
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
  } catch (error) {
    report('pointer-probe-error', String(error.message ?? error));
    palette.close();
  } finally {
    await driver.stop();
  }
}
