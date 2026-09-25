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
        # Residency preloads (/api/generate without messages) are legitimate
        # lifecycle traffic in nested tests: acknowledge without generating.
        if 'messages' not in body:
            self.send_response(200); self.end_headers()
            self.wfile.write(json.dumps({'done': True, 'message': {'content': ''}}).encode())
            return
        prompt = body['messages'][-1]['content']
        time.sleep(3 if 'slow fixture' in prompt else .2)
        try:
            self.send_response(200); self.end_headers()
            # Echo fixture: reply with exactly the marked span, proving what
            # the pipeline actually delivered to the provider. Checked first:
            # quoted conversation history may legitimately contain the other
            # fixture keywords below.
            # Fixture keywords must match the actual request (the prompt's
            # first line), never the quoted conversation history that follows.
            first_line = prompt.splitlines()[0] if prompt else ''
            marker = 'EchoFixture:'
            if marker in prompt:
                text = prompt.rsplit(marker, 1)[1].strip().splitlines()[0].strip()
            elif 'Markdown fixture' in first_line and body.get('stream'):
                text = '# Attention\n\n- Compare queries and keys.\n- Scale the scores.\n\nUse `softmax` to obtain weights.\n\n```python\nweights = softmax(scores)\n```\n\n[GNOME](https://www.gnome.org/)'
            elif 'Follow-up fixture' in first_line and body.get('stream'):
                text = 'The previous answer discussed attention.'
            else:
                text = 'Fixture answer. ' * 120 if body.get('stream') else 'selected phrase revised 🌙'
            # Debug aid: log the matching decision for nested-probe triage.
            try:
                entry = {'at': round(time.time(), 3), 'first_line': first_line[:120],
                         'stream': bool(body.get('stream')),
                         'returned': text[:60], 'echo_marker': marker in prompt}
                log_path = sys.argv[1] + '.requests.json'
                try:
                    with open(log_path) as sink:
                        log = json.load(sink)
                except Exception:
                    log = []
                log.append(entry)
                with open(log_path, 'w') as sink:
                    json.dump(log[-60:], sink)
            except Exception:
                pass
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
