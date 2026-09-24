/* GDI Phase 4 action registry/parser unit checks (run with: node tools/test-actions.mjs) */
import assert from 'node:assert/strict';
import {copyFileSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// parser.js imports registry.js relatively, so load both from a temporary
// ESM package instead of the data-URL trick used for dependency-free modules.
const moduleDir = mkdtempSync(join(tmpdir(), 'gdi-actions-'));
writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({type: 'module'}));
for (const name of ['registry.js', 'parser.js'])
  copyFileSync(new URL(`../src/actions/${name}`, import.meta.url), join(moduleDir, name));
const registry = await import(pathToFileURL(join(moduleDir, 'registry.js')));
const parser = await import(pathToFileURL(join(moduleDir, 'parser.js')));
const {parseAction, parseActionPlan, parseFileQuery, normalizeQuery} = parser;
const {validateArgs, needsConfirmation, describeModelRoutable, getAction, RISK} = registry;

/* ---- deterministic parsing: the phase's example phrases ---------------- */
const cases = [
  ['volume 30', 'audio.setVolume', {percent: 30}],
  ['set the volume to 40', 'audio.setVolume', {percent: 40}],
  ['make the volume 40', 'audio.setVolume', {percent: 40}],
  ['set sound to 40 percent', 'audio.setVolume', {percent: 40}],
  ['volume 30%', 'audio.setVolume', {percent: 30}],
  ['mute', 'audio.setMute', {muted: true}],
  ['mute the sound', 'audio.setMute', {muted: true}],
  ['unmute audio', 'audio.setMute', {muted: false}],
  ['sound off', 'audio.setMute', {muted: true}],
  ['turn off the sound', 'audio.setMute', {muted: true}],
  ['volume up', 'audio.adjustVolume', {step: 10}],
  ['louder', 'audio.adjustVolume', {step: 10}],
  ['quieter', 'audio.adjustVolume', {step: -10}],
  ['turn the volume down', 'audio.adjustVolume', {step: -10}],
  ['what is the volume', 'audio.getVolume', {}],
  ['volume', 'audio.getVolume', {}],

  ['turn bluetooth off', 'bluetooth.setState', {enabled: false}],
  ['bluetooth off', 'bluetooth.setState', {enabled: false}],
  ['switch off bluetooth', 'bluetooth.setState', {enabled: false}],
  ['disable bluetooth', 'bluetooth.setState', {enabled: false}],
  ['turn bluetooth on', 'bluetooth.setState', {enabled: true}],
  ['enable bluetooth', 'bluetooth.setState', {enabled: true}],
  ['bluetooth status', 'bluetooth.getState', {}],
  ['is bluetooth on', 'bluetooth.getState', {}],

  ['turn wifi on', 'wifi.setState', {enabled: true}],
  ['wifi off', 'wifi.setState', {enabled: false}],
  ['turn off wifi', 'wifi.setState', {enabled: false}],
  ['switch off wi-fi', 'wifi.setState', {enabled: false}],
  ['disable wireless', 'wifi.setState', {enabled: false}],
  ['wi-fi status', 'wifi.getState', {}],

  ['switch to power saver', 'power.setProfile', {profile: 'power-saver'}],
  ['use power saver', 'power.setProfile', {profile: 'power-saver'}],
  ['battery saver', 'power.setProfile', {profile: 'power-saver'}],
  ['switch to performance mode', 'power.setProfile', {profile: 'performance'}],
  ['balanced', 'power.setProfile', {profile: 'balanced'}],
  ['power profile', 'power.getProfile', {}],
  ['what power profile am i on', 'power.getProfile', {}],

  ['turn on dark mode', 'gnome.setColorScheme', {scheme: 'prefer-dark'}],
  ['dark mode', 'gnome.setColorScheme', {scheme: 'prefer-dark'}],
  ['enable dark theme', 'gnome.setColorScheme', {scheme: 'prefer-dark'}],
  ['turn off dark mode', 'gnome.setColorScheme', {scheme: 'default'}],
  ['light mode', 'gnome.setColorScheme', {scheme: 'default'}],
  ['color scheme', 'gnome.getColorScheme', {}],

  ['turn on night light', 'gnome.setNightLight', {enabled: true}],
  ['night light off', 'gnome.setNightLight', {enabled: false}],
  ['disable night light', 'gnome.setNightLight', {enabled: false}],
  ['night light', 'gnome.getNightLight', {}],

  ['brightness 40', 'display.setBrightness', {percent: 40}],
  ['set brightness to 75 percent', 'display.setBrightness', {percent: 75}],
  ['brightness up', 'display.adjustBrightness', {step: 10}],
  ['brighter', 'display.adjustBrightness', {step: 10}],
  ['dimmer', 'display.adjustBrightness', {step: -10}],
  ['brightness', 'display.getBrightness', {}],

  ['set text scaling to 1.25', 'gnome.setTextScaling', {factor: 1.25}],
  ['text scaling 1.5', 'gnome.setTextScaling', {factor: 1.5}],
  ['text size', 'gnome.getTextScaling', {}],

  ['how much disk space do i have', 'system.diskUsage', {}],
  ['disk space', 'system.diskUsage', {}],
  ['free disk space', 'system.diskUsage', {}],
  ['memory usage', 'system.memoryStatus', {}],
  ['how much ram', 'system.memoryStatus', {}],
  ['show my ip', 'system.networkStatus', {}],
  ['what is my ip', 'system.networkStatus', {}],
  ['ip address', 'system.networkStatus', {}],
  ['network status', 'system.networkStatus', {}],
  ['battery', 'system.batteryStatus', {}],
  ['battery level', 'system.batteryStatus', {}],

  ['open display settings', 'gnome.openSettingsPanel', {panel: 'display'}],
  ['display settings', 'gnome.openSettingsPanel', {panel: 'display'}],
  ['open sound settings', 'gnome.openSettingsPanel', {panel: 'sound'}],
  ['wifi settings', 'gnome.openSettingsPanel', {panel: 'wifi'}],
  ['appearance settings', 'gnome.openSettingsPanel', {panel: 'ubuntu'}],
  ['open settings', 'gnome.openSettingsPanel', {panel: ''}],

  ['open downloads', 'directory.open', {dir: 'downloads'}],
  ['open my documents', 'directory.open', {dir: 'documents'}],
  ['open the videos folder', 'directory.open', {dir: 'videos'}],
  ['open home', 'directory.open', {dir: 'home'}],

  ['open https://example.com/page', 'url.open', {url: 'https://example.com/page'}],
  ['https://www.gnome.org', 'url.open', {url: 'https://www.gnome.org'}],
];

for (const [query, id, args] of cases) {
  const parsed = parseAction(query);
  assert(parsed, `no parse: ${query}`);
  assert.equal(parsed.id, id, query);
  assert.deepEqual(parsed.args, args, query);
}

/* ---- non-actions stay deterministic launcher queries ------------------- */
for (const query of ['open firefox', 'open android studio', 'camera settings',
  'search attention mechanism', 'what is gradient descent', 'ask why',
  'volume 300', 'brightness 101', 'open https://user@evil.org', '2 + 2',
  'turn bluetooth off and eat a sandwich', 'open /etc/passwd', 'rm -rf /',
  'delete my files', 'install firefox', 'kill firefox']) {
  assert.equal(parseAction(query), null, `unexpected parse: ${query}`);
}

/* ---- normalization and case -------------------------------------------- */
assert.deepEqual(parseAction('VOLUME 30!'), {id: 'audio.setVolume', args: {percent: 30}});
assert.deepEqual(parseAction('PLEASE TURN BLUETOOTH OFF'), {id: 'bluetooth.setState', args: {enabled: false}});
assert.deepEqual(parseAction('could you turn bluetooth off'), {id: 'bluetooth.setState', args: {enabled: false}});
assert.equal(normalizeQuery('  What   Is My IP? '), 'what is my ip');

/* ---- bounded multi-step plans ------------------------------------------ */
const plan = parseActionPlan('turn bluetooth off and switch to power saver');
assert.deepEqual(plan.map(s => s.id), ['bluetooth.setState', 'power.setProfile']);
assert.deepEqual(parseActionPlan('volume 30 then mute').map(s => s.id),
  ['audio.setVolume', 'audio.setMute']);
assert.equal(parseActionPlan('turn bluetooth off and eat a sandwich'), null);
assert.equal(parseActionPlan('volume 30 and 2 + 2'), null);
assert.equal(parseActionPlan('volume 30 and'), null);
assert.equal(parseActionPlan('search cats and dogs'), null);

/* ---- file query phrasing ----------------------------------------------- */
assert.deepEqual(parseFileQuery('find resume pdf'),
  {terms: 'resume', extension: 'pdf', modifiedToday: false});
assert.deepEqual(parseFileQuery('find pdfs modified today'),
  {terms: '', extension: 'pdf', modifiedToday: true});
assert.deepEqual(parseFileQuery('find my cv'),
  {terms: 'cv', extension: null, modifiedToday: false});
assert.deepEqual(parseFileQuery('file report'),
  {terms: 'report', extension: null, modifiedToday: false});
assert.deepEqual(parseFileQuery('find report today'),
  {terms: 'report', extension: null, modifiedToday: true});
assert.equal(parseFileQuery('open firefox'), null);

/* ---- registry argument validation (the trust boundary) ----------------- */
assert.equal(validateArgs('audio.setVolume', {percent: 30}).ok, true);
assert.equal(validateArgs('audio.setVolume', {percent: 300}).reason, 'invalid-argument:percent');
assert.equal(validateArgs('audio.setVolume', {percent: 30, extra: 1}).reason, 'unexpected-argument:extra');
assert.equal(validateArgs('unknown.action', {}).reason, 'unknown-action');
assert.equal(validateArgs('bluetooth.setState', {enabled: 'yes'}).reason, 'invalid-argument:enabled');
assert.equal(validateArgs('power.setProfile', {profile: 'turbo'}).reason, 'invalid-argument:profile');
assert.equal(validateArgs('gnome.openSettingsPanel', {panel: 'display'}).ok, true);
assert.equal(validateArgs('gnome.openSettingsPanel', {panel: '; rm -rf'}).reason, 'invalid-argument:panel');
assert.equal(validateArgs('url.open', {url: 'file:///etc/passwd'}).reason, 'invalid-argument:url');
assert.equal(validateArgs('url.open', {url: 'javascript:alert(1)'}).ok, false);
assert.equal(validateArgs('url.open', {url: 'https://user@evil.org'}).ok, false);
assert.equal(validateArgs('url.open', {url: 'https://example.com/x'}).ok, true);
assert.equal(validateArgs('gnome.setTextScaling', {factor: 4}).ok, false);
assert.equal(validateArgs('gnome.setTextScaling', {factor: 1.25}).args.factor, 1.25);
assert.equal(validateArgs('bluetooth.setState', {enabled: false}).args.enabled, false);
assert.equal(getAction('audio.setVolume').risk, RISK.STATE_CHANGE);
assert.equal(getAction('system.diskUsage').risk, RISK.READ_ONLY);

/* ---- confirmation policy ----------------------------------------------- */
assert.equal(needsConfirmation('audio.setVolume', {percent: 30}).confirm, false);
assert.equal(needsConfirmation('gnome.setColorScheme', {scheme: 'prefer-dark'}).confirm, false);
assert.equal(needsConfirmation('system.diskUsage', {}).confirm, false);
assert.equal(needsConfirmation('gnome.setTextScaling', {factor: 1.5}).confirm, true);
assert.equal(needsConfirmation('wifi.setState', {enabled: false}).confirm, true);
assert.equal(needsConfirmation('wifi.setState', {enabled: true}).confirm, false);
assert.equal(needsConfirmation('bluetooth.setState', {enabled: false}, {connectedDevices: 0}).confirm, false);
assert.equal(needsConfirmation('bluetooth.setState', {enabled: false}, {connectedDevices: 2}).confirm, true);
assert.equal(needsConfirmation('bluetooth.setState', {enabled: true}, {connectedDevices: 2}).confirm, false);

/* ---- model routing surface --------------------------------------------- */
const routable = describeModelRoutable().map(a => a.id);
assert(routable.includes('bluetooth.setState'));
assert(routable.includes('audio.setVolume'));
assert(!routable.includes('app.open'));
assert(!routable.includes('file.open'));
assert(!routable.includes('web.search'));
assert(!routable.includes('url.open'));
assert(!routable.includes('directory.open'));
for (const entry of describeModelRoutable())
  assert(entry.description && entry.description.length < 120, entry.id);

console.log('Action registry, parser, validation and confirmation policy: PASS');
