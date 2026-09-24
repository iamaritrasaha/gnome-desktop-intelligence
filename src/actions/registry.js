/*
 * GDI native action registry: typed, risk-classified GNOME desktop actions.
 *
 * Pure data and pure functions — no GIO/Gtk imports — so the mapping from
 * natural language to a trusted action stays inspectable and unit-testable
 * outside GNOME Shell. Execution lives in engine.js.
 *
 * Copyright (C) 2026 GDI contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const RISK = {
  READ_ONLY: 'read-only',
  LOW_RISK: 'low-risk',
  STATE_CHANGE: 'state-change',
  SENSITIVE: 'sensitive',
};

/* gnome-control-center panels verified on GNOME 46 (gnome-control-center --list). */
export const PANELS = [
  'applications', 'background', 'bluetooth', 'color', 'display', 'keyboard',
  'mouse', 'multitasking', 'network', 'notifications', 'online-accounts',
  'power', 'printers', 'privacy', 'search', 'sharing', 'sound', 'system',
  'ubuntu', 'universal-access', 'wifi', 'wacom', 'wwan',
];

/* Ubuntu 46 folds Appearance into the ubuntu panel; keep a documented alias. */
const PANEL_ALIASES = {
  wifi: 'wifi',
  wireless: 'wifi',
  internet: 'network',
  appearance: 'ubuntu',
  'ubuntu desktop': 'ubuntu',
  'default apps': 'applications',
  'default applications': 'applications',
  accessibility: 'universal-access',
  'date time': 'system',
};

/* XDG user directories resolvable without reading any configuration file. */
export const DIRECTORIES = [
  'downloads', 'documents', 'desktop', 'pictures', 'videos', 'music', 'home',
];

const POWER_PROFILES = ['performance', 'balanced', 'power-saver'];

const SCHEMES = ['prefer-dark', 'default'];

const SCHEME_LABELS = { 'prefer-dark': 'dark', default: 'light' };

const PROFILE_LABELS = {
  performance: 'Performance',
  balanced: 'Balanced',
  'power-saver': 'Power Saver',
};

function percent(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

function factor(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0.5 && n <= 3 ? Math.round(n * 100) / 100 : null;
}

const onoff = value => (typeof value === 'boolean' ? value : null);

const oneOf = list => value => (list.includes(value) ? value : null);

const ARG_TYPES = {
  percent,
  factor,
  onoff,
  profile: oneOf(POWER_PROFILES),
  scheme: oneOf(SCHEMES),
  panel: value => {
    const name = String(value ?? '').trim().toLowerCase();
    const resolved = PANEL_ALIASES[name] ?? name;
    return resolved === '' || PANELS.includes(resolved) ? resolved : null;
  },
  dirname: value => {
    const name = String(value ?? '').trim().toLowerCase();
    return DIRECTORIES.includes(name) ? name : null;
  },
  url: value => {
    const uri = String(value ?? '').trim();
    // No credentials, no non-web schemes, bounded length.
    return /^https?:\/\/[^\s<>"\u0000-\u001f]{1,1900}$/i.test(uri) && !/^https?:\/\/[^/]*@/i.test(uri) ? uri : null;
  },
  text: value => {
    const text = String(value ?? '').trim();
    return text && text.length <= 300 ? text : null;
  },
  app: value => {
    const name = String(value ?? '').trim();
    return name && name.length <= 100 ? name : null;
  },
};

/*
 * title(args): row label. result(args): confirmation message on success.
 * confirmNote(args): extra line in the confirmation view, when present.
 */
const ACTIONS = {
  'audio.getVolume': {
    risk: RISK.READ_ONLY,
    backend: 'gvc',
    icon: 'audio-volume-high-symbolic',
    title: () => 'Check output volume',
    result: () => 'Volume checked',
  },
  'audio.setVolume': {
    risk: RISK.STATE_CHANGE,
    backend: 'gvc',
    icon: 'audio-volume-high-symbolic',
    args: { percent: 'percent' },
    title: a => `Set volume to ${a.percent}%`,
    result: a => `Volume set to ${a.percent}%`,
  },
  'audio.adjustVolume': {
    risk: RISK.STATE_CHANGE,
    backend: 'gvc',
    icon: 'audio-volume-high-symbolic',
    args: { step: 'percent' },
    title: a => `${a.step >= 0 ? 'Raise' : 'Lower'} volume by ${Math.abs(a.step)}%`,
    result: a => `Volume changed by ${a.step}%`,
  },
  'audio.setMute': {
    risk: RISK.STATE_CHANGE,
    backend: 'gvc',
    icon: 'audio-volume-muted-symbolic',
    args: { muted: 'onoff' },
    title: a => (a.muted ? 'Mute sound' : 'Unmute sound'),
    result: a => (a.muted ? 'Sound muted' : 'Sound unmuted'),
  },
  'bluetooth.getState': {
    risk: RISK.READ_ONLY,
    backend: 'bluez-dbus',
    icon: 'bluetooth-symbolic',
    title: () => 'Check Bluetooth',
    result: () => 'Bluetooth state checked',
  },
  'bluetooth.setState': {
    risk: RISK.STATE_CHANGE,
    backend: 'bluez-dbus',
    icon: 'bluetooth-symbolic',
    args: { enabled: 'onoff' },
    // Disconnecting paired devices is the one Bluetooth change worth a check.
    confirm: 'when-devices-connected',
    title: a => (a.enabled ? 'Turn Bluetooth on' : 'Turn Bluetooth off'),
    result: a => `Bluetooth turned ${a.enabled ? 'on' : 'off'}`,
    confirmLabel: a => (a.enabled ? 'Turn On' : 'Turn Off'),
    confirmNote: a => (a.enabled ? null : 'Connected Bluetooth devices may disconnect.'),
  },
  'wifi.getState': {
    risk: RISK.READ_ONLY,
    backend: 'networkmanager-dbus',
    icon: 'network-wireless-symbolic',
    title: () => 'Check Wi-Fi',
    result: () => 'Wi-Fi state checked',
  },
  'wifi.setState': {
    risk: RISK.STATE_CHANGE,
    backend: 'networkmanager-dbus',
    icon: 'network-wireless-symbolic',
    args: { enabled: 'onoff' },
    confirm: 'when-disabling',
    title: a => (a.enabled ? 'Turn Wi-Fi on' : 'Turn Wi-Fi off'),
    result: a => `Wi-Fi turned ${a.enabled ? 'on' : 'off'}`,
    confirmLabel: a => (a.enabled ? 'Turn On' : 'Turn Off'),
    confirmNote: a => (a.enabled ? null : 'This may disconnect your network connection.'),
  },
  'power.getProfile': {
    risk: RISK.READ_ONLY,
    backend: 'power-profiles-dbus',
    icon: 'power-profile-balanced-symbolic',
    title: () => 'Check power profile',
    result: () => 'Power profile checked',
  },
  'power.setProfile': {
    risk: RISK.STATE_CHANGE,
    backend: 'power-profiles-dbus',
    icon: 'power-profile-balanced-symbolic',
    args: { profile: 'profile' },
    title: a => `Switch to ${PROFILE_LABELS[a.profile]}`,
    result: a => `Power profile set to ${PROFILE_LABELS[a.profile]}`,
  },
  'gnome.getColorScheme': {
    risk: RISK.READ_ONLY,
    backend: 'gsettings',
    icon: 'dark-mode-symbolic',
    title: () => 'Check appearance',
    result: () => 'Appearance checked',
  },
  'gnome.setColorScheme': {
    risk: RISK.STATE_CHANGE,
    backend: 'gsettings',
    icon: 'dark-mode-symbolic',
    args: { scheme: 'scheme' },
    title: a => `Switch to ${SCHEME_LABELS[a.scheme]} mode`,
    result: a => `Switched to ${SCHEME_LABELS[a.scheme]} mode`,
  },
  'gnome.getNightLight': {
    risk: RISK.READ_ONLY,
    backend: 'gsettings',
    icon: 'night-light-symbolic',
    title: () => 'Check Night Light',
    result: () => 'Night Light state checked',
  },
  'gnome.setNightLight': {
    risk: RISK.STATE_CHANGE,
    backend: 'gsettings',
    icon: 'night-light-symbolic',
    args: { enabled: 'onoff' },
    title: a => (a.enabled ? 'Turn Night Light on' : 'Turn Night Light off'),
    result: a => `Night Light turned ${a.enabled ? 'on' : 'off'}`,
  },
  'gnome.getTextScaling': {
    risk: RISK.READ_ONLY,
    backend: 'gsettings',
    icon: 'font-x-generic-symbolic',
    title: () => 'Check text size',
    result: () => 'Text size checked',
  },
  'gnome.setTextScaling': {
    risk: RISK.STATE_CHANGE,
    backend: 'gsettings',
    icon: 'font-x-generic-symbolic',
    args: { factor: 'factor' },
    confirm: 'always',
    title: a => `Set text size to ${a.factor}×`,
    result: a => `Text size set to ${a.factor}×`,
    confirmLabel: () => 'Set Size',
    confirmNote: () => 'This changes text size across the desktop.',
  },
  'gnome.openSettingsPanel': {
    risk: RISK.LOW_RISK,
    backend: 'gio',
    icon: 'preferences-system-symbolic',
    args: { panel: 'panel' },
    title: a => (a.panel ? `Open ${PANEL_LABELS[a.panel] ?? a.panel} settings` : 'Open Settings'),
    result: () => 'Settings opened',
  },
  'display.getBrightness': {
    risk: RISK.READ_ONLY,
    backend: 'session-dbus',
    icon: 'display-brightness-symbolic',
    title: () => 'Check screen brightness',
    result: () => 'Brightness checked',
  },
  'display.setBrightness': {
    risk: RISK.STATE_CHANGE,
    backend: 'session-dbus',
    icon: 'display-brightness-symbolic',
    args: { percent: 'percent' },
    title: a => `Set brightness to ${a.percent}%`,
    result: a => `Brightness set to ${a.percent}%`,
  },
  'display.adjustBrightness': {
    risk: RISK.STATE_CHANGE,
    backend: 'session-dbus',
    icon: 'display-brightness-symbolic',
    args: { step: 'percent' },
    title: a => `${a.step >= 0 ? 'Raise' : 'Lower'} brightness by ${Math.abs(a.step)}%`,
    result: a => `Brightness changed by ${a.step}%`,
  },
  'system.diskUsage': {
    risk: RISK.READ_ONLY,
    backend: 'gio',
    icon: 'drive-harddisk-symbolic',
    title: () => 'Check disk space',
    result: () => 'Disk space checked',
  },
  'system.memoryStatus': {
    risk: RISK.READ_ONLY,
    backend: 'proc',
    icon: 'utilities-system-monitor-symbolic',
    title: () => 'Check memory usage',
    result: () => 'Memory usage checked',
  },
  'system.networkStatus': {
    risk: RISK.READ_ONLY,
    backend: 'networkmanager-dbus',
    icon: 'network-wireless-symbolic',
    title: () => 'Check network status',
    result: () => 'Network status checked',
  },
  'system.batteryStatus': {
    risk: RISK.READ_ONLY,
    backend: 'upower-dbus',
    icon: 'battery-symbolic',
    title: () => 'Check battery',
    result: () => 'Battery checked',
  },
  'directory.open': {
    risk: RISK.LOW_RISK,
    backend: 'gio',
    icon: 'folder-symbolic',
    args: { dir: 'dirname' },
    title: a => `Open ${DIRECTORY_LABELS[a.dir]}`,
    result: () => 'Folder opened',
  },
  'url.open': {
    risk: RISK.LOW_RISK,
    backend: 'gio',
    icon: 'web-browser-symbolic',
    args: { url: 'url' },
    title: a => `Open ${shortUrl(a.url)}`,
    result: () => 'Link opened',
  },
  'web.search': {
    risk: RISK.LOW_RISK,
    backend: 'gio',
    icon: 'web-browser-symbolic',
    args: { query: 'text' },
    title: a => `Search the web for “${a.query}”`,
    result: () => 'Web search opened',
  },
  'app.open': {
    risk: RISK.LOW_RISK,
    backend: 'gio',
    icon: 'application-x-executable',
    args: { app: 'app' },
    title: a => `Open ${a.app}`,
    result: a => `${a.app} launched`,
  },
  'file.open': {
    risk: RISK.LOW_RISK,
    backend: 'gio',
    icon: 'text-x-generic',
    args: { name: 'app' },
    title: a => `Open ${a.name}`,
    result: a => `${a.name} opened`,
  },
};

const DIRECTORY_LABELS = {
  downloads: 'Downloads',
  documents: 'Documents',
  desktop: 'Desktop',
  pictures: 'Pictures',
  videos: 'Videos',
  music: 'Music',
  home: 'Home',
};

const PANEL_LABELS = {
  applications: 'Applications',
  background: 'Background',
  bluetooth: 'Bluetooth',
  color: 'Color',
  display: 'Display',
  keyboard: 'Keyboard',
  mouse: 'Mouse',
  multitasking: 'Multitasking',
  network: 'Network',
  notifications: 'Notifications',
  'online-accounts': 'Online Accounts',
  power: 'Power',
  printers: 'Printers',
  privacy: 'Privacy',
  search: 'Search',
  sharing: 'Sharing',
  sound: 'Sound',
  system: 'System',
  ubuntu: 'Ubuntu Desktop',
  'universal-access': 'Accessibility',
  wifi: 'Wi-Fi',
  wacom: 'Wacom',
  wwan: 'Mobile Broadband',
};

function shortUrl(uri) {
  try {
    const parsed = new URL(uri);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch (_error) {
    return uri;
  }
}

export function getAction(id) {
  return id in ACTIONS ? { id, ...ACTIONS[id] } : null;
}

export function actionIds() {
  return Object.keys(ACTIONS);
}

/** Validate raw (possibly untrusted) arguments against the registry types. */
export function validateArgs(id, rawArgs = {}) {
  const action = getAction(id);
  if (!action)
    return { ok: false, reason: 'unknown-action' };
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))
    return { ok: false, reason: 'invalid-arguments' };
  const schema = action.args ?? {};
  const extra = Object.keys(rawArgs).filter(key => !(key in schema));
  if (extra.length)
    return { ok: false, reason: `unexpected-argument:${extra[0]}` };
  const args = {};
  for (const [key, type] of Object.entries(schema)) {
    const value = ARG_TYPES[type](rawArgs[key]);
    if (value === null)
      return { ok: false, reason: `invalid-argument:${key}` };
    args[key] = value;
  }
  return { ok: true, action, args };
}

/**
 * Whether the confirmation policy requires an explicit user confirmation
 * before this action executes. `context` carries engine-known facts such as
 * the number of connected Bluetooth devices. Personalization can never
 * influence this decision.
 */
export function needsConfirmation(id, args, context = {}) {
  const action = getAction(id);
  if (!action)
    return { confirm: false };
  if (action.risk === RISK.SENSITIVE)
    return { confirm: true };
  if (action.risk !== RISK.STATE_CHANGE)
    return { confirm: false };
  if (action.confirm === 'always')
    return { confirm: true };
  if (action.confirm === 'when-disabling')
    return { confirm: args.enabled === false };
  if (action.confirm === 'when-devices-connected')
    return { confirm: args.enabled === false && (context.connectedDevices ?? 0) > 0 };
  return { confirm: false };
}

/** Validate one URL argument; shared by the parser for fail-fast checks. */
export function urlArg(value) {
  return ARG_TYPES.url(value);
}

/** Compact registry description handed to the routing model, if ever used. */
export function describeModelRoutable() {
  return Object.entries(ACTIONS)
    .filter(([, action]) => action.modelRoutable)
    .map(([id, action]) => ({
      id,
      description: action.description ?? action.title(sampleArgs(action.args ?? {})),
      args: Object.entries(action.args ?? {}).map(([key, type]) => ({ key, type })),
    }));
}

function sampleArgs(schema) {
  const samples = {
    percent: { percent: 50, step: 10 },
    factor: { factor: 1.25 },
    onoff: { enabled: false, muted: true },
    profile: { profile: 'power-saver' },
    scheme: { scheme: 'prefer-dark' },
    panel: { panel: 'display' },
    dirname: { dir: 'downloads' },
    url: { url: 'https://www.gnome.org' },
  };
  const args = {};
  for (const [key, type] of Object.entries(schema))
    args[key] = (samples[type] ?? {})[key] ?? '';
  return args;
}

// Model routing is opt-in per action: only bounded system actions with typed
// arguments may be chosen by the small routing model. Launching apps, files
// and web searches stay purely deterministic.
for (const action of Object.values(ACTIONS))
  action.modelRoutable = action.risk !== RISK.LOW_RISK;

export { PROFILE_LABELS, SCHEME_LABELS, DIRECTORY_LABELS, PANEL_LABELS, PANEL_ALIASES, POWER_PROFILES };
