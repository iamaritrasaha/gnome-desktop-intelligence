"""Opt-in event-driven observation. No event payloads, polling, or document reads."""
import json
import hashlib
import secrets
import time
from collections import Counter
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib
from quality import candidate, quality
from prediction import clean_prediction, prediction_source
from scheduler import PASSIVE, PREDICTION

EVENTS = ('object:text-changed', 'object:text-caret-moved',
          'object:text-selection-changed', 'object:state-changed:focused')

# Predictive writing: a short continuation offered after a typing pause. Its
# pacing is intentionally separate from proofreading, and much stricter about
# not firing: a debounced pause, a minimum interval, end-of-text caret, and a
# useful-context minimum all gate the single model request.
PREDICTION_DEBOUNCE_MS = 500
MIN_PREDICTION_INTERVAL = 2.5
PREDICTION_EXPIRY_SECONDS = 10
PREDICTION_CONTEXT_CHARS = 320


def _prediction_prefix(continuation, words):
    """(accepted prefix, remaining ghost) for word-wise acceptance."""
    words = max(0, int(words or 0))
    if words <= 0:
        return continuation, ''
    leading = ''
    body = continuation
    if body[:1] in (' ', '\n'):
        leading, body = body[0], body[1:]
    parts = body.split(' ')
    if words >= len(parts):
        return continuation, ''
    return leading + ' '.join(parts[:words]), ' ' + ' '.join(parts[words:])


class PassiveWriting:
    def __init__(self, service, settings, emit):
        self.service, self.settings, self.emit = service, settings, emit
        self.owner = None
        self.pid = 0
        self.geometry = {}
        self.listener = None
        self.enabled = False
        self.predict_enabled = False
        self.timer = self.expiry = self.post_timer = 0
        self.predict_timer = self.predict_expiry = 0
        self.source = None
        self.offer = self.post = None
        self.ghost = None
        self.cancel = None
        self.predict_cancel = None
        self.anchor_nonce = self.anchor_cache = None
        self.anchor_retry = None
        self.anchor_feature = None
        self.generation = 0
        self.predict_generation = 0
        self.backoff_until = 0
        self.failures = 0
        self.last_request = 0
        self.last_prediction = 0
        self.last_text_event = 0
        self.last_source = None
        self.metrics = Counter()
        self.trace = []
        self._eligibility_cache = None
        self.settings_handler = settings.connect('changed', self._settings_changed)

    def _settings_changed(self, _settings, key):
        if key == 'retain-learning-examples' and not self.settings.get_boolean(key):
            self.service._learning.purge_examples()
        if key == 'enable-learning' and not self.settings.get_boolean(key):
            self.forget_learning()
        if key.startswith('model-') or key in ('enable-passive-writing',
                                               'enable-predictive-writing',
                                               'passive-debounce-ms'):
            self.backoff_until = 0
            self.dismiss('settings')
            self.dismiss_prediction('settings')
            if not self.settings.get_boolean('enable-passive-writing'):
                self.enabled = False
                self.dismiss('disabled')
            if not self.settings.get_boolean('enable-predictive-writing'):
                self.predict_enabled = False
                self.dismiss_prediction('disabled')
            if not self.enabled and not self.predict_enabled:
                self.stop()

    def supports_field(self, context):
        """Toolkit-level field eligibility for passive assistance, shared with
        the capability report. Focus/selection state is checked separately."""
        accessible = context.get("accessible")
        if accessible is None:
            return False
        try:
            toolkit = accessible.get_application().get_toolkit_name()
            if toolkit == 'Gecko':
                return False
            states = accessible.get_state_set()
            if toolkit == 'GTK' and not states.contains(Atspi.StateType.MULTI_LINE):
                version = accessible.get_application().get_toolkit_version() or ''
                if not version.startswith('3.'):
                    return False
            return self.service._editable(accessible)
        except Exception:
            return False

    def _trace(self, stage, **fields):
        """Bounded developer diagnostics: stage metadata only, never text."""
        record = {'at': round(time.time(), 3), 'stage': stage}
        record.update(fields)
        self.trace.append(record)
        del self.trace[:-30]

    def configure(self, owner, passive_enabled, prediction_enabled, pid, geometry):
        changed = owner != self.owner or pid != self.pid or geometry != self.geometry
        if changed:
            self.dismiss('focus')
            self.finish_post()
            self.last_source = None
        self.owner, self.pid, self.geometry = owner, pid, geometry
        self.enabled = bool(passive_enabled and pid > 0 and
                            self.settings.get_boolean('enable-passive-writing'))
        self.predict_enabled = bool(prediction_enabled and pid > 0 and
                                    self.settings.get_boolean('enable-predictive-writing'))
        if changed and (self.enabled or self.predict_enabled):
            self._trace('focus', pid=pid)
        if not self.enabled and not self.predict_enabled:
            self.stop()
        elif not self.listener:
            self.listener = Atspi.EventListener.new(self._event, None, None)
            for event in EVENTS:
                if not self.listener.register(event):
                    self.stop(); break

    def stop(self):
        self.enabled = False
        self.predict_enabled = False
        self.dismiss('disabled')
        self.dismiss_prediction('disabled')
        self.finish_post()
        if self.listener:
            for event in EVENTS:
                self.listener.deregister(event)
            self.listener = None
        self.source = self.last_source = None

    def forget_learning(self):
        for data in (self.offer, self.post):
            if data: data['learn'] = data['retain'] = False

    def _drop_timer(self, name):
        value = getattr(self, name)
        if value: GLib.source_remove(value)
        setattr(self, name, 0)

    def _same_app(self, source):
        try:
            return source.get_application().get_process_id() == self.pid
        except Exception:
            return False

    def _eligible_cached(self, source):
        """Eligibility reads several remote AT-SPI properties per call. During
        a typing burst the same source is re-checked per event; reuse the
        verdict for a second so a busy session cannot stall the main loop."""
        now = time.monotonic()
        cached = self._eligibility_cache
        if cached and cached[0] == source and now - cached[1] < 1:
            return cached[2]
        result = self._eligible(source)
        self._eligibility_cache = (source, now, result)
        return result

    def _eligible(self, source):
        try:
            states = source.get_state_set()
            # Firefox 156 / Gecko advertises EditableText but its range edits
            # acknowledge without changing the tested DOM controls. Do not
            # offer automatic acceptance until that backend is validated.
            toolkit = source.get_application().get_toolkit_name()
            if toolkit == 'Gecko':
                return False
            # GTK4 masked Entry can expose exactly the same role, attributes
            # and input-purpose as ordinary Entry. Never trial-read to tell.
            if toolkit == 'GTK' and not states.contains(Atspi.StateType.MULTI_LINE):
                version = source.get_application().get_toolkit_version() or ''
                if not version.startswith('3.'):
                    return False
            return (self._same_app(source) and self.service._editable(source)
                    and all(states.contains(state) for state in
                            (Atspi.StateType.FOCUSED, Atspi.StateType.SHOWING, Atspi.StateType.VISIBLE))
                    and Atspi.Text.get_n_selections(source) == 0)
        except Exception:
            return False

    def _event(self, event, *_):
        # Never inspect event.any_data: AT-SPI includes inserted/deleted text there.
        if not self.enabled and not self.predict_enabled:
            return
        source = event.source
        if not self._same_app(source):
            return
        try:
            if self.service._protected_ancestry(source):
                self.dismiss('sensitive'); self.dismiss_prediction('sensitive'); self.finish_post(); return
            kind = event.type
            if self.post and source == self.post['accessible']:
                context = self.service._contexts.get(self.post['token'], {})
                if context.get('awaiting_own'):
                    return
                if 'text-changed' in kind:
                    self._post_event(event)
            if 'focused' in kind:
                self.dismiss('focus')
                self.dismiss_prediction('focus')
                if not event.detail1: self.finish_post()
                return
            if 'text-changed' in kind:
                if not self._eligible_cached(source):
                    return
                self.metrics['text_events'] += 1
                self.last_text_event = time.monotonic()
                if self.trace and self.trace[-1]['stage'] == 'typing' and \
                        time.monotonic() - self.trace[-1]['at'] < .5:
                    self.trace[-1]['events'] = self.trace[-1].get('events', 1) + 1
                else:
                    self._trace('typing', role=Atspi.Role.get_name(source.get_role()))
                own_settle = False
                if self.ghost:
                    ghost_context = self.service._contexts.get(self.ghost['token'], {})
                    own_settle = bool(ghost_context.get('awaiting_own'))
                if not own_settle:
                    # Our own partial insert is still settling; its AT-SPI
                    # echo must not dismiss the remainder ghost.
                    self.dismiss('continued_typing')
                    self.source = source
                    if self.enabled:
                        self.timer = GLib.timeout_add(self.settings.get_int('passive-debounce-ms'), self._trigger)
                    if self.predict_enabled:
                        self.schedule_prediction()
            elif 'caret' in kind or 'selection' in kind:
                if self.timer and source == self.source and time.monotonic() - self.last_text_event < .05:
                    # Each insert normally emits its caret event afterwards. The
                    # debounce captures the final caret; pending work has no snapshot.
                    return
                if self.offer or self.cancel or self.timer:
                    self.dismiss('caret')
                if self.ghost:
                    # GTK emits caret and selection events together; the live
                    # offset decides. The echo of the user's last insert at the
                    # predicted position is not navigation and keeps the ghost.
                    try:
                        moved = Atspi.Text.get_caret_offset(source) != self.ghost.get('caret', -1)
                    except Exception:
                        moved = True
                    if moved:
                        self.dismiss_prediction('caret')
                elif self.predict_cancel or self.predict_timer:
                    self.dismiss_prediction('caret')
                if self.post:
                    self.finish_post()
        except Exception as error:
            self.metrics['observer_error_' + type(error).__name__] += 1
            self._trace('event-error', error=type(error).__name__)
            self.dismiss('unavailable')

    def _resolve_anchor(self, source, caret, retry=None, timer_name='timer', expiry=None):
        """WINDOW character extents when available, else a fresh coordinate
        snapshot requested from the Shell (input-method caret location).
        Returns an anchor dict, or None after emitting the request; the
        pending retry callable runs from set_anchor."""
        try:
            rect = Atspi.Text.get_character_extents(source, max(0, caret - 1), Atspi.CoordType.WINDOW)
            anchor = {'x': rect.x, 'y': rect.y, 'height': rect.height}
            # Firefox on Wayland may return sentinel coordinates rather
            # than an error for WINDOW extents. Treat both as unavailable.
            if self._valid_anchor(anchor):
                return anchor
        except Exception:
            pass
        anchor = self.anchor_cache
        self.anchor_cache = None
        if anchor is not None and self._valid_anchor(anchor):
            return anchor
        self.anchor_nonce = secrets.token_urlsafe(18)
        self.anchor_retry = retry or self._trigger
        # One pending anchor request at a time: the feature that asked owns
        # the nonce until set_anchor answers or its expiry clears it.
        self.anchor_feature = 'prediction' if timer_name == 'predict_timer' else 'passive'
        self.emit('PassiveAnchorRequest', self.anchor_nonce)
        self._drop_timer(timer_name)
        setattr(self, timer_name, GLib.timeout_add(600, expiry or (lambda: self.dismiss('no-anchor'))))
        return None

    def _trigger(self):
        self.timer = 0
        source = self.source
        now = time.monotonic()
        self._trace('debounce-fire')
        if (not self.enabled or not source or now < self.backoff_until or
                now - self.last_request < 5 or not self._eligible(source)):
            self.metrics['trigger_ineligible_or_cooldown'] += 1
            self._trace('ineligible')
            return GLib.SOURCE_REMOVE
        # A proven correction supersedes any visible prediction.
        self.dismiss_prediction('superseded')
        token = None
        try:
            caret = Atspi.Text.get_caret_offset(source)
            length = Atspi.Text.get_character_count(source)
            # Avoid completions in the middle of an existing sentence or selection.
            if caret < 1 or caret > length:
                return GLib.SOURCE_REMOVE
            if not self.service._public_text_range(source, caret, min(length, caret + 32)):
                return GLib.SOURCE_REMOVE
            after = Atspi.Text.get_text(source, caret, min(length, caret + 32))
            if after and not after.startswith('\n'):
                return GLib.SOURCE_REMOVE
            base = max(0, caret - 320)
            if not self.service._public_text_range(source, max(0, base - 32), min(length, caret + 32)):
                self.metrics['sensitive_range_suppressed'] += 1
                return GLib.SOURCE_REMOVE
            nearby = Atspi.Text.get_text(source, base, caret)
            captured = candidate(nearby, base)
            if not captured:
                self.metrics['preflight_suppressed'] += 1
                self._trace('preflight-suppressed')
                return GLib.SOURCE_REMOVE
            start, text = captured
            self._trace('captured', role=Atspi.Role.get_name(source.get_role()),
                        toolkit=source.get_application().get_toolkit_name(),
                        chars=len(text), start=start)
            fingerprint = hashlib.sha256(text.encode()).hexdigest()
            if self.last_source == (source, start, fingerprint):
                self._trace('duplicate-source')
                return GLib.SOURCE_REMOVE
            if self.anchor_nonce and self.anchor_feature == 'prediction':
                # The prediction cycle is waiting for its own anchor; a second
                # request here would overwrite its nonce and silently drop it.
                self._trace('anchor-busy-prediction')
                return GLib.SOURCE_REMOVE
            anchor = self._resolve_anchor(source, caret)
            if anchor is None:
                return GLib.SOURCE_REMOVE
            if not self._valid_anchor(anchor):
                self.metrics['invalid_anchor'] += 1
                self._trace('anchor-invalid', anchor=anchor)
                return GLib.SOURCE_REMOVE
            application = (source.get_application().get_name() or '')[:128]
            learn = self.settings.get_boolean('enable-learning')
            if learn and not self.service._learning.allows(application):
                self.metrics['personalization_suppressed'] += 1
                return GLib.SOURCE_REMOVE
            token = secrets.token_urlsafe(24)
            end = start + len(text)
            context = dict(token=token, selected=text, nearby='', application=application,
                role=Atspi.Role.get_name(source.get_role()), caret=caret, accessible=source,
                editable=True, passive=True, start=start, end=end, length=length,
                before=Atspi.Text.get_text(source, max(0, start - 32), start),
                after=Atspi.Text.get_text(source, end, min(length, end + 32)),
                created=now, stale=False, owner=self.owner, action='passive')
            self.service._prune_contexts()
            self.service._contexts[token] = context
            self.service._watch_context(context)
            if context.get('stale') or not context.get('ready'):
                self._trace('capture-stale')
                self.service._release_context(token)
                return GLib.SOURCE_REMOVE
            states = source.get_state_set()
            data = dict(context, source=text, model=self.settings.get_string('model-quick-writing'),
                context_type='multiline' if states.contains(Atspi.StateType.MULTI_LINE) else 'singleline',
                anchor=anchor,
                # Web editors and single-line focus navigation never take Tab.
                tab_safe=states.contains(Atspi.StateType.MULTI_LINE) and source.get_application().get_toolkit_name() == 'GTK',
                learn=learn, retain=learn and self.settings.get_boolean('retain-learning-examples'))
            self.finish_post()
            self.offer = data
            self.last_source = (source, start, fingerprint)
            self.last_request = now
            self.metrics['requests'] += 1
            self.generation += 1
            generation = self.generation
            self.cancel = Gio.Cancellable()
            ticket_holder = {}
            metadata = {}

            def release_ticket():
                ticket = ticket_holder.pop('ticket', None)
                if ticket is not None:
                    # Mirror the explicit paths: the residency manager learns
                    # the request ended, so its active counter and latency
                    # samples stay truthful for the quick model.
                    self.service._residency.observe_request_end(
                        'quick', self.settings.get_string('model-quick-writing'), metadata)
                    ticket.release()

            def completed(response, error):
                # The scheduler slot is released first: a superseded request
                # must never strand it, whatever path the completion takes.
                release_ticket()
                if generation != self.generation:
                    return
                was_cancelled = self.cancel is not None and self.cancel.is_cancelled()
                self.cancel = None
                self.metrics['completed'] += 1
                self.metrics['latency_ms_total'] += round((time.monotonic() - now) * 1000)
                if error:
                    if was_cancelled:
                        # Cancelled by continued typing or preempted by a
                        # higher-priority request: unavailability, never a
                        # provider failure to back off from.
                        self._trace('request-cancelled')
                        self.dismiss('cancelled')
                        return
                    self.metrics['provider_errors'] += 1
                    self.failures += 1
                    self.backoff_until = time.monotonic() + min(60, 15 * self.failures)
                    self._trace('provider-error', backoff_s=min(60, 15 * self.failures))
                    self.dismiss('provider'); return
                self.failures = 0
                self._trace('model-result', chars=len(response or ''))
                result = quality(text, response)
                if not result:
                    self.metrics['quality_suppressed'] += 1
                    self._trace('gate-rejected')
                    self.dismiss('quality'); return
                self._trace('gate-accepted', category=result.get('category'))
                if not self.current():
                    self.dismiss('stale'); return
                data.update(result)
                learn_now = data.get('learn') and self.settings.get_boolean('enable-learning')
                data['pattern'] = ''
                allowed = True
                if learn_now:
                    try:
                        data['pattern'] = self.service._learning.pattern(result['category'], result['pattern_before'], result['pattern_after'])
                        allowed = self.service._learning.allows(application, data['pattern'], result['category'])
                    except Exception:
                        self.metrics['learning_errors'] += 1
                        data['learn'] = data['retain'] = False
                if not allowed:
                    self.metrics['personalization_suppressed'] += 1
                    self.dismiss('quality'); return
                data['shown'] = True
                self.metrics['shown'] += 1
                self._trace('suggestion-shown', anchor='extents' if anchor else 'input-method')
                self.emit('PassiveSuggestion', json.dumps({key: data[key] for key in
                    ('token', 'source', 'before', 'after', 'larger', 'anchor', 'tab_safe')}))
                self.expiry = GLib.timeout_add_seconds(12, lambda: self.dismiss('expired'))
            def start_passive_request():
                self.service._last_model_activity = time.monotonic()
                self.service._residency.note_writing_activity()
                self.service._residency.observe_request_start(
                    'quick', self.settings.get_string('model-quick-writing'))
                try:
                    self._trace('request', model=self.settings.get_string('model-quick-writing'))
                    self.service._router.run_passive(text, self.settings, self.cancel,
                                                     completed,
                                                     residency=self.service._residency,
                                                     metadata=metadata)
                except Exception as error:
                    self._trace('request-failed', error=type(error).__name__)
                    completed(None, error)

            ticket = self.service._scheduler.submit(
                'passive', PASSIVE, start_passive_request,
                cancellable=self.cancel,
                on_ticket=lambda t: ticket_holder.update(ticket=t))
            if ticket is None:
                # Foreground intelligence work owns the model right now; the
                # correction yields instead of queuing or racing it.
                self.metrics['yielded_to_foreground'] += 1
                self._trace('passive-yielded-to-foreground')
                self.dismiss('busy')
                return GLib.SOURCE_REMOVE
        except Exception as error:
            self.metrics['capture_error_' + type(error).__name__] += 1
            if token and (not self.offer or self.offer['token'] != token):
                self.service._release_context(token)
            self.dismiss('unavailable')
        return GLib.SOURCE_REMOVE

    def _valid_anchor(self, anchor):
        return (isinstance(anchor, dict) and 1 <= anchor.get('height', 0) <= 100 and
                0 <= anchor.get('x', -1) <= self.geometry.get('width', 0) and
                0 <= anchor.get('y', -1) and anchor['y'] + anchor['height'] <= self.geometry.get('height', 0))

    def schedule_prediction(self):
        """(Re)arm the prediction pause. Continued typing restarts the timer
        and aggressively cancels any in-flight or already shown prediction."""
        self.dismiss_prediction('continued_typing')
        self._drop_timer('predict_timer')
        self.predict_timer = GLib.timeout_add(PREDICTION_DEBOUNCE_MS, self._prediction_trigger)

    def dismiss_prediction(self, reason='dismissed'):
        had_work = self.ghost is not None or self.predict_cancel is not None
        self._drop_timer('predict_timer')
        self._drop_timer('predict_expiry')
        self.predict_generation += 1
        if self.predict_cancel:
            self.predict_cancel.cancel()
            self.predict_cancel = None
            self.metrics['prediction_cancelled'] += 1
        data, self.ghost = self.ghost, None
        if data and data.get('shown') and reason in ('dismissed', 'continued_typing',
                                                     'caret', 'focus', 'expired'):
            signal = 'dismissed' if reason in ('dismissed',) else 'ignored'
            self._trace('prediction-dismissed', reason=reason, signal=signal)
            if data.get('learn') and self.settings.get_boolean('enable-learning'):
                try:
                    self.service._learning.record_prediction(data['application'], signal)
                except Exception:
                    self.metrics['learning_errors'] += 1
        # The Shell must hide a stale ghost immediately, exactly like a
        # dismissed correction; never leave an unbacked surface visible.
        if had_work and self.owner:
            self.emit('PassiveHidden', 'prediction-' + reason)
        return GLib.SOURCE_REMOVE

    def _prediction_trigger(self):
        self.predict_timer = 0
        if not self.predict_enabled:
            return GLib.SOURCE_REMOVE
        source = self.source
        now = time.monotonic()
        if (not source or self.offer or self.cancel or
                now - self.last_prediction < MIN_PREDICTION_INTERVAL or
                now < self.backoff_until):
            self._trace('prediction-ineligible', busy=bool(self.offer or self.cancel))
            return GLib.SOURCE_REMOVE
        token = None
        try:
            if not self._eligible(source):
                self._trace('prediction-ineligible', reason='field')
                return GLib.SOURCE_REMOVE
            caret = Atspi.Text.get_caret_offset(source)
            length = Atspi.Text.get_character_count(source)
            # Predict only at the very end of the text the user just typed;
            # mid-document carets cannot be inserted into safely.
            if caret < 1 or caret != length:
                self._trace('prediction-ineligible', reason='caret')
                return GLib.SOURCE_REMOVE
            base = max(0, caret - PREDICTION_CONTEXT_CHARS)
            if not self.service._public_text_range(source, max(0, base - 32), min(length, caret + 32)):
                self.metrics['sensitive_range_suppressed'] += 1
                return GLib.SOURCE_REMOVE
            nearby = Atspi.Text.get_text(source, base, caret)
            source_text = prediction_source(nearby)
            if not source_text:
                self.metrics['prediction_context_suppressed'] += 1
                self._trace('prediction-ineligible', reason='context')
                return GLib.SOURCE_REMOVE
            if self.anchor_nonce and self.anchor_feature == 'passive':
                # A correction is waiting for its anchor; do not overwrite it.
                self._trace('prediction-ineligible', reason='anchor-busy')
                return GLib.SOURCE_REMOVE
            anchor = self._resolve_anchor(
                source, caret, retry=self._prediction_trigger,
                timer_name='predict_timer',
                expiry=lambda: self.dismiss_prediction('no-anchor'))
            if anchor is None:
                return GLib.SOURCE_REMOVE
            application = (source.get_application().get_name() or '')[:128]
            learn = self.settings.get_boolean('enable-learning')
            if learn and not self.service._learning.allows_prediction(application):
                self.metrics['prediction_personalization_suppressed'] += 1
                self._trace('prediction-suppressed', reason='learning')
                return GLib.SOURCE_REMOVE
            token = secrets.token_urlsafe(24)
            context = dict(token=token, selected='', nearby='', application=application,
                role=Atspi.Role.get_name(source.get_role()), caret=caret, accessible=source,
                editable=True, passive=True, insert=True, prediction=True,
                start=caret, end=caret, length=length,
                before=Atspi.Text.get_text(source, max(0, caret - 32), caret),
                after=Atspi.Text.get_text(source, caret, min(length, caret + 32)),
                created=now, stale=False, owner=self.owner, action='prediction')
            self.service._prune_contexts()
            self.service._contexts[token] = context
            self.service._watch_context(context)
            if context.get('stale') or not context.get('ready'):
                self._trace('prediction-capture-stale')
                self.service._release_context(token)
                return GLib.SOURCE_REMOVE
            states = source.get_state_set()
            data = dict(kind='prediction', token=token, continuation='', application=application,
                source_text=source_text, anchor=anchor, caret=caret, length=length,
                tab_safe=states.contains(Atspi.StateType.MULTI_LINE) and source.get_application().get_toolkit_name() == 'GTK',
                learn=learn, shown=False)
            self.last_prediction = now
            self.metrics['prediction_requests'] += 1
            self.predict_generation += 1
            generation = self.predict_generation
            self.predict_cancel = Gio.Cancellable()
            started = now
            predict_ticket_holder = {}
            predict_metadata = {}

            def release_predict_ticket():
                ticket = predict_ticket_holder.pop('ticket', None)
                if ticket is not None:
                    self.service._residency.observe_request_end(
                        'quick', self.settings.get_string('model-quick-writing'),
                        predict_metadata)
                    ticket.release()

            def completed(continuation, error):
                release_predict_ticket()
                if generation != self.predict_generation:
                    return
                was_cancelled = (self.predict_cancel is not None and
                                 self.predict_cancel.is_cancelled())
                self.predict_cancel = None
                latency = round((time.monotonic() - started) * 1000)
                if error:
                    if was_cancelled:
                        # Superseded by foreground work: unavailability, not a
                        # provider failure.
                        self._trace('prediction-cancelled', latency_ms=latency)
                        self.service._release_context(token)
                        return
                    self.metrics['prediction_provider_errors'] += 1
                    self._trace('prediction-error', latency_ms=latency)
                    self.service._release_context(token)
                    return
                self.metrics['prediction_latency_ms_total'] += latency
                gated = clean_prediction(source_text, continuation or '')
                self._trace('prediction-gate', decision=bool(gated), chars=len(gated or ''),
                            latency_ms=latency)
                if not gated:
                    self.metrics['prediction_gate_suppressed'] += 1
                    self.service._release_context(token)
                    return
                # The user may have kept typing while the model was working.
                if not self._prediction_current(data):
                    self.metrics['prediction_stale'] += 1
                    self._trace('prediction-stale')
                    self.service._release_context(token)
                    return
                data['continuation'] = gated
                data['shown'] = True
                self.ghost = data
                self.metrics['prediction_shown'] += 1
                self._trace('prediction-shown', anchor='extents' if anchor else 'input-method')
                self.emit('PassiveSuggestion', json.dumps({
                    'kind': 'prediction', 'token': token, 'continuation': gated,
                    'anchor': anchor, 'tab_safe': data['tab_safe']}))
                self.predict_expiry = GLib.timeout_add_seconds(
                    PREDICTION_EXPIRY_SECONDS, lambda: self.dismiss_prediction('expired'))
            def start_prediction_request():
                self.service._last_model_activity = time.monotonic()
                self.service._residency.note_writing_activity()
                self.service._residency.observe_request_start(
                    'quick', self.settings.get_string('model-quick-writing'))
                try:
                    self._trace('prediction-request', model=self.settings.get_string('model-quick-writing'),
                                context_chars=len(source_text))
                    self.service._router.run_prediction(
                        source=source_text, provider_name=self.settings.get_string('model-provider'),
                        endpoint=self.settings.get_string('model-endpoint'),
                        model=self.settings.get_string('model-quick-writing'),
                        cancellable=self.predict_cancel, callback=completed,
                        residency=self.service._residency, metadata=predict_metadata)
                except Exception as error:
                    self._trace('prediction-request-failed', error=type(error).__name__)
                    completed(None, error)

            ticket = self.service._scheduler.submit(
                'prediction', PREDICTION, start_prediction_request,
                cancellable=self.predict_cancel,
                on_ticket=lambda t: predict_ticket_holder.update(ticket=t))
            if ticket is None:
                # Speculative work never races or queues behind foreground
                # intelligence: dropped silently, the next pause retries.
                self.metrics['prediction_yielded_to_foreground'] += 1
                self._trace('prediction-yielded-to-foreground')
                self.service._release_context(token)
                return GLib.SOURCE_REMOVE
        except Exception as error:
            self.metrics['prediction_error_' + type(error).__name__] += 1
            if token and (not self.ghost or self.ghost['token'] != token):
                self.service._release_context(token)
            self.dismiss_prediction('unavailable')
        return GLib.SOURCE_REMOVE

    def _prediction_current(self, data):
        """Freshness check before showing or accepting: the same field is
        still focused and its caret and length are unchanged."""
        source = self.source
        if not source or not self._eligible(source):
            return False
        try:
            return (Atspi.Text.get_caret_offset(source) == data['caret'] and
                    Atspi.Text.get_character_count(source) == data['length'])
        except Exception:
            return False

    def accept_prediction(self, token, words):
        """Insert the whole continuation (words=0) or its first words. The
        insertion reuses the guarded caret-range editor; the remainder stays
        as ghost text at the new caret."""
        data = self.ghost
        if not data or token != data['token']:
            return False, 'This prediction is no longer current.'
        context = self.service._contexts.get(token)
        if not data.get('shown') or not context or not self._prediction_current(data):
            self._trace('prediction-accept-refused', reason='stale')
            self.dismiss_prediction('stale')
            return False, 'The text changed; nothing was inserted.'
        prefix, remainder = _prediction_prefix(data['continuation'], words)
        if not prefix:
            return False, 'Nothing to insert.'
        result, message = self.service._replace(token, prefix, False)
        self._trace('prediction-insert', success=bool(result), partial=bool(remainder))
        if not result:
            self.metrics['prediction_insert_refused'] += 1
            return result, message
        self._drop_timer('predict_expiry')
        if self.settings.get_boolean('enable-learning') and data.get('learn'):
            try:
                self.service._learning.record_prediction(
                    data['application'], 'partial' if remainder else 'accepted')
            except Exception:
                self.metrics['learning_errors'] += 1
        if not remainder:
            self.ghost = None
            # The insertion leaves the caret at the end of the inserted text;
            # the undo verification must expect that position.
            context['caret'] = context['undo_end']
            try:
                Atspi.Text.set_caret_offset(context['accessible'], context['undo_end'])
            except Exception:
                pass
            # A short guarded undo watch; typing removes it and an immediate
            # undo is recorded as a negative prediction signal.
            # Settle any still-running correction watch first: its outcome and
            # timer must not be overwritten by the prediction's post state.
            self.finish_post()
            self.post = dict(data, accessible=context['accessible'],
                start=context['start'], end=context['end'], length=context['length'],
                edit_end=context['undo_end'], dirty=False, range_uncertain=False,
                learn=data.get('learn'), retain=False, source=prefix,
                replacement=prefix, category='prediction', pattern='',
                context_type='prediction', model=self.settings.get_string('model-quick-writing'),
                prediction=True)
            self._trace('prediction-accepted')
            self.emit('PassiveSuggestion', json.dumps({
                'kind': 'prediction_done', 'token': token}))
            self.post_timer = GLib.timeout_add_seconds(8, self._finish_prediction_post)
            return True, 'Continuation inserted.'
        # Partial acceptance: re-anchor the remaining ghost at the new caret.
        context.pop('replaced', None)
        context.pop('undo_original', None)
        context['start'] = context['end'] = context['caret'] = context['undo_end']
        context['before'] = (context['before'] + prefix)[-32:]
        context['after'] = ''
        data['continuation'] = remainder
        data['caret'] = context['caret']
        data['length'] = context['length']
        self.ghost = data
        try:
            Atspi.Text.set_caret_offset(context['accessible'], context['caret'])
        except Exception:
            pass
        self.anchor_nonce = secrets.token_urlsafe(18)
        self.anchor_retry = lambda: self._reshow_prediction(data)
        self.anchor_feature = 'prediction'
        self.emit('PassiveAnchorRequest', self.anchor_nonce)
        self.predict_expiry = GLib.timeout_add_seconds(
            PREDICTION_EXPIRY_SECONDS, lambda: self.dismiss_prediction('expired'))
        return True, 'Continuation inserted.'

    def _reshow_prediction(self, data):
        if not self.ghost or self.ghost['token'] != data['token']:
            return
        anchor = self.anchor_cache or data.get('anchor', {})
        self.anchor_cache = None
        self._trace('prediction-reshown', partial=True)
        self.emit('PassiveSuggestion', json.dumps({
            'kind': 'prediction', 'token': data['token'], 'continuation': data['continuation'],
            'anchor': anchor, 'tab_safe': data['tab_safe']}))

    def _finish_prediction_post(self):
        self._drop_timer('post_timer')
        data, self.post = self.post, None
        if not data:
            return GLib.SOURCE_REMOVE
        # The acceptance signal was recorded when the continuation was
        # inserted; an explicit Ctrl+Alt+Z undo records its own signal.
        self.service._release_context(data['token'])
        self.emit('PassiveHidden', 'expired')
        return GLib.SOURCE_REMOVE

    def set_anchor(self, nonce, anchor):
        if nonce != self.anchor_nonce or not (self.enabled or self.predict_enabled):
            return
        # Whichever feature requested the anchor, its no-anchor expiry must
        # not fire after the answer arrived.
        self._drop_timer('timer')
        self._drop_timer('predict_timer')
        self.anchor_nonce = None
        self.anchor_feature = None
        self.anchor_cache = anchor
        retry, self.anchor_retry = self.anchor_retry, None
        if retry:
            retry()

    def current(self):
        data = self.offer
        if not data or not self._eligible(data['accessible']): return False
        context = self.service._contexts.get(data['token'])
        return bool(context and self.service._selection_is_current(context, context['start'], context['end'], context['selected']))

    def dismiss(self, reason='dismissed'):
        self._drop_timer('timer'); self._drop_timer('expiry')
        if reason in ('dismissed', 'explicit'):
            self.finish_post()
        self.anchor_nonce = self.anchor_cache = None
        self.anchor_feature = None
        self.generation += 1
        if self.cancel:
            self.cancel.cancel(); self.cancel = None
            self.metrics['cancelled'] += 1
        data, self.offer = self.offer, None
        if data:
            if data.get('shown') and reason in ('dismissed', 'continued_typing'):
                self._record(data, reason)
            self.service._release_context(data['token'])
        if self.owner:
            self.emit('PassiveHidden', reason)
        return GLib.SOURCE_REMOVE

    def accept(self, token):
        if not self.offer or token != self.offer['token'] or not self.current():
            self._trace('replace-refused', reason='stale')
            self.dismiss('stale'); return False, 'The text changed; no replacement was made.'
        data = self.offer
        if not data.get('shown'):
            return False, 'No correction is ready.'
        self._drop_timer('expiry')
        result, message = self.service._replace(token, data['replacement'], False)
        self._trace('replace-result', success=bool(result))
        if not result:
            # Preserve the bounded original until dismissal/expiry so the UI can
            # offer Copy original after an uncertain remote edit.
            self.metrics['replacement_refused'] += 1
            return result, message
        self.offer = None
        self.post = data
        self.post['edit_end'] = data['start'] + len(data['replacement'])
        self.post['dirty'] = False
        try:
            Atspi.Text.set_caret_offset(data['accessible'], data['caret'] + len(data['replacement']) - len(data['source']))
        except Exception:
            pass
        self.metrics['accepted'] += 1
        self.post_timer = GLib.timeout_add_seconds(8, self.finish_post)
        return True, 'Correction applied. GDI Undo is available briefly while the range stays unchanged.'

    def _post_event(self, event):
        data = self.post
        observed = ('insert' if 'insert' in event.type else 'delete', event.detail1, event.detail2)
        previous = data.get('last_post_event')
        now = time.monotonic()
        if previous and previous[0] == observed and now - previous[1] < .02:
            return
        data['last_post_event'] = (observed, now)
        data['dirty'] = True
        offset, count = event.detail1, event.detail2
        if not data['start'] <= offset <= data['edit_end']:
            data['range_uncertain'] = True
        # GTK can duplicate or coalesce notifications. The live character count
        # is authoritative; do not double-apply event lengths to the range.
        data['edit_end'] = data['end'] + Atspi.Text.get_character_count(data['accessible']) - data['length']
        # Typing always removes the Undo surface; the short learning watch stays
        # bounded to this one field/range and never reads event text.
        self.emit('PassiveHidden', 'continued_typing')

    def undo(self, token):
        data = self.post
        if not data or token != data['token'] or not self._eligible(data['accessible']):
            return False, 'This correction is no longer current.'
        result, message = self.service._undo(token)
        if result:
            if data.get('prediction'):
                if self.settings.get_boolean('enable-learning') and data.get('learn'):
                    try:
                        self.service._learning.record_prediction(data['application'], 'immediate_undo')
                    except Exception:
                        self.metrics['learning_errors'] += 1
            else:
                self._record(data, 'immediate_undo')
            self._drop_timer('post_timer')
            self.post = None
            self.service._release_context(token)
            self.emit('PassiveHidden', 'undo')
        return result, message

    def finish_post(self):
        self._drop_timer('post_timer')
        data, self.post = self.post, None
        if not data: return GLib.SOURCE_REMOVE
        if data.get('prediction'):
            # The prediction outcome signal was recorded at acceptance; this
            # watch only bounds how long the undo range stays protected.
            self.service._release_context(data['token'])
            self.emit('PassiveHidden', 'expired')
            return GLib.SOURCE_REMOVE
        try:
            final = None
            if (data.get('learn') and not data.get('range_uncertain') and
                    self._eligible(data['accessible']) and
                    Atspi.Text.get_character_count(data['accessible']) == data['length'] + data['edit_end'] - data['end']):
                end = data['edit_end']
                if (data['start'] <= end <= data['start'] + 350 and
                        self.service._public_text_range(data['accessible'], data['start'], end)):
                    final = Atspi.Text.get_text(data['accessible'], data['start'], end)
            if data['dirty'] and final is None:
                self.metrics['edited_example_unverified'] += 1
            outcome = ('immediate_undo' if final == data['source'] else
                       'accepted_edited' if data['dirty'] else 'accepted_unchanged')
            self._record(data, outcome, final)
        finally:
            self.service._release_context(data['token'])
        self.emit('PassiveHidden', 'expired')
        return GLib.SOURCE_REMOVE

    def _record(self, data, outcome, final=None):
        if data.get('learn') and self.settings.get_boolean('enable-learning'):
            try:
                self.service._learning.outcome(data, outcome, final,
                    data.get('retain') and self.settings.get_boolean('retain-learning-examples'))
            except Exception:
                self.metrics['learning_errors'] += 1

    def stats(self):
        return dict(self.metrics, enabled=self.enabled, prediction_enabled=self.predict_enabled,
                    listeners=len(EVENTS) if self.listener else 0,
                    timers=sum(bool(value) for value in (self.timer, self.expiry, self.post_timer,
                                                         self.predict_timer, self.predict_expiry)),
                    active_request=self.cancel is not None,
                    prediction_active=self.predict_cancel is not None,
                    average_latency_ms=round(self.metrics['latency_ms_total'] / max(1, self.metrics['completed'])),
                    recent=list(self.trace))
