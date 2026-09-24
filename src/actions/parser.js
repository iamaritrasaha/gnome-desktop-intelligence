/*
 * Deterministic natural-language intent parsing for GDI native actions.
 *
 * A bounded, inspectable rule table normalizes common desktop phrasings onto
 * registry actions. The routing model is only consulted when nothing here
 * matches (gated by engine-side keywords), never for the queries below.
 *
 * Copyright (C) 2026 GDI contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getAction, urlArg, PANELS, PANEL_ALIASES, DIRECTORIES } from './registry.js';

const MAX_STEPS = 3;

const KNOWN_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'txt', 'md', 'odt', 'rtf', 'tex', 'xls', 'xlsx', 'csv',
  'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mp3', 'mp4',
  'mkv', 'avi', 'wav', 'flac', 'ogg', 'zip', 'tar', 'gz', 'xz', 'deb', 'iso',
  'epub', 'pub',
];

export function normalizeQuery(query) {
  return String(query ?? '')
    .trim().toLowerCase()
    .replace(/^(?:could you |can you |would you |please )+/, '')
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const WIFI = '(?:wifi|wi-?fi|wireless)';
const STEP_DEFAULT = 10;

const clampPercent = value => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

/*
 * Each rule returns {id, args} or null. Order matters: more specific and
 * more common phrasings come first. Everything here is deterministic.
 */
const RULES = [
  // --- audio -------------------------------------------------------------
  [/^(?:(?:turn|set|crank) (?:the )?(?:volume|sound|audio)|volume) (up|down)(?: (?:by )?(\d{1,3}))?$/,
    m => stepAction('audio.adjustVolume', m[1], m[2])],
  [/^(louder|quieter|softer)$/,
    m => ({ id: 'audio.adjustVolume', args: { step: m[1] === 'louder' ? STEP_DEFAULT : -STEP_DEFAULT } })],
  [/^(?:set |make |put |turn )?(?:the )?(?:volume|sound|audio)(?: level)? (?:to |at )?(\d{1,3})(?: ?%| percent)?$/,
    m => ({ id: 'audio.setVolume', args: { percent: clampPercent(m[1]) } })],
  [/^(?:what(?:'s| is|s) (?:the |my )?|current |my )?(?:volume|sound|audio)(?: level| status)?$|^how loud$/,
    () => ({ id: 'audio.getVolume', args: {} })],
  [/^mute(?: (?:the )?(?:audio|volume|sound|output))?$/,
    () => ({ id: 'audio.setMute', args: { muted: true } })],
  [/^unmute(?: (?:the )?(?:audio|volume|sound|output))?$/,
    () => ({ id: 'audio.setMute', args: { muted: false } })],
  [/^(?:turn |switch )?(?:the )?sound (off|on)$/,
    m => ({ id: 'audio.setMute', args: { muted: m[1] === 'off' } })],
  [/^(?:turn|switch) (?:the )?(off|on) (?:the )?(?:sound|audio)$/,
    m => ({ id: 'audio.setMute', args: { muted: m[1] === 'off' } })],

  // --- bluetooth ---------------------------------------------------------
  [/^(?:turn |switch |shut )?bluetooth (on|off)$/,
    m => ({ id: 'bluetooth.setState', args: { enabled: m[1] === 'on' } })],
  [/^(?:turn|switch|shut) (?:the )?(on|off) bluetooth$/,
    m => ({ id: 'bluetooth.setState', args: { enabled: m[1] === 'on' } })],
  [/^(enable|disable) bluetooth$/,
    m => ({ id: 'bluetooth.setState', args: { enabled: m[1] === 'enable' } })],
  [/^(?:is bluetooth (?:on|off)|bluetooth (?:status|state)|bluetooth)$/,
    () => ({ id: 'bluetooth.getState', args: {} })],

  // --- wi-fi -------------------------------------------------------------
  [new RegExp(`^(?:turn |switch |shut )?${WIFI} (on|off)$`),
    m => ({ id: 'wifi.setState', args: { enabled: m[1] === 'on' } })],
  [new RegExp(`^(?:turn|switch|shut) (?:the )?(on|off) ${WIFI}$`),
    m => ({ id: 'wifi.setState', args: { enabled: m[1] === 'on' } })],
  [new RegExp(`^(enable|disable) ${WIFI}$`),
    m => ({ id: 'wifi.setState', args: { enabled: m[1] === 'enable' } })],
  [new RegExp(`^(?:is ${WIFI} (?:on|off)|${WIFI} (?:status|state)|${WIFI})$`),
    () => ({ id: 'wifi.getState', args: {} })],

  // --- power profile -----------------------------------------------------
  [/^(?:switch to |use |set |change to |activate |select |enable |go )?(?:power (?:saver|saving)|battery saver)(?: mode| profile)?$/,
    () => ({ id: 'power.setProfile', args: { profile: 'power-saver' } })],
  [/^(?:switch to |use |set |change to |activate |select |enable )?performance(?: mode| profile)?$/,
    () => ({ id: 'power.setProfile', args: { profile: 'performance' } })],
  [/^(?:switch to |use |set |change to |activate |select |enable )?balanced(?: mode| profile)?$/,
    () => ({ id: 'power.setProfile', args: { profile: 'balanced' } })],
  [/^(?:what(?:'s| is)? (?:the |my )?|current |my )?power profile(?: am i (?:on|using))?$|^which power profile$/,
    () => ({ id: 'power.getProfile', args: {} })],

  // --- appearance --------------------------------------------------------
  [/^(?:(turn(?: on| off)?|enable|disable|switch to|use|activate|select|leave|exit) )?(?:the )?dark (?:mode|theme)$/, m => {
    const turningOff = ['turn off', 'disable', 'leave', 'exit'].includes(m[1]);
    return { id: 'gnome.setColorScheme', args: { scheme: turningOff ? 'default' : 'prefer-dark' } };
  }],
  [/^(?:turn on |enable |switch to |use |activate |select )?light (?:mode|theme)$/,
    () => ({ id: 'gnome.setColorScheme', args: { scheme: 'default' } })],
  [/^(?:what(?:'s| is) (?:my |the )?|current |my )?(?:color scheme|colour scheme|theme|appearance)$|^what theme am i (?:using|on)$/,
    () => ({ id: 'gnome.getColorScheme', args: {} })],

  // --- night light -------------------------------------------------------
  [/^(?:turn |switch )?night light (on|off)$/,
    m => ({ id: 'gnome.setNightLight', args: { enabled: m[1] === 'on' } })],
  [/^(?:turn|switch) (?:the )?(on|off) night light$/,
    m => ({ id: 'gnome.setNightLight', args: { enabled: m[1] === 'on' } })],
  [/^(?:turn on |enable )night light$/,
    () => ({ id: 'gnome.setNightLight', args: { enabled: true } })],
  [/^(?:turn off |disable )night light$/,
    () => ({ id: 'gnome.setNightLight', args: { enabled: false } })],
  [/^(?:is night light (?:on|off)|night light (?:status|state)|night light)$/,
    () => ({ id: 'gnome.getNightLight', args: {} })],

  // --- brightness --------------------------------------------------------
  [/^(?:(?:turn|set) (?:the )?)?(?:brightness|screen) (up|down)(?: (?:by )?(\d{1,3}))?$/,
    m => stepAction('display.adjustBrightness', m[1], m[2])],
  [/^(brighter|dimmer)$/,
    m => ({ id: 'display.adjustBrightness', args: { step: m[1] === 'brighter' ? STEP_DEFAULT : -STEP_DEFAULT } })],
  [/^(?:set |turn )?brightness (?:to |at )?(\d{1,3})(?: ?%| percent)?$/,
    m => ({ id: 'display.setBrightness', args: { percent: clampPercent(m[1]) } })],
  [/^(?:what(?:'s| is) (?:the |my )?|current |my )?brightness(?: level| status)?$/,
    () => ({ id: 'display.getBrightness', args: {} })],

  // --- text scaling ------------------------------------------------------
  [/^(?:set )?text scaling(?: factor)?(?: to | )(\d(?:\.\d{1,2})?)$/,
    m => ({ id: 'gnome.setTextScaling', args: { factor: Number(m[1]) } })],
  [/^(?:what(?:'s| is) (?:the |my )?|current )?text scaling(?: factor)?$|^text size$/,
    () => ({ id: 'gnome.getTextScaling', args: {} })],

  // --- system information ------------------------------------------------
  // All information rules are anchored so multi-step splitting stays
  // unambiguous ("dark mode and disk space" must not parse as one query).
  [/^(?:how much |what(?:'s| is) (?:the |my )?)?(?:disk|storage|drive) (?:space|usage|left|free)(?: do i have)?$|^free (?:disk |storage )?space$|^(?:disk|storage) free$|^how much (?:disk |storage )?space(?: do i have)?$/,
    () => ({ id: 'system.diskUsage', args: {} })],
  [/^(?:how much |what(?:'s| is) (?:the |my )?)?(?:memory|ram) (?:usage|status|use|used)(?: do i have)?$|^how much (?:memory|ram)(?: do i have)?$|^(?:memory|ram)$|^free memory$/,
    () => ({ id: 'system.memoryStatus', args: {} })],
  [/^(?:what(?:'s| is|s) |show |tell me )?my (?:ip|ip address)$|^ip address$|^show ip$|^what(?:'s| is|s) my ip$|^network (?:status|state)$/,
    () => ({ id: 'system.networkStatus', args: {} })],
  [/^battery(?: status| level| percentage| state| life)?$|^how much battery(?: is left)?$/,
    () => ({ id: 'system.batteryStatus', args: {} })],

  // --- settings panels ---------------------------------------------------
  [/^(?:open|show) (?:the )?(.+?) settings$/,
    m => panelAction(m[1])],
  [/^(?:open|show) settings$/, () => ({ id: 'gnome.openSettingsPanel', args: { panel: '' } })],
  [/^([a-z][a-z ]*?) settings$/, m => panelAction(m[1])],

  // --- user directories and links ----------------------------------------
  [new RegExp(`^(?:open|show) (?:the |my )?(${DIRECTORIES.join('|')})(?: folder| directory)?$`),
    m => ({ id: 'directory.open', args: { dir: m[1] } })],
  [/^(?:open |go to |visit )?(https?:\/\/\S+?)\.?$/,
    m => ({ id: 'url.open', args: { url: urlArg(m[1]) } })],
];

function stepAction(id, direction, rawAmount) {
  const amount = rawAmount ? clampPercent(rawAmount) : STEP_DEFAULT;
  if (amount === null)
    return null;
  return { id, args: { step: direction === 'up' ? amount : -amount } };
}

function panelAction(name) {
  const normalized = String(name ?? '').trim().toLowerCase();
  const resolved = PANEL_ALIASES[normalized] ?? normalized;
  if (!PANELS.includes(resolved))
    return null;
  return { id: 'gnome.openSettingsPanel', args: { panel: resolved } };
}

/** Parse one normalized query into a registry action, or null. */
export function parseAction(query) {
  const normalized = normalizeQuery(query);
  if (!normalized || normalized.length > 120)
    return null;
  for (const [pattern, build] of RULES) {
    const match = normalized.match(pattern);
    if (!match)
      continue;
    const parsed = build(match);
    // A builder vetoes out-of-range values (e.g. "volume 300") with a null
    // argument, and only registered actions can ever be returned.
    if (!parsed || !getAction(parsed.id))
      continue;
    if (Object.values(parsed.args).some(value => value === null))
      continue;
    return parsed;
  }
  return null;
}

/**
 * Bounded multi-step support: split on "and"/"then" and parse every part.
 * Any unparseable part means no plan at all — there is no partial guessing
 * and no recursion. Returns [{id, args}, ...] or null.
 */
export function parseActionPlan(query) {
  const single = parseAction(query);
  if (single)
    return [single];
  const normalized = normalizeQuery(query);
  if (!/\s+(?:and|then)\s+/.test(normalized))
    return null;
  const parts = normalized.split(/\s+(?:and|then)\s+/).map(part => part.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > MAX_STEPS)
    return null;
  const steps = [];
  for (const part of parts) {
    const parsed = parseAction(part);
    if (!parsed)
      return null;
    steps.push(parsed);
  }
  return steps;
}

/**
 * File-search phrasing shared with the launcher's existing file path:
 * "find resume pdf", "find pdfs modified today", "file report".
 * Returns {terms, extension, modifiedToday} or null when it is not a
 * file-search request. A trailing known extension narrows the search to
 * that file type; it is never treated as part of the name.
 */
export function parseFileQuery(query) {
  const normalized = normalizeQuery(query);
  const match = normalized.match(/^(?:file|find)(?: file)?\s+(.+)$/);
  if (!match)
    return null;
  let terms = match[1].replace(/^(?:my |the )+/, '').trim();
  let modifiedToday = false;
  const today = terms.match(/\s+(?:(?:modified|changed|edited) today|modified|changed|edited|from today|today)$/);
  if (today) {
    modifiedToday = true;
    terms = terms.slice(0, today.index).trim();
  }
  let extension = null;
  const tokens = terms.split(' ').filter(Boolean);
  const last = tokens[tokens.length - 1]?.replace(/\.$/, '');
  const singular = last?.endsWith('s') ? last.slice(0, -1) : null;
  if (last && KNOWN_EXTENSIONS.includes(last)) {
    extension = last;
  } else if (singular && KNOWN_EXTENSIONS.includes(singular)) {
    extension = singular;
  }
  if (extension) {
    tokens.pop();
    terms = tokens.join(' ');
  }
  return { terms, extension, modifiedToday };
}
