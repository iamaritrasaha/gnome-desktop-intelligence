/* Isolated screenshot fixture driver. Never packaged or enabled on the host. */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
  resolve(); return GLib.SOURCE_REMOVE;
}));

export async function visual(request) {
  const {state, theme, scale, name} = JSON.parse(request);
  const extension = Main.extensionManager.lookup('gdi@gnome.desktop.intelligence').stateObj;
  const p = extension._palette;
  if (theme) {
    const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    settings.set_string('color-scheme', `prefer-${theme}`);
    settings.set_double('text-scaling-factor', scale);
    await pause(600);
    // Ubuntu may keep Shell menus dark with light applications. Exercise the
    // actual upstream GNOME 46 light/dark stylesheets as well, test session only.
    const context = St.ThemeContext.get_for_stage(global.stage);
    const previous = context.get_theme();
    const native = new St.Theme({default_stylesheet: Gio.File.new_for_uri(
      `resource:///org/gnome/shell/theme/gnome-shell-${theme}.css`)});
    for (const sheet of previous.get_custom_stylesheets()) native.load_stylesheet(sheet);
    context.set_theme(native);
    await pause(100);
  }
  if (state && state !== 'capture') {
    extension._indicator.menu.close();
    p.close();
    await pause(160);
    if (state === 'panel') extension._indicator.menu.open();
    else if (state !== 'closed') {
      p.open();
      if (state === 'search') p._entry.set_text('search attention mechanism');
      if (state === 'ask') p._entry.set_text('Explain how attention works');
      if (state === 'results' || state === 'long') {
        const names = state === 'long'
          ? ['A very long application name that should truncate gracefully at the palette edge',
            'A very long document title with notes and revisions for the upcoming planning meeting']
          : ['Files', 'Text Editor', 'Settings', 'Calculator'];
        p._setResults(names.map((title, index) => ({
          type: state === 'long' && index === 1 ? 'file' : 'app', name: title,
          description: state === 'long' ? '/home/example/Documents/Research/Project planning and revisions' : '',
          icon: new Gio.ThemedIcon({name: ['org.gnome.Nautilus', 'org.gnome.TextEditor', 'org.gnome.Settings', 'org.gnome.Calculator'][index]}),
        })));
      }
      if (state === 'loading') {
        p._settings.set_string('model-endpoint', `http://127.0.0.1:${GLib.getenv('GDI_MOCK_PORT')}`);
        p._writingContext = {token: GLib.uuid_string_random(), selected: '', nearby: '', editable: false};
        p._startWritingRequest({key: 'assistant', label: 'Ask Intelligence'}, 'slow fixture question');
      }
      if (state === 'response' || state === 'writing') {
        const writing = state === 'writing';
        p._writingContext = {token: '', selected: writing
          ? 'The team have reviewed the proposal and we thinks it is ready to share.' : '', nearby: '', editable: writing};
        p._writingAction = {key: writing ? 'proofread' : 'assistant', label: writing ? 'Fix grammar' : 'Ask Intelligence'};
        p._writingSuggestion = writing
          ? 'The team has reviewed the proposal, and we think it is ready to share.'
          : '# How attention works\n\nAttention finds the input that matters for the current task.\n\n- Compare queries and keys.\n- Scale scores before `softmax`.\n- Combine the values.\n\n```python\nweights = softmax(scores)\noutput = weights @ values\n```\n\n[Read GNOME documentation](https://www.gnome.org/)';
        p._renderWritingResult(p._writingSuggestion, '');
      }
    }
    await pause(250);
  }
  const out = `${GLib.getenv('GDI_CHECK_ROOT')}/build/validation/visual`;
  GLib.mkdir_with_parents(out, 0o755);
  const path = `${out}/${name}.png`;
  const monitor = Main.layoutManager.primaryMonitor;
  const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
  const shot = new Shell.Screenshot();
  await new Promise((resolve, reject) => shot.screenshot_area(
    monitor.x, monitor.y, monitor.width, monitor.height, stream, (object, result) => {
      try { object.screenshot_area_finish(result); stream.close(null); resolve(); }
      catch (error) { reject(error); }
    }));
  const [x, y] = p._palette.get_transformed_position();
  return JSON.stringify({path, x, y, width: p._palette.width, height: p._palette.height,
    mode: p._mode, theme: Main.getStyleVariant(),
    surface: p._palette.get_theme_node().get_background_color().to_string(),
    hint: p._entry.get_hint_actor().get_theme_node().get_foreground_color().to_string(),
    hintOpacity: p._entry.get_hint_actor().opacity,
    monitor: {width: monitor.width, height: monitor.height}});
}
