import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/intelligence/ClipboardTools.js', import.meta.url), 'utf8');
const {CLIPBOARD_MAX_CHARS, CLIPBOARD_CHIP_ACTIONS, clipboardCommandFor,
  assessClipboardText, clipboardCapabilities} =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

/* Command parsing: the required launcher commands, case-insensitive, with the
 * same normalize rules as the deterministic action parser. */
assert.deepEqual(clipboardCommandFor('clipboard'), {kind: 'surface'});
assert.deepEqual(clipboardCommandFor('  Clipboard '), {kind: 'surface'});
assert.deepEqual(clipboardCommandFor('CLIPBOARD'), {kind: 'surface'});
assert.deepEqual(clipboardCommandFor('clipboard?'), {kind: 'surface'});

for (const [query, actionKey] of [
  ['summarize clipboard', 'summarize'],
  ['Summarize clipboard', 'summarize'],
  ['summaries clipboard'.replace('summaries', 'summarize'), 'summarize'],
  ['improve clipboard', 'rewrite'],
  ['rewrite clipboard', 'rewrite'],
  ['fix clipboard', 'proofread'],
  ['correct clipboard', 'proofread'],
  ['proofread clipboard', 'proofread'],
  ['explain clipboard', 'explain'],
  ['translate clipboard', 'translate'],
]) {
  const command = clipboardCommandFor(query);
  assert.deepEqual(command, {kind: 'action', actionKey});
}

assert.deepEqual(clipboardCommandFor('ask clipboard'),
  {kind: 'action', actionKey: 'ask', question: ''});
assert.deepEqual(clipboardCommandFor('ask clipboard what does this mean'),
  {kind: 'action', actionKey: 'ask', question: 'what does this mean'});
assert.deepEqual(clipboardCommandFor('  ASK   CLIPBOARD   why? '),
  {kind: 'action', actionKey: 'ask', question: 'why'});
// The question is user content: only the command words are routing metadata,
// so mixed-case remainders keep their exact casing.
assert.deepEqual(clipboardCommandFor('ask clipboard EchoFixture:MixedCase7'),
  {kind: 'action', actionKey: 'ask', question: 'EchoFixture:MixedCase7'});

/* Non-commands keep ordinary launcher routing (apps, files, actions, Ask). */
for (const query of [
  'clipboard manager', 'summarize', 'summarize this text', 'fix', 'ask',
  'ask why', 'search clipboard', 'open clipboard', 'find clipboard',
  'fix  the clipboard', 'explain the clipboard', 'translate to french clipboard',
  'volume', '', null, undefined,
]) {
  assert.equal(clipboardCommandFor(query), null, JSON.stringify(query));
}

/* Content assessment: every required shape, with the length decision only. */
const shortText = 'Copy this URL https://example.com/x';
const short = assessClipboardText(shortText);
assert.deepEqual(short, {usable: true, length: shortText.length});

// Multiline prose keeps its exact character count; no text is retained.
const multilineText = 'First line.\n\nSecond paragraph — with Unicode ✓.\n';
const multiline = assessClipboardText(multilineText);
assert.ok(multiline.usable && multiline.length === multilineText.length);

// Code and whitespace-heavy text are ordinary text.
assert.ok(assessClipboardText('def f(x):\n    return x * 2').usable);
assert.ok(assessClipboardText('   \n  ').usable === false);

// Empty and non-text content are ignored, never shown as actions.
assert.deepEqual(assessClipboardText(''), {usable: false, reason: 'empty'});
assert.deepEqual(assessClipboardText('   '), {usable: false, reason: 'empty'});
assert.deepEqual(assessClipboardText(null), {usable: false, reason: 'empty'});
assert.deepEqual(assessClipboardText(undefined), {usable: false, reason: 'empty'});
assert.deepEqual(assessClipboardText(42), {usable: false, reason: 'empty'});

// Exactly at the limit is usable; one character more is refused, untruncated.
assert.equal(CLIPBOARD_MAX_CHARS, 12000);
assert.ok(assessClipboardText('x'.repeat(CLIPBOARD_MAX_CHARS)).usable);
const oversized = assessClipboardText('x'.repeat(CLIPBOARD_MAX_CHARS + 1));
assert.deepEqual(oversized, {usable: false, reason: 'too-large', length: CLIPBOARD_MAX_CHARS + 1});

/* Strip actions: stable keys that map onto existing Writing/Ask routes, with
 * the two prompt actions marked. */
assert.deepEqual(CLIPBOARD_CHIP_ACTIONS.map(item => item.label),
  ['Summarize', 'Improve', 'Fix', 'Explain', 'Translate', 'Ask Intelligence']);
for (const item of CLIPBOARD_CHIP_ACTIONS) {
  assert.ok(['summarize', 'rewrite', 'proofread', 'explain', 'translate', 'ask'].includes(item.key));
  assert.equal(!!item.prompt, ['translate', 'ask'].includes(item.key));
}

/* Capabilities: clipboard text is readable and never replaceable — the whole
 * feature is read/transform/copy by construction. */
const caps = clipboardCapabilities();
assert.equal(caps.canReadSelection, true);
assert.equal(caps.canReplaceSelection, false);
assert.equal(caps.canInsertText, false);
assert.equal(caps.canObserveTyping, false);
assert.equal(caps.hasField, false);
assert.equal(caps.application, 'Clipboard');

console.log('test-clipboard: PASS');
