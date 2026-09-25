import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/intelligence/Presentation.js', import.meta.url), 'utf8');
const {wordDiff, diffMarkup, markdownBlocks, responseLinks, selectionIntent, selectionIntentParts, askQueryRemainder} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
for (const [a, b] of [['This are useful.', 'This is useful.'], ['recieve', 'receive'], ['Hello world', 'Hello, world.'], ['a '.repeat(1200), 'b '.repeat(1200)], ['', 'new'], ['a', '']]) {
  const diff = wordDiff(a, b);
  assert.equal(diff.filter(r => r.kind !== 'add').map(r => r.text).join(''), a);
  assert.equal(diff.filter(r => r.kind !== 'remove').map(r => r.text).join(''), b);
}
assert(diffMarkup('a <b>', 'a <i>').suggestion.includes('&lt;i&gt;'));
const blocks = markdownBlocks('# Heading\n\n- Item **bold**\n\n```js\n<script>\n```\n\n`code` & text');
assert.deepEqual(blocks.map(b => b.kind), ['heading', 'list', 'code', 'text']);
assert(blocks[2].markup.includes('&lt;script&gt;'));
assert.deepEqual(responseLinks('[Docs](https://example.org/docs) file:///etc/passwd javascript:foo https://user@evil.org'), ['https://example.org/docs']);
assert.equal(selectionIntent('rewrite this naturally'), 'rewrite');
assert.equal(selectionIntent('explain this'), 'explain');
// Intent verbs are routing metadata and must never reach a model prompt.
assert.deepEqual(selectionIntentParts('explain this'), {action: 'explain', remainder: ''});
assert.deepEqual(selectionIntentParts('ask why does it work'), {action: 'ask', remainder: 'why does it work'});
assert.deepEqual(selectionIntentParts('ask'), {action: 'ask', remainder: ''});
assert.deepEqual(selectionIntentParts('improve writing for the report'), {action: 'rewrite', remainder: 'for the report'});
assert.deepEqual(selectionIntentParts('fix grammar'), {action: 'proofread', remainder: 'grammar'});
assert.deepEqual(selectionIntentParts('rewrite this'), {action: 'rewrite', remainder: ''});
assert.deepEqual(selectionIntentParts('summarize'), {action: 'summarize', remainder: ''});
// Launcher Ask commands: bare 'ask' prompts; 'ask <q>' strips the prefix;
// anything else is not an Ask command.
assert.equal(askQueryRemainder('ask'), '');
assert.equal(askQueryRemainder('  ask  '), '');
assert.equal(askQueryRemainder('ask what is gradient descent'), 'what is gradient descent');
assert.equal(askQueryRemainder('ASK why'), 'why');
assert.equal(askQueryRemainder('askeladd'), null);
assert.equal(askQueryRemainder('what is a neural network?'), null);
console.log('Bounded word diff, escaping, Markdown, safe links and selection intents: PASS');
assert.equal(markdownBlocks('[GNOME](https://www.gnome.org/)')[0].kind, 'link');
assert(!markdownBlocks('[Bad](https://user@evil.org)')[0].uri);
const {preferAssistant} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
assert(preferAssistant('why does attention use scaling', ['Attention']));
assert(!preferAssistant('firefox', ['Firefox']));

// Streaming Markdown hygiene: completed lines are stable, the partial tail is
// suppressed while it still contains raw syntax tokens.
const {stableStreamView, historyGroups} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
let view = stableStreamView('# Attention\n\n- Compare qu');
assert.equal(view.stable, '# Attention\n');
assert.equal(view.tail, ''); // tail starts a list: hidden until the line completes
view = stableStreamView('# Attention\n\nUse softmax to obtain ');
assert.equal(view.stable, '# Attention\n');
assert.equal(view.tail, 'Use softmax to obtain ');
view = stableStreamView('Use `softmax` to ob');
assert.equal(view.tail, ''); // partial inline code never flashes
view = stableStreamView('weights = **soft');
assert.equal(view.tail, ''); // partial bold never flashes
view = stableStreamView('plain tail with no markers');
assert.equal(view.tail, 'plain tail with no markers');
assert.deepEqual(stableStreamView(''), {stable: '', tail: ''});
// A fenced block opened but not closed stays in the stable region.
view = stableStreamView('```python\nweights = softmax(scores)\n');
assert(view.stable.startsWith('```python'));

// History grouping: local Today / Yesterday / Earlier buckets.
const now = new Date('2026-09-25T15:00:00');
const day = 86400000;
const conversations = [
  {id: 'a', updatedAt: now.getTime() / 1000},
  {id: 'b', updatedAt: (now.getTime() - day + 3600000) / 1000},
  {id: 'c', updatedAt: (now.getTime() - 5 * day) / 1000},
];
const groups = historyGroups(conversations, now.getTime());
assert.deepEqual(groups.Today.map(c => c.id), ['a']);
assert.deepEqual(groups.Yesterday.map(c => c.id), ['b']);
assert.deepEqual(groups.Earlier.map(c => c.id), ['c']);
assert.deepEqual(historyGroups([], now.getTime()), {Today: [], Yesterday: [], Earlier: []});
console.log('Streaming Markdown hygiene and history grouping: PASS');
