/* Native St rendering, with escaped Pango and keyboard-focusable safe links. */
import St from 'gi://St';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import {diffMarkup, markdownBlocks, responseLinks} from './Presentation.js';

export function textLabel(markup, style = 'gdi-writing-text') {
  const label = new St.Label({style_class: style, x_expand: true});
  label.clutter_text.set_markup(markup);
  label.clutter_text.line_wrap = true;
  label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
  label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
  return label;
}

export function addDiff(parent, original, suggestion, compact = false) {
  const diff = diffMarkup(original, suggestion);
  for (const [title, key] of [['Original', 'original'], ['Suggestion', 'suggestion']]) {
    const section = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'gdi-diff-section'});
    if (!compact) section.add_child(new St.Label({text: title, style_class: 'gdi-writing-section-title'}));
    const label = textLabel(diff[key], compact ? 'gdi-passive-text' : 'gdi-writing-text');
    if (key === 'original') label.opacity = 170;
    section.add_child(label);
    parent.add_child(section);
  }
}

export function addMarkdown(parent, text) {
  const linked = new Set();
  const addLink = (uri, title = uri) => {
    linked.add(uri);
    const button = new St.Button({style_class: 'button flat gdi-response-link', can_focus: true,
      label: title, x_expand: true, accessible_name: `Open link ${uri}`});
    (button.get_child().clutter_text ?? button.get_child()).ellipsize = Pango.EllipsizeMode.END;
    button.connect('clicked', () => {
      try { Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1)); }
      catch { button.label = 'Could not open link'; }
    });
    parent.add_child(button);
  };
  for (const block of markdownBlocks(text)) {
    if (block.kind === 'link') { addLink(block.uri, block.label); continue; }
    const label = textLabel(block.kind === 'code' ? `<tt>${block.markup}</tt>` : block.markup,
      `gdi-writing-text gdi-markdown-${block.kind}`);
    parent.add_child(label);
  }
  for (const uri of responseLinks(text))
    if (!linked.has(uri)) addLink(uri);
}
