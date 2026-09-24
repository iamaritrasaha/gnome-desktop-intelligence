#!/usr/bin/python3
"""Disposable GTK4 editable-text fixture for the nested AT-SPI check."""

import os
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GLib, Gtk


TEXT = "Before café. selected phrase 🌙 after."
SELECTED = "selected phrase 🌙"


def _write(path, value):
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as stream:
        stream.write(value)
    os.replace(temporary, path)


def main(state_path, password=False):
    Gtk.init()
    window = Gtk.Window(title="GDI temporary AT-SPI fixture")
    window.set_default_size(480, 120)
    if password:
        field = Gtk.PasswordEntry()
        field.set_text("fixture-secret-must-not-be-read")
        field.select_region(0, -1)
    else:
        field = Gtk.TextView()
        field.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        text_buffer = field.get_buffer()
        text_buffer.set_text(TEXT)
        start = TEXT.index(SELECTED)
        end = start + len(SELECTED)
        text_buffer.select_range(
            text_buffer.get_iter_at_offset(end),
            text_buffer.get_iter_at_offset(start),
        )
        text_buffer.connect("changed", lambda *_args: _write(
            state_path,
            text_buffer.get_text(text_buffer.get_start_iter(),
                                 text_buffer.get_end_iter(), True),
        ))

    if not password:
        def commands():
            path = state_path + '.command'
            if not os.path.exists(path):
                return GLib.SOURCE_CONTINUE
            command = open(path).read().strip()
            os.remove(path)
            if command == 'select':
                start = TEXT.index(SELECTED)
                text_buffer.select_range(text_buffer.get_iter_at_offset(start + len(SELECTED)), text_buffer.get_iter_at_offset(start))
            elif command == 'caret':
                text_buffer.place_cursor(text_buffer.get_iter_at_offset(TEXT.index(SELECTED)))
            elif command == 'other-selection':
                text_buffer.select_range(text_buffer.get_iter_at_offset(6), text_buffer.get_iter_at_offset(0))
            elif command == 'pad':
                text_buffer.insert(text_buffer.get_end_iter(), 'x' * 900)
            elif command == 'change-back':
                text_buffer.insert(text_buffer.get_end_iter(), '!')
                text_buffer.delete(text_buffer.get_iter_at_offset(text_buffer.get_char_count() - 1), text_buffer.get_end_iter())
            elif command == 'readonly':
                field.set_editable(False)
            _write(state_path + '.done', command)
            return GLib.SOURCE_CONTINUE
        GLib.timeout_add(50, commands)

    window.set_child(field)
    window.set_focus(field)
    window.present()
    field.grab_focus()
    if password:
        _write(state_path, field.get_text())
    else:
        text_buffer = field.get_buffer()
        _write(state_path, text_buffer.get_text(text_buffer.get_start_iter(),
                                               text_buffer.get_end_iter(), True))
    GLib.timeout_add(150, lambda: (_write(state_path + ".ready", "ready"),
                                  GLib.SOURCE_REMOVE)[1])
    loop = GLib.MainLoop()
    window.connect("close-request", lambda *_args: (loop.quit(), False)[1])
    loop.run()


if __name__ == "__main__":
    main(sys.argv[1], "--password" in sys.argv)
