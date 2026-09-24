#!/usr/bin/python3
"""Configurable fixture: counts calls and captures only synthetic QA prompts."""
import json
import sys
import time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root = Path(sys.argv[1]); root.mkdir(exist_ok=True)
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with (root / 'calls.jsonl').open('a') as stream:
            stream.write(json.dumps({'time':time.time(), 'body':body})+'\n')
        control = json.loads((root/'control.json').read_text()) if (root/'control.json').exists() else {}
        text = body['messages'][-1]['content'].removeprefix('Text: ')
        corrected = text.replace('This are', 'This is').replace('recieve','receive').replace('the the','the')
        # Reference case: aux deletion plus irregular verb forms; only the
        # extended deterministic gate algebra can reconstruct this one.
        corrected = corrected.replace(
            'I has went to the market yesterday and buy some apples.',
            'I went to the market yesterday and bought some apples.')
        time.sleep(control.get('delay', .1))
        try:
            self.send_response(control.get('status', 200)); self.end_headers()
            self.wfile.write(json.dumps({'done':True,'message':{'content':json.dumps({'replacement':corrected,'reason':'grammar'})}}).encode())
        except (BrokenPipeError, ConnectionResetError): pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
(root/'port').write_text(str(server.server_port)); server.serve_forever()
