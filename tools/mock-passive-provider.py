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
        schema = body.get('format') or {}
        if isinstance(schema, dict) and 'continuation' in schema.get('properties', {}):
            # Predictive writing: structured continuation for the typed prefix.
            reply = json.dumps({'continuation': control.get(
                'continuation',
                ' that it keeps the model layer separate from the desktop integration.')})
            delay = control.get('prediction_delay', .15)
        else:
            text = body['messages'][-1]['content'].removeprefix('Text: ')
            corrected = text.replace('This are', 'This is').replace('recieve','receive').replace('the the','the')
            # Reference case: aux deletion plus irregular verb forms; only the
            # extended deterministic gate algebra can reconstruct this one.
            corrected = corrected.replace(
                'I has went to the market yesterday and buy some apples.',
                'I went to the market yesterday and bought some apples.')
            reply = json.dumps({'replacement':corrected,'reason':'grammar'})
            delay = control.get('delay', .1)
        time.sleep(delay)
        try:
            self.send_response(control.get('status', 200)); self.end_headers()
            self.wfile.write(json.dumps({'done':True,'message':{'content':reply}}).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
(root/'port').write_text(str(server.server_port)); server.serve_forever()
