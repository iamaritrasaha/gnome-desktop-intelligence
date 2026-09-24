#!/usr/bin/python3
"""Native keyboard input solely for the isolated nested test compositor."""
import sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
def call(path, interface, method, params=None):
    return bus.call_sync('org.gnome.Mutter.RemoteDesktop', path, interface, method,
                         params, None, Gio.DBusCallFlags.NONE, 5000, None)
path = call('/org/gnome/Mutter/RemoteDesktop', 'org.gnome.Mutter.RemoteDesktop', 'CreateSession').unpack()[0]
interface = 'org.gnome.Mutter.RemoteDesktop.Session'
call(path, interface, 'Start')
def key(code, pressed):
    call(path, interface, 'NotifyKeyboardKeysym', GLib.Variant('(ub)', (code, pressed)))
try:
    if sys.argv[1] == 'backtab': key(0xffe1, True)
    if sys.argv[1] == 'shortcut':
        key(0xffe3, True); key(0xffeb, True)
    code = {'enter': 0xff0d, 'tab': 0xff09, 'backtab': 0xff09, 'escape': 0xff1b, 'shortcut': 0x20}[sys.argv[1]]
    key(code, True); key(code, False)
    if sys.argv[1] == 'backtab': key(0xffe1, False)
    if sys.argv[1] == 'shortcut':
        key(0xffeb, False); key(0xffe3, False)
finally:
    call(path, interface, 'Stop')
