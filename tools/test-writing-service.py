#!/usr/bin/python3
"""Exercise selected-text capture and exact-range edits with a GTK4 fixture."""

import json
import os
import subprocess
import sys
import time

import gi

gi.require_version("Gio", "2.0")
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib


BUS_NAME = "org.gnome.DesktopIntelligence1"
OBJECT_PATH = "/org/gnome/DesktopIntelligence1"
INTERFACE = "org.gnome.DesktopIntelligence1"
FIXTURE = os.path.join(os.path.dirname(__file__), "atspi-fixture.py")
REPLACEMENT = "replacement ✓"


def wait_for(path, process, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(path):
            return True
        if process.poll() is not None:
            details = process.stderr.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"GTK fixture exited with status {process.returncode}: {details[-1200:]}")
        time.sleep(0.05)
    return False


def launch_fixture(state_path, password=False):
    argv = [sys.executable, FIXTURE, state_path]
    if password:
        argv.append("--password")
    environment = os.environ.copy()
    environment["GDK_BACKEND"] = "wayland"
    environment["GTK_A11Y"] = "atspi"
    process = subprocess.Popen(argv, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE, env=environment)
    if not wait_for(state_path + ".ready", process):
        process.terminate()
        provider_error = ""
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
        details = process.stderr.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GTK fixture did not become ready: {details[-1200:]}")
    return process


def stop_fixture(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def wait_for_text(path, process, expected, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("GTK fixture stopped during the edit check")
        try:
            with open(path, encoding="utf-8") as stream:
                if stream.read() == expected:
                    return True
        except OSError:
            pass
        time.sleep(0.05)
    return False


def call(connection, method, signature="()", values=(), timeout=10000):
    return connection.call_sync(
        BUS_NAME,
        OBJECT_PATH,
        INTERFACE,
        method,
        GLib.Variant(signature, values),
        None,
        Gio.DBusCallFlags.NONE,
        timeout,
        None,
    ).unpack()


def report(name, passed, detail=""):
    suffix = f" ({detail})" if detail else ""
    print(f"GDI_ATSPI {name}={'PASS' if passed else 'FAIL'}{suffix}", flush=True)
    if not passed:
        raise RuntimeError(f"AT-SPI check failed: {name}")


def debug_focused_roles():
    """Print only role/state/interface metadata for the static fixture."""
    try:
        Atspi.init()
        queue = [(Atspi.get_desktop(0), 0)]
        visited = 0
        while queue and visited < 240:
            accessible, depth = queue.pop(0)
            visited += 1
            try:
                states = accessible.get_state_set()
                focused = states.contains(Atspi.StateType.FOCUSED)
                editable = states.contains(Atspi.StateType.EDITABLE)
                if focused or editable or depth < 2:
                    role = Atspi.Role.get_name(accessible.get_role())
                    interfaces = ",".join(accessible.get_interfaces())
                    print(f"GDI_ATSPI_DEBUG pid={accessible.get_process_id()} depth={depth} role={role} "
                          f"focused={focused} editable={editable} "
                          f"interfaces={interfaces}", flush=True)
                for index in range(min(accessible.get_child_count(), 60)):
                    child = accessible.get_child_at_index(index)
                    if child is not None:
                        queue.append((child, depth + 1))
            except Exception:
                continue
    except Exception as error:
        print(f"GDI_ATSPI_DEBUG unavailable: {error}", flush=True)


def focus_fixture_editable(process):
    """Focus only the process-owned fixture node through its a11y component."""
    Atspi.init()
    queue = [(Atspi.get_desktop(0), 0)]
    candidates = []
    visited = 0
    while queue and visited < 1200:
        accessible, depth = queue.pop(0)
        visited += 1
        try:
            if depth == 1 and accessible.get_process_id() != process.pid:
                continue
            if accessible.get_process_id() == process.pid:
                states = accessible.get_state_set()
                interfaces = set(accessible.get_interfaces())
                if (states.contains(Atspi.StateType.EDITABLE) and
                        states.contains(Atspi.StateType.SENSITIVE) and
                        not states.contains(Atspi.StateType.READ_ONLY) and
                        "EditableText" in interfaces and "Text" in interfaces):
                    candidates.append((accessible, depth))
            for index in range(min(accessible.get_child_count(), 120)):
                child = accessible.get_child_at_index(index)
                if child is not None:
                    queue.append((child, depth + 1))
        except Exception:
            continue

    for accessible, _depth in sorted(candidates, key=lambda item: item[1], reverse=True):
        try:
            states = accessible.get_state_set()
            if not states.contains(Atspi.StateType.FOCUSED):
                Atspi.Component.grab_focus(accessible)
                time.sleep(0.1)
            states = accessible.get_state_set()
            if states.contains(Atspi.StateType.FOCUSED):
                role = Atspi.Role.get_name(accessible.get_role())
                attrs = accessible.get_attributes()
                if isinstance(attrs, dict):
                    attr_values = " ".join(str(value) for value in attrs.values())
                    attr_keys = " ".join(str(key) for key in attrs)
                else:
                    attr_values = " ".join(str(value) for value in (attrs or []))
                    attr_keys = ""
                password_marker = "password" in (role + attr_keys + attr_values).lower()
                return role, password_marker
        except Exception:
            continue
    return "", False


def command(path, process, value):
    with open(path + '.command', 'w') as stream:
        stream.write(value)
    assert wait_for_text(path + '.done', process, value)
    time.sleep(0.15)  # let AT-SPI change notifications reach the service


def main(home):
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    state_path = os.path.join(home, "gdi-atspi-fixture-state")
    normal = launch_fixture(state_path)
    try:
        fixture_role = ''
        for _ in range(30):
            fixture_role, _password_marker = focus_fixture_editable(normal)
            if fixture_role:
                break
            time.sleep(.1)
        if not fixture_role:
            debug_focused_roles()
        report("fixture-editable-focused", bool(fixture_role), fixture_role)
        context = call(connection, "GetFocusedContext", "(i)", (normal.pid,))
        token, selected, nearby, _application, role, start, end, caret, editable = context[:9]
        try:
            capabilities = json.loads(context[9])
        except (IndexError, ValueError):
            capabilities = {}
        report("selected-text-read", selected == "selected phrase 🌙",
               f"role={role!r}")
        report("capability-model-reported",
               capabilities.get("canReadSelection") is True and
               capabilities.get("canReplaceSelection") is True and
               capabilities.get("canObserveTyping") is True and
               bool(capabilities.get("role")), repr(capabilities)[:160])
        report("selection-and-caret-offsets",
               start >= 0 and end > start and caret >= 0 and end - start == len(selected))
        report("bounded-nearby-context", len(nearby) < 1600)

        try:
            call(connection, "Transform", "(sssssssssssiii)", (
                token, "proofread", selected, nearby, "", "ollama",
                "http://127.0.0.1:1", "fixture-model", "fixture-model",
                "fixture-model", "fixture-model", 5, 8192, 1024,
            ), timeout=8000)
            request_failed_cleanly = False
        except GLib.Error as error:
            provider_error = str(error)
            request_failed_cleanly = "Could not reach Ollama" in provider_error
        report("ollama-unavailable-clean-failure", request_failed_cleanly,
               provider_error[:240])
        still_available = call(connection, "GetFocusedContext", "(i)", (normal.pid,))[1] == selected
        report("service-survives-provider-failure", still_available)

        success, message = call(connection, "Replace", "(ssb)",
                                (token, REPLACEMENT, False))
        replaced_text = wait_for_text(
            state_path, normal, "Before café. replacement ✓ after.")
        report("exact-range-replacement", success and
               replaced_text, message)

        success, _message = call(connection, "Undo", "(s)", (token,))
        restored_text = wait_for_text(
            state_path, normal, "Before café. selected phrase 🌙 after.")
        report("precise-undo", success and restored_text, _message)
        command(state_path, normal, 'pad')
        command(state_path, normal, 'select')
        current = call(connection, "GetFocusedContext", "(i)", (normal.pid,))
        command(state_path, normal, 'other-selection')
        success, message = call(connection, "Replace", "(ssb)", (current[0], REPLACEMENT, False))
        report('different-selection-refused', not success and 'changed' in message)
        command(state_path, normal, 'select')
        current = call(connection, "GetFocusedContext", "(i)", (normal.pid,))
        command(state_path, normal, 'change-back')
        success, message = call(connection, "Replace", "(ssb)", (current[0], REPLACEMENT, False))
        report('edit-and-revert-still-stale', not success and 'changed' in message)
        current = call(connection, "GetFocusedContext", "(i)", (normal.pid,))
        success, message = call(connection, "Replace", "(ssb)", (current[0], REPLACEMENT, False))
        report('fresh-selection-replace', success, message)
        command(state_path, normal, 'change-back')
        success, message = call(connection, "Undo", "(s)", (current[0],))
        report('stale-undo-refused', not success, message)
        command(state_path, normal, 'select')
        command(state_path, normal, 'readonly')
        current = call(connection, "GetFocusedContext", "(i)", (normal.pid,))
        report('readonly-selection-captured', bool(current[1]) and current[8] is False)
        try:
            readonly_caps = json.loads(current[9])
        except (IndexError, ValueError):
            readonly_caps = {}
        report('readonly-not-replaceable',
               readonly_caps.get("canReadSelection") is True and
               readonly_caps.get("canReplaceSelection") is False and
               readonly_caps.get("reason") == "not-editable", repr(readonly_caps)[:160])
        success, message = call(connection, "Replace", "(ssb)", (current[0], REPLACEMENT, False))
        report('readonly-replace-refused', not success)
        call(connection, 'ReleaseContext', '(s)', (current[0],))
        try:
            call(connection, 'Replace', '(ssb)', (current[0], REPLACEMENT, False))
            released = False
        except GLib.Error:
            released = True
        report('released-context-unusable', released)
    finally:
        stop_fixture(normal)

    password_path = state_path + "-password"
    password = launch_fixture(password_path, password=True)
    try:
        fixture_role, password_marker = focus_fixture_editable(password)
        report("password-fixture-focused", bool(fixture_role), fixture_role)
        context = call(connection, "GetFocusedContext", "(i)", (password.pid,))
        selected = context[1]
        report("password-field-not-captured", password_marker and selected == "" and
               "fixture-secret-must-not-be-read" not in repr(context))
        try:
            password_caps = json.loads(context[9])
        except (IndexError, ValueError):
            password_caps = {}
        report("password-capability-reason", password_caps.get("reason") == "protected-field",
               repr(password_caps)[:160])
    finally:
        stop_fixture(password)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: test-writing-service.py TEST_HOME")
    try:
        main(sys.argv[1])
    except Exception as error:
        print(f"GDI_ATSPI ERROR: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
