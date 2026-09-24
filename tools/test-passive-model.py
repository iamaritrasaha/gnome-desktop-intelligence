#!/usr/bin/python3
"""Bounded real-provider checks with synthetic sentences; no user settings writes."""
import json
from pathlib import Path
import sys
import time
import gi
from gi.repository import Gio, GLib
root=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(root/'service'))
from router import ModelRouter
from quality import quality
schema=Gio.SettingsSchemaSource.new_from_directory(str(root/'schemas'),None,False)
settings=Gio.Settings.new_full(schema.lookup('org.gnome.shell.extensions.gdi',False),None,None)
router=ModelRouter(); reports=[]
for text in ('This are a useful sentence.', 'Please recieve the report.', 'We have the the report.'):
    loop=GLib.MainLoop(); started=time.monotonic()
    def done(response,error):
        checked=quality(text,response) if response and not error else None
        reports.append(dict(source=text, response=response, accepted=bool(checked), error=str(error) if error else None, latency_ms=round((time.monotonic()-started)*1000)))
        loop.quit()
    router.run_passive(text,settings,Gio.Cancellable(),done); loop.run()
print(json.dumps(reports,indent=2))
assert all(not row['error'] and isinstance(json.loads(row['response']).get('replacement'), str) for row in reports)
assert sum(row['accepted'] for row in reports) >= 2, 'Quick model did not provide usable corrections on this small smoke sample'
