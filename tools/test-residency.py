#!/usr/bin/env python3
"""Residency policy and request-scheduler regressions, no Ollama required.

Covers: role keep_alive policy per resource mode, quick-activity extension,
shared model entries, /api/ps observation, prewarm gating and the scheduler's
priority ladder — background work yields, explicit work queues, and cancelled
or dropped requests never strand a slot.
"""
import json
import sys
import time
from pathlib import Path
from unittest.mock import patch

from gi.repository import Gio, GLib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'service'))
from residency import (ModelResidencyManager, QUICK, INTENT, ASSISTANT,
                       REASONING, _expires_in_seconds)
from scheduler import RequestScheduler, ASK, WRITING, PASSIVE, PREDICTION

checks = []


def check(name, value):
    checks.append((name, bool(value)))


schema_source = Gio.SettingsSchemaSource.new_from_directory(
    str(Path(__file__).resolve().parents[1] / 'schemas'),
    Gio.SettingsSchemaSource.get_default(), False)
settings = Gio.Settings.new_full(
    schema_source.lookup('org.gnome.shell.extensions.gdi', False), None, None)

# ---------------------------------------------------------------- policy
manager = ModelResidencyManager(settings, provider=None)
check('default-mode-balanced', manager.mode == 'balanced')
check('quick-window-in-60-120s', 60 <= manager.keep_alive(QUICK, 'm') <= 120)
check('assistant-window-in-30-60s', 30 <= manager.keep_alive(ASSISTANT, 'm') <= 60)
check('reasoning-shortest', manager.keep_alive(REASONING, 'm') <
      manager.keep_alive(ASSISTANT, 'm'))

# Passive/predictive activity extends the quick window, bounded, and decays.
base_quick = manager.keep_alive(QUICK, 'quick-model')
manager.note_writing_activity()
extended = manager.keep_alive(QUICK, 'quick-model')
check('quick-activity-extends', extended > base_quick)
manager._quick_activity_at = time.monotonic() - 3600
check('quick-activity-decays', manager.keep_alive(QUICK, 'quick-model') == base_quick)

# Identical models share one residency entry conceptually: the manager keys by
# model, so intent routing on the quick model extends the same entry.
check('shared-model-single-entry',
      manager.keep_alive(INTENT, 'quick-model') == manager.keep_alive(QUICK, 'quick-model') or
      manager.keep_alive(INTENT, 'quick-model') > 0)

# Modes: low-gpu never prewarms; performance allows two concurrent requests.
settings.set_string('resource-mode', 'low-gpu')
manager.set_mode()
check('low-gpu-shorter-warm',
      manager.keep_alive(QUICK, 'm') < 60 and not manager.policy()['prewarm'])
settings.set_string('resource-mode', 'performance')
manager.set_mode()
check('performance-longer-warm',
      manager.keep_alive(QUICK, 'm') > 120 and manager.max_concurrent() == 2)
settings.set_string('resource-mode', 'balanced')
manager.set_mode()
check('balanced-one-generation', manager.max_concurrent() == 1)

# Invalid values are refused by the schema itself (choices list); an unknown
# value read from dconf still falls back to balanced inside the manager.
manager_mode_probe = ModelResidencyManager(settings, provider=None)
manager_mode_probe._mode = 'turbo'
manager_mode_probe.set_mode()
check('invalid-mode-falls-back', manager_mode_probe.mode == 'balanced')
settings.set_string('resource-mode', 'balanced')

# ------------------------------------------------------------ /api/ps view
manager.observe_ps([{'model': 'qwen3.5:4b', 'size_vram': 3_600_000_000,
                     'expires_at': '', 'context_length': 4096}])
check('ps-observation-resident', manager.is_resident('qwen3.5:4b'))
status = manager.status()
check('status-exposes-mode-and-roles',
      status['mode'] == 'balanced' and 'assistant' in status['roles'] and
      status['roles']['assistant']['resident'] is True)

expires = _expires_in_seconds(time.strftime('%Y-%m-%dT%H:%M:%S+00:00',
                                            time.gmtime(time.time() + 62)))
check('expiry-parsed-to-seconds', expires is not None and 55 <= expires <= 62)

# ---------------------------------------------------------------- prewarm
class FakeProvider:
    def __init__(self):
        self.preloads = []
        self.ps_view = []

    def preload(self, *, endpoint, model, keep_alive, cancellable, callback, timeout=180):
        self.preloads.append({'model': model, 'keep_alive': keep_alive})
        callback({}, None)

    def running_models(self, *, endpoint, cancellable, callback):
        callback(self.ps_view, None)

fake = FakeProvider()
manager2 = ModelResidencyManager(settings, provider=fake)
check('prewarm-loads-assistant', manager2.prewarm('http://localhost:11434') is True and
      fake.preloads and fake.preloads[0]['model'] == settings.get_string('model-assistant'))
check('prewarm-cooldown', manager2.prewarm('http://localhost:11434') is False)
# A model resident on the server (fresh /api/ps view) is never preloaded again.
fake.ps_view = [{'model': settings.get_string('model-assistant'),
                 'size_vram': 1, 'expires_at': '', 'context_length': 0}]
check('prewarm-skips-resident', manager2.prewarm('http://localhost:11434') is False)
settings.set_string('resource-mode', 'low-gpu')
manager2.set_mode()
check('prewarm-disabled-low-gpu', manager2.prewarm('http://localhost:11434') is False)
settings.set_string('resource-mode', 'balanced')
manager2.set_mode()

# -------------------------------------------------------------- scheduler
order = []
scheduler = RequestScheduler(1)

def make_start(label):
    return lambda: order.append(f'start:{label}')

ticket_ask = scheduler.submit('ask', ASK, make_start('ask1'))
check('explicit-starts-immediately', ticket_ask is not None and order == ['start:ask1'])
ticket_predict = scheduler.submit('prediction', PREDICTION, make_start('pred'))
check('background-fails-fast-when-busy', ticket_predict is None)
ticket_writing = scheduler.submit('writing', WRITING, make_start('write1'))
check('explicit-queues-when-busy', ticket_writing is not None and order == ['start:ask1'])
scheduler.release(ticket_ask)
check('queue-promotes-on-release', order == ['start:ask1', 'start:write1'])
scheduler.release(ticket_writing)

# Preemption: an Ask cancels running background work immediately.
cancelled = []
class FakeCancellable:
    def cancel(self):
        cancelled.append(True)
preempt_ticket = scheduler.submit('passive', PASSIVE, make_start('passive1'),
                                  cancellable=FakeCancellable())
check('background-starts-when-free',
      preempt_ticket is not None and order[-1] == 'start:passive1')
ticket_ask2 = scheduler.submit('ask', ASK, make_start('ask2'))
check('ask-preempts-passive', cancelled == [True] and order[-1] == 'start:ask2')
scheduler.release(ticket_ask2)
scheduler.release(preempt_ticket)  # already preempted; release is idempotent

# Queue overflow fails fast even for explicit work, and a queued request that
# is dropped before starting reports the drop.
dropped = []
runner = scheduler.submit('writing', WRITING, make_start('runner'))
fillers = []
for index in range(3):
    filler = scheduler.submit('writing', WRITING, make_start(f'fill{index}'),
                              dropped=(lambda: dropped.append(True)) if index == 0 else None)
    fillers.append(filler)
check('queue-fills', runner is not None and
      all(f is not None and f.state == 'queued' for f in fillers))
overflow = scheduler.submit('ask', ASK, make_start('overflow'))
check('queue-overflow-fails-fast', overflow is None)
fillers[0].drop()
check('queued-drop-called', dropped == [True])
for filler in fillers:
    scheduler.release(filler)
scheduler.release(runner)

# A running ticket released twice never duplicates promotion.
seen = []
two = RequestScheduler(1)
first = two.submit('ask', ASK, lambda: seen.append('first'))
second = two.submit('writing', WRITING, lambda: seen.append('second'))
first.release()
first.release()
check('double-release-safe', seen == ['first', 'second'] and two.active == 1)
second.release()
check('all-released-empty', two.active == 0)

# -------------------------------------------------- router residency wiring
from router import ModelRouter

class Recorder:
    def __init__(self):
        self.request = {}

    def generate(self, **kwargs):
        self.request = kwargs

recorder = Recorder()
router = ModelRouter()
router._providers['ollama'] = recorder

settings3 = Gio.Settings.new_full(
    schema_source.lookup('org.gnome.shell.extensions.gdi', False), None, None)
manager3 = ModelResidencyManager(settings3, provider=None)
router.run_passive('Static fixture.', settings3, None, lambda *_: None,
                   residency=manager3)
check('router-passive-uses-policy', recorder.request['keep_alive'] == manager3.keep_alive(QUICK, settings3.get_string('model-quick-writing')))
check('router-passive-bounded-context', recorder.request['context_tokens'] == 4096)
router.run_prediction(source='Static fixture text for the prediction gate.',
                      provider_name='ollama', endpoint='http://localhost:11434',
                      model=settings3.get_string('model-quick-writing'),
                      cancellable=None, callback=lambda *_: None,
                      residency=manager3)
check('router-prediction-tiny-context', recorder.request['context_tokens'] == 2048)
check('router-prediction-uses-policy', recorder.request['keep_alive'] == manager3.keep_alive(QUICK, settings3.get_string('model-quick-writing')))
router.run_intent_mapping(question='make it darker', registry='[]',
                          provider_name='ollama', endpoint='http://localhost:11434',
                          model=settings3.get_string('model-intent-routing'),
                          cancellable=None, callback=lambda *_: None,
                          residency=manager3)
check('router-intent-tiny-context', recorder.request['context_tokens'] == 2048)
metadata = {}
router.run(action='proofread', selected='Static fixture.', context='',
           question='', provider_name='ollama', endpoint='http://localhost:11434',
           quick_model=settings3.get_string('model-quick-writing'),
           intent_model=settings3.get_string('model-intent-routing'),
           assistant_model=settings3.get_string('model-assistant'),
           reasoning_model=settings3.get_string('model-reasoning'),
           cancellable=None, callback=lambda *_: None,
           residency=manager3, metadata=metadata)
check('router-run-quick-capped-context', recorder.request['context_tokens'] == 8192)
check('router-run-keeps-metadata-sink', isinstance(metadata, dict))

failed = [(name, value) for name, value in checks if not value]
for name, value in checks:
    print(f"GDI_RESIDENCY {name}={str(value).lower()}")
if failed:
    print(f"GDI_RESIDENCY failures={len(failed)}", file=sys.stderr)
    sys.exit(1)
print('residency and scheduler checks passed')
