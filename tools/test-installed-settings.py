#!/usr/bin/python3
"""Exercise actual Shell/Preferences settings in try-phase2.sh --check."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import gi
gi.require_version('Atspi', '2.0')
gi.require_version('Gtk', '4.0')
from gi.repository import Atspi, Gdk, Gio, GLib, Gtk

root = Path(sys.argv[1]).resolve()
uuid = 'gdi@gnome.desktop.intelligence'
schema_id = 'org.gnome.shell.extensions.gdi'
default = ['<Control><Super>space']
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def wait_for(predicate, label, seconds=15):
    deadline = time.monotonic() + seconds
    last_error = None
    while time.monotonic() < deadline:
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        try:
            result = predicate()
            if result:
                return result
        except GLib.Error as error:
            last_error = error
        time.sleep(.1)
    raise AssertionError(f'{label} timed out: {last_error}')


def snapshot():
    value = bus.call_sync('org.gnome.Shell', '/org/gnome/GdiSettingsTest',
                         'org.gnome.GdiSettingsTest', 'Snapshot', None, None,
                         Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
    return json.loads(value)


def report(label):
    print(f'GDI_SETTINGS {label}=PASS', flush=True)


def key(name):
    subprocess.run([sys.executable, str(Path(__file__).with_name('press-key.py')), name], check=True)


def ready():
    value = snapshot()
    return value if value.get('bound') else False


initial = wait_for(ready, 'Shell settings')
assert initial['state'] == 1 and not initial['errors'], initial
assert initial['path'] == str(root) and initial['schema'] == schema_id, initial
assert initial['shortcut'] == default and initial['action'] > 0, initial
report('shell-local-schema-and-default-binding')

# An unthemed flat icon path loads in GTK but is NOT recolored symbolically.
# Require the shipped hicolor asset, not an unrelated icon from the host theme.
Gtk.init()
icons = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
icons.add_search_path(str(root / 'icons'))
mark = icons.lookup_icon('gdi-intelligence-symbolic', None, 16, 1,
                         Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_SYMBOLIC)
assert mark.is_symbolic(), 'GDI identity must recolor in light and dark GTK themes'
assert mark.get_file().get_path() == str(root / 'icons/hicolor/scalable/apps/gdi-intelligence-symbolic.svg')
report('installed-identity-is-gtk-symbolic')

# No global schema parent: the extracted directory must be self-contained.
source = Gio.SettingsSchemaSource.new_from_directory(str(root / 'schemas'), None, False)
schema = source.lookup(schema_id, False)
settings = Gio.Settings.new_full(schema, None, None)
assert settings.get_strv('shortcut') == default
previous_timeout = settings.get_int('request-timeout')
settings.set_int('request-timeout', 121)
Gio.Settings.sync()
wait_for(lambda: snapshot()['timeout'] == 121, 'Shell reads changed settings')
assert Gio.Settings.new_full(schema, None, None).get_int('request-timeout') == 121
report('settings-read-write-visible-in-shell')

settings.set_strv('shortcut', [])
Gio.Settings.sync()
wait_for(lambda: snapshot()['shortcut'] == default and snapshot()['bound'], 'empty shortcut fallback')
report('empty-shortcut-restores-schema-default')
key('shortcut')
wait_for(lambda: snapshot()['open'], 'default shortcut opens palette')
key('shortcut')
wait_for(lambda: not snapshot()['open'], 'default shortcut closes palette')
report('native-control-super-space-toggles-palette')

# Open prefs.js via GNOME's real Preferences service, not a mock constructor.
subprocess.run(['gnome-extensions', 'prefs', uuid], check=True)
Atspi.init()
Atspi.set_timeout(300, 300)

def preferences_nodes():
    pid = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                        'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                        GLib.Variant('(s)', ('org.gnome.Shell.Extensions',)), None,
                        Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    queue = [(Atspi.get_desktop(0), 0)]
    result = []
    for _ in range(1500):
        if not queue:
            break
        node, depth = queue.pop(0)
        try:
            if depth == 1 and node.get_process_id() != pid:
                continue
            if node.get_process_id() == pid:
                result.append(node)
            if depth < 30:
                for index in range(min(120, node.get_child_count())):
                    child = node.get_child_at_index(index)
                    if child is not None:
                        queue.append((child, depth + 1))
        except GLib.Error:
            continue
    return result


def named_widgets():
    return [(node, node.get_name() or '') for node in preferences_nodes()]


def loaded_preferences():
    nodes = named_widgets()
    names = [name for _, name in nodes]
    if 'Keyboard shortcut' in names and 'Writing intelligence' in names:
        return nodes
    return False

nodes = wait_for(loaded_preferences, 'real Preferences window')
valid, keyval, modifiers = Gtk.accelerator_parse(default[0])
assert valid
label = Gtk.accelerator_get_label(keyval, modifiers)
assert any(label in name for _, name in nodes), [name for _, name in nodes]
assert any('Default:' in name and label in name for _, name in nodes), [name for _, name in nodes]
report('preferences-open-and-default-shortcut-visible')


def select_page(title):
    for node, name in named_widgets():
        if name == title and 'Action' in node.get_interfaces():
            if Atspi.Action.do_action(node, 0):
                time.sleep(.3)
                return
    raise AssertionError(f'Preferences page not found: {title}')


select_page('AI & Models')


def timeout_spin():
    for node, name in named_widgets():
        if 'Value' in node.get_interfaces() and Atspi.Value.get_current_value(node) == 121:
            return node
    return False

spin = wait_for(timeout_spin, 'Preferences reads Shell settings')
assert Atspi.Value.set_current_value(spin, 122)
wait_for(lambda: settings.get_int('request-timeout') == 122 and snapshot()['timeout'] == 122,
         'Preferences writes shared settings')
report('preferences-read-write-shared-schema')
settings.set_int('request-timeout', previous_timeout)
Gio.Settings.sync()

subprocess.run(['gnome-extensions', 'disable', uuid], check=True)
wait_for(lambda: not snapshot()['bound'], 'shortcut removed on disable')
subprocess.run(['gnome-extensions', 'enable', uuid], check=True)
wait_for(ready, 'shortcut registered after re-enable')
time.sleep(.5)
key('shortcut')
wait_for(lambda: snapshot()['open'], 'shortcut opens after re-enable')
key('escape')
wait_for(lambda: not snapshot()['open'], 'palette dismissed after re-enable')
assert not snapshot()['errors']
report('disable-reenable-and-native-shortcut')
report('physical-runner-settings-regression-complete')
