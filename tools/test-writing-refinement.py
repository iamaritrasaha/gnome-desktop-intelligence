#!/usr/bin/python3
"""Explicit prompt distinctions, literal/output gates, and inspectable learning."""
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'service'))
from router import ModelRouter
from learning import LearningStore
class Recorder:
    def generate(self, **args): self.args = args
recorder = Recorder(); router = ModelRouter(); router._providers['fixture'] = recorder
base = dict(selected='Please recieve the report at https://example.org by email a@b.org or /tmp/report.', context='',
            question='', provider_name='fixture', endpoint='', quick_model='quick', intent_model='',
            assistant_model='general', reasoning_model='hard', cancellable=None)
def run(action, result=None, **extra):
    replies=[]
    router.run(**(base | dict(action=action,callback=lambda v,e: replies.append((v,e))) | extra))
    if result is not None: recorder.args['callback'](result,None)
    return replies
prompts=[]
for action in ['proofread','rewrite','concise','expand','professional','casual','translate']:
    run(action, question='French' if action=='translate' else '')
    assert recorder.args['model']=='quick'
    prompts.append(recorder.args['prompt'])
assert len(set(prompts))==7
for bad in ['Sure, here is your correction.', 'Please receive the report.', 'A '*1000]:
    assert run('proofread',bad)[0][1]
run('proofread')
corrected = recorder.args['prompt'].split('Selected text:\n')[-1].replace('recieve','receive')
assert not run('proofread',corrected)[0][1]
run('rewrite',preferences={'tone':'casual','verbosity':'concise'})
assert 'conversational' in recorder.args['prompt'] and 'Prefer brief' in recorder.args['prompt']
run('professional',preferences={'tone':'casual','verbosity':'concise'})
assert 'conversational' not in recorder.args['prompt']
with tempfile.TemporaryDirectory() as root:
    store=LearningStore(str(Path(root)/'learning.sqlite3'))
    for _ in range(3): store.record('concise','accepted','fixture')
    assert store.stats()['preferences']['verbosity']=='concise'
    for n in range(6):
        data=dict(model='quick',application='fixture',context_type='multiline',category='grammar',
                  pattern=str(n),source='synthetic',replacement='synthetic corrected')
        store.outcome(data,'dismissed')
    assert not store.allows('fixture','new','grammar')
    assert store.allows('fixture','new','spelling')
    assert 'synthetic' not in Path(store._path).read_bytes().decode(errors='ignore')
    store.clear(); assert store.allows('fixture','new','grammar')
print('Writing prompt roles, gates, preference use and category suppression: PASS')
from router import mask_literals
from providers.ollama import _valid_text
masked, tokens = mask_literals('See ' + ' '.join(f'https://example.org/{i}' for i in range(12)))
assert len(tokens) == 12 and all(masked.count(key) == 1 for key in tokens)
for bad in ['bad\0text', '\ud800']:
    try: _valid_text(bad)
    except Exception: pass
    else: raise AssertionError('Invalid Unicode/control text accepted')
assert run('rewrite','Short.',selected='This is important context. '*20)[0][1]
