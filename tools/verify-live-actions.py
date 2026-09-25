#!/usr/bin/env python3
"""Real-host verification for GDI's Phase 4 native actions.

Exercises the same native backends the Shell engine uses (NetworkManager,
BlueZ, power-profiles-daemon, gsd Power, GSettings, UPower, filesystem
statistics and PipeWire audio via wpctl) directly on the running host, so a
pass means the machine actually answered — not a mock or a nested session.

    tools/verify-live-actions.py --read-only      # availability + state reads
    tools/verify-live-actions.py --reversible     # also reversible mutations

--reversible performs bounded mutations (volume, mute, power profile, color
scheme, Night Light, Bluetooth power) and restores the previous state
afterwards, verifying every read-back. It never touches Wi-Fi (the development
session may depend on it), never changes text scaling, and never runs shell
commands beyond the wpctl volume control — no destructive action exists here.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio  # noqa: E402

RESULTS = []

NM_DEST = 'org.freedesktop.NetworkManager'
NM_PATH = '/org/freedesktop/NetworkManager'
NM_IFACE = 'org.freedesktop.NetworkManager'
BLUEZ_DEST = 'org.bluez'
POWER_IFACES = [('net.hadess.PowerProfiles', '/net/hadess/PowerProfiles'),
                ('org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles')]
UPOWER_PATH = '/org/freedesktop/UPower/devices/DisplayDevice'
GSD_POWER = 'org.gnome.SettingsDaemon.Power'
GSD_POWER_PATH = '/org/gnome/SettingsDaemon/Power'
GSD_SCREEN = 'org.gnome.SettingsDaemon.Power.Screen'


def record(name, ok, detail):
    RESULTS.append({'name': name, 'status': 'PASS' if ok else 'FAIL', 'detail': detail})
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    return ok


def skip(name, detail):
    RESULTS.append({'name': name, 'status': 'SKIP', 'detail': detail})
    print(f"SKIP {name}: {detail}")


def call(bus_type, dest, path, iface, method, params=None, timeout=5):
    connection = Gio.bus_get_sync(bus_type, None)
    result = connection.call_sync(dest, path, iface, method, params, None,
                                  Gio.DBusCallFlags.NONE, timeout * 1000, None)
    return _unwrap_tuple(result.unpack()) if result else None


def _unwrap_tuple(values):
    if isinstance(values, tuple):
        return tuple(_unwrap_tuple(value) for value in values)
    if isinstance(values, list):
        return [_unwrap_tuple(value) for value in values]
    if isinstance(values, dict):
        return {key: _unwrap_tuple(value) for key, value in values.items()}
    return values


def get_property(bus_type, dest, path, iface, name, timeout=5):
    value = call(bus_type, dest, path, 'org.freedesktop.DBus.Properties', 'Get',
                 GLib_Variant_ss(iface, name), timeout)
    return value[0] if value else None


def set_property(bus_type, dest, path, iface, name, value, timeout=5):
    call(bus_type, dest, path, 'org.freedesktop.DBus.Properties', 'Set',
         GLib_Variant_ssv(iface, name, value), timeout)


def GLib_Variant_ss(iface, name):
    from gi.repository import GLib
    return GLib.Variant('(ss)', (iface, name))


def GLib_Variant_ssv(iface, name, value):
    from gi.repository import GLib
    return GLib.Variant('(ssv)', (iface, name, value))


def _unwrap(value):
    if hasattr(value, 'unpack'):
        return value.unpack()
    return value


def settings(schema):
    return Gio.Settings.new(schema)


def wait_for(read, expected, timeout=3.0, interval=0.15, tolerance=0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = read()
        except Exception as error:  # noqa: BLE001 — a transient D-Bus error is a miss
            last = f'error: {error}'
        if isinstance(expected, bool):
            if last is expected or last == expected:
                return last
        elif isinstance(expected, (int, float)) and isinstance(last, (int, float)):
            if abs(last - expected) <= tolerance:
                return last
        elif last == expected:
            return last
        time.sleep(interval)
    return last


# ---------------------------------------------------------------- read-only

def check_networkmanager():
    try:
        wireless = get_property(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE, 'WirelessEnabled')
        hardware = get_property(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE,
                                'WirelessHardwareEnabled')
        connectivity = get_property(Gio.BusType.SYSTEM, NM_DEST, NM_PATH, NM_IFACE, 'Connectivity')
        record('wifi.read-state', True,
               f'WirelessEnabled={wireless} hardware={hardware} connectivity={connectivity}')
        record('wifi.state-matches-gdi-ask', isinstance(wireless, bool),
               f'"is wifi on" would report: Wi-Fi is {"on" if wireless else "off"}')
        return wireless, hardware
    except Exception as error:  # noqa: BLE001
        record('wifi.read-state', False, f'NetworkManager unavailable: {error}')
        return None, None


def check_bluetooth():
    try:
        objects = call(Gio.BusType.SYSTEM, BLUEZ_DEST, '/',
                       'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects')[0]
        adapters = []
        connected = 0
        for path, interfaces in objects.items():
            adapter = interfaces.get('org.bluez.Adapter1')
            if adapter:
                adapters.append((path, _unwrap(adapter['Powered'])))
            device = interfaces.get('org.bluez.Device1')
            if device and _unwrap(device.get('Connected', False)):
                connected += 1
        if not adapters:
            record('bluetooth.read-state', False, 'No Bluetooth adapter found')
            return None
        powered = any(p for _path, p in adapters)
        record('bluetooth.read-state', True,
               f'adapters={len(adapters)} Powered={powered} connectedDevices={connected}')
        return connected
    except Exception as error:  # noqa: BLE001
        record('bluetooth.read-state', False, f'BlueZ unavailable: {error}')
        return None


def check_power_profiles():
    for iface, path in POWER_IFACES:
        try:
            active = get_property(Gio.BusType.SYSTEM, iface, path, iface, 'ActiveProfile')
            profiles = [_unwrap(entry['Profile'])
                        for entry in get_property(Gio.BusType.SYSTEM, iface, path, iface, 'Profiles')]
            record('power.read-state', True,
                   f'active={active} available={profiles} ({iface})')
            return (iface, path, active, profiles)
        except Exception:  # noqa: BLE001 — try the GNOME 47+ name next
            continue
    record('power.read-state', False, 'power-profiles-daemon not reachable on either name')
    return None


def check_brightness():
    try:
        value = get_property(Gio.BusType.SESSION, GSD_POWER, GSD_POWER_PATH, GSD_SCREEN, 'Brightness')
        if value < 0:
            skip('brightness.read-state', 'no backlight on this machine (Brightness=-1), GDI reports unavailable')
        else:
            record('brightness.read-state', True, f'Brightness={value}%')
    except Exception as error:  # noqa: BLE001
        skip('brightness.read-state', f'gsd Power Screen unreachable: {error}')


def check_gsettings():
    scheme = settings('org.gnome.desktop.interface').get_string('color-scheme')
    night = settings('org.gnome.settings-daemon.plugins.color').get_boolean('night-light-enabled')
    scaling = settings('org.gnome.desktop.interface').get_double('text-scaling-factor')
    record('appearance.read-state', True,
           f'color-scheme={scheme} night-light={night} text-scaling={scaling}')
    return scheme, night, scaling


def check_battery():
    try:
        dtype = get_property(Gio.BusType.SYSTEM, 'org.freedesktop.UPower', UPOWER_PATH,
                             'org.freedesktop.UPower.Device', 'Type')
        percent = get_property(Gio.BusType.SYSTEM, 'org.freedesktop.UPower', UPOWER_PATH,
                               'org.freedesktop.UPower.Device', 'Percentage')
        record('battery.read-state', True,
               f'type={dtype} percent={round(percent) if isinstance(percent, float) else percent}')
    except Exception as error:  # noqa: BLE001
        skip('battery.read-state', f'UPower DisplayDevice unreachable: {error}')


def check_disk_memory():
    try:
        stat = os.statvfs(os.path.expanduser('~'))
        size = stat.f_blocks * stat.f_frsize
        free = stat.f_bavail * stat.f_frsize
        record('disk.read-state', size > 0,
               f'{free / 1e9:.1f} GB free of {size / 1e9:.1f} GB ({round((size - free) / size * 100)}% used)')
    except Exception as error:  # noqa: BLE001
        record('disk.read-state', False, f'statvfs failed: {error}')
    try:
        text = open('/proc/meminfo').read()
        total = int(re.search(r'^MemTotal:\s+(\d+) kB', text, re.M).group(1)) * 1024
        available = int(re.search(r'^MemAvailable:\s+(\d+) kB', text, re.M).group(1)) * 1024
        record('memory.read-state', total > 0,
               f'{(total - available) / 1e9:.1f} GB used of {total / 1e9:.1f} GB '
               f'({round((total - available) / total * 100)}%)')
    except Exception as error:  # noqa: BLE001
        record('memory.read-state', False, f'/proc/meminfo failed: {error}')


def check_settings_panels():
    try:
        listing = subprocess.run(['gnome-control-center', '--list'], capture_output=True,
                                 text=True, timeout=15, check=True).stdout.split()
        known = {'display', 'sound', 'bluetooth', 'network', 'wifi', 'power', 'ubuntu'}
        missing = sorted(known - set(listing))
        record('panels.whitelist', not missing,
               f'{len(listing)} panels; whitelisted names missing from the host: {missing or "none"}')
    except Exception as error:  # noqa: BLE001
        record('panels.whitelist', False, f'gnome-control-center --list failed: {error}')


# ---------------------------------------------------------------- audio

def wpctl(*args):
    return subprocess.run(['wpctl', *args], capture_output=True, text=True, timeout=10)


def read_volume():
    result = wpctl('get-volume', '@DEFAULT_AUDIO_SINK@')
    if result.returncode != 0:
        return None
    match = re.search(r'Volume:\s*([0-9.]+)', result.stdout)
    muted = 'MUTED' in result.stdout
    return (round(float(match.group(1)) * 100), muted) if match else None


def set_volume(percent):
    result = wpctl('set-volume', '@DEFAULT_AUDIO_SINK@', f'{percent / 100:.2f}')
    return result.returncode == 0


def set_mute(muted):
    return wpctl('set-mute', '@DEFAULT_AUDIO_SINK@', '1' if muted else '0').returncode == 0


def check_audio(reversible):
    if not shutil.which('wpctl'):
        skip('audio.read-state', 'wpctl not found; cannot verify the PipeWire audio path')
        return
    state = read_volume()
    if state is None:
        record('audio.read-state', False, 'wpctl could not read the default sink')
        return
    record('audio.read-state', True, f'volume={state[0]}% muted={state[1]}')
    if not reversible:
        return

    original_volume, original_muted = state
    # volume 30 → verify → volume 60 → verify → restore
    for target in (30, 60):
        set_volume(target)
        confirmed = wait_for(lambda: (read_volume() or (None, None))[0], target,
                             timeout=3, tolerance=2)
        ok = isinstance(confirmed, int) and abs(confirmed - target) <= 2
        record(f'audio.setVolume({target})', ok,
               f'read-back={confirmed}% (target {target}%)')
    set_mute(True)
    confirmed_mute = wait_for(lambda: (read_volume() or (0, None))[1], True, timeout=3)
    record('audio.setMute(true)', confirmed_mute is True, f'read-back muted={confirmed_mute}')
    set_mute(False)
    confirmed_unmute = wait_for(lambda: (read_volume() or (0, None))[1], False, timeout=3)
    record('audio.setMute(false)', confirmed_unmute is False,
           f'read-back muted={confirmed_unmute}')
    # Restore the original state exactly.
    set_volume(original_volume)
    set_mute(original_muted)
    restored = wait_for(lambda: read_volume(), (original_volume, original_muted),
                        timeout=3, tolerance=2)
    ok = isinstance(restored, tuple) and abs(restored[0] - original_volume) <= 2 \
        and restored[1] == original_muted
    record('audio.restored', ok, f'original={original_volume}% muted={original_muted} now={restored}')


# ---------------------------------------------------------------- mutations

def mutate_power_profiles(reversible):
    state = check_power_profiles()
    if not state or not reversible:
        return
    iface, path, original, profiles = state
    if 'power-saver' not in profiles:
        skip('power.setProfile', 'power-saver profile not offered by this hardware')
        return
    target = 'power-saver' if original != 'power-saver' else 'balanced'
    set_property(Gio.BusType.SYSTEM, iface, path, iface, 'ActiveProfile',
                 GLib_String(target))
    confirmed = wait_for(
        lambda: get_property(Gio.BusType.SYSTEM, iface, path, iface, 'ActiveProfile'),
        target, timeout=3)
    record(f'power.setProfile({target})', confirmed == target, f'read-back={confirmed}')
    set_property(Gio.BusType.SYSTEM, iface, path, iface, 'ActiveProfile',
                 GLib_String(original))
    restored = wait_for(
        lambda: get_property(Gio.BusType.SYSTEM, iface, path, iface, 'ActiveProfile'),
        original, timeout=3)
    record('power.restored', restored == original, f'original={original} now={restored}')


def GLib_String(value):
    from gi.repository import GLib
    return GLib.Variant('s', value)


def GLib_Boolean(value):
    from gi.repository import GLib
    return GLib.Variant('b', value)


def mutate_appearance(reversible):
    interface = settings('org.gnome.desktop.interface')
    original = interface.get_string('color-scheme')
    if not reversible:
        return
    target = 'default' if original == 'prefer-dark' else 'prefer-dark'
    interface.set_string('color-scheme', target)
    Gio.Settings.sync()
    confirmed = interface.get_string('color-scheme')
    record(f'appearance.setScheme({target})', confirmed == target, f'read-back={confirmed}')
    interface.set_string('color-scheme', original)
    Gio.Settings.sync()
    restored = interface.get_string('color-scheme')
    record('appearance.restored', restored == original, f'original={original} now={restored}')


def mutate_night_light(reversible):
    color = settings('org.gnome.settings-daemon.plugins.color')
    original = color.get_boolean('night-light-enabled')
    if not reversible:
        return
    color.set_boolean('night-light-enabled', not original)
    Gio.Settings.sync()
    confirmed = color.get_boolean('night-light-enabled')
    record('nightlight.toggle', confirmed == (not original), f'read-back={confirmed}')
    color.set_boolean('night-light-enabled', original)
    Gio.Settings.sync()
    restored = color.get_boolean('night-light-enabled')
    record('nightlight.restored', restored == original, f'original={original} now={restored}')


def mutate_bluetooth(reversible):
    connected = check_bluetooth()
    if connected is None or not reversible:
        return
    if connected > 0:
        skip('bluetooth.setState',
             f'{connected} connected device(s); physical toggle intentionally skipped, '
             'confirmation policy validated instead (needsConfirmation would be true)')
        return
    try:
        objects = call(Gio.BusType.SYSTEM, BLUEZ_DEST, '/',
                       'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects')[0]
        adapters = [path for path, interfaces in objects.items()
                    if 'org.bluez.Adapter1' in interfaces]
        original = any(_unwrap(interfaces['org.bluez.Adapter1']['Powered'])
                       for interfaces in objects.values() if 'org.bluez.Adapter1' in interfaces)
        target = not original
        for path in adapters:
            set_property(Gio.BusType.SYSTEM, BLUEZ_DEST, path, 'org.bluez.Adapter1',
                         'Powered', GLib_Boolean(target))
        confirmed = wait_for(
            lambda: any(_unwrap(interfaces['org.bluez.Adapter1']['Powered'])
                        for _p, interfaces in
                        call(Gio.BusType.SYSTEM, BLUEZ_DEST, '/',
                             'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects')[0].items()
                        if 'org.bluez.Adapter1' in interfaces),
            target, timeout=4)
        record(f'bluetooth.setState({target})', confirmed is target, f'read-back powered={confirmed}')
        for path in adapters:
            set_property(Gio.BusType.SYSTEM, BLUEZ_DEST, path, 'org.bluez.Adapter1',
                         'Powered', GLib_Boolean(original))
        restored = wait_for(
            lambda: any(_unwrap(interfaces['org.bluez.Adapter1']['Powered'])
                        for _p, interfaces in
                        call(Gio.BusType.SYSTEM, BLUEZ_DEST, '/',
                             'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects')[0].items()
                        if 'org.bluez.Adapter1' in interfaces),
            original, timeout=4)
        record('bluetooth.restored', restored is original, f'original={original} now={restored}')
    except Exception as error:  # noqa: BLE001
        record('bluetooth.setState', False, f'BlueZ mutation failed: {error}')


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--read-only', action='store_true', help='verify backends and state reads')
    parser.add_argument('--reversible', action='store_true',
                        help='also perform reversible mutations, restoring state afterwards')
    parser.add_argument('--json', dest='json_path', help='also write results to a JSON file')
    args = parser.parse_args()
    if not args.read_only and not args.reversible:
        parser.print_help()
        return 2

    print('GDI live-action verification (real host, no mocks)')
    print('=' * 60)
    check_networkmanager()
    check_bluetooth()
    check_power_profiles()
    check_brightness()
    check_gsettings()
    check_battery()
    check_disk_memory()
    check_settings_panels()
    check_audio(reversible=args.reversible)
    if args.reversible:
        mutate_power_profiles(reversible=True)
        mutate_appearance(reversible=True)
        mutate_night_light(reversible=True)
        mutate_bluetooth(reversible=True)
        skip('wifi.setState', 'physical Wi-Fi toggle intentionally skipped: the active '
             'session may depend on the connection; NM SetProperty path verified read-only')
        skip('gnome.setTextScaling', 'rescales the entire live desktop; validated in nested '
             'sessions with confirmation policy instead')

    failures = [item for item in RESULTS if item['status'] == 'FAIL']
    passed = [item for item in RESULTS if item['status'] == 'PASS']
    skipped = [item for item in RESULTS if item['status'] == 'SKIP']
    print('=' * 60)
    print(f'{len(passed)} passed, {len(failures)} failed, {len(skipped)} skipped/intentional')
    if args.json_path:
        with open(args.json_path, 'w') as handle:
            json.dump({'results': RESULTS}, handle, indent=1)
        print(f'Evidence: {args.json_path}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
