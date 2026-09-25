#!/usr/bin/env python3
"""Live model-residency validation: real service, real local Ollama.

Runs the actual GDI service against the configured local Ollama on a private
D-Bus session with a disposable HOME, then proves the residency policy
end-to-end:

* the first assistant request is cold (Ollama reports a load duration),
* an immediate second request is warm (load ≈ 0) and answers faster,
* the model is resident afterwards per /api/ps with a bounded expiry,
* PrewarmModel loads the assistant model without generating,
* RouteAction reuses the warm quick model,
* after the keep_alive window passes the model is gone again (no polling,
  no forced unload — Ollama's own expiry).

Expectations print as GDI_RESIDENCY_LIVE lines. Requires the configured
models to exist on the local Ollama endpoint.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUS_NAME = "org.gnome.DesktopIntelligence1"
OBJECT_PATH = "/org/gnome/DesktopIntelligence1"
INTERFACE = "org.gnome.DesktopIntelligence1"
STAGE_ENV = "GDI_RESIDENCY_LIVE_STAGE"


def ps(endpoint):
    with urllib.request.urlopen(endpoint.rstrip('/') + '/api/ps', timeout=5) as response:
        return json.loads(response.read().decode())


def wait_service(bus, timeout=20):
    import gi
    from gi.repository import Gio, GLib
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "NameHasOwner", GLib.Variant("(s)", (BUS_NAME,)),
                None, Gio.DBusCallFlags.NONE, 1000, None)
            if result.unpack()[0]:
                return
        except Exception:
            pass
        time.sleep(0.1)
    raise RuntimeError("GDI service did not start")


def run(endpoint, assistant_model, quick_model, warm_seconds):
    import gi
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    wait_service(bus)
    results = []

    def check(name, ok):
        results.append((name, bool(ok)))
        print(f"GDI_RESIDENCY_LIVE {name}={'PASS' if ok else 'FAIL'}")

    def call(method, signature, args, timeout=120000):
        return bus.call_sync(BUS_NAME, OBJECT_PATH, INTERFACE, method,
            GLib.Variant(signature, args), None, Gio.DBusCallFlags.NONE,
            timeout, None).unpack()

    # Make sure the assistant model starts cold.
    urllib.request.urlopen(urllib.request.Request(
        endpoint.rstrip('/') + '/api/generate',
        data=json.dumps({'model': assistant_model, 'keep_alive': 0}).encode(),
        headers={'Content-Type': 'application/json'}), timeout=30)

    def ask(question, timeout=5):
        token = 'live-' + str(time.monotonic_ns())
        started = time.monotonic()
        reply = call("Transform", "(sssssssssssiii)", (
            token, 'assistant', '', '', question, 'ollama', endpoint,
            quick_model, quick_model, assistant_model, assistant_model,
            timeout, 8192, 256))
        return time.monotonic() - started, reply[0]

    first_total, _ = ask('What is the capital of France? Answer in one word.')
    second_total, _ = ask('What is the capital of Italy? Answer in one word.')

    stats = json.loads(call("RequestStats", "()", [])[0])
    assistant_records = [r for r in stats.get('recent', [])
                         if r.get('action') == 'assistant' and r.get('status') == 'complete']
    check('assistant-requests-recorded', len(assistant_records) >= 2)
    cold = [r for r in assistant_records if r.get('cold')]
    warm = [r for r in assistant_records if not r.get('cold')]
    check('first-request-cold', len(cold) >= 1)
    check('second-request-warm', len(warm) >= 1)
    check('warm-total-faster-than-cold', second_total < first_total)

    resident = ps(endpoint).get('models', [])
    names = [m.get('model') or m.get('name') for m in resident]
    check('assistant-resident-after-use', assistant_model in names)
    entry = next((m for m in resident if (m.get('model') or m.get('name')) == assistant_model), None)
    check('resident-has-vram-and-expiry', bool(entry) and
          entry.get('size_vram', 0) > 0 and bool(entry.get('expires_at')))

    status = json.loads(call("ResidencyStatus", "()", [])[0])
    check('residency-status-assistant-warm',
          status.get('roles', {}).get('assistant', {}).get('resident') is True)

    # Prewarm: unload, then verify PrewarmModel loads it without generating.
    urllib.request.urlopen(urllib.request.Request(
        endpoint.rstrip('/') + '/api/generate',
        data=json.dumps({'model': assistant_model, 'keep_alive': 0}).encode(),
        headers={'Content-Type': 'application/json'}), timeout=30)
    initiated = call("PrewarmModel", "(s)", ('assistant',))[0] is True
    loaded = False
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if any((m.get('model') or m.get('name')) == assistant_model
               for m in ps(endpoint)['models']):
            loaded = True
            break
        time.sleep(1)
    check('prewarm-loads-assistant', initiated and loaded)

    # Routing model: two RouteAction calls, the second on the warm quick model.
    registry = json.dumps([{"id": "audio.setVolume", "description": "Set output volume"}])
    started = time.monotonic()
    call("RouteAction", "(ss)",
         ('volume EchoFixture:{"action":"audio.setVolume","args":{"percent":30}}', registry),
         60000)
    routing_cold = time.monotonic() - started
    started = time.monotonic()
    call("RouteAction", "(ss)",
         ('volume EchoFixture:{"action":"audio.setVolume","args":{"percent":40}}', registry),
         60000)
    routing_warm = time.monotonic() - started
    check('routing-reuses-warm-quick-model', routing_warm <= routing_cold)

    # Bounded expiry: Ollama itself expires the model; nothing GDI does keeps
    # it forever. Keep the wait bounded for CI (default 45 s + margin).
    deadline = time.monotonic() + warm_seconds + 30
    while time.monotonic() < deadline:
        names = [m.get('model') or m.get('name') for m in ps(endpoint)['models']]
        if assistant_model not in names:
            break
        time.sleep(2)
    check('assistant-expires-after-warm-window', assistant_model not in names)

    failed = [name for name, ok in results if not ok]
    if failed:
        print(f"GDI_RESIDENCY_LIVE failures={len(failed)}: {', '.join(failed)}",
              file=sys.stderr)
        sys.exit(1)
    print('GDI_RESIDENCY_LIVE residency lifecycle: PASS')


def main():
    if STAGE_ENV in os.environ:
        run(os.environ['GDI_LIVE_ENDPOINT'],
            os.environ['GDI_LIVE_ASSISTANT'], os.environ['GDI_LIVE_QUICK'],
            int(os.environ.get('GDI_LIVE_WARM_SECONDS', '50')))
        return
    tmp = tempfile.mkdtemp(prefix='gdi-residency-live-')
    home = Path(tmp) / 'home'
    (home / '.config').mkdir(parents=True)
    env = {**os.environ, STAGE_ENV: '1', 'HOME': str(home),
           'XDG_DATA_HOME': str(home / '.local' / 'share'),
           'XDG_CONFIG_HOME': str(home / '.config'),
           'GSETTINGS_SCHEMA_DIR': str(ROOT / 'schemas')}
    endpoint = 'http://127.0.0.1:11434'
    try:
        env['GDI_LIVE_ENDPOINT'] = endpoint
        env['GDI_LIVE_ASSISTANT'] = 'qwen3.5:4b'
        env['GDI_LIVE_QUICK'] = 'LiquidAI/lfm2.5-1.2b-instruct:q4_k_m'
        env['GDI_LIVE_WARM_SECONDS'] = os.environ.get('GDI_RESIDENCY_WARM_WAIT', '50')
        script = (
            "gsettings set org.gnome.shell.extensions.gdi model-endpoint "
            f"'\''{endpoint}'\''\n"
            f"python3 {ROOT / 'service' / 'gdi-service.py'} > {tmp}/service.log 2>&1 &\n"
            "SERVICE=$!\n"
            f"python3 {Path(__file__).resolve()} --stage\n"
            "STATUS=$?\n"
            "kill $SERVICE 2>/dev/null || true\n"
            "exit $STATUS")
        result = subprocess.run(['dbus-run-session', '--', 'bash', '-ec', script],
                                env=env, timeout=420)
        sys.exit(result.returncode)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
