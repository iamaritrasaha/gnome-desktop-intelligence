#!/usr/bin/env python3
"""Assert routes and Ollama lifecycle payloads without loading any model."""
import json
import sys
from unittest.mock import patch
from pathlib import Path
from gi.repository import Gio

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'service'))
from providers.base import ProviderError
from router import ModelRouter, normalize_intent_response
from providers.ollama import OllamaProvider

source = Gio.SettingsSchemaSource.new_from_directory(
    str(Path(__file__).resolve().parents[1] / 'schemas'),
    Gio.SettingsSchemaSource.get_default(), False)
schema = source.lookup('org.gnome.shell.extensions.gdi', False)
def default(key):
    return schema.get_key(key).get_default_value().unpack()
models = {name: default('model-' + key) for name, key in [
    ('quick', 'quick-writing'), ('intent', 'intent-routing'),
    ('assistant', 'assistant'), ('reasoning', 'reasoning')]}
assert models == {'quick': 'LiquidAI/lfm2.5-1.2b-instruct:q4_k_m',
                  'intent': 'LiquidAI/lfm2.5-1.2b-instruct:q4_k_m',
                  'assistant': 'qwen3.5:4b',
                  'reasoning': 'qwen3.5:4b'}

class Recorder:
    def generate(self, **kwargs):
        self.request = kwargs

router = ModelRouter()
recorder = Recorder()
router._providers['ollama'] = recorder
for action in ('proofread', 'rewrite', 'concise', 'expand', 'professional',
               'casual', 'translate', 'summarize', 'explain', 'ask'):
    router.run(action=action, selected='Static fixture.', context='',
               question='English' if action == 'translate' else 'Explain',
               provider_name='ollama', endpoint='http://localhost:11434',
               quick_model=models['quick'], intent_model=models['intent'],
               assistant_model=models['assistant'], reasoning_model=models['reasoning'],
               cancellable=None, callback=lambda *_: None)
    expected = models['assistant'] if action in ('summarize', 'explain', 'ask') else models['quick']
    assert recorder.request['model'] == expected, action
    assert recorder.request['keep_alive'] == 0

provider = OllamaProvider()
for ttl in (0, 30):
    with patch.object(provider, '_request') as request:
        provider.generate(endpoint='http://localhost:11434', model=models['quick'],
                          system='Fixture', prompt='Fixture', cancellable=None,
                          callback=lambda *_: None, keep_alive=ttl)
        payload = request.call_args.args[2]
        assert payload['keep_alive'] == ttl
        assert payload['model'] == models['quick']
        assert payload['stream'] is False

# Phase 4: the action-routing route is a bounded structured-output request that
# can only ever name a registry action; it carries no execution rights.
router.run_intent_mapping(
    question='make it darker in here', registry='[{"id": "gnome.setColorScheme"}]',
    provider_name='ollama', endpoint='http://localhost:11434',
    model=models['intent'], cancellable=None, callback=lambda *_: None)
assert recorder.request['model'] == models['intent']
assert recorder.request['keep_alive'] == 0
assert recorder.request['response_schema']['required'] == ['action']
assert recorder.request['output_tokens'] == 256
assert 'Never invent actions' in recorder.request['system']
assert recorder.request['prompt'].startswith('Request: make it darker in here')
assert '"id": "gnome.setColorScheme"' in recorder.request['prompt']
try:
    router.run_intent_mapping(question='x', registry='[]', provider_name='ollama',
                              endpoint='', model='   ', cancellable=None,
                              callback=lambda *_: None)
    raise SystemExit('an empty routing model must be refused')
except ProviderError as error:
    assert 'routing model' in str(error)

assert normalize_intent_response('{"action": "audio.setVolume", "args": {"percent": 30}}') == \
    {'action': 'audio.setVolume', 'args': {'percent': 30}}
assert normalize_intent_response('not json at all') == {'action': '', 'args': {}}
assert normalize_intent_response('{"action": null}') == {'action': '', 'args': {}}
assert normalize_intent_response('{"action": "x", "args": [1]}') == {'action': 'x', 'args': {}}
assert normalize_intent_response('{"action": 5}') == {'action': '', 'args': {}}

print('Model defaults, writing routes, keep_alive and action routing: PASS (no models loaded)')
