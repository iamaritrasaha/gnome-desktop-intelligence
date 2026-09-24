#!/usr/bin/python3
"""Loopback HTTP fixture for nested UI checks; never used in production."""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        prompt = body['messages'][-1]['content']
        time.sleep(3 if 'slow fixture' in prompt else .2)
        try:
            self.send_response(200); self.end_headers()
            # Echo fixture: reply with exactly the marked span, proving what
            # the pipeline actually delivered to the provider.
            marker = 'EchoFixture:'
            if marker in prompt:
                text = prompt.rsplit(marker, 1)[1].strip().splitlines()[0].strip()
            else:
                text = 'Fixture answer. ' * 120 if body.get('stream') else 'selected phrase revised 🌙'
            if body.get('stream') and 'Markdown fixture' in prompt:
                text = '# Attention\n\n- Compare queries and keys.\n- Scale the scores.\n\nUse `softmax` to obtain weights.\n\n```python\nweights = softmax(scores)\n```\n\n[GNOME](https://www.gnome.org/)'
            if body.get('stream') and 'Follow-up fixture' in prompt:
                text = 'The previous answer discussed attention.'
            if body.get('stream'):
                for index in range(0, len(text), 180):
                    self.wfile.write((json.dumps({'done': False, 'message': {'content': text[index:index+180]}})+'\n').encode())
                    self.wfile.flush(); time.sleep(.03)
                self.wfile.write(b'{"done":true,"message":{"content":""}}\n')
            else:
                self.wfile.write(json.dumps({'done': True, 'message': {'content': text}}).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
open(sys.argv[1], 'w').write(str(server.server_port))
server.serve_forever()
