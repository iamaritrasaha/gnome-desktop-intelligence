import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/intelligence/WritingMenu.js', import.meta.url), 'utf8');
const {writingMenuFor, TONE_ACTIONS, MORE_ACTIONS} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Selected text: the compact primary row with progressive disclosure.
const capsReplaceable = {
  canReadSelection: true, canReplaceSelection: true, canInsertText: true,
  canReadCaretContext: true, canReadText: true,
};
const menu = writingMenuFor({selected: true, capabilities: capsReplaceable});
assert.deepEqual(menu.map(item => item.label), ['Improve', 'Fix', 'Shorten', 'Tone', 'More…']);
const tone = menu.find(item => item.key === 'tone');
assert.deepEqual(tone.children.map(item => item.label), ['Professional', 'Casual', 'Friendly', 'Direct']);
const more = menu.find(item => item.key === 'more');
assert.deepEqual(more.children.map(item => item.label),
  ['Expand', 'Summarize', 'Explain', 'Translate', 'Ask Intelligence']);
// Progressive disclosure: the full action set is NOT shown at once.
assert(menu.length === 5 && tone.children.length === 4 && more.children.length === 5);

// No selection: contextual caret-scoped actions, gated by the capability
// snapshot.
const contextual = writingMenuFor({selected: false, capabilities: {...capsReplaceable, canReadSelection: false}});
assert.deepEqual(contextual.map(item => item.label),
  ['Improve sentence', 'Continue writing', 'Fix paragraph', 'Tone', 'More…']);
// 'Continue writing' needs insertion capability.
const readOnlyField = writingMenuFor({selected: false,
  capabilities: {...capsReplaceable, canReadSelection: false, canInsertText: false, canReplaceSelection: false}});
assert(!readOnlyField.some(item => item.key === 'continue'));
assert(readOnlyField.length === 4);
// Unsupported targets get no writing surface at all — never a broken menu.
assert.deepEqual(writingMenuFor({selected: true, capabilities: null}), []);
assert.deepEqual(writingMenuFor({selected: true, capabilities: {canReadSelection: false}}), []);
assert.deepEqual(writingMenuFor({selected: false, capabilities: {canReadCaretContext: false}}), []);
assert.deepEqual(writingMenuFor({}), []);

// Tone and More children always carry the same stable action keys.
for (const action of [...TONE_ACTIONS, ...MORE_ACTIONS])
  assert(/^[a-z]+$/.test(action.key) && action.label.length > 0);

console.log('GDI_WRITING_MENU compact contextual surface, Tone/More disclosure and capability gating PASS');
