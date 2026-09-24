/*
 * Native action execution for GDI Phase 4.
 *
 * Every desktop action runs through this engine. There is no generic shell or
 * command tool: only registry-validated actions with typed arguments reach a
 * backend, every backend call is asynchronous and failure is reported as a
 * result, never as a Shell crash. Model output can only ever name a registered
 * action and is re-validated here before it can execute.
 *
 * Copyright (C) 2026 GDI contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';

import { getAction, needsConfirmation, describeModelRoutable, validateArgs } from './registry.js';
import { parseActionPlan, normalizeQuery } from './parser.js';
import { searchApps } from '../search/AppSearch.js';
import { routeAction, recordActionDiagnostic, recordActionUse } from '../intelligence/ServiceClient.js';

const NM_DEST = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
const NM_IFACE = 'org.freedesktop.NetworkManager';
const BLUEZ_DEST = 'org.bluez';
const POWER_IFACE = 'net.hadess.PowerProfiles';
const POWER_PATH = '/net/hadess/PowerProfiles';
const POWER_IFACE_NEW = 'org.freedesktop.UPower.PowerProfiles';
const POWER_PATH_NEW = '/org/freedesktop/UPower/PowerProfiles';
const UPOWER_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const GSD_POWER = 'org.gnome.SettingsDaemon.Power';
const GSD_POWER_PATH = '/org/gnome/SettingsDaemon/Power';
const GSD_SCREEN = 'org.gnome.SettingsDaemon.Power.Screen';

const ACTION_TIMEOUT_MS = 8000;

class ActionError extends Error {
}

class ActionUnavailableError extends ActionError {
}

/* ------------------------------------------------------------------ */
/* Small asynchronous primitives.                                      */
/* ------------------------------------------------------------------ */

const _buses = new Map();

function bus(type) {
  if (!_buses.has(type)) {
    _buses.set(type, new Promise((resolve, reject) => {
      Gio.bus_get(type, null, (_source, result) => {
        try {
          resolve(Gio.bus_get_finish(result));
        } catch (error) {
          _buses.delete(type);
          reject(error);
        }
      });
    }));
  }
  return _buses.get(type);
}

function callBus(type, dest, path, iface, method, params, timeout = ACTION_TIMEOUT_MS) {
  return bus(type).then(connection => new Promise((resolve, reject) => {
    connection.call(dest, path, iface, method, params ?? null, null,
      Gio.DBusCallFlags.NONE, timeout, null, (conn, result) => {
        try {
          resolve(conn.call_finish(result).deep_unpack());
        } catch (error) {
          reject(error);
        }
      });
  }));
}

// deep_unpack is recursive, but tolerate either plain values or Variants.
const unwrap = value => (value && typeof value.deep_unpack === 'function' ? value.deep_unpack() : value);

function getProperty(type, dest, path, iface, name) {
  return callBus(type, dest, path, 'org.freedesktop.DBus.Properties', 'Get',
    new GLib.Variant('(ss)', [iface, name])).then(([value]) => unwrap(value));
}

function setProperty(type, dest, path, iface, name, value) {
  return callBus(type, dest, path, 'org.freedesktop.DBus.Properties', 'Set',
    new GLib.Variant('(ssv)', [iface, name, value]));
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
  () => (resolve(), GLib.SOURCE_REMOVE)));

function launchUri(uri) {
  return new Promise((resolve, reject) => {
    Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1),
      null, (_source, result) => {
        try {
          resolve(Gio.AppInfo.launch_default_for_uri_finish(result));
        } catch (error) {
          reject(error);
        }
      });
  });
}

/* ------------------------------------------------------------------ */
/* Audio via GVC, the same mixer library GNOME Shell itself uses.      */
/* ------------------------------------------------------------------ */

let _mixer = null;

function audioControl() {
  if (!_mixer) {
    _mixer = new Gvc.MixerControl({ name: 'GDI' });
    _mixer.open();
  }
  return _mixer;
}

async function audioSink() {
  const control = audioControl();
  const deadline = Date.now() + 2500;
  while (control.get_state() === Gvc.MixerControlState.OPENING && Date.now() < deadline)
    await sleep(60);
  if (control.get_state() !== Gvc.MixerControlState.READY)
    throw new ActionUnavailableError('Audio is not available right now.');
  const sink = control.get_default_sink();
  if (!sink)
    throw new ActionUnavailableError('No audio output device was found.');
  return { control, sink };
}

const volumePercent = state =>
  Math.round(state.sink.volume / Math.max(1, state.control.get_vol_max_norm()) * 100);

async function applyVolume(percent) {
  const state = await audioSink();
  state.sink.volume = Math.round(percent / 100 * Math.max(1, state.control.get_vol_max_norm()));
  state.sink.push_volume();
  if (percent > 0 && state.sink.is_muted)
    state.sink.change_is_muted(false);
  return state;
}

/* ------------------------------------------------------------------ */
/* GSettings-backed appearance and desktop settings.                   */
/* ------------------------------------------------------------------ */

const interfaceSettings = () => new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
const colorSettings = () => new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.color' });

const PROFILE_NAMES = {performance: 'Performance', balanced: 'Balanced', 'power-saver': 'Power Saver'};

/* ------------------------------------------------------------------ */
/* Backend-specific action implementations. Each returns a human       */
/* readable result string.                                             */
/* ------------------------------------------------------------------ */

const IMPLEMENTATIONS = {
  'audio.getVolume': async () => {
    const state = await audioSink();
    return `Output volume is ${volumePercent(state)}%${state.sink.is_muted ? ' (muted)' : ''}.`;
  },
  'audio.setVolume': async args => {
    const state = await applyVolume(args.percent);
    return `Volume set to ${volumePercent(state)}%.`;
  },
  'audio.adjustVolume': async args => {
    const current = volumePercent(await audioSink());
    const target = Math.max(0, Math.min(100, current + args.step));
    await applyVolume(target);
    return `Volume ${args.step >= 0 ? 'raised' : 'lowered'} to ${target}%.`;
  },
  'audio.setMute': async args => {
    const {sink} = await audioSink();
    sink.change_is_muted(args.muted);
    return args.muted ? 'Sound muted.' : 'Sound unmuted.';
  },

  'bluetooth.getState': async () => {
    const state = await bluetoothState();
    if (!state.adapters.length)
      throw new ActionUnavailableError('No Bluetooth adapter was found on this machine.');
    const devices = state.connectedDevices === 1 ? '1 device connected'
      : `${state.connectedDevices} devices connected`;
    return `Bluetooth is ${state.powered ? 'on' : 'off'}${state.powered ? ` · ${devices}` : ''}.`;
  },
  'bluetooth.setState': async args => {
    const state = await bluetoothState();
    if (!state.adapters.length)
      throw new ActionUnavailableError('No Bluetooth adapter was found on this machine.');
    for (const adapter of state.adapters) {
      await setProperty(Gio.BusType.SYSTEM, BLUEZ_DEST, adapter.path,
        'org.bluez.Adapter1', 'Powered', GLib.Variant.new_boolean(args.enabled));
    }
    return `Bluetooth turned ${args.enabled ? 'on' : 'off'}.`;
  },

  'wifi.getState': async () => {
    const enabled = await getProperty(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE, 'WirelessEnabled');
    const hardware = await getProperty(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE, 'WirelessHardwareEnabled');
    if (!enabled)
      return `Wi-Fi is off${hardware ? '' : ' (disabled by a hardware switch)'}.`;
    const summary = await wifiSummary().catch(() => null);
    return `Wi-Fi is on${summary ? ` · ${summary}` : ''}.`;
  },
  'wifi.setState': async args => {
    if (args.enabled) {
      const hardware = await getProperty(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE, 'WirelessHardwareEnabled');
      if (!hardware)
        throw new ActionUnavailableError('Wi-Fi is disabled by a hardware switch.');
    }
    await setProperty(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE, 'WirelessEnabled',
      GLib.Variant.new_boolean(args.enabled));
    return `Wi-Fi turned ${args.enabled ? 'on' : 'off'}.`;
  },

  'power.getProfile': async () => {
    const {active, profiles} = await powerProfileState();
    const available = profiles.map(name => PROFILE_NAMES[name]).filter(Boolean).join(', ');
    return `Power profile: ${PROFILE_NAMES[active] ?? active}${available ? ` (available: ${available})` : ''}.`;
  },
  'power.setProfile': async args => {
    const state = await powerProfileState();
    if (!state.profiles.includes(args.profile))
      throw new ActionUnavailableError(`The ${args.profile} profile is not available on this hardware.`);
    await setProperty(Gio.BusType.SYSTEM, state.iface, state.path, state.iface, 'ActiveProfile',
      GLib.Variant.new_string(args.profile));
    return `Power profile set to ${PROFILE_NAMES[args.profile] ?? args.profile}.`;
  },

  'gnome.getColorScheme': async () => {
    const scheme = interfaceSettings().get_string('color-scheme');
    return `Appearance is ${scheme === 'prefer-dark' ? 'dark' : 'light'}.`;
  },
  'gnome.setColorScheme': async args => {
    if (!interfaceSettings().set_string('color-scheme', args.scheme))
      throw new ActionError('The appearance setting could not be changed.');
    Gio.Settings.sync();
    return `Switched to ${args.scheme === 'prefer-dark' ? 'dark' : 'light'} mode.`;
  },
  'gnome.getNightLight': async () => {
    const enabled = colorSettings().get_boolean('night-light-enabled');
    return `Night Light is ${enabled ? 'on' : 'off'}.`;
  },
  'gnome.setNightLight': async args => {
    if (!colorSettings().set_boolean('night-light-enabled', args.enabled))
      throw new ActionError('Night Light could not be changed.');
    Gio.Settings.sync();
    return `Night Light turned ${args.enabled ? 'on' : 'off'}.`;
  },
  'gnome.getTextScaling': async () => {
    const factor = interfaceSettings().get_double('text-scaling-factor');
    return `Text size is ${Math.round(factor * 100)}% (×${factor}).`;
  },
  'gnome.setTextScaling': async args => {
    if (!interfaceSettings().set_double('text-scaling-factor', args.factor))
      throw new ActionError('The text size setting could not be changed.');
    Gio.Settings.sync();
    return `Text size set to ${args.factor}×.`;
  },
  'gnome.openSettingsPanel': async args => {
    const panel = args.panel && /^[a-z-]+$/.test(args.panel) ? ` ${args.panel}` : '';
    const appInfo = Gio.AppInfo.create_from_commandline(
      `gnome-control-center${panel}`, 'GNOME Settings', Gio.AppInfoCreateFlags.NONE);
    if (!appInfo || !appInfo.launch([], global.create_app_launch_context(0, -1)))
      throw new ActionError('GNOME Settings could not be opened.');
    return 'Settings opened.';
  },

  'display.getBrightness': async () => {
    const value = await sessionBrightness();
    if (value < 0)
      throw new ActionUnavailableError('Brightness control is not available on this display.');
    return `Screen brightness is ${value}%.`;
  },
  'display.setBrightness': async args => {
    await setBrightnessChecked(args.percent);
    return `Brightness set to ${args.percent}%.`;
  },
  'display.adjustBrightness': async args => {
    const current = await sessionBrightness();
    if (current < 0)
      throw new ActionUnavailableError('Brightness control is not available on this display.');
    const target = Math.max(1, Math.min(100, current + args.step));
    await setBrightnessChecked(target);
    return `Brightness ${args.step >= 0 ? 'raised' : 'lowered'} to ${target}%.`;
  },

  'system.diskUsage': async () => {
    const home = Gio.File.new_for_path(GLib.get_home_dir());
    const info = await new Promise((resolve, reject) => {
      home.query_filesystem_info_async('filesystem::size,filesystem::free',
        GLib.PRIORITY_DEFAULT, null, (_source, result) => {
          try {
            resolve(home.query_filesystem_info_finish(result));
          } catch (error) {
            reject(error);
          }
        });
    });
    const size = info.get_attribute_uint64('filesystem::size');
    const free = info.get_attribute_uint64('filesystem::free');
    if (!size)
      throw new ActionUnavailableError('Disk usage could not be read.');
    const usedPercent = Math.round((size - free) / size * 100);
    return `${formatBytes(free)} free of ${formatBytes(size)} (${usedPercent}% used).`;
  },
  'system.memoryStatus': async () => {
    const [ok, bytes] = GLib.file_get_contents('/proc/meminfo');
    if (!ok)
      throw new ActionUnavailableError('Memory information could not be read.');
    const text = new TextDecoder().decode(bytes);
    const read = key => {
      const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
      return match ? Number(match[1]) * 1024 : 0;
    };
    const total = read('MemTotal');
    const available = read('MemAvailable');
    if (!total || !available)
      throw new ActionUnavailableError('Memory information could not be read.');
    const used = total - available;
    return `${formatBytes(used)} used of ${formatBytes(total)} (${Math.round(used / total * 100)}%).`;
  },
  'system.networkStatus': async () => {
    const connectivity = await getProperty(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE,
      'Connectivity').catch(() => 0);
    const lines = [];
    if (connectivity === 1)
      lines.push('Network is offline.');
    const active = await activatedNetworks().catch(() => []);
    if (active.length)
      lines.push(`Connected: ${active.join(', ')}.`);
    else if (connectivity !== 1)
      lines.push('No active network connection.');
    const addresses = await activeIpAddresses().catch(() => []);
    if (addresses.length)
      lines.push(`IP address: ${addresses.join(', ')}`);
    if (!lines.length)
      lines.push('Network information is unavailable.');
    return lines.join('\n');
  },
  'system.batteryStatus': async () => {
    try {
      const type = await getProperty(Gio.BusType.SYSTEM, 'org.freedesktop.UPower', UPOWER_PATH,
        'org.freedesktop.UPower.Device', 'Type');
      if (type !== 2 && type !== 3)
        return 'No battery — this machine runs on external power.';
      const percent = await getProperty(Gio.BusType.SYSTEM, 'org.freedesktop.UPower', UPOWER_PATH,
        'org.freedesktop.UPower.Device', 'Percentage');
      const state = await getProperty(Gio.BusType.SYSTEM, 'org.freedesktop.UPower', UPOWER_PATH,
        'org.freedesktop.UPower.Device', 'State');
      const states = {1: 'charging', 2: 'discharging', 3: 'empty', 4: 'fully charged',
        5: 'waiting to charge', 6: 'waiting to discharge'};
      let line = `${type === 3 ? 'UPS' : 'Battery'} is at ${Math.round(percent)}%`;
      if (states[state])
        line += ` (${states[state]})`;
      return `${line}.`;
    } catch (_error) {
      return 'No battery — this machine runs on external power.';
    }
  },

  'directory.open': async args => {
    const userDirs = {
      downloads: GLib.UserDirectory.DIRECTORY_DOWNLOAD,
      documents: GLib.UserDirectory.DIRECTORY_DOCUMENTS,
      desktop: GLib.UserDirectory.DIRECTORY_DESKTOP,
      pictures: GLib.UserDirectory.DIRECTORY_PICTURES,
      videos: GLib.UserDirectory.DIRECTORY_VIDEOS,
      music: GLib.UserDirectory.DIRECTORY_MUSIC,
    };
    const path = args.dir === 'home' ? GLib.get_home_dir()
      : GLib.get_user_special_dir(userDirs[args.dir]);
    if (!path)
      throw new ActionUnavailableError('That folder could not be located.');
    await launchUri(Gio.File.new_for_path(path).get_uri());
    return 'Folder opened.';
  },
  'url.open': async args => {
    await launchUri(args.url);
    return 'Link opened.';
  },
  'web.search': async args => {
    const encoded = GLib.uri_escape_string(args.query, null, true);
    await launchUri(`https://www.google.com/search?q=${encoded}`);
    return 'Web search opened.';
  },
  'app.open': async args => {
    const name = args.app.trim().toLowerCase();
    const matches = searchApps(name, 2);
    const app = matches.find(candidate => candidate.searchName === name ||
      candidate.searchId === `${name}.desktop`) ??
      (matches[0]?.searchName.startsWith(name) ? matches[0] : null);
    if (!app)
      throw new ActionUnavailableError(`No installed application matches “${args.app}”.`);
    if (!app.appInfo.launch([], global.create_app_launch_context(0, -1)))
      throw new ActionError(`${app.name} could not be launched.`);
    return `${app.name} launched.`;
  },
};

/* ------------------------------------------------------------------ */
/* Backend helpers.                                                    */
/* ------------------------------------------------------------------ */

async function bluetoothState() {
  const [objects] = await callBus(Gio.BusType.SYSTEM, BLUEZ_DEST, '/',
    'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects');
  const adapters = [];
  let connectedDevices = 0;
  for (const [path, interfaces] of Object.entries(objects ?? {})) {
    if (interfaces?.['org.bluez.Adapter1'])
      adapters.push({path, powered: Boolean(unwrap(interfaces['org.bluez.Adapter1']['Powered']))});
    if (unwrap(interfaces?.['org.bluez.Device1']?.['Connected']))
      connectedDevices++;
  }
  return {adapters, connectedDevices, powered: adapters.some(adapter => adapter.powered)};
}

async function powerProfileState() {
  for (const [iface, path] of [[POWER_IFACE, POWER_PATH], [POWER_IFACE_NEW, POWER_PATH_NEW]]) {
    try {
      const [active, profileVariants] = await Promise.all([
        getProperty(Gio.BusType.SYSTEM, iface, path, iface, 'ActiveProfile'),
        getProperty(Gio.BusType.SYSTEM, iface, path, iface, 'Profiles'),
      ]);
      const profiles = (profileVariants ?? [])
        .map(entry => unwrap(entry?.['Profile']))
        .filter(Boolean);
      return {iface, path, active, profiles};
    } catch (_error) {
      // Try the GNOME 47+ interface name before reporting unavailability.
    }
  }
  throw new ActionUnavailableError('Power profile control is not available on this machine.');
}

function sessionBrightness() {
  return getProperty(Gio.BusType.SESSION, GSD_POWER, GSD_POWER_PATH, GSD_SCREEN, 'Brightness');
}

async function setBrightnessChecked(percent) {
  const current = await sessionBrightness();
  if (current < 0)
    throw new ActionUnavailableError('Brightness control is not available on this display.');
  await setProperty(Gio.BusType.SESSION, GSD_POWER, GSD_POWER_PATH, GSD_SCREEN, 'Brightness',
    GLib.Variant.new_int32(percent));
}

async function activatedNetworks() {
  const [devices] = await callBus(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE, 'GetDevices');
  const active = [];
  for (const path of devices.slice(0, 12)) {
    const [type, state] = await Promise.all([
      getProperty(Gio.BusType.SYSTEM, NM_DEST, path, NM_IFACE, 'DeviceType'),
      getProperty(Gio.BusType.SYSTEM, NM_DEST, path, NM_IFACE, 'State'),
    ]);
    if (state !== 100)
      continue;
    if (type === 1)
      active.push('Wired connection');
    else if (type === 2) {
      const ssid = await wifiSsid(path).catch(() => null);
      active.push(`Wi-Fi${ssid ? ` “${ssid}”` : ''}`);
    }
    if (active.length >= 2)
      break;
  }
  return [...new Set(active)];
}

async function wifiSummary() {
  const active = await activatedNetworks();
  return active.find(entry => entry.startsWith('Wi-Fi'))?.replace('Wi-Fi', 'connected') ?? null;
}

async function wifiSsid(devicePath) {
  const accessPoint = await getProperty(Gio.BusType.SYSTEM, NM_DEST, devicePath, NM_IFACE, 'AccessPoint');
  if (!accessPoint || accessPoint === '/')
    return null;
  const ssid = await getProperty(Gio.BusType.SYSTEM, NM_DEST, accessPoint,
    'org.freedesktop.NetworkManager.AccessPoint', 'Ssid');
  return new TextDecoder().decode(Uint8Array.from(ssid ?? []));
}

async function activeIpAddresses() {
  const activeConnections = await getProperty(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE,
    'ActiveConnections').catch(() => []);
  const addresses = [];
  for (const connection of (activeConnections ?? []).slice(0, 3)) {
    try {
      const config = await getProperty(Gio.BusType.SYSTEM, NM_DEST, connection,
        'org.freedesktop.NetworkManager.Connection.Active', 'Ip4Config');
      if (!config || config === '/')
        continue;
      const entries = await getProperty(Gio.BusType.SYSTEM, NM_DEST, config,
        'org.freedesktop.NetworkManager.IP4Config', 'AddressData');
      for (const entry of entries ?? []) {
        const address = unwrap(entry?.['address']);
        if (address && !addresses.includes(address))
          addresses.push(address);
        if (addresses.length >= 3)
          break;
      }
    } catch (_error) {
      // Skip an unreadable connection; the rest still answer the query.
    }
  }
  return addresses;
}

function formatBytes(bytes) {
  const gb = bytes / 1e9;
  return `${gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/* ------------------------------------------------------------------ */
/* Plan preparation, confirmation policy and execution.                */
/* ------------------------------------------------------------------ */

function friendlyError(error) {
  if (error instanceof ActionError)
    return error.message;
  const message = String(error?.message ?? error ?? '');
  if (/ServiceUnknown|\.service files|UnknownObject|UnknownMethod|ObjectPath/i.test(message))
    return 'The system service for this action is not running.';
  if (/AccessDenied|NotAuthorized|Rejected/i.test(message))
    return 'The system refused this change.';
  if (/NoReply|Timeout|TimedOut/i.test(message))
    return 'The system service for this action did not respond.';
  return 'This action could not be completed.';
}

/**
 * Parse a query into a trusted plan and attach confirmation decisions.
 * Personalization never participates here — only the risk table and the
 * machine state (e.g. connected Bluetooth devices).
 */
export async function preparePlan(query, source = 'deterministic') {
  const parsed = parseActionPlan(query);
  if (!parsed)
    return null;
  const steps = [];
  for (const step of parsed) {
    const validated = validateArgs(step.id, step.args);
    if (!validated.ok)
      return null;
    steps.push({
      id: validated.action.id,
      args: validated.args,
      action: validated.action,
      source,
    });
  }
  return preparePlanForSteps(steps);
}

/**
 * Build a one-step plan from an already-named action (the model fallback
 * path). Untrusted arguments are re-validated against the registry here.
 */
export async function prepareAction(id, args, source = 'model') {
  const validated = validateArgs(id, args);
  if (!validated.ok)
    return null;
  return preparePlanForSteps([{
    id: validated.action.id,
    args: validated.args,
    action: validated.action,
    source,
  }]);
}

function preparePlanForSteps(steps) {
  return bluetoothConfirmationSteps(steps).then(annotated => {
    for (const step of annotated) {
      const decision = needsConfirmation(step.id, step.args,
        {connectedDevices: step._connectedDevices ?? 0});
      step.needsConfirmation = decision.confirm;
      delete step._connectedDevices;
    }
    return {steps: annotated, needsConfirmation: annotated.some(step => step.needsConfirmation)};
  });
}

function bluetoothConfirmationSteps(steps) {
  const needsDevices = steps.some(step => step.id === 'bluetooth.setState' && !step.args.enabled);
  if (!needsDevices)
    return Promise.resolve(steps);
  return bluetoothState()
    .then(state => steps.map(step => ({...step, _connectedDevices: state.connectedDevices})))
    .catch(() => steps);
}

export async function executeStep(step) {
  const started = GLib.get_monotonic_time();
  let outcome;
  try {
    const implementation = IMPLEMENTATIONS[step.id];
    if (!implementation)
      throw new ActionUnavailableError('That action is not implemented.');
    const message = await implementation(step.args);
    outcome = {ok: true, message};
  } catch (error) {
    outcome = {ok: false, message: friendlyError(error)};
  }
  recordDiagnostic({
    source: step.source ?? 'deterministic',
    action: step.id,
    args: step.args,
    risk: step.action?.risk ?? getAction(step.id)?.risk ?? '',
    latencyMs: Math.round((GLib.get_monotonic_time() - started) / 1000),
    status: outcome.ok ? 'complete' : 'error',
    reason: outcome.ok ? '' : outcome.message,
  });
  if (outcome.ok && ['app.open', 'directory.open'].includes(step.id))
    recordUse(step.id, step.args);
  return outcome;
}

export async function executePlan(plan) {
  const results = [];
  for (const step of plan.steps) {
    const result = await executeStep(step);
    results.push({step, ...result});
    if (!result.ok)
      break;
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Learning (ranking only) and diagnostics.                            */
/* ------------------------------------------------------------------ */

function recordUse(id, args) {
  try {
    const target = id === 'app.open' ? args.app : id === 'directory.open' ? args.dir : '';
    if (target)
      recordActionUse(id, target);
  } catch (_error) {
    // Learning must never affect the action path.
  }
}

const _diagnostics = [];

function recordDiagnostic(entry) {
  try {
    const record = {...entry, time: new Date().toISOString()};
    _diagnostics.push(record);
    if (_diagnostics.length > 50)
      _diagnostics.shift();
    recordActionDiagnostic(JSON.stringify(record));
  } catch (_error) {
    // Diagnostics are best-effort and never surface in normal UI.
  }
}

export function localDiagnostics() {
  return [..._diagnostics];
}

/* ------------------------------------------------------------------ */
/* Model fallback: only when deterministic parsing has no answer and   */
/* the query plausibly names a desktop capability.                     */
/* ------------------------------------------------------------------ */

const MODEL_HINTS = /\b(volume|sound|mute|louder|quieter|softer|bluetooth|wi-?fi|wireless|power ?saver|battery saver|performance mode|balanced|power profile|dark mode|light mode|dark theme|light theme|colou?r scheme|theme|appearance|night light|brightness|brighter|dimmer|text size|text scaling|disk|storage|memory|ram|my ip|ip address|network|battery)\b/;

export function mayNeedModelRouting(query) {
  const normalized = normalizeQuery(query);
  return normalized.length >= 3 && normalized.length <= 80 && MODEL_HINTS.test(normalized);
}

let _registryDescriptor = null;

export async function suggestActionFromModel(query, settings) {
  if (!_registryDescriptor)
    _registryDescriptor = JSON.stringify(describeModelRoutable());
  const timeout = Math.min(20, settings.get_int('request-timeout'));
  const [reply] = await routeAction(query.slice(0, 200), _registryDescriptor, timeout);
  let parsed = null;
  try {
    parsed = JSON.parse(reply);
  } catch (_error) {
    parsed = null;
  }
  const id = parsed?.action;
  if (!id || typeof id !== 'string')
    return null;
  const validated = validateArgs(id, parsed?.args ?? {});
  if (!validated.ok) {
    recordDiagnostic({
      source: 'model',
      action: String(id).slice(0, 64),
      args: {},
      risk: '',
      latencyMs: 0,
      status: 'invalid-tool-call',
      reason: validated.reason,
    });
    return null;
  }
  return {id: validated.action.id, args: validated.args};
}
