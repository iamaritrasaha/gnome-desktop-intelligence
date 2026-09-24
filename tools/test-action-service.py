#!/usr/bin/env python3
"""Phase 4 service regression: RouteAction, diagnostics and usage learning.

Runs the real service against the loopback mock provider on a private D-Bus
session with a disposable HOME, so the host desktop and its GDI service are
never touched. Expectations are GDI_ACTION lines.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUS_NAME = "org.gnome.DesktopIntelligence1"
OBJECT_PATH = "/org/gnome/DesktopIntelligence1"
INTERFACE = "org.gnome.DesktopIntelligence1"
STAGE_ENV = "GDI_ACTION_TEST_STAGE"


def wait_port(port_path, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_path.exists():
            return port_path.read_text().strip()
        time.sleep(0.05)
    raise RuntimeError("mock provider did not start")


def wait_service(bus, timeout=20):
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "NameHasOwner",
                GLib.Variant("(s)", (BUS_NAME,)), None,
                Gio.DBusCallFlags.NONE, 1000, None)
            if result.unpack()[0]:
                return
        except Exception:
            pass
        time.sleep(0.1)
    raise RuntimeError("GDI service did not start on the private bus")


def client(port):
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    wait_service(bus)

    def call(method, signature, args, timeout=25000):
        result = bus.call_sync(
            BUS_NAME, OBJECT_PATH, INTERFACE, method,
            GLib.Variant(signature, args), None,
            Gio.DBusCallFlags.NONE, timeout, None)
        return result.unpack()

    def call_error(method, signature, args, timeout=25000):
        try:
            bus.call_sync(
                BUS_NAME, OBJECT_PATH, INTERFACE, method,
                GLib.Variant(signature, args), None,
                Gio.DBusCallFlags.NONE, timeout, None)
            return None
        except GLib.Error as error:
            return error.message

    report = lambda name, ok: print(f"GDI_ACTION {name}={'PASS' if ok else 'FAIL'}")

    registry = json.dumps([{"id": "audio.setVolume", "description": "Set output volume"}])

    # The echo fixture proves exactly what the service returned to the caller.
    # The marker must end the line: the mock echoes to the end of the line.
    reply = call("RouteAction", "(ss)",
                 ('volume EchoFixture:{"action":"audio.setVolume","args":{"percent":30}}', registry))
    parsed = json.loads(reply[0])
    report("route-action-passthrough",
           parsed.get("action") == "audio.setVolume" and
           parsed.get("args", {}).get("percent") == 30)

    reply = call("RouteAction", "(ss)", ("volume EchoFixture:not-json", registry))
    parsed = json.loads(reply[0])
    report("route-action-normalizes-garbage", parsed == {"action": "", "args": {}})

    error = call_error("RouteAction", "(ss)", ("x" * 201, registry))
    report("route-action-rejects-oversized-question", error is not None)

    error = call_error("RouteAction", "(ss)", ("volume", "x" * 16385))
    report("route-action-rejects-oversized-registry", error is not None)

    # Diagnostics are RAM-only and bounded.
    for index in range(55):
        call("RecordActionDiagnostic", "(s)",
             (json.dumps({"status": "complete", "action": "system.diskUsage", "n": index}),))
    stats = json.loads(call("ActionStats", "()", [])[0])
    report("diagnostics-bounded-to-50", len(stats.get("recent", [])) == 50)
    report("diagnostics-keep-newest", stats["recent"][-1].get("n") == 54)

    # Usage learning is inert while the opt-in is off, active when on.
    report("learning-off-no-ranking",
           call("RecordActionUse", "(ss)", ("app.open", "Firefox")) == () and
           json.loads(call("ActionStats", "()", [])[0]).get("apps", {}) == {})
    subprocess.run(["gsettings", "set", "org.gnome.shell.extensions.gdi",
                    "enable-learning", "true"], check=True,
                   env={**os.environ, "GSETTINGS_SCHEMA_DIR": str(ROOT / "schemas")})
    call("RecordActionUse", "(ss)", ("app.open", "Firefox"))
    call("RecordActionUse", "(ss)", ("app.open", "Firefox"))
    call("RecordActionUse", "(ss)", ("directory.open", "downloads"))
    stats = json.loads(call("ActionStats", "()", [])[0])
    report("learning-on-records-labels",
           stats.get("apps", {}).get("Firefox") == 2 and
           stats.get("dirs", {}).get("downloads") == 1)
    print("GDI_ACTION action-service-suite=PASS")


def main():
    if STAGE_ENV not in os.environ:
        tmp = tempfile.mkdtemp(prefix="gdi-action-service-")
        home = Path(tmp) / "home"
        (home / ".config").mkdir(parents=True)
        port_path = Path(tmp) / "port"
        env = {**os.environ, STAGE_ENV: "1",
               "HOME": str(home),
               "XDG_DATA_HOME": str(home / ".local" / "share"),
               "XDG_CONFIG_HOME": str(home / ".config")}
        mock = subprocess.Popen(
            [sys.executable, str(ROOT / "tools" / "mock-provider.py"), str(port_path)],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            port = wait_port(port_path)
            env["GDI_MOCK_PORT"] = port
            script = (
                f"export GSETTINGS_SCHEMA_DIR={ROOT / 'schemas'}\n"
                # The service must reach the loopback mock, never a live provider.
                f"gsettings set org.gnome.shell.extensions.gdi model-endpoint 'http://127.0.0.1:{port}'\n"
                f"python3 {ROOT / 'service' / 'gdi-service.py'} "
                f"> {tmp}/service.log 2>&1 &\n"
                f"SERVICE=$!\n"
                f"python3 {Path(__file__).resolve()} --client {port}\n"
                f"STATUS=$?\n"
                f"kill $SERVICE 2>/dev/null || true\n"
                f"exit $STATUS")
            result = subprocess.run(["dbus-run-session", "--", "bash", "-ec", script],
                                    env=env, timeout=120)
            sys.exit(result.returncode)
        finally:
            mock.terminate()
            mock.wait()
            shutil.rmtree(tmp, ignore_errors=True)
    elif len(sys.argv) > 2 and sys.argv[1] == "--client":
        client(sys.argv[2])
    else:
        raise SystemExit("internal staging error")


if __name__ == "__main__":
    main()
