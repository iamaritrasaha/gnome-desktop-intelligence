/* Clipboard Intelligence structure: pure, node-testable data and rules.
 * The palette renders the surface and owns every St/GJS clipboard call;
 * nothing here touches St/GJS.
 *
 * Privacy model: clipboard text is read only while the palette is open or a
 * clipboard command runs, never in the background. Only the length decision
 * crosses back into the UI; the text itself is re-read from the clipboard at
 * the moment the user explicitly chooses an action and then only lives in the
 * service's bounded RAM context (same lifetime as a selection snapshot). */

export const CLIPBOARD_MAX_CHARS = 12000;

/* Every supported action maps onto the existing Writing/Ask routing keys. */
const CLIPBOARD_ACTION_KEYS = {
  summarize: 'summarize',
  improve: 'rewrite',
  rewrite: 'rewrite',
  fix: 'proofread',
  correct: 'proofread',
  proofread: 'proofread',
  explain: 'explain',
  translate: 'translate',
};

/* Subtle strip on palette open: the frequent actions, in order. `prompt`
 * actions need one question (target language / question) before anything is
 * sent; the palette asks for it through the existing question prompt. */
export const CLIPBOARD_CHIP_ACTIONS = [
  {key: 'summarize', label: 'Summarize'},
  {key: 'rewrite', label: 'Improve'},
  {key: 'proofread', label: 'Fix'},
  {key: 'explain', label: 'Explain'},
  {key: 'translate', label: 'Translate', prompt: true},
  {key: 'ask', label: 'Ask Intelligence', prompt: true},
];

/* Typed launcher commands. `clipboard` opens the action list;
 * `<verb> clipboard` proposes one explicit action row; `ask clipboard
 * <question>` proposes Ask with the clipboard as context. Anything else is
 * not a clipboard command (null) and keeps ordinary launcher routing.
 * Command words are routing metadata and case-insensitive, but the question
 * remainder keeps the user's original casing. */
export function clipboardCommandFor(query) {
  const raw = String(query ?? '').trim()
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ');
  const normalized = raw.toLowerCase();
  if (normalized === 'clipboard')
    return {kind: 'surface'};
  const verb = normalized.match(/^([a-z]+) clipboard$/);
  if (verb && CLIPBOARD_ACTION_KEYS[verb[1]])
    return {kind: 'action', actionKey: CLIPBOARD_ACTION_KEYS[verb[1]]};
  const ask = raw.match(/^ask clipboard(?:\s+(.+))?$/i);
  if (ask)
    return {kind: 'action', actionKey: 'ask', question: (ask[1] ?? '').trim()};
  return null;
}

/* Classify clipboard content without retaining it. Non-text content arrives
 * from St as null and is treated as empty; oversized text stays untouched in
 * the clipboard and is reported, never truncated silently. */
export function assessClipboardText(text) {
  if (typeof text !== 'string' || !text.trim())
    return {usable: false, reason: 'empty'};
  if (text.length > CLIPBOARD_MAX_CHARS)
    return {usable: false, reason: 'too-large', length: text.length};
  return {usable: true, length: text.length};
}

/* Capability snapshot for a clipboard context. Clipboard text is always
 * readable and never replaceable: GDI cannot modify the application the text
 * came from, so results are transform-and-copy only. */
export function clipboardCapabilities() {
  return {
    hasField: false,
    application: 'Clipboard',
    role: 'clipboard',
    canReadText: true,
    canReadSelection: true,
    canGetCaret: false,
    canReplaceSelection: false,
    canInsertText: false,
    canObserveTyping: false,
    canPassiveAssist: false,
    canReadCaretContext: false,
    reason: 'not-editable',
  };
}
