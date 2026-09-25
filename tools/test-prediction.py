#!/usr/bin/python3
"""Predictive writing regressions: gate decisions, trigger pacing inputs,
stale-model routing payload and the 'continue' transform route."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'service'))

from prediction import clean_prediction, prediction_source  # noqa: E402
from router import ModelRouter  # noqa: E402
from providers.base import ProviderError  # noqa: E402


SOURCE = 'The main reason I prefer this architecture is'

# --- Trigger context extraction -------------------------------------------
assert prediction_source(SOURCE) == SOURCE
# Not enough useful context: no prediction.
assert prediction_source('is') == ''
assert prediction_source('one two three') == ''
assert prediction_source('') == ''
# Code-like content never predicts.
assert prediction_source('def main():\n    return {x: 1}') == ''
assert prediction_source('see https://example.org/docs for') == ''
# Whitespace-only or symbol-only trailing context is not prose.
assert prediction_source('12345 12345 12345 12345 12345') == ''


# --- Gate: useful phrases pass --------------------------------------------
def gated(continuation, source=SOURCE):
    # The router's parsed callback hands the gate the raw continuation string.
    return clean_prediction(source, continuation)

kept = gated('that it keeps the model layer separate from the desktop.')
assert kept == ' that it keeps the model layer separate from the desktop.', kept
# A missing leading space is normalized, never displayed glued to the caret.
assert clean_prediction(SOURCE, 'that it keeps the model layer separate.')
# Source already ending in whitespace keeps the continuation unindented.
assert clean_prediction('The main reason is ', 'that it works.') == 'that it works.'
# Full JSON response object form is accepted too (defensive path).
assert clean_prediction(SOURCE, {'continuation': ' that it works.'}) == ' that it works.'
# Unparsed JSON text can never display as a suggestion.
assert not gated('{"continuation": " that it works."}')

# --- Gate: suppressions ----------------------------------------------------
# Repeated existing text (echoes of the source) never display.
assert not gated('The main reason I prefer this architecture')
assert not gated('is the main reason I prefer')
# Any 4-word run copied from the source is an echo.
assert not gated('this architecture is the main reason')
# Trivial or obvious completions are suppressed.
assert not gated('the')
assert not gated('and')
assert not gated('.')
assert not gated('')
assert not gated('   ')
# Excessive length is suppressed.
assert not gated('word ' * 40)
assert not gated('x' * 200)
# Commentary and model self-reference is suppressed.
for bad in ("Sure, here is a continuation", 'Here is the next part',
            'Continuation: and it works', 'As an AI I cannot predict'):
    assert not gated(bad), bad
# Markdown syntax, links and code are corruption in a prose prediction.
for bad in ('that **works** well', 'see `the docs`', '# Heading text',
            'a [link](https://x.org) here', '> quoted text', 'item | table'):
    assert not gated(bad), bad
# URLs and paths never appear (protected literals are not predictions).
assert not gated('visit https://example.org now')
assert not gated('open /usr/share/doc for')
# Multi-line output is truncated to its first line; only that must survive.
assert clean_prediction(SOURCE, 'that it works.') == ' that it works.'

# --- Router: prediction request payload ------------------------------------
class FakeProvider:
    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        kwargs['callback'](json.dumps({'continuation': ' that it works.'}), None)


router = ModelRouter()
router._providers['ollama'] = FakeProvider()
results = {}
router.run_prediction(source=SOURCE, provider_name='ollama',
                      endpoint='http://localhost:11434', model='quick-model',
                      cancellable=None, callback=lambda value, error: results.update(value=value, error=error))
provider = router._providers['ollama']
assert len(provider.calls) == 1
call = provider.calls[0]
# The prediction uses the quick model slot, bounded output, structured JSON.
assert call['model'] == 'quick-model'
assert call['output_tokens'] <= 96 and call['timeout'] <= 8
assert call['keep_alive'] == 0
assert call['response_schema']['properties']['continuation']['type'] == 'string'
assert 'continuation' in call['system'] and 'JSON' in call['system']
assert SOURCE in call['prompt']
assert results['value'] == ' that it works.'
# No model configured fails closed without touching the provider.
router._providers['ollama'].calls.clear()
try:
    router.run_prediction(source=SOURCE, provider_name='ollama',
                          endpoint='http://localhost:11434', model='  ',
                          cancellable=None, callback=lambda value, error: None)
    raise AssertionError('empty model must raise')
except ProviderError:
    pass
assert not router._providers['ollama'].calls

# --- Router: 'continue' writing-tool route ---------------------------------
class ContinueProvider:
    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        kwargs['callback'](' that it keeps the model layer separate.', None)


router2 = ModelRouter()
router2._providers['ollama'] = ContinueProvider()
continue_results = {}
router2.run(action='continue', selected=SOURCE, context='', question='',
            provider_name='ollama', endpoint='http://localhost:11434',
            quick_model='quick-model', intent_model='x', assistant_model='a',
            reasoning_model='r', cancellable=None,
            callback=lambda value, error: continue_results.update(value=value, error=error),
            timeout=30, context_tokens=8192, output_tokens=256)
call = router2._providers['ollama'].calls[0]
assert call['model'] == 'quick-model'
# The continuation instruction must demand new text only.
assert 'Never repeat any existing text' in call['system'] + call['prompt']
assert 'that it keeps the model layer separate.' == continue_results['value']
# A continuation that echoes the selected sentence is a transform failure,
# but literal-multiset protection must NOT apply to continuations (the
# continuation does not repeat the source's tokens).
router2._providers['ollama'].calls.clear()
echo_results = {}
router2.run(action='continue', selected=SOURCE + ' with a URL https://example.org/x',
            context='', question='', provider_name='ollama',
            endpoint='http://localhost:11434', quick_model='q', intent_model='x',
            assistant_model='a', reasoning_model='r', cancellable=None,
            callback=lambda value, error: echo_results.update(value=value, error=error),
            timeout=30, context_tokens=8192, output_tokens=256)
assert echo_results['value'] and 'GDI_LITERAL' not in echo_results['value']

# Tone variants are wired to the quick route with real instructions.
for action in ('friendly', 'direct'):
    router2._providers['ollama'].calls.clear()
    tone_results = {}
    router2.run(action=action, selected='A sentence.', context='', question='',
                provider_name='ollama', endpoint='http://localhost:11434',
                quick_model='q', intent_model='x', assistant_model='a',
                reasoning_model='r', cancellable=None,
                callback=lambda value, error: tone_results.update(value=value, error=error),
                timeout=30, context_tokens=8192, output_tokens=256)
    assert tone_results['value'], action

print('GDI_PREDICTION gate, trigger context, prediction payload and continue route PASS')
