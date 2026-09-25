/* Native St rendering, with escaped Pango and keyboard-focusable safe links. */
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import {diffMarkup, markdownBlocks, responseLinks, stableStreamView} from './Presentation.js';

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

/* Fenced code is display-and-copy only: a distinct block that scrolls
 * horizontally instead of widening anything, with its own copy control. */
function addCodeBlock(parent, block) {
  const container = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'gdi-markdown-code'});
  const header = new St.BoxLayout({x_expand: true, style_class: 'gdi-code-header'});
  const copy = new St.Button({style_class: 'button flat gdi-code-copy', label: 'Copy',
    can_focus: true, x_align: Clutter.ActorAlign.END});
  copy.connect('clicked', () => {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, block.raw ?? '');
    copy.label = 'Copied';
  });
  header.add_child(copy);
  container.add_child(header);
  const scroll = new St.ScrollView({
    style_class: 'gdi-code-scroll', x_expand: true,
  });
  scroll.set_policy(St.PolicyType.AUTOMATIC, St.PolicyType.NEVER);
  // GNOME 46's StScrollView.set_child requires an StScrollable: wrap the
  // code label in a box so long lines scroll horizontally instead of
  // widening the palette.
  const content = new St.BoxLayout({vertical: true});
  const code = new St.Label({style_class: 'gdi-code-text'});
  code.clutter_text.set_markup(`<tt>${block.markup}</tt>`);
  code.clutter_text.line_wrap = false;
  code.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
  content.add_child(code);
  scroll.set_child(content);
  container.add_child(scroll);
  parent.add_child(container);
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
    if (block.kind === 'code') { addCodeBlock(parent, block); continue; }
    parent.add_child(textLabel(block.markup, `gdi-writing-text gdi-markdown-${block.kind}`));
  }
  for (const uri of responseLinks(text))
    if (!linked.has(uri)) addLink(uri);
}

/* Incremental streaming renderer. Completed lines become rendered Markdown
 * blocks (kept when unchanged); the partial trailing line is plain text, and
 * hidden while it still contains raw syntax tokens. finish() hands the whole
 * response to the complete renderer (links, code copy controls). */
export class StreamRenderer {
  constructor(parent) {
    this._parent = parent;
    this._box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'gdi-stream'});
    parent.add_child(this._box);
    this._blocks = [];
    this._tail = null;
  }

  update(text) {
    const {stable, tail} = stableStreamView(text);
    const blocks = stable ? markdownBlocks(stable) : [];
    const signature = blocks.map(block => `${block.kind}\u0000${block.markup}`);
    let common = 0;
    while (common < this._blocks.length && common < signature.length &&
           this._blocks[common] === signature[common])
      common++;
    if (common < this._blocks.length || common < signature.length) {
      if (this._tail) { this._tail.destroy(); this._tail = null; }
      for (const child of this._box.get_children().slice(common)) child.destroy();
      for (const block of blocks.slice(common)) {
        if (block.kind === 'code') {
          const label = textLabel(`<tt>${block.markup}</tt>`, 'gdi-writing-text gdi-markdown-code');
          this._box.add_child(label);
        } else {
          this._box.add_child(textLabel(block.markup, `gdi-writing-text gdi-markdown-${block.kind}`));
        }
      }
      this._blocks = signature;
    }
    if (tail) {
      if (!this._tail) {
        this._tail = new St.Label({style_class: 'gdi-writing-text gdi-stream-tail', x_expand: true});
        this._tail.clutter_text.line_wrap = true;
        this._tail.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._tail.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._box.add_child(this._tail);
      }
      this._tail.text = tail;
    } else if (this._tail) {
      this._tail.destroy();
      this._tail = null;
    }
  }

  finish(text) {
    this.destroy();
    addMarkdown(this._parent, text);
  }

  destroy() {
    this._box.destroy();
    this._tail = null;
    this._blocks = [];
  }
}
