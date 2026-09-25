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

import { getAction, needsConfirmation, describeModelRoutable, validateArgs, RISK } from './registry.js';
import { parseActionPlan, normalizeQuery, mayNeedModelRouting } from './parser.js';
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

/** A mutating action whose post-change state read-back disagreed. */
class VerificationError extends ActionError {
  constructor(message) {
    super(message);
    this.verificationFailed = true;
  }
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

/**
 * Poll a state read until `check` returns a non-null value or the deadline
 * passes. Mutating actions use this to verify that the backend actually
 * applied the change before success is reported; a timeout means the change
 * was not confirmed and the action reports failure.
 */
async function waitFor(check, timeoutMs = 1500, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = await check();
    } catch (_error) {
      value = null;
    }
    if (value !== null && value !== undefined)
      return value;
    if (Date.now() >= deadline)
      return null;
    await sleep(intervalMs);
  }
}

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
    await applyVolume(args.percent);
    // GVC refreshes the sink object from the daemon after push_volume; the
    // read-back therefore reflects the applied server state, not the request.
    const confirmed = await waitFor(async () => {
      const current = volumePercent(await audioSink());
      return Math.abs(current - args.percent) <= 2 ? current : null;
    }, 1000, 100);
    if (confirmed === null)
      throw new VerificationError('The audio system did not confirm the new volume.');
    return `Volume set to ${confirmed}%.`;
  },
  'audio.adjustVolume': async args => {
    const current = volumePercent(await audioSink());
    const target = Math.max(0, Math.min(100, current + args.step));
    await applyVolume(target);
    const confirmed = await waitFor(async () => {
      const read = volumePercent(await audioSink());
      return Math.abs(read - target) <= 2 ? read : null;
    }, 1000, 100);
    if (confirmed === null)
      throw new VerificationError('The audio system did not confirm the new volume.');
    return `Volume ${args.step >= 0 ? 'raised' : 'lowered'} to ${confirmed}%.`;
  },
  'audio.setMute': async args => {
    const {sink} = await audioSink();
    sink.change_is_muted(args.muted);
    const confirmed = await waitFor(async () => {
      const state = await audioSink();
      return state.sink.is_muted === args.muted ? args.muted : null;
    }, 1000, 100);
    if (confirmed === null)
      throw new VerificationError('The audio system did not confirm the mute change.');
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
    const confirmed = await waitFor(async () => {
      const after = await bluetoothState();
      return after.powered === args.enabled ? args.enabled : null;
    }, 3000, 200);
    if (confirmed === null)
      throw new VerificationError(`Bluetooth did not turn ${args.enabled ? 'on' : 'off'}.`);
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
    const confirmed = await waitFor(async () => {
      const enabled = await getProperty(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE, 'WirelessEnabled');
      return enabled === args.enabled ? enabled : null;
    }, 3000, 200);
    if (confirmed === null)
      throw new VerificationError(`Wi-Fi did not turn ${args.enabled ? 'on' : 'off'}.`);
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
    const confirmed = await waitFor(async () => {
      const after = await powerProfileState();
      return after.active === args.profile ? after.active : null;
    }, 2000, 150);
    if (confirmed === null)
      throw new VerificationError('The power profile did not change.');
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
    if (interfaceSettings().get_string('color-scheme') !== args.scheme)
      throw new VerificationError('The appearance setting did not change.');
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
    if (colorSettings().get_boolean('night-light-enabled') !== args.enabled)
      throw new VerificationError('Night Light did not change.');
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
    if (interfaceSettings().get_double('text-scaling-factor') !== args.factor)
      throw new VerificationError('The text size setting did not change.');
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
  const confirmed = await waitFor(async () => {
    const value = await sessionBrightness();
    return Math.abs(value - percent) <= 3 ? value : null;
  }, 1500, 150);
  if (confirmed === null)
    throw new VerificationError('The brightness level did not change.');
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
/**
 * One end-to-end trace per user invocation: raw text, normalized text,
 * routing source, chosen action, validated arguments, risk class,
 * confirmation decision, backend, backend result/error, UI result and total
 * latency. Traces are bounded RAM-only records mirrored to the service's
 * ActionStats; they contain no writing-tool text and no secrets.
 */
let _traceSeq = 0;
const _traces = [];
const _traceSummary = {total: 0, complete: 0, failed: 0, cancelled: 0, invalidToolCalls: 0, modelRouted: 0};

export function beginActionTrace({query, source}) {
  const trace = {
    id: ++_traceSeq,
    time: new Date().toISOString(),
    query: String(query ?? '').slice(0, 200),
    normalized: normalizeQuery(query).slice(0, 200),
    source,
    steps: [],
    confirmation: '',
    status: 'open',
    _started: GLib.get_monotonic_time(),
  };
  _traceSummary.total++;
  if (source === 'model')
    _traceSummary.modelRouted++;
  return trace;
}

function traceStepSummary(step, outcome, latencyMs) {
  return {
    action: step.id,
    args: step.args,
    risk: step.action?.risk ?? '',
    backend: step.action?.backend ?? '',
    source: step.source ?? 'deterministic',
    confirmation: step.needsConfirmation ? 'required' : 'immediate',
    status: outcome.ok ? 'complete' : 'error',
    verified: outcome.ok ? !(outcome.verificationFailed ?? false) : null,
    reason: outcome.ok ? '' : outcome.message,
    latencyMs,
  };
}

export function finishTrace(trace, status, ui) {
  if (!trace || trace.status !== 'open')
    return;
  trace.status = status;
  trace.ui = String(ui ?? '').slice(0, 200);
  trace.totalMs = Math.round((GLib.get_monotonic_time() - trace._started) / 1000);
  if (status === 'complete')
    _traceSummary.complete++;
  else if (status === 'failed')
    _traceSummary.failed++;
  else if (status === 'cancelled')
    _traceSummary.cancelled++;
  else if (status === 'invalid-tool-call')
    _traceSummary.invalidToolCalls++;
  recordDiagnostic(trace);
}

/** Close a trace opened by the palette for a plain launcher activation. */
export function finishLauncherTrace(trace, {action, target, status, message, latencyMs}) {
  trace.steps = [{action, args: {target: String(target ?? '').slice(0, 100)}, risk: 'low-risk',
    backend: 'gio', source: trace.source, confirmation: 'immediate',
    status, verified: null, reason: message, latencyMs}];
  finishTrace(trace, status === 'complete' ? 'complete' : 'failed', message);
}

export function clearDiagnostics() {
  _traces.length = 0;
  _traceSummary.total = 0;
  _traceSummary.complete = 0;
  _traceSummary.failed = 0;
  _traceSummary.cancelled = 0;
  _traceSummary.invalidToolCalls = 0;
  _traceSummary.modelRouted = 0;
}

export function diagnosticsSummary() {
  return {..._traceSummary};
}

export async function preparePlan(query, source = 'deterministic', trace = null) {
  const started = GLib.get_monotonic_time();
  const parsed = parseActionPlan(query);
  if (!parsed) {
    if (trace)
      trace.deterministicMatch = false;
    return null;
  }
  if (trace)
    trace.deterministicMatch = true;
  const steps = [];
  for (const step of parsed) {
    const validated = validateArgs(step.id, step.args);
    if (!validated.ok) {
      if (trace)
        finishTrace(trace, 'failed', `Rejected: ${validated.reason}`);
      return null;
    }
    steps.push({
      id: validated.action.id,
      args: validated.args,
      action: validated.action,
      source,
    });
  }
  return preparePlanForSteps(steps, trace, started);
}

/**
 * Build a one-step plan from an already-named action (the model fallback
 * path). Untrusted arguments are re-validated against the registry here.
 */
export async function prepareAction(id, args, source = 'model', trace = null) {
  const started = GLib.get_monotonic_time();
  const validated = validateArgs(id, args);
  if (!validated.ok) {
    if (trace)
      finishTrace(trace, 'invalid-tool-call', `Rejected: ${validated.reason}`);
    return null;
  }
  return preparePlanForSteps([{
    id: validated.action.id,
    args: validated.args,
    action: validated.action,
    source,
  }], trace, started);
}

function preparePlanForSteps(steps, trace = null, started = 0) {
  return bluetoothConfirmationSteps(steps).then(annotated => {
    for (const step of annotated) {
      const decision = needsConfirmation(step.id, step.args,
        {connectedDevices: step._connectedDevices ?? 0});
      // A model-proposed state change is never immediate: the routing model
      // cannot lower the confirmation policy, only raise it.
      step.needsConfirmation = decision.confirm ||
        (step.source === 'model' && step.action.risk === RISK.STATE_CHANGE);
      delete step._connectedDevices;
    }
    if (trace) {
      trace._started = trace._started || started;
      trace.confirmation = annotated.some(step => step.needsConfirmation)
        ? 'required' : 'immediate';
      trace.proposedSteps = annotated.map(step => step.id);
    }
    return {steps: annotated, needsConfirmation: annotated.some(step => step.needsConfirmation), trace};
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
    outcome = {
      ok: false,
      message: friendlyError(error),
      verificationFailed: Boolean(error?.verificationFailed),
    };
  }
  outcome.latencyMs = Math.round((GLib.get_monotonic_time() - started) / 1000);
  if (outcome.ok && ['app.open', 'directory.open'].includes(step.id))
    recordUse(step.id, step.args);
  return outcome;
}

export async function executePlan(plan) {
  const results = [];
  for (const step of plan.steps) {
    const result = await executeStep(step);
    results.push({step, ...result});
    if (plan.trace)
      plan.trace.steps.push(traceStepSummary(step, result, result.latencyMs));
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

const _MAX_DIAGNOSTICS = 50;

function recordDiagnostic(trace) {
  try {
    const record = {...trace, _started: undefined};
    _traces.push(record);
    if (_traces.length > _MAX_DIAGNOSTICS)
      _traces.shift();
    // The service mirror is bounded (4096-byte records, 50 entries).
    recordActionDiagnostic(JSON.stringify(record));
  } catch (_error) {
    // Diagnostics are best-effort and never surface in normal UI.
  }
}

export function localDiagnostics() {
  return [..._traces];
}

export { mayNeedModelRouting };

/* ------------------------------------------------------------------ */
/* Model fallback: only when deterministic parsing has no answer and   */
/* the query plausibly names a desktop capability.                     */
/* ------------------------------------------------------------------ */

let _registryDescriptor = null;

export async function suggestActionFromModel(query, settings, trace = null) {
  if (!_registryDescriptor)
    _registryDescriptor = JSON.stringify(describeModelRoutable());
  const timeout = Math.min(20, settings.get_int('request-timeout'));
  const started = GLib.get_monotonic_time();
  const [reply] = await routeAction(query.slice(0, 200), _registryDescriptor, timeout);
  if (trace) {
    trace.modelLatencyMs = Math.round((GLib.get_monotonic_time() - started) / 1000);
    trace.modelReply = String(reply ?? '').slice(0, 200);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(reply);
  } catch (_error) {
    parsed = null;
  }
  const id = parsed?.action;
  if (!id || typeof id !== 'string') {
    if (trace)
      trace.modelSuggestion = 'none';
    return null;
  }
  const validated = validateArgs(id, parsed?.args ?? {});
  if (!validated.ok) {
    if (trace) {
      trace.modelSuggestion = String(id).slice(0, 64);
      finishTrace(trace, 'invalid-tool-call', `Rejected by the registry: ${validated.reason}`);
    } else {
      _traceSummary.invalidToolCalls++;
    }
    return null;
  }
  if (trace)
    trace.modelSuggestion = validated.action.id;
  return {id: validated.action.id, args: validated.args};
}
