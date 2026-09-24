#!/usr/bin/python3
"""Real Soup/NDJSON transport: chunk boundaries, failures, cancellation and recovery."""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'service'))
from gi.repository import Gio, GLib
from providers.ollama import OllamaProvider

class Fixture(BaseHTTPRequestHandler):
    mode = 'ok'
    def log_message(self, *_): pass
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert payload['stream'] and payload['keep_alive'] == 0
        mode = self.mode
        self.send_response(503 if mode == 'http' else 200); self.end_headers()
        if mode == 'http': return
        try:
            for text in (['bad\0text'] if mode == 'control' else ['Hello ', 'café 🌙', '\n\n# Heading\n- Item\n```python\nprint(1)\n```']):
                raw = (json.dumps({'message': {'content': text}, 'done': False}, ensure_ascii=False)+'\n').encode()
                for byte in raw: self.wfile.write(bytes([byte]))
                self.wfile.flush(); time.sleep(.06 if mode != 'slow' else 2)
            if mode == 'malformed': self.wfile.write(b'{bad}\n')
            elif mode != 'truncated': self.wfile.write(b'{"message":{"content":""},"done":true}\n')
        except (BrokenPipeError, ConnectionResetError): pass

provider = OllamaProvider()
server = ThreadingHTTPServer(('127.0.0.1',0), Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
endpoint = f'http://127.0.0.1:{server.server_port}'
for mode in ('ok','malformed','truncated','control','http','slow','ok'):
    Fixture.mode = mode
    loop = GLib.MainLoop(); cancel = Gio.Cancellable(); chunks = []; results = []; ticks = []
    timer = GLib.timeout_add(10, lambda: (ticks.append(1), GLib.SOURCE_CONTINUE)[1])
    start = time.monotonic()
    def done(text, error): results.append((text,error)); loop.quit()
    def chunk(text): chunks.append((time.monotonic(), text))
    provider.generate(endpoint=endpoint,model='fixture',system='fixture',prompt='fixture',cancellable=cancel,
                      callback=done,on_chunk=chunk,timeout=5)
    if mode == 'slow': GLib.timeout_add(100, lambda: (cancel.cancel(), GLib.SOURCE_REMOVE)[1])
    loop.run(); GLib.source_remove(timer)
    assert len(results) == 1
    value, error = results[0]
    assert bool(error) == (mode != 'ok'), (mode, value, error)
    if mode == 'ok':
        assert 'café 🌙' in value and ''.join(c[1] for c in chunks) == value
        assert len(ticks) >= 10 and chunks[0][0] < time.monotonic() - .08
    if mode == 'slow': assert time.monotonic()-start < .5 and 'cancelled' in str(error)
    print('STREAM', mode, 'PASS', flush=True)
server.shutdown(); server.server_close()
