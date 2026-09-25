/* Writing Tools menu structure: pure data so the compact contextual surface
 * is node-testable. The palette renders it; nothing here touches St/GJS. */

export const TONE_ACTIONS = [
  {key: 'professional', label: 'Professional'},
  {key: 'casual', label: 'Casual'},
  {key: 'friendly', label: 'Friendly'},
  {key: 'direct', label: 'Direct'},
];

export const MORE_ACTIONS = [
  {key: 'expand', label: 'Expand'},
  {key: 'summarize', label: 'Summarize'},
  {key: 'explain', label: 'Explain'},
  {key: 'translate', label: 'Translate'},
  {key: 'ask', label: 'Ask Intelligence'},
];

/* Primary row for selected text: the frequent actions up front, everything
 * else behind progressive disclosure. */
const SELECTION_PRIMARY = [
  {key: 'rewrite', label: 'Improve'},
  {key: 'proofread', label: 'Fix'},
  {key: 'concise', label: 'Shorten'},
  {key: 'tone', label: 'Tone', children: TONE_ACTIONS},
  {key: 'more', label: 'More…', children: MORE_ACTIONS},
];

/* No-selection contextual actions, scoped to the text at the caret. Every
 * entry names the capture it needs so availability can be decided from the
 * capability snapshot alone. */
const CONTEXT_PRIMARY = [
  {key: 'rewrite', label: 'Improve sentence', scope: 'sentence'},
  {key: 'continue', label: 'Continue writing', scope: 'sentence'},
  {key: 'proofread', label: 'Fix paragraph', scope: 'paragraph'},
  {key: 'tone', label: 'Tone', scope: 'sentence', children: TONE_ACTIONS},
  {key: 'more', label: 'More…', scope: 'sentence',
   children: MORE_ACTIONS.map(action => ({...action, scope: 'sentence'}))},
];

/* `capabilities` is the service capability snapshot; `selected` says whether
 * a selection was captured. Returns the top-level items the current target
 * actually supports, or an empty list when the surface is unsupported. */
export function writingMenuFor({selected = false, capabilities = null} = {}) {
  if (selected) {
    if (!capabilities || capabilities.canReadSelection !== true)
      return [];
    return SELECTION_PRIMARY;
  }
  if (!capabilities || capabilities.canReadCaretContext !== true)
    return [];
  const canInsert = capabilities.canInsertText === true || capabilities.canReplaceSelection === true;
  return CONTEXT_PRIMARY.filter(item =>
    item.key !== 'continue' || canInsert);
}
