"""Model residency: one deliberate model lifecycle instead of scattered
keep_alive values.

GDI used to send ``keep_alive=0`` (immediate unload) with every request, so
each prediction, correction, routing call and Ask paid a full cold model load
even during active use. This module owns residency policy instead:

* roles map to models per request; identical models share one entry,
* every request asks the manager for its ``keep_alive`` value,
* warm periods are bounded — models expire by Ollama's own keep_alive
  mechanism, never by GDI force-unloading anything,
* ``/api/ps`` is observed only on lifecycle transitions, never polled,
* Ask-mode prewarming is demand-driven and skipped when the model is
  already resident or the mode says not to,
* diagnostics record cold/warm state and load/eval latency from Ollama's
  response metadata.
"""

import time

import gi
from gi.repository import GLib

QUICK = 'quick'
INTENT = 'intent'
ASSISTANT = 'assistant'
REASONING = 'reasoning'

# Starting hypotheses, benchmarked in build/validation/release-perf; they are
# policy inputs, not sacred constants. keep_alive is the seconds the model
# stays resident after the request; Ollama itself expires it.
MODES = {
    'low-gpu': {
        'keep_alive': {QUICK: 30, INTENT: 20, ASSISTANT: 20, REASONING: 10},
        'prewarm': False,
        'extend_quick_activity': False,
        'max_concurrent': 1,
    },
    'balanced': {
        'keep_alive': {QUICK: 90, INTENT: 60, ASSISTANT: 45, REASONING: 15},
        'prewarm': True,
        'extend_quick_activity': True,
        'max_concurrent': 1,
    },
    'performance': {
        'keep_alive': {QUICK: 240, INTENT: 120, ASSISTANT: 120, REASONING: 45},
        'prewarm': True,
        'extend_quick_activity': True,
        'max_concurrent': 2,
    },
}

# While passive/predictive writing is actively used, the quick model's warm
# window extends; after this much idle time it decays back to the mode value.
QUICK_ACTIVITY_EXTENSION_SECONDS = 180
QUICK_ACTIVITY_WINDOW_SECONDS = 90
PREWARM_ROLE = ASSISTANT
PREWARM_COOLDOWN_SECONDS = 60
LATENCY_SAMPLE_LIMIT = 20


class ResidencyError(Exception):
    pass


def _expires_in_seconds(expires_at):
    """Seconds until an Ollama keep_alive expiry, or None when unparseable.
    Ollama timestamps carry nanosecond precision; trimmed defensively."""
    if not isinstance(expires_at, str) or not expires_at:
        return None
    from datetime import datetime
    text = expires_at
    try:
        head, _, rest = text.partition('.')
        if rest:
            digits = ''
            while rest and rest[0].isdigit():
                digits += rest[0]
                rest = rest[1:]
            text = f'{head}.{digits[:6]}{rest}'
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return max(0, round(parsed.timestamp() - time.time()))


def seconds_to_keep_alive(seconds):
    """Ollama accepts seconds, duration strings, or -1 (forever) / 0 (now)."""
    return int(seconds)


class ModelResidencyManager:
    def __init__(self, settings, provider=None):
        self._settings = settings
        self._provider = provider
        self._mode = self._read_mode()
        self._last_use = {}          # model -> monotonic time
        self._resident = {}          # model -> {size_vram, expires_at, context_length}
        self._ps_fetch_at = 0.0      # throttle for /api/ps refreshes
        self._quick_activity_at = 0.0
        self._prewarm_at = {}        # model -> monotonic time of last prewarm
        self._prewarm_in_flight = False
        self._latency = {}           # model -> [sample dicts]
        self._active_requests = {}

    # ------------------------------------------------------------- policy

    def _read_mode(self):
        try:
            mode = self._settings.get_string('resource-mode')
        except Exception:
            mode = 'balanced'
        return mode if mode in MODES else 'balanced'

    def set_mode(self, mode=None):
        self._mode = self._read_mode() if mode is None else mode

    @property
    def mode(self):
        return self._mode

    def policy(self):
        return MODES[self._mode]

    def max_concurrent(self):
        return self.policy()['max_concurrent']

    def note_writing_activity(self):
        """Passive/predictive work happened: extend the quick model's warm
        window, bounded, and let it expire again once activity stops."""
        self._quick_activity_at = time.monotonic()

    def keep_alive(self, role, model):
        """The keep_alive value (seconds) a request on `role`/`model` uses.
        This is the only place residency durations are decided."""
        if not model or not str(model).strip():
            return 0
        seconds = self.policy()['keep_alive'].get(role, 45)
        if (role == QUICK and self.policy()['extend_quick_activity'] and
                time.monotonic() - self._quick_activity_at < QUICK_ACTIVITY_WINDOW_SECONDS):
            seconds = max(seconds, QUICK_ACTIVITY_EXTENSION_SECONDS)
        return seconds_to_keep_alive(seconds)

    # ---------------------------------------------------------- lifecycle

    def observe_request_start(self, role, model):
        self._last_use[model] = time.monotonic()
        self._active_requests[model] = self._active_requests.get(model, 0) + 1
        self.schedule_ps_refresh(1.0)

    def observe_request_end(self, role, model, metadata=None):
        self._last_use[model] = time.monotonic()
        self._active_requests[model] = max(0, self._active_requests.get(model, 1) - 1)
        if metadata:
            sample = {
                'role': role,
                'cold': metadata.get('load_ms', 0) > 200,
                'load_ms': metadata.get('load_ms'),
                'prompt_eval_ms': metadata.get('prompt_eval_ms'),
                'eval_ms': metadata.get('eval_ms'),
                'total_ms': metadata.get('total_ms'),
                'tokens': metadata.get('tokens'),
                'keep_alive': self.keep_alive(role, model),
            }
            samples = self._latency.setdefault(model, [])
            samples.append(sample)
            del samples[:-LATENCY_SAMPLE_LIMIT]
        # One refresh after the keep_alive window would have expired, so the
        # observed residency is accurate without any polling loop.
        self.schedule_ps_refresh(self.keep_alive(role, model) + 2)

    def observe_ps(self, models):
        """Store a /api/ps snapshot (list of model dicts)."""
        self._resident = {}
        for item in models or []:
            name = item.get('model') or item.get('name')
            if isinstance(name, str) and name:
                self._resident[name] = {
                    'size_vram': item.get('size_vram', 0),
                    'size': item.get('size', 0),
                    'expires_at': item.get('expires_at', ''),
                    'context_length': item.get('context_length', 0),
                }
        self._ps_fetch_at = time.monotonic()

    def is_resident(self, model):
        return model in self._resident

    # ------------------------------------------------------------ prewarm

    def prewarm(self, endpoint, role=None):
        """Demand-driven preloading of the assistant model. Called when the
        user explicitly enters Ask Intelligence — never by the plain launcher,
        calculator or app launches. Observes /api/ps first so a stale or
        out-of-band unload cannot cause a wrong skip, and never runs while a
        prewarm is already in flight or inside the cooldown window."""
        if self._provider is None or not self.policy()['prewarm']:
            return False
        if role not in (None, PREWARM_ROLE):
            return False
        try:
            model = self._settings.get_string('model-assistant')
            endpoint = endpoint or self._settings.get_string('model-endpoint')
        except Exception:
            return False
        now = time.monotonic()
        if self._prewarm_in_flight or not model.strip() or \
                now - self._prewarm_at.get(model, 0) < PREWARM_COOLDOWN_SECONDS:
            return False
        self._prewarm_in_flight = True
        self._prewarm_at[model] = now

        def finish(loaded=False):
            self._prewarm_in_flight = False
            if loaded:
                self._last_use[model] = time.monotonic()
            self.schedule_ps_refresh(1.0)

        def observed(models, error):
            if error is not None:
                # Unreachable server: nothing to preload, retry later.
                finish(False)
                return
            self.observe_ps(models)
            if self.is_resident(model):
                finish(False)
                return
            self._prewarm_at[model] = time.monotonic()

            def loaded(_response, preload_error):
                finish(preload_error is None)

            try:
                self._provider.preload(endpoint=endpoint, model=model,
                                       keep_alive=self.keep_alive(PREWARM_ROLE, model),
                                       cancellable=None, callback=loaded)
            except Exception:
                finish(False)

        try:
            self._provider.running_models(endpoint=endpoint, cancellable=None,
                                          callback=observed)
            return True
        except Exception:
            self._prewarm_in_flight = False
            return False

    # ------------------------------------------------------- observations

    def schedule_ps_refresh(self, delay_seconds):
        """One-shot /api/ps refresh after a lifecycle transition. Overlapping
        requests coalesce through the cooldown; there is no polling loop."""
        if self._provider is None:
            return
        try:
            endpoint = self._settings.get_string('model-endpoint')
        except Exception:
            return
        now = time.monotonic()
        if now + delay_seconds < self._ps_fetch_at + 1.0:
            return
        self._ps_fetch_at = now + delay_seconds

        def fetch_ps():
            def completed(models, error):
                if error is None:
                    self.observe_ps(models)
            try:
                self._provider.running_models(endpoint=endpoint, cancellable=None,
                                              callback=completed)
            except Exception:
                pass
            return GLib.SOURCE_REMOVE

        if delay_seconds <= 0:
            fetch_ps()
        else:
            GLib.timeout_add_seconds(max(1, int(delay_seconds)), fetch_ps)

    def status_then(self, callback):
        """Diagnostics on demand: refresh the /api/ps observation first (the
        documented refresh trigger for opening diagnostics), then answer with
        the snapshot. Falls back to the last known state if unreachable."""
        if self._provider is None:
            callback(self.status())
            return
        try:
            endpoint = self._settings.get_string('model-endpoint')
        except Exception:
            callback(self.status())
            return

        def observed(models, error):
            if error is None:
                self.observe_ps(models)
            callback(self.status())

        try:
            self._provider.running_models(endpoint=endpoint, cancellable=None,
                                          callback=observed)
        except Exception:
            callback(self.status())

    def status(self):
        """Diagnostics snapshot: residency, VRAM and recent latency samples,
        labelled cold/warm so optimization stays measurable."""
        now = time.monotonic()
        try:
            models = {
                QUICK: self._settings.get_string('model-quick-writing'),
                INTENT: self._settings.get_string('model-intent-routing'),
                ASSISTANT: self._settings.get_string('model-assistant'),
                REASONING: self._settings.get_string('model-reasoning'),
            }
        except Exception:
            models = {}
        roles = {}
        for role, model in models.items():
            resident = self._resident.get(model)
            keep = self.keep_alive(role, model)
            entry = {
                'model': model,
                'keep_alive': keep,
                'resident': resident is not None,
            }
            if resident:
                entry.update({
                    'size_vram': resident.get('size_vram', 0),
                    'expires_at': resident.get('expires_at', ''),
                    'expires_in': _expires_in_seconds(resident.get('expires_at', '')),
                    'context_length': resident.get('context_length', 0),
                })
            if model in self._latency:
                entry['recent'] = self._latency[model][-5:]
            roles[role] = entry
        return {
            'mode': self._mode,
            'quick_activity_recent': now - self._quick_activity_at < QUICK_ACTIVITY_WINDOW_SECONDS,
            'active_requests': sum(1 for count in self._active_requests.values() if count),
            'resident_models': sorted(self._resident.keys()),
            'roles': roles,
        }
