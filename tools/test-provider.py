#!/usr/bin/python3
"""Provider/router integration: real libsoup I/O, controlled HTTP failures, optional local models."""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'service'))
from gi.repository import Gio, GLib
from providers.ollama import OllamaProvider
from router import ModelRouter

class Fixture(BaseHTTPRequestHandler):
    mode = 'ok'
    requests = []
    def log_message(self, *_):
        pass
    def do_GET(self):
        self.reply({'models': [] if self.mode == 'empty' else [{'name': 'fixture'}]})
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.requests.append(payload)
        if self.mode == 'slow':
            time.sleep(8)
        if self.mode == 'http':
            self.send_response(404); self.end_headers(); return
        if self.mode == 'oversize':
            self.reply({'x': 'x' * 300000}); return
        if self.mode == 'invalid':
            self.reply({'unexpected': True}); return
        if self.mode == 'protected':
            self.reply({'message': {'content': 'Corrupted URL'}, 'done': True}); return
        self.reply({'message': {'content': 'A usable fixture response.'}, 'done': True})
    def reply(self, payload):
        try:
            self.send_response(200); self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass


def await_result(start, cancel_after=None):
    loop = GLib.MainLoop()
    cancel = Gio.Cancellable()
    result = []
    tick = [0]
    def heartbeat():
        tick[0] += 1
        return GLib.SOURCE_CONTINUE
    ticker = GLib.timeout_add(20, heartbeat)
    def done(value, error):
        result.append((value, error))
        loop.quit()
    start(cancel, done)
    if cancel_after:
        GLib.timeout_add(cancel_after, lambda: (cancel.cancel(), GLib.SOURCE_REMOVE)[1])
    guard = GLib.timeout_add_seconds(180, lambda: (loop.quit(), GLib.SOURCE_REMOVE)[1])
    if not result:
        loop.run()
    GLib.source_remove(ticker)
    GLib.source_remove(guard)
    assert len(result) == 1, result
    return *result[0], tick[0]

provider = OllamaProvider()
server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
endpoint = f'http://127.0.0.1:{server.server_port}'
def generate(cancel, done):
    provider.generate(endpoint=endpoint, model='fixture', system='Fixture', prompt='Fixture',
                      cancellable=cancel, callback=done, timeout=5)
for mode in ('ok', 'http', 'oversize', 'invalid', 'slow'):
    Fixture.mode = mode
    value, error, ticks = await_result(generate)
    assert bool(error) == (mode != 'ok'), (mode, value, error)
    if mode == 'slow':
        assert 'timed out' in str(error) and ticks > 30
    print(f'PROVIDER {mode}: PASS', flush=True)
value, error, ticks = await_result(generate, 100)
assert error and 'cancelled' in str(error) and ticks >= 3
print('PROVIDER cancellation and responsive event loop: PASS', flush=True)
for mode in ('ok', 'empty'):
    Fixture.mode = mode
    value, error, _ = await_result(lambda c, d: provider.health(endpoint=endpoint, cancellable=c, callback=d))
    assert not error and value['available'] and bool(value['models']) == (mode == 'ok')
print('PROVIDER health/model discovery/empty inventory: PASS', flush=True)
server.shutdown(); server.server_close()
value, error, _ = await_result(lambda c, d: provider.health(endpoint=endpoint, cancellable=c, callback=d))
assert error
print('PROVIDER stopped endpoint: PASS', flush=True)

if '--real' in sys.argv:
    endpoint = 'http://127.0.0.1:11434'
    value, error, _ = await_result(lambda c, d: provider.health(endpoint=endpoint, cancellable=c, callback=d))
    assert not error, error
    models = value['models']
    print('REAL discovered:', ', '.join(models), flush=True)
    source = Gio.SettingsSchemaSource.new_from_directory(str(Path(__file__).resolve().parents[1] / 'schemas'), Gio.SettingsSchemaSource.get_default(), False)
    schema = source.lookup('org.gnome.shell.extensions.gdi', False)
    model = lambda key: schema.get_key('model-' + key).get_default_value().unpack()
    router = ModelRouter()
    for action in ('proofread', 'rewrite', 'concise', 'expand', 'professional', 'casual', 'translate', 'summarize', 'explain', 'ask', 'assistant', 'harder'):
        question = 'French' if action == 'translate' else 'What is the main point?'
        selected = 'We has completed the report. Please review it before Friday.'
        if action in ('assistant', 'harder'):
            selected = ''; question = 'Explain why the sky looks blue in two sentences.'
        value, error, ticks = await_result(lambda c, d: router.run(
            action=action, selected=selected, context='', question=question,
            provider_name='ollama', endpoint=endpoint, quick_model=model('quick-writing'),
            intent_model=model('intent-routing'), assistant_model=model('assistant'), reasoning_model=model('reasoning'),
            cancellable=c, callback=d, output_tokens=512, timeout=150))
        # A real small model occasionally answers with commentary, omissions or
        # rewrites. The deterministic gate must refuse those; that outcome is a
        # pass for this suite. Only transport or unexpected errors are failures.
        conservative = ('commentary', 'changed too much', 'omitted too much',
                        'correction rewrote too much', 'protected URL',
                        'did not preserve a protected token', 'no replacement')
        if error and any(text in str(error) for text in conservative):
            print(f'REAL {action}: gate refused a low-quality model response (correct)', flush=True)
            continue
        assert not error, (action, error)
        print(f'REAL {action}: {value}', flush=True)
