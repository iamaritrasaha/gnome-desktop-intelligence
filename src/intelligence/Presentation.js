/* Bounded, toolkit-independent presentation. Model text is never trusted markup. */
export const escapeMarkup = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const safeLink = uri => /^https?:\/\/[^\s<>"\u0000-\u001f]+$/i.test(uri) && !/^https?:\/\/[^/]*@/i.test(uri);

export function wordDiff(original, suggestion) {
  const a = original.match(/\s+|[^\s]+/gu) ?? [];
  const b = suggestion.match(/\s+|[^\s]+/gu) ?? [];
  let runs = [];
  const push = (kind, text) => {
    if (runs.at(-1)?.kind === kind) runs.at(-1).text += text;
    else runs.push({kind, text});
  };
  // Long input cannot allocate an unbounded LCS matrix in Shell.
  if (a.length * b.length > 180000) {
    let start = 0, end = 0;
    while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
    while (end < Math.min(a.length, b.length) - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
    push('same', a.slice(0, start).join(''));
    push('remove', a.slice(start, a.length - end).join(''));
    push('add', b.slice(start, b.length - end).join(''));
    push('same', a.slice(a.length - end).join(''));
  } else {
    const matrix = Array.from({length: a.length + 1}, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { push('same', a[i++]); j++; }
      else if (i < a.length && (j === b.length || matrix[i + 1][j] >= matrix[i][j + 1])) push('remove', a[i++]);
      else push('add', b[j++]);
    }
  }
  return runs.filter(run => run.text);
}

export function diffMarkup(original, suggestion) {
  const runs = wordDiff(original, suggestion);
  return {
    original: runs.filter(r => r.kind !== 'add').map(r => r.kind === 'remove' ? `<s>${escapeMarkup(r.text)}</s>` : escapeMarkup(r.text)).join(''),
    suggestion: runs.filter(r => r.kind !== 'remove').map(r => r.kind === 'add' ? `<b>${escapeMarkup(r.text)}</b>` : escapeMarkup(r.text)).join(''),
  };
}

function inline(text) {
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map(part => {
    if (part.startsWith('`') && part.endsWith('`')) return `<tt>${escapeMarkup(part.slice(1, -1))}</tt>`;
    if (part.startsWith('**') && part.endsWith('**')) return `<b>${escapeMarkup(part.slice(2, -2))}</b>`;
    return escapeMarkup(part);
  }).join('');
}

export function markdownBlocks(text) {
  const blocks = [];
  let code = null, paragraph = [];
  const flush = () => { if (paragraph.length) blocks.push({kind: 'text', markup: inline(paragraph.join('\n'))}); paragraph = []; };
  for (const line of text.slice(0, 20000).split('\n')) {
    if (/^\s*```/.test(line)) {
      flush();
      if (code !== null) { blocks.push({kind: 'code', markup: escapeMarkup(code.join('\n'))}); code = null; }
      else code = [];
    } else if (code !== null) code.push(line);
    else if (/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.test(line)) {
      flush();
      const [, label, uri] = line.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (safeLink(uri)) blocks.push({kind: 'link', label, uri});
      else paragraph.push(line);
    }
    else if (/^#{1,6}\s/.test(line)) { flush(); blocks.push({kind: 'heading', markup: inline(line.replace(/^#+\s*/, ''))}); }
    else if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) { flush(); blocks.push({kind: 'list', markup: inline(line.replace(/^\s*[-*+] /, '• '))}); }
    else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  if (code !== null) blocks.push({kind: 'code', markup: escapeMarkup(code.join('\n'))});
  return blocks;
}

export function responseLinks(text) {
  // Only explicit user activation launches a web URI. No file/custom schemes.
  return [...new Set(text.match(/https?:\/\/[^\s<>"`\])]+/gi) ?? [])]
    .map(uri => uri.replace(/[.,;!?]+$/, '')).filter(safeLink).slice(0, 4);
}

export function selectionIntent(query) {
  if (/^(?:rewrite|improve)\b/i.test(query)) return 'rewrite';
  if (/^(?:fix|correct|proofread)\b/i.test(query)) return 'proofread';
  if (/^(?:summari[sz]e)\b/i.test(query)) return 'summarize';
  if (/^key points\b/i.test(query)) return 'keypoints';
  if (/^explain\b/i.test(query)) return 'explain';
  return 'ask';
}
export const isResponse = action => ['ask', 'assistant', 'harder', 'explain', 'summarize', 'keypoints'].includes(action);

// The typed intent verb is routing metadata, never user content: strip it
// before the remainder becomes a model-facing instruction. A bare anaphora
// ("explain this") refers to the selection itself and leaves no instruction.
const INTENT_VERBS = {
  rewrite: /^improve\s+writing\s*|^(?:rewrite|improve)\s*/i,
  proofread: /^(?:fix|correct|proofread)\s*/i,
  summarize: /^summari[sz]e\s*/i,
  keypoints: /^key\s+points\s*/i,
  explain: /^explain\s*/i,
  ask: /^ask\s*/i,
};
export function selectionIntentParts(query) {
  const action = selectionIntent(query);
  const remainder = query.replace(INTENT_VERBS[action], '').trim();
  const anaphora = /^(?:this|that|it|them|these|those)?$/i.test(remainder);
  return {action, remainder: action === 'ask' || !anaphora ? remainder : ''};
}

// Launcher Ask commands: 'ask' enters the empty prompt; 'ask <question>'
// submits only the question. Anything else is not an Ask command (null).
export function askQueryRemainder(query) {
  const match = query.trim().match(/^ask\s+(.+)$/i);
  if (match)
    return match[1].trim();
  return /^ask$/i.test(query.trim()) ? '' : null;
}

export function preferAssistant(query, appNames = []) {
  const normalized = query.trim().toLowerCase();
  if (appNames.some(name => name.toLowerCase() === normalized)) return false;
  return /^(?:explain|why|how|what|when|where|who|compare|describe|help me|tell me)\b/i.test(query);
}
