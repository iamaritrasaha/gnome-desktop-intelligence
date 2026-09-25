"""Test-only Mutter input on the private nested bus; never installed."""
import time
from gi.repository import Gio, GLib
class Keyboard:
    def __init__(self, bus):
        self.bus = bus
        self.interface = 'org.gnome.Mutter.RemoteDesktop.Session'
        self.path = self.call('/org/gnome/Mutter/RemoteDesktop', 'org.gnome.Mutter.RemoteDesktop', 'CreateSession').unpack()[0]
        self.call(self.path, self.interface, 'Start')
    def call(self, path, interface, method, args=None):
        return self.bus.call_sync('org.gnome.Mutter.RemoteDesktop', path, interface, method, args, None, Gio.DBusCallFlags.NONE, 5000, None)
    def key(self, key, state):
        self.call(self.path, self.interface, 'NotifyKeyboardKeysym', GLib.Variant('(ub)', (key, state)))
    def chord(self, key, modifiers=()):
        # Real keyboards hold a modifier for tens of milliseconds around the
        # key and separate press from release; back-to-back injected events
        # can reach the compositor before its modifier state has settled,
        # which turns e.g. Ctrl+Alt+Enter into a plain Enter in the field.
        # The delays model the physical event lifecycle instead of racing it.
        for mod in modifiers:
            self.key(mod, True); time.sleep(.03)
        self.key(key, True); time.sleep(.02)
        self.key(key, False)
        for mod in reversed(modifiers):
            time.sleep(.01); self.key(mod, False)
    def text(self, text, delay=.005):
        for character in text:
            if character == '\n':
                self.chord(0xff0d)
            elif character.isascii() and character.isupper():
                self.chord(ord(character.lower()), (0xffe1,))
            else:
                self.chord(ord(character) if ord(character) < 128 else 0x1000000 + ord(character))
            if delay: time.sleep(delay)
    def close(self): self.call(self.path, self.interface, 'Stop')
