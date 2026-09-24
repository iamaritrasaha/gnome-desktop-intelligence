#!/usr/bin/python3
"""Synthetic real-model benchmark; never reads user documents or retains their text."""
import json
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'service'))
from gi.repository import Gio, GLib
from router import ModelRouter
root=Path(__file__).resolve().parents[1]
source=Gio.SettingsSchemaSource.new_from_directory(str(root/'schemas'),None,False)
schema=source.lookup('org.gnome.shell.extensions.gdi',False)
model=lambda role:schema.get_key('model-'+role).get_default_value().unpack()
router=ModelRouter(); results=[]
cases = [(action, 'standard') for action in ['proofread','rewrite','concise','expand','professional','casual','translate','assistant']] + [('proofread','typo'), ('proofread','punctuation'), ('rewrite','long'), ('proofread','literals'), ('assistant','factual'), ('assistant','followup')]
for action, case in cases:
    selected='We has finished the report. Please review it before Friday.' if action!='assistant' else ''
    question='French' if action=='translate' else 'Explain why attention uses scaling, in 100 words with one heading and a short list.' if action=='assistant' else ''
    if case == 'typo': selected = 'Please recieve the report before Friday.'
    if case == 'punctuation': selected = 'Hello Alex we have finished the report.'
    if case == 'long': selected = ('We has finished the report, and the team has checked each section carefully. The introduction explains the project scope and the methods section describes how the data was collected. The results include three tables, with notes about missing values and the limits of the sample. Please review the figures before Friday and send any corrections to the team. We will prepare the final version after everyone has reviewed their section. The appendix contains the survey questions and a description of the review process.')
    if case == 'literals': selected = 'We has sent https://example.org/report to alex@example.org. Save it at /tmp/report.txt and keep `report_id` unchanged.'
    if case == 'factual': question = 'What is the capital of France? Answer in one sentence.'
    if case == 'followup': question = 'Which country is that city in?'
    history = [{'role':'user','content':'What is the capital of France?'}, {'role':'assistant','content':'Paris.'}] if case == 'followup' else []
    loop=GLib.MainLoop(); start=time.monotonic(); first=[]; result=[]
    def chunk(text):
        if not first: first.append(round((time.monotonic()-start)*1000))
    def done(text,error): result.append((text,str(error) if error else None)); loop.quit()
    router.run(action=action,selected=selected,context='',question=question,provider_name='ollama',
        endpoint='http://127.0.0.1:11434',quick_model=model('quick-writing'),intent_model='',
        assistant_model=model('assistant'),reasoning_model=model('reasoning'),cancellable=Gio.Cancellable(),
        callback=done,history=history,on_chunk=chunk if action=='assistant' else None,timeout=120,output_tokens=512)
    if not result: loop.run()
    record=dict(action=action,case=case,model=model('assistant' if action=='assistant' else 'quick-writing'),
                first_token_ms=first[0] if first else None,total_ms=round((time.monotonic()-start)*1000),
                response=result[0][0],error=result[0][1])
    results.append(record); print(json.dumps(record),flush=True)
(root/'build/validation/phase35-real-models.json').write_text(json.dumps(results,indent=2))
assert all(not r['error'] for r in results), results
