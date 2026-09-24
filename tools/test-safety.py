#!/usr/bin/python3
"""Adversarial editing and routing regressions; no real document contents."""
import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'service'))
from selection import SelectionContext
from router import ModelRouter, protected_tokens
from providers.base import ProviderError

class Snapshot(SelectionContext):
    def _surroundings_match(self, *_):
        return True
ctx = {'accessible': object()}
snapshot = Snapshot()
with patch('selection.Atspi.Text.get_character_count', return_value=10), \
     patch('selection.Atspi.EditableText.delete_text', side_effect=RuntimeError('remote uncertain')), \
     patch('selection.Atspi.EditableText.insert_text') as insert:
    assert snapshot._replace_range(ctx, 2, 4, 'new', 'old') is False
    insert.assert_not_called()
print('SAFETY uncertain deletion never blindly inserts original: PASS')
with patch('selection.Atspi.Text.get_character_count', side_effect=[10, 8]), \
     patch('selection.Atspi.EditableText.delete_text', return_value=True), \
     patch('selection.Atspi.EditableText.insert_text', side_effect=RuntimeError('insert may have succeeded')) as insert:
    assert snapshot._replace_range(ctx, 2, 4, 'new', 'old') is False
    assert insert.call_count == 1
print('SAFETY uncertain insertion never duplicates original: PASS')
router = ModelRouter()
class Provider:
    def generate(self, **kwargs):
        self.model = kwargs['model']
        kwargs['callback']('Visit https://wrong.example and `changed()`.', None)
p = Provider(); router._providers['test'] = p
answers = []
kwargs = dict(selected='Visit https://example.com and `safe()`.', context='', question='',
              provider_name='test', endpoint='http://localhost', quick_model='arbitrary-writing',
              assistant_model='arbitrary-assistant', reasoning_model='arbitrary-hard', intent_model='',
              cancellable=None, callback=lambda *args: answers.append(args))
router.run(action='proofread', **kwargs)
assert answers[0][0] is None and isinstance(answers[0][1], ProviderError)
assert p.model == 'arbitrary-writing'
for action, expected in [('explain', 'arbitrary-assistant'), ('harder', 'arbitrary-hard')]:
    router.run(action=action, **{**kwargs, 'question': 'Explain'})
    assert p.model == expected
assert protected_tokens('Email x@y.com, /tmp/path and `literal()`') == protected_tokens('`literal()` /tmp/path x@y.com')
print('SAFETY protected literals rejected and model-neutral routes: PASS')

spec = importlib.util.spec_from_file_location('gdi_service', Path(__file__).resolve().parents[1] / 'service/gdi-service.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class Bus:
    def signal_subscribe(self, *_): return 1
    def register_object(self, *_): return 1
class Invocation:
    def __init__(self): self.replies = []
    def return_dbus_error(self, *args): self.replies.append(('error', args))
    def return_value(self, value): self.replies.append(('value', value))
service = module.GdiService(Bus())
args = ('fixture-token', 'assistant', '', '', '', 'ollama', 'http://127.0.0.1:1', 'writing', '', 'assistant', 'harder', 5, 8192, 512)
invocation = Invocation()
service._start_transform(args, invocation, ':test')
assert len(invocation.replies) == 1 and not service._requests
class DeferredRouter:
    def run(self, **kwargs): self.callback = kwargs['callback']
service._router = DeferredRouter()
invocation = Invocation()
service._start_transform(args, invocation, ':test')
try:
    service._check_owner('fixture-token', ':another-client')
    raise AssertionError('foreign request accepted')
except ProviderError:
    pass
service._cancel_transform('fixture-token')
service._router.callback('late response', None)
assert len(invocation.replies) == 1 and not service._requests
class Listener:
    def __init__(self): self.removed = []
    def deregister(self, event): self.removed.append(event)
listener = Listener()
service._revision_listener = listener
service._contexts['fixture-token'] = {'watched': True, 'owner': ':test'}
service._release_context('fixture-token')
assert not service._contexts and service._revision_listener is None
assert listener.removed == ['object:text-changed']
print('SAFETY request validation cleanup, ownership, cancellation, late reply and listener release: PASS')
