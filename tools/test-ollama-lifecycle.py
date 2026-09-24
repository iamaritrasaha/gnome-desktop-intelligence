#!/usr/bin/python3
"""Start/stop an isolated empty Ollama instance, leaving the user's daemon alone."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'service'))
from gi.repository import Gio, GLib
from providers.ollama import OllamaProvider
provider = OllamaProvider()
with socket.socket() as port_socket:
    port_socket.bind(('127.0.0.1', 0)); port = port_socket.getsockname()[1]
endpoint = f'http://127.0.0.1:{port}'
def health():
    result = []
    loop = GLib.MainLoop()
    def done(value, error):
        result.append((value, error)); loop.quit()
    provider.health(endpoint=endpoint, cancellable=Gio.Cancellable(), callback=done)
    if not result: loop.run()
    return result[0]
assert health()[1]
with tempfile.TemporaryDirectory(prefix='gdi-ollama-') as root:
    with open(Path(root) / 'server.log', 'w') as log:
        server = subprocess.Popen(['ollama', 'serve'], env={**os.environ,
            'OLLAMA_HOST': f'127.0.0.1:{port}', 'OLLAMA_MODELS': root + '/models',
            'HOME': root}, stdout=log, stderr=log)
        try:
            for _ in range(50):
                value, error = health()
                if not error: break
                assert server.poll() is None, 'isolated Ollama failed to start'
                time.sleep(.1)
            assert not error and value == {'available': True, 'models': []}, (value, error)
            print('OLLAMA isolated start and empty model discovery: PASS')
        finally:
            server.terminate(); server.wait(timeout=10)
    assert health()[1]
    print('OLLAMA isolated stop detected gracefully: PASS')
