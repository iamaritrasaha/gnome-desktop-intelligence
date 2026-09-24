#!/usr/bin/python3
"""GTK4 controls with an isolated test D-Bus driver and synthetic text only."""
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gio, GLib
Gtk.init()
window = Gtk.Window(title='GDI passive fixture')
window.set_default_size(760, 480)
field = None

def reset(kind):
    global field
    if kind == 'password': field = Gtk.PasswordEntry()
    elif kind in ('entry','hidden'):
        field = Gtk.Entry()
        if kind == 'hidden': field.set_visibility(False)
    else:
        field = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD_CHAR)
        field.set_left_margin(16); field.set_top_margin(16)
        field.get_buffer().set_enable_undo(True)
        if kind == 'sensitive':
            field.set_input_hints(Gtk.InputHints.PRIVATE)
            field.set_input_purpose(Gtk.InputPurpose.PASSWORD)
        if kind == 'tag-hidden':
            buffer = field.get_buffer(); tag = buffer.create_tag('hidden', invisible=True)
            buffer.connect('changed', lambda b: b.apply_tag(tag, b.get_start_iter(), b.get_end_iter()))
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    box.set_margin_top(16); box.set_margin_start(16); box.set_margin_end(16)
    field.set_vexpand(isinstance(field, Gtk.TextView))
    box.append(field)
    window.set_child(box); window.set_focus(field); window.present(); field.grab_focus()

def method(_c, _sender, _p, _i, name, parameters, invocation):
    if name == 'Reset': reset(parameters.unpack()[0]); reply = GLib.Variant('()', ())
    elif name == 'Read':
        value = field.get_buffer().get_text(field.get_buffer().get_start_iter(), field.get_buffer().get_end_iter(), True) if isinstance(field, Gtk.TextView) else field.get_text()
        reply = GLib.Variant('(s)', (value,))
    invocation.return_value(reply)
xml = '<node><interface name="org.gnome.GdiPassiveFixture"><method name="Reset"><arg type="s" direction="in"/></method><method name="Read"><arg type="s" direction="out"/></method></interface></node>'
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
node = Gio.DBusNodeInfo.new_for_xml(xml)
bus.register_object('/org/gnome/GdiPassiveFixture', node.interfaces[0], method, None, None)
Gio.bus_own_name_on_connection(bus, 'org.gnome.GdiPassiveFixture', Gio.BusNameOwnerFlags.NONE, None, None)
reset('textview')
GLib.MainLoop().run()
