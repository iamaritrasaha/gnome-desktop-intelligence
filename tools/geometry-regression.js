/* Allocation regression probe: test-only, never included in the extension ZIP. */
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const settle = () => new Promise(resolve => GLib.timeout_add(
  GLib.PRIORITY_DEFAULT, 300, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
  }));

export async function validateGeometry(palette, report, capture = async () => {}) {
  const search = palette._search;
  const typeLabel = palette._getTypeLabel;
  const long = 'AbsurdlyLongFixtureNameWithoutBreaks'.repeat(100);
  const fixtures = {
    'gdi-fixture-short': [{type: 'app', name: 'Short'}],
    'gdi-fixture-two': [{type: 'app', name: 'One'}, {type: 'file', name: 'Two'}],
    'gdi-fixture-long': ['app', 'file', 'web', 'calc', 'app'].map(type => ({
      type, name: long, description: long, detail: long,
    })),
  };
  const allocations = [];
  const monitor = Main.layoutManager.currentMonitor;
  const width = Math.min(500, monitor.width - 32);
  const snapshot = async name => {
    await settle(); // Includes debounce, row fade, positioning idle and actual allocation.
    const actor = palette._palette;
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    const box = actor.get_allocation_box();
    const value = {name, x, y, width: w, height: h,
      allocation: [box.x1, box.y1, box.x2, box.y2]};
    allocations.push(value);
    report(`allocation-${name}`, JSON.stringify(value));
    const descendantsFit = parent => parent.get_children().every(child => {
      if (!child.visible)
        return true;
      const [cx] = child.get_transformed_position();
      const [cw] = child.get_transformed_size();
      return cx >= x - 1 && cx + cw <= x + w + 1 && descendantsFit(child);
    });
    report(`content-contained-${name}`, descendantsFit(actor));
    await capture(name, value);
    return value;
  };
  try {
    palette.close();
    await settle();
    palette.open();
    palette._search = function (query, generation) {
      if (fixtures[query])
        this._setResults(fixtures[query]);
      else
        search.call(this, query, generation);
    };
    const empty = await snapshot('empty');
    palette._entry.set_text('a');
    await snapshot('one-character');
    palette._entry.set_text('gdi-fixture-short');
    const one = await snapshot('short');
    palette._entry.set_text('gdi-fixture-two');
    const two = await snapshot('two');
    palette._getTypeLabel = () => long;
    palette._entry.set_text('gdi-fixture-long');
    const many = await snapshot('long');
    report('four-result-cap', palette._items.length === 4);
    report('compact-row-height', palette._results.get_children().every(row =>
      row.height >= 44 && row.height <= 48));
    const titles = palette._results.get_children().map(row =>
      row.get_child().get_children()[1].get_first_child());
    report('long-titles-ellipsized', titles.every(label =>
      label.clutter_text.get_layout().is_ellipsized()));
    palette._getTypeLabel = typeLabel;
    palette._entry.set_text(`search ${long}`);
    await snapshot('long-query');
    palette._entry.set_text('');
    const cleared = await snapshot('cleared');
    report('query-width-invariant', allocations.every(a => Math.abs(a.width - width) <= 1));
    report('query-top-invariant', allocations.every(a => Math.abs(a.y - empty.y) <= 0.5));
    report('query-center-invariant', allocations.every(a =>
      Math.abs(a.x + a.width / 2 - (monitor.x + monitor.width / 2)) <= 0.5));
    report('compact-dynamic-height', empty.height < one.height && one.height < two.height &&
      two.height < many.height && many.height <= 260 && cleared.height === empty.height);

    // Exercise real actor allocations, not just placement arithmetic, at signed origins.
    for (const origin of [-1280, 1920]) {
      const virtualMonitor = {x: origin, y: 100, width: 1280, height: 720};
      for (const query of ['', 'gdi-fixture-long', '']) {
        palette._entry.set_text(query);
        await settle();
        palette._positionPalette(virtualMonitor);
        await settle();
        const [x] = palette._palette.get_transformed_position();
        report(`monitor-origin-${origin}-${query || 'empty'}`,
          Math.abs(palette._palette.width - 500) <= 1 &&
          Math.abs(x + palette._palette.width / 2 - (origin + 640)) <= 0.5);
      }
    }
  } finally {
    palette._search = search;
    palette._getTypeLabel = typeLabel;
    palette.close();
    await settle();
  }
}
