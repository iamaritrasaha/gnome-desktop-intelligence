#!/usr/bin/python3
"""Disposable real-app QA on the nested compositor; only synthetic content."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib
spec = importlib.util.spec_from_file_location('fixture_test', Path(__file__).with_name('test-writing-service.py'))
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
root = Path(sys.argv[1])
text = 'Before café. selected phrase 🌙 after.'
(root / 'editor-fixture.txt').write_text(text)

def desktop_call(path, interface, method, params=None):
    return bus.call_sync('org.gnome.Mutter.RemoteDesktop', path, interface, method, params, None, Gio.DBusCallFlags.NONE, 5000, None)

def send_chord(modifier=0xffe3, code=ord('a')):
    path = desktop_call('/org/gnome/Mutter/RemoteDesktop', 'org.gnome.Mutter.RemoteDesktop', 'CreateSession').unpack()[0]
    interface = 'org.gnome.Mutter.RemoteDesktop.Session'
    desktop_call(path, interface, 'Start')
    def key(code, pressed):
        desktop_call(path, interface, 'NotifyKeyboardKeysym', GLib.Variant('(ub)', (code, pressed)))
    try:
        key(modifier, True); key(code, True); key(code, False); key(modifier, False)
    finally:
        desktop_call(path, interface, 'Stop')


def check(app, argv):
    env = {**os.environ, 'GTK_A11Y': 'atspi', 'MOZ_ENABLE_WAYLAND': '1', 'MOZ_ACCESSIBILITY_ATSPI_ENABLED': '1'}
    with open(root / (app + '.log'), 'w') as output:
        process = subprocess.Popen(argv, env=env, stdout=output, stderr=output)
        try:
            focused = ''
            for attempt in range(30):
                if attempt == 5:
                    send_chord(0xffe9, 0xff09)
                if process.poll() is not None:
                    break
                focused, _ = fixture.focus_fixture_editable(process)
                if focused:
                    break
                time.sleep(.1)
            if not focused:
                print(f'EDITOR {app}: NOT VERIFIED in this automated run (no focused EditableText for process)', flush=True)
                return
            send_chord(); time.sleep(.25)
            context = fixture.call(bus, 'GetFocusedContext', '(i)', (process.pid,))
            if context[1] != text:
                print(f'EDITOR {app}: NOT VERIFIED selection capture (no matching synthetic range)', flush=True)
                return
            token = context[0]
            result = fixture.call(bus, 'Replace', '(ssb)', (token, 'Verified replacement ✓', False))
            assert result[0], result
            time.sleep(.2)
            result = fixture.call(bus, 'Undo', '(s)', (token,))
            assert result[0], result
            fixture.call(bus, 'ReleaseContext', '(s)', (token,))
            print(f'EDITOR {app}: selection, exact replacement and GDI Undo PASS', flush=True)
        finally:
            fixture.stop_fixture(process)

check('gnome-text-editor', ['gnome-text-editor', '--standalone', str(root / 'editor-fixture.txt')])
profile = root / 'firefox-profile'; profile.mkdir(exist_ok=True)
(profile / 'user.js').write_text('user_pref("accessibility.force_disabled", -1);\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.aboutwelcome.enabled", false);\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);\nuser_pref("datareporting.healthreport.uploadEnabled", false);\nuser_pref("toolkit.telemetry.enabled", false);\n')
page = root / 'editor-fixture.html'
page.write_text('<!doctype html><meta charset="utf-8"><title>GDI synthetic editor fixture</title><textarea autofocus style="width:600px;height:250px">'+text+'</textarea><script>document.querySelector("textarea").focus();document.querySelector("textarea").select();</script>')
check('firefox', ['firefox', '--no-remote', '--profile', str(profile), page.as_uri()])
