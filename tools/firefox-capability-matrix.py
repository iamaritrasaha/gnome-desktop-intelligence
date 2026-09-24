#!/usr/bin/python3
"""Firefox/Gecko per-field capability matrix on a disposable nested Wayland
compositor. Every trial edit targets a synthetic page in a private profile.
Read-only for the user's session; the probe never modifies browser settings
outside its throwaway profile."""
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib

_spec = importlib.util.spec_from_file_location(
    'gdi_native_input', Path(__file__).resolve().with_name('native-input.py'))
_native = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_native)
Keyboard = _native.Keyboard

Atspi.init()
Atspi.set_timeout(250, 500)
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
keyboard = Keyboard(bus)
work = Path(sys.argv[1])
work.mkdir(parents=True, exist_ok=True)
results = []


def wait(predicate, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(.1)
    return None


def focused_by_pid(pid):
    try:
        desktop = Atspi.get_desktop(0)
        queue = [(desktop, 0)]
        for _ in range(800):
            if not queue:
                return None
            node, depth = queue.pop(0)
            try:
                if depth == 1 and node.get_process_id() != pid:
                    continue
                if node.get_state_set().contains(Atspi.StateType.FOCUSED):
                    return node
                if depth < 20:
                    for index in range(min(node.get_child_count(), 120)):
                        child = node.get_child_at_index(index)
                        if child is not None:
                            queue.append((child, depth + 1))
            except Exception:
                continue
    except Exception:
        return None
    return None


def text_of(node):
    try:
        return Atspi.Text.get_text(node, 0, Atspi.Text.get_character_count(node))
    except Exception:
        return None


class TypingObserver:
    """Counts text-changed and caret-moved events for one accessible."""

    def __init__(self):
        self.text_events = 0
        self.caret_events = 0
        self.listener = Atspi.EventListener.new(self._event, None, None)
        self.listener.register('object:text-changed')
        self.listener.register('object:text-caret-moved')

    def _event(self, event, *_args):
        if 'text-changed' in event.type:
            self.text_events += 1
        elif 'caret' in event.type:
            self.caret_events += 1

    def close(self):
        self.listener.deregister('object:text-changed')
        self.listener.deregister('object:text-caret-moved')


def retry(fn, attempts=4, delay=.35):
    """Gecko recreates accessibles while the page settles; retry transient
    'Get failed' AT-SPI errors briefly before recording a capability."""
    last = None
    for _ in range(attempts):
        try:
            return fn()
        except Exception as error:
            last = error
            time.sleep(delay)
    raise last


def probe_field(label, pid, sample, refocus=None):
    """One field: focus already set by the page. Measure every capability."""
    node = wait(lambda: focused_by_pid(pid), 6)
    row = dict(field=label, focused=bool(node))
    if not node:
        results.append(row)
        print(f'GDI_FIREFOX {label}: no focused accessible', flush=True)
        return
    try:
        role = node.get_role_name()
        states = node.get_state_set()
        row.update(role=role, toolkit=node.get_application().get_toolkit_name(),
                   editable_text='EditableText' in node.get_interfaces(),
                   text_iface='Text' in node.get_interfaces(),
                   state_editable=states.contains(Atspi.StateType.EDITABLE),
                   multiline=states.contains(Atspi.StateType.MULTI_LINE),
                   sensitive=states.contains(Atspi.StateType.SENSITIVE))
        length = retry(lambda: Atspi.Text.get_character_count(node))
        row['length'] = length
        # Keyboard select-all inside the focused field.
        keyboard.chord(0x61, (0xffe3,))  # Ctrl+A
        time.sleep(.4)
        selections = retry(lambda: Atspi.Text.get_n_selections(node))
        row['selection_count'] = selections
        if selections >= 1:
            sel = Atspi.Text.get_selection(node, 0)
            start, end = int(sel.start_offset), int(sel.end_offset)
            row['selection_offsets'] = [start, end]
            row['read_selection'] = Atspi.Text.get_text(node, start, end) == sample
            row['read_surroundings'] = True
        else:
            row['read_selection'] = False
            start, end = 0, min(length, len(sample))
        caret = Atspi.Text.get_caret_offset(node)
        row['caret_offset'] = caret
        row['can_get_caret'] = caret >= 0
        try:
            rect = Atspi.Text.get_character_extents(node, max(0, caret - 1), Atspi.CoordType.WINDOW)
            row['caret_extents_window'] = bool(rect.width or rect.height) and not (
                rect.x == -1 and rect.y == -1)
        except Exception:
            row['caret_extents_window'] = False

        # Trial range replacement: delete + insert through EditableText.
        if row['editable_text'] and selections >= 1 and 0 < end - start <= length:
            acknowledged = Atspi.EditableText.delete_text(node, start, end)
            time.sleep(.5)
            after_delete = text_of(node)
            deleted_applied = after_delete is not None and \
                Atspi.Text.get_character_count(node) == length - (end - start)
            inserted = False
            if deleted_applied:
                inserted = Atspi.EditableText.insert_text(node, start, 'GDI ✓'.replace(' ✓', ''),
                                                          len('GDI'))
                time.sleep(.5)
            row['range_delete_acknowledged'] = bool(acknowledged)
            row['range_delete_applied'] = bool(deleted_applied)
            row['range_insert_applied'] = bool(deleted_applied and inserted and
                                               'GDI' in (text_of(node) or ''))
            row['can_replace_range'] = bool(deleted_applied and inserted)
        else:
            row['range_delete_acknowledged'] = None
            row['can_replace_range'] = False

        # Trial whole-value replacement through EditableText.setTextContents.
        if row['editable_text'] and row['text_iface']:
            whole = 'Matrix whole-value probe.'
            try:
                acknowledged = Atspi.EditableText.set_text_contents(node, whole)
                time.sleep(.5)
                applied = text_of(node) == whole
            except Exception as error:
                acknowledged, applied = None, False
                row['whole_value_error'] = type(error).__name__
            row['whole_value_acknowledged'] = bool(acknowledged)
            row['can_replace_whole_value'] = bool(applied)

        # Typing observation for passive assistance. Re-focus through the page
        # shortcut first: the trial edits above may have moved focus.
        if refocus:
            refocus()
            time.sleep(.8)
            keyboard.chord(0x61, (0xffe3,))
            time.sleep(.3)
        observer = TypingObserver()
        keyboard.text('xy', delay=.03)
        time.sleep(1.2)
        row['typing_arrived_in_field'] = text_of(node) == 'xy'
        row['typing_events_observed'] = observer.text_events > 0
        row['caret_events_observed'] = observer.caret_events > 0
        observer.close()
        row['can_observe_typing'] = row['typing_events_observed']
        row['can_passive_assist'] = bool(row['can_observe_typing'] and row['can_get_caret'] and
                                         row['state_editable'])
        results.append(row)
        print(f'GDI_FIREFOX {label}: ' + json.dumps(row), flush=True)
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {error}'
        results.append(row)
        print(f'GDI_FIREFOX {label}: ERROR {row["error"]}', flush=True)


def probe_static_selection(pid, extension_bus):
    """Static webpage text: keyboard selection, then read through ancestors and
    through GDI's own capture service (the end-to-end product path)."""
    row = dict(field='static-text')
    node = wait(lambda: focused_by_pid(pid), 6)
    if not node:
        results.append(row)
        print('GDI_FIREFOX static-text: no focused accessible', flush=True)
        return
    try:
        states = node.get_state_set()
        row.update(focused_role=node.get_role_name(),
                   focused_text='Text' in node.get_interfaces(),
                   focused_sensitive=states.contains(Atspi.StateType.SENSITIVE),
                   focused_editable_text='EditableText' in node.get_interfaces())
    except Exception:
        pass
    keyboard.chord(0x61, (0xffe3,))  # Ctrl+A over the page
    time.sleep(.6)
    chain = []
    current = node
    for _ in range(8):
        try:
            current = current.get_parent()
        except Exception:
            break
        if current is None:
            break
        try:
            chain.append((current.get_role_name(), 'Text' in current.get_interfaces(),
                          Atspi.Text.get_n_selections(current)))
        except Exception:
            chain.append((current.get_role_name() if hasattr(current, 'get_role_name') else '?', False, None))
    row['ancestor_selections'] = chain
    readable = any(count and count >= 1 for _, _, count in chain)
    row['read_page_selection'] = readable
    try:
        captured = extension_bus.call_sync(
            'org.gnome.DesktopIntelligence1', '/org/gnome/DesktopIntelligence1',
            'org.gnome.DesktopIntelligence1', 'GetFocusedContext', GLib.Variant('(i)', (pid,)),
            None, Gio.DBusCallFlags.NONE, 4000, None).unpack()
        caps = json.loads(captured[9])
        row['gdi_captured_selection'] = captured[1][:80]
        row['gdi_capability_reason'] = caps.get('reason')
        row['gdi_can_read_selection'] = caps.get('canReadSelection')
    except Exception as error:
        row['gdi_capture_error'] = f'{type(error).__name__}: {error}'
    results.append(row)
    print(f'GDI_FIREFOX static-text: ' + json.dumps(row), flush=True)


def main():
    profile = work / 'firefox-profile'
    profile.mkdir(exist_ok=True)
    (profile / 'user.js').write_text(
        'user_pref("accessibility.force_disabled", -1);\n'
        'user_pref("browser.shell.checkDefaultBrowser", false);\n'
        'user_pref("browser.aboutwelcome.enabled", false);\n'
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);\n'
        'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);\n'
        'user_pref("datareporting.healthreport.uploadEnabled", false);\n'
        'user_pref("toolkit.telemetry.enabled", false);\n'
        'user_pref("browser.tabs.warnOnClose", false);\n')
    sample = 'The quick brown probe jumps over the lazy fixture.'
    page = work / 'capability-matrix.html'
    page.write_text(f'''<!doctype html><meta charset="utf-8"><title>GDI capability matrix</title>
<style>body{{padding:40px;font:18px sans-serif}} textarea,input,[contenteditable],p{{display:block;width:640px;margin:15px;border:1px solid #aaa;padding:6px}} input{{height:40px}}</style>
<p id="static" tabindex="0">{sample}</p>
<textarea id="ta">{sample}</textarea>
<input id="in" value="{sample}">
<div id="ce" contenteditable="true">{sample}</div>
<div id="rich" contenteditable="true"><b>Bold sample</b> and <a href="https://example.org/">a link</a> {sample}</div>
<script>
const targets = {{'1': 'static', '2': 'ta', '3': 'in', '4': 'ce', '5': 'rich'}};
addEventListener('keydown', event => {{
  if (event.altKey && targets[event.key]) {{
    const el = document.getElementById(targets[event.key]);
    el.focus();
    if (el.select) el.select();
    event.preventDefault();
  }}
}});
document.getElementById('ta').focus();
document.getElementById('ta').select();
</script>''')
    log = work / 'firefox-matrix.log'
    with log.open('w') as output:
        process = subprocess.Popen(
            ['firefox', '--no-remote', '--profile', str(profile), page.as_uri()],
            env={**os.environ, 'MOZ_ENABLE_WAYLAND': '1', 'MOZ_ACCESSIBILITY_ATSPI_ENABLED': '1',
                 'GDK_BACKEND': 'wayland', 'GTK_A11Y': 'atspi'},
            stdout=output, stderr=output)
        try:
            if not wait(lambda: focused_by_pid(process.pid), 25):
                raise RuntimeError('Firefox field never became accessible/focused')
            time.sleep(1.5)
            # Static page selection first: no field typing may pollute the page
            # selection this probe reads through the document accessible.
            keyboard.chord(0xff31, (0xffe9,))  # Alt+1
            time.sleep(.8)
            probe_static_selection(process.pid, bus)
            probe_field('textarea', process.pid, sample,
                        refocus=lambda: keyboard.chord(0xff32, (0xffe9,)))
            keyboard.chord(0xff33, (0xffe9,))  # Alt+3
            time.sleep(.8)
            probe_field('input-text', process.pid, sample,
                        refocus=lambda: keyboard.chord(0xff33, (0xffe9,)))
            keyboard.chord(0xff34, (0xffe9,))  # Alt+4
            time.sleep(.8)
            probe_field('contenteditable', process.pid, sample,
                        refocus=lambda: keyboard.chord(0xff34, (0xffe9,)))
            keyboard.chord(0xff35, (0xffe9,))  # Alt+5
            time.sleep(.8)
            probe_field('contenteditable-rich', process.pid, sample,
                        refocus=lambda: keyboard.chord(0xff35, (0xffe9,)))
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            keyboard.close()
    out = work.parent / 'validation'
    out.mkdir(exist_ok=True)
    (out / 'firefox-capability-matrix.json').write_text(json.dumps(results, indent=2))
    print('FIREFOX MATRIX ' + json.dumps(results), flush=True)


if __name__ == '__main__':
    main()
