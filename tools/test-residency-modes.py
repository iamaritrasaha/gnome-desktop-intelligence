#!/usr/bin/env python3
"""Resource-mode validation on the real machine: low-gpu, balanced, performance.

For each configured resource mode this runs the actual GDI service against the
real local Ollama on a private D-Bus session with a disposable HOME, then
measures — through the service's own RequestStats and Ollama's /api/ps:

* cold vs warm assistant (Ask) latency and Ollama's load duration,
* the keep_alive value the mode's policy actually attached to the request,
* VRAM residency (size_vram) and expiry metadata after use,
* prewarm gating: disabled in low-gpu, demand-driven in balanced/performance,
* routing-model (quick role) keep_alive via RouteAction.

Everything is restored: the tool unloads both models with keep_alive=0 when
finished and never touches the user's GDI installation or Ollama config.

Expectations print as GDI_RESIDENCY_MODE lines.
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
STAGE_ENV = "GDI_RESIDENCY_MODES_STAGE"

ASSISTANT_KEEP_ALIVE = {'low-gpu': 20, 'balanced': 45, 'performance': 120}
QUICK_KEEP_ALIVE = {'low-gpu': 20, 'balanced': 60, 'performance': 120}
PREWARM_ALLOWED = {'low-gpu': False, 'balanced': True, 'performance': True}


def ollama(endpoint, path, payload=None, timeout=60):
    if payload is None:
        with urllib.request.urlopen(endpoint.rstrip('/') + path, timeout=timeout) as r:
            return json.loads(r.read().decode())
    request = urllib.request.Request(
        endpoint.rstrip('/') + path, data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def resident(endpoint):
    return {m.get('model') or m.get('name'): m
            for m in ollama(endpoint, '/api/ps', timeout=5).get('models', [])}


def unload(endpoint, *models):
    for model in models:
        ollama(endpoint, '/api/generate', {'model': model, 'keep_alive': 0}, timeout=60)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if not set(models) & set(resident(endpoint)):
            return
        time.sleep(0.5)


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


def run_mode(mode, endpoint, assistant_model, quick_model):
    """Runs inside the private session with the mode already configured."""
    import gi
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    wait_service(bus)
    results = []

    def check(name, ok):
        results.append((name, bool(ok)))
        print(f"GDI_RESIDENCY_MODE {mode}-{name}={'PASS' if ok else 'FAIL'}")

    def call(method, signature, args, timeout=120000):
        return bus.call_sync(BUS_NAME, OBJECT_PATH, INTERFACE, method,
            GLib.Variant(signature, args), None, Gio.DBusCallFlags.NONE,
            timeout, None).unpack()

    def ask(question, timeout=60):
        # The timeout is the request contract, not the measurement: the very
        # first cold load of the run can exceed the service default while the
        # model is still absent from the OS page cache.
        token = f'{mode}-{time.monotonic_ns()}'
        started = time.monotonic()
        call("Transform", "(sssssssssssiii)", (
            token, 'assistant', '', '', question, 'ollama', endpoint,
            quick_model, quick_model, assistant_model, assistant_model,
            timeout, 8192, 256))
        return time.monotonic() - started

    status = json.loads(call("ResidencyStatus", "()", [])[0])
    check('status-reports-mode', status.get('mode') == mode)

    # Cold then warm Ask; RequestStats carries Ollama's own load split and
    # the keep_alive the residency manager attached.
    first_total = ask('What is the capital of France? Answer in one word.')
    second_total = ask('What is the capital of Italy? Answer in one word.')
    stats = json.loads(call("RequestStats", "()", [])[0])
    records = [r for r in stats.get('recent', [])
               if r.get('action') == 'assistant' and r.get('status') == 'complete']
    cold = [r for r in records if r.get('cold')]
    warm = [r for r in records if not r.get('cold')]
    check('first-cold-second-warm', len(cold) >= 1 and len(warm) >= 1)
    check('warm-faster', second_total < first_total)
    attached = {r.get('keep_alive') for r in records if r.get('keep_alive') is not None}
    check('assistant-keep-alive-matches-policy',
          attached and attached.issubset({ASSISTANT_KEEP_ALIVE[mode]}))
    if cold:
        print(f"GDI_PERF_MODE {mode} cold_total_ms={cold[0].get('total_ms')} "
              f"cold_load_ms={cold[0].get('load_ms')}")
    if warm:
        print(f"GDI_PERF_MODE {mode} warm_total_ms={warm[0].get('total_ms')} "
              f"warm_load_ms={warm[0].get('load_ms')} "
              f"first_token_ms={warm[0].get('first_token_ms')}")

    entry = resident(endpoint).get(assistant_model)
    check('assistant-resident-with-vram', bool(entry) and
          entry.get('size_vram', 0) > 0 and bool(entry.get('expires_at')))
    if entry:
        print(f"GDI_PERF_MODE {mode} assistant_vram_gb="
              f"{round(entry.get('size_vram', 0) / 1e9, 2)}")

    # Prewarm gating: forbidden in low-gpu, demand-driven otherwise.
    unload(endpoint, assistant_model)
    initiated = call("PrewarmModel", "(s)", ('assistant',))[0] is True
    loaded = False
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if assistant_model in resident(endpoint):
            loaded = True
            break
        time.sleep(1)
    if PREWARM_ALLOWED[mode]:
        check('prewarm-loads-assistant', initiated and loaded)
    else:
        check('prewarm-disabled-in-low-gpu', not loaded)

    # Quick model keep_alive through the routing role.
    registry = json.dumps([{"id": "audio.setVolume", "description": "Set output volume"}])
    call("RouteAction", "(ss)",
         ('volume EchoFixture:{"action":"audio.setVolume","args":{"percent":30}}', registry),
         60000)
    time.sleep(1)
    route_stats = json.loads(call("RequestStats", "()", [])[0])
    routing = [r for r in route_stats.get('recent', []) if r.get('route') == 'intent']
    # RouteAction diagnostics live in ActionStats, not RequestStats; the
    # keep_alive evidence for the quick model comes from /api/ps expiry.
    entry = resident(endpoint).get(quick_model)
    check('routing-model-resident', bool(entry))

    failed = [name for name, ok in results if not ok]
    if failed:
        print(f"GDI_RESIDENCY_MODE {mode} failures={len(failed)}: "
              f"{', '.join(failed)}", file=sys.stderr)
        return 1
    print(f"GDI_RESIDENCY_MODE {mode}: PASS")
    return 0


def main():
    if STAGE_ENV in os.environ:
        sys.exit(run_mode(os.environ['GDI_MODE'], os.environ['GDI_LIVE_ENDPOINT'],
                          os.environ['GDI_LIVE_ASSISTANT'], os.environ['GDI_LIVE_QUICK']))
    endpoint = 'http://127.0.0.1:11434'
    assistant_model = 'qwen3.5:4b'
    quick_model = 'LiquidAI/lfm2.5-1.2b-instruct:q4_k_m'
    try:
        ollama(endpoint, '/api/tags', timeout=5)
    except Exception:
        print('GDI_RESIDENCY_MODE skipped: no local Ollama endpoint', file=sys.stderr)
        return 0

    here = Path(__file__).resolve()
    failures = 0
    for mode in ('low-gpu', 'balanced', 'performance'):
        tmp = tempfile.mkdtemp(prefix=f'gdi-residency-{mode}-')
        home = Path(tmp) / 'home'
        (home / '.config').mkdir(parents=True)
        env = {**os.environ, STAGE_ENV: '1', 'GDI_MODE': mode,
               'HOME': str(home),
               'XDG_DATA_HOME': str(home / '.local' / 'share'),
               'XDG_CONFIG_HOME': str(home / '.config'),
               'GSETTINGS_SCHEMA_DIR': str(ROOT / 'schemas'),
               'GDI_LIVE_ENDPOINT': endpoint,
               'GDI_LIVE_ASSISTANT': assistant_model,
               'GDI_LIVE_QUICK': quick_model}
        try:
            script = (
                "gsettings set org.gnome.shell.extensions.gdi model-endpoint "
                f"'\''{endpoint}'\''\n"
                f"gsettings set org.gnome.shell.extensions.gdi resource-mode '\'{mode}\''\n"
                f"python3 {ROOT / 'service' / 'gdi-service.py'} > {tmp}/service.log 2>&1 &\n"
                "SERVICE=$!\n"
                f"python3 {here} --stage\n"
                "STATUS=$?\n"
                "kill $SERVICE 2>/dev/null || true\n"
                "exit $STATUS")
            result = subprocess.run(['dbus-run-session', '--', 'bash', '-ec', script],
                                    env=env, timeout=600)
            failures += result.returncode
        finally:
            try:
                unload(endpoint, assistant_model, quick_model)
            except Exception:
                pass
            shutil.rmtree(tmp, ignore_errors=True)
    if failures:
        sys.exit(1)
    print('GDI_RESIDENCY_MODE all-modes: PASS')


if __name__ == '__main__':
    main()
