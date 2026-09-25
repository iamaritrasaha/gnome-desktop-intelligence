#!/usr/bin/python3
"""GNOME Desktop Intelligence session service.

This service handles explicit writing requests, short-lived AT-SPI context, and
minimal opt-in learning signals. It never accepts or executes shell commands.
"""

import json
import os
import secrets
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib

from router import ModelRouter, normalize_intent_response
from selection import SelectionContext
from learning import LearningStore
from history import HistoryStore
from passive import PassiveWriting
from pathlib import Path
from providers.base import ProviderError


BUS_NAME = "org.gnome.DesktopIntelligence1"
OBJECT_PATH = "/org/gnome/DesktopIntelligence1"
INTERFACE = "org.gnome.DesktopIntelligence1"
CONTEXT_LIFETIME_SECONDS = 900
MAX_CONTEXTS = 8

INTROSPECTION_XML = """
<node>
  <interface name="org.gnome.DesktopIntelligence1">
    <method name="GetFocusedContext">
      <arg type="i" name="pid" direction="in"/>
      <arg type="s" name="token" direction="out"/>
      <arg type="s" name="selected_text" direction="out"/>
      <arg type="s" name="nearby_context" direction="out"/>
      <arg type="s" name="application" direction="out"/>
      <arg type="s" name="role" direction="out"/>
      <arg type="i" name="start_offset" direction="out"/>
      <arg type="i" name="end_offset" direction="out"/>
      <arg type="i" name="caret_offset" direction="out"/>
      <arg type="b" name="editable" direction="out"/>
      <arg type="s" name="capabilities" direction="out"/>
    </method>
    <method name="GetCaretContext">
      <arg type="i" name="pid" direction="in"/>
      <arg type="s" name="kind" direction="in"/>
      <arg type="s" name="token" direction="out"/>
      <arg type="s" name="selected_text" direction="out"/>
      <arg type="s" name="nearby_context" direction="out"/>
      <arg type="s" name="application" direction="out"/>
      <arg type="s" name="role" direction="out"/>
      <arg type="i" name="start_offset" direction="out"/>
      <arg type="i" name="end_offset" direction="out"/>
      <arg type="i" name="caret_offset" direction="out"/>
      <arg type="b" name="editable" direction="out"/>
      <arg type="s" name="capabilities" direction="out"/>
    </method>
    <method name="AcceptPrediction">
      <arg type="s" name="token" direction="in"/>
      <arg type="i" name="words" direction="in"/>
      <arg type="b" name="success" direction="out"/>
      <arg type="s" name="message" direction="out"/>
    </method>
    <method name="HistoryStart"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="HistoryAdd"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
    <method name="HistoryTrim"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
    <method name="HistoryList"><arg type="s" direction="out"/></method>
    <method name="HistoryGet"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="HistoryRename"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
    <method name="HistoryDelete"><arg type="s" direction="in"/></method>
    <method name="HistoryClear">
      <arg type="b" name="success" direction="out"/>
    </method>
    <method name="ReleaseContext"><arg type="s" direction="in"/></method>
    <method name="ProviderStatus"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="Transform">
      <arg type="s" name="token" direction="in"/>
      <arg type="s" name="action" direction="in"/>
      <arg type="s" name="selected_text" direction="in"/>
      <arg type="s" name="nearby_context" direction="in"/>
      <arg type="s" name="question" direction="in"/>
      <arg type="s" name="provider" direction="in"/>
      <arg type="s" name="endpoint" direction="in"/>
      <arg type="s" name="quick_model" direction="in"/>
      <arg type="s" name="intent_model" direction="in"/>
      <arg type="s" name="assistant_model" direction="in"/>
      <arg type="s" name="reasoning_model" direction="in"/>
      <arg type="i" name="timeout" direction="in"/>
      <arg type="i" name="context_tokens" direction="in"/>
      <arg type="i" name="output_tokens" direction="in"/>
      <arg type="s" name="response" direction="out"/>
    </method>
    <method name="CancelTransform">
      <arg type="s" name="token" direction="in"/>
    </method>
    <method name="Replace">
      <arg type="s" name="token" direction="in"/>
      <arg type="s" name="replacement" direction="in"/>
      <arg type="b" name="learning_enabled" direction="in"/>
      <arg type="b" name="success" direction="out"/>
      <arg type="s" name="message" direction="out"/>
    </method>
    <method name="Undo">
      <arg type="s" name="token" direction="in"/>
      <arg type="b" name="success" direction="out"/>
      <arg type="s" name="message" direction="out"/>
    </method>
    <method name="RecordSignal">
      <arg type="s" name="token" direction="in"/>
      <arg type="s" name="action" direction="in"/>
      <arg type="s" name="signal" direction="in"/>
      <arg type="b" name="learning_enabled" direction="in"/>
    </method>
    <signal name="PassiveAnchorRequest"><arg type="s"/></signal>
    <method name="SetPassiveAnchor"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
    <method name="PurgeLearningExamples"/>
    <signal name="PassiveSuggestion"><arg type="s"/></signal>
    <signal name="PassiveHidden"><arg type="s"/></signal>
    <method name="ConfigurePassive"><arg type="b" direction="in"/><arg type="b" direction="in"/><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
    <method name="AcceptPassive"><arg type="s" direction="in"/><arg type="b" direction="out"/><arg type="s" direction="out"/></method>
    <method name="DismissPassive"><arg type="s" direction="in"/></method>
    <method name="UndoPassive"><arg type="s" direction="in"/><arg type="b" direction="out"/><arg type="s" direction="out"/></method>
    <method name="LearningStats"><arg type="s" direction="out"/></method>
    <method name="PassiveStats"><arg type="s" direction="out"/></method>
    <method name="ActionStats"><arg type="s" direction="out"/></method>
    <method name="RecordActionDiagnostic"><arg type="s" direction="in"/></method>
    <method name="RecordActionUse"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
    <method name="ResetActionStats"/>
    <method name="RouteAction">
      <arg type="s" name="question" direction="in"/>
      <arg type="s" name="registry" direction="in"/>
      <arg type="s" name="response" direction="out"/>
    </method>
    <method name="ClearLearning">
      <arg type="b" name="success" direction="out"/>
    </method>
  </interface>
</node>
"""

# Preserve the original Transform contract for installed clients and regression probes.
_stream_method = INTROSPECTION_XML.split('<method name="Transform">', 1)[1].split('</method>', 1)[0]
_stream_method = _stream_method.replace('<arg type="s" name="response" direction="out"/>',
    '<arg type="s" name="request_id" direction="in"/><arg type="s" name="history" direction="in"/>'
    '<arg type="s" name="conversation_id" direction="in"/><arg type="s" name="response" direction="out"/>')
INTROSPECTION_XML = INTROSPECTION_XML.replace('</interface>',
    '<method name="TransformStream">' + _stream_method + '</method>'
    '<signal name="ResponseChunk"><arg type="s"/><arg type="s"/><arg type="s"/></signal>'
    '<method name="RequestStats"><arg type="s" direction="out"/></method>'
    '<method name="CancelRequest"><arg type="s" direction="in"/><arg type="s" direction="in"/></method></interface>')


class GdiService(SelectionContext):
    def __init__(self, connection):
        self._connection = connection
        self._router = ModelRouter()
        self._request_stats = []
        self._learning = LearningStore()
        schema_source = Gio.SettingsSchemaSource.new_from_directory(
            str(Path(__file__).resolve().parent.parent / 'schemas'), Gio.SettingsSchemaSource.get_default(), False)
        self._settings = Gio.Settings.new_full(schema_source.lookup('org.gnome.shell.extensions.gdi', False), None, None)
        if not self._settings.get_boolean('retain-learning-examples'):
            self._learning.purge_examples()
        self._passive = PassiveWriting(self, self._settings, self._emit_passive)
        self._contexts = {}
        self._requests = {}
        self._action_stats = []
        self._route_actions = 0
        self._history = None
        self._owner_signal = connection.signal_subscribe(
            "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
            "/org/freedesktop/DBus", None, Gio.DBusSignalFlags.NONE,
            self._owner_changed)
        self._node_info = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION_XML)
        self._registration_id = connection.register_object(
            OBJECT_PATH,
            self._node_info.interfaces[0],
            self._on_method_call,
            None,
            None,
        )

    def _emit_passive(self, name, payload):
        if self._passive.owner:
            self._connection.emit_signal(self._passive.owner, OBJECT_PATH, INTERFACE, name,
                                         GLib.Variant('(s)', (payload,)))

    def _owner_changed(self, _bus, _sender, _path, _interface, _signal, params):
        name, old, new = params.unpack()
        if not old or new:
            return
        if self._passive.owner == name:
            self._passive.stop()
            self._passive.owner = None
        for token, context in list(self._contexts.items()):
            if context.get("owner") == name:
                self._release_context(token)
        for token, request in list(self._requests.items()):
            if request.get("owner") == name:
                self._cancel_transform(token)

    def _history_store(self):
        """Lazily opened: no history database I/O happens until a client uses
        the History feature."""
        if self._history is None:
            self._history = HistoryStore()
        return self._history

    def _capabilities_for(self, context):
        """Derive the focused element's writing capabilities from the raw
        snapshot. Metadata only; no text and no secrets are reported."""
        accessible = context.get("accessible")
        role = context.get("role", "")
        caps = {
            "hasField": accessible is not None,
            "application": context.get("application", ""),
            "role": role,
            "canReadText": accessible is not None,
            "canReadSelection": bool(context.get("selected")),
            "canGetCaret": context.get("caret", -1) >= 0,
            "canReplaceSelection": False,
            "canInsertText": bool(context.get("insert")),
            "canObserveTyping": False,
            "canPassiveAssist": False,
            "reason": "",
        }
        if caps["canReadSelection"] and context.get("editable"):
            caps["canReplaceSelection"] = True
        if accessible is not None:
            try:
                caps["canObserveTyping"] = self._passive.supports_field(context)
            except Exception:
                caps["canObserveTyping"] = False
        # The same eligibility family (GTK multiline, non-secret, editable)
        # governs reading the sentence/paragraph at the caret on an explicit
        # no-selection writing action.
        caps["canReadCaretContext"] = caps["canObserveTyping"]
        if context.get("focus_reason") == "secret":
            caps["reason"] = "protected-field"
        elif accessible is None:
            caps["reason"] = "no-accessible-field"
        elif not caps["canReadSelection"] and not caps["canInsertText"]:
            caps["reason"] = "no-readable-selection"
        elif caps["canReadSelection"] and not context.get("editable"):
            caps["reason"] = "not-editable"
        caps["canPassiveAssist"] = caps["canObserveTyping"]
        return caps

    def _on_method_call(self, _connection, _sender, _path, _interface,
                        method, parameters, invocation):
        try:
            args = parameters.unpack()
            if method == 'ConfigurePassive':
                geometry = json.loads(args[3])
                if not isinstance(geometry, dict): raise ValueError('Invalid window geometry')
                self._passive.configure(_sender, args[0], args[1], args[2], geometry)
                invocation.return_value(GLib.Variant('()', ()))
            elif method == 'GetCaretContext':
                self._passive.dismiss('explicit')
                context = self._capture_caret_context(args[0], args[1] if args[1] in ('sentence', 'paragraph') else 'sentence')
                context["owner"] = _sender
                context["expiry_id"] = GLib.timeout_add_seconds(CONTEXT_LIFETIME_SECONDS, lambda: self._expire_context(context["token"]))
                invocation.return_value(GLib.Variant(
                    "(sssssiiibs)", (
                        context["token"], context["selected"], context["nearby"],
                        context["application"], context["role"],
                        context["start"], context["end"], context["caret"], context["editable"],
                        json.dumps(self._capabilities_for(context)),
                    )))
            elif method == 'AcceptPrediction':
                if self._passive.owner != _sender: raise ValueError('Passive session belongs to another client')
                success, message = self._passive.accept_prediction(args[0], args[1])
                invocation.return_value(GLib.Variant('(bs)', (success, message)))
            elif method == 'HistoryStart':
                if not self._settings.get_boolean('save-intelligence-history'):
                    invocation.return_value(GLib.Variant('(s)', ('',)))
                    return
                invocation.return_value(GLib.Variant(
                    '(s)', (self._history_store().start_conversation(args[0][:128]),)))
            elif method == 'HistoryAdd':
                if self._settings.get_boolean('save-intelligence-history'):
                    self._history_store().add_message(args[0], args[1], args[2])
                invocation.return_value(GLib.Variant('()', ()))
            elif method == 'HistoryTrim':
                if self._settings.get_boolean('save-intelligence-history'):
                    self._history_store().trim(args[0], args[1])
                invocation.return_value(GLib.Variant('()', ()))
            elif method == 'HistoryList':
                invocation.return_value(GLib.Variant(
                    '(s)', (json.dumps(self._history_store().list_conversations()),)))
            elif method == 'HistoryGet':
                invocation.return_value(GLib.Variant(
                    '(s)', (json.dumps(self._history_store().get_conversation(args[0]) or {}),)))
            elif method == 'HistoryRename':
                self._history_store().rename(args[0], args[1])
                invocation.return_value(GLib.Variant('()', ()))
            elif method == 'HistoryDelete':
                self._history_store().delete(args[0])
                invocation.return_value(GLib.Variant('()', ()))
            elif method == 'HistoryClear':
                success = True
                if self._history is not None:
                    success = self._history.clear()
                invocation.return_value(GLib.Variant('(b)', (success,)))
            elif method == 'SetPassiveAnchor':
                if self._passive.owner != _sender: raise ValueError('Wrong passive owner')
                self._passive.set_anchor(args[0], json.loads(args[1]))
                invocation.return_value(GLib.Variant('()', ()))
            elif method == 'PurgeLearningExamples':
                if not self._settings.get_boolean('retain-learning-examples'):
                    self._learning.purge_examples()
                invocation.return_value(GLib.Variant('()', ()))
            elif method in ('AcceptPassive', 'UndoPassive', 'DismissPassive'):
                if self._passive.owner != _sender: raise ValueError('Passive session belongs to another client')
                if method == 'DismissPassive':
                    reason = args[0] if args[0] in ('dismissed', 'focus', 'explicit') else 'dismissed'
                    self._passive.dismiss(reason)
                    self._passive.dismiss_prediction(reason)
                    invocation.return_value(GLib.Variant('()', ()))
                else:
                    def passive_edit():
                        try:
                            result = self._passive.accept(args[0]) if method == 'AcceptPassive' else self._passive.undo(args[0])
                            invocation.return_value(GLib.Variant('(bs)', result))
                        except Exception as error:
                            invocation.return_dbus_error(f'{INTERFACE}.Error.Failed', str(error)[:512])
                        return GLib.SOURCE_REMOVE
                    if method == 'UndoPassive' and self._contexts.get(args[0], {}).get('awaiting_own'):
                        GLib.timeout_add(75, passive_edit)
                    else:
                        passive_edit()
            elif method in ('LearningStats', 'PassiveStats', 'ActionStats'):
                if method == 'LearningStats':
                    stats = self._learning.stats()
                elif method == 'PassiveStats':
                    stats = self._passive.stats()
                else:
                    stats = {'recent': self._action_stats}
                    if self._settings.get_boolean('enable-learning'):
                        try:
                            ranking = self._learning.action_ranking()
                            stats['apps'] = ranking.get('app.open', {})
                            stats['dirs'] = ranking.get('directory.open', {})
                        except Exception:
                            stats['apps'] = {}
                            stats['dirs'] = {}
                    else:
                        stats['apps'] = {}
                        stats['dirs'] = {}
                invocation.return_value(GLib.Variant('(s)', (json.dumps(stats),)))
            elif method == 'RecordActionDiagnostic':
                try:
                    record = json.loads(args[0])
                    if not isinstance(record, dict):
                        raise ValueError('not an object')
                    if len(json.dumps(record)) > 4096:
                        record = {'status': 'oversized-record'}
                except Exception:
                    record = {'status': 'unparsed-record'}
                self._action_stats.append(record)
                self._action_stats[:] = self._action_stats[-50:]
                invocation.return_value(GLib.Variant('()', ()))
            elif method == 'RecordActionUse':
                if self._settings.get_boolean('enable-learning'):
                    try:
                        self._learning.record(args[0][:64], 'accepted', args[1][:128])
                    except Exception as error:
                        print(f"GDI learning store unavailable: {error}", flush=True)
                invocation.return_value(GLib.Variant('()', ()))
            elif method == 'ResetActionStats':
                self._action_stats[:] = []
                invocation.return_value(GLib.Variant('()', ()))
            elif method == 'RouteAction':
                question, registry_json = args
                if not question.strip() or len(question) > 200:
                    raise ProviderError("The request is outside GDI's routing limits.")
                if len(registry_json) > 16384:
                    raise ProviderError("The action registry exceeded GDI's limit.")
                registry = json.loads(registry_json)
                if not isinstance(registry, list):
                    raise ProviderError('Invalid action registry.')
                if self._route_actions >= 2:
                    raise ProviderError('GDI is busy. Try again shortly.')
                self._route_actions += 1

                def routed(response, error):
                    self._route_actions = max(0, self._route_actions - 1)
                    try:
                        if error is not None:
                            invocation.return_dbus_error(
                                f'{INTERFACE}.Error.Provider',
                                'The routing model could not answer.')
                            return
                        invocation.return_value(GLib.Variant(
                            '(s)', (json.dumps(normalize_intent_response(response)),)))
                    except Exception:
                        pass  # The client disappeared; nothing to answer.

                try:
                    self._router.run_intent_mapping(
                        question=question, registry=registry_json,
                        provider_name=self._settings.get_string('model-provider'),
                        endpoint=self._settings.get_string('model-endpoint'),
                        model=self._settings.get_string('model-intent-routing'),
                        cancellable=Gio.Cancellable(), callback=routed,
                        timeout=min(20, self._settings.get_int('request-timeout')))
                except Exception as error:
                    self._route_actions = max(0, self._route_actions - 1)
                    raise
            elif method == "GetFocusedContext":
                self._passive.dismiss('explicit')
                context = self._capture_focused_context(args[0])
                context["owner"] = _sender
                context["expiry_id"] = GLib.timeout_add_seconds(CONTEXT_LIFETIME_SECONDS, lambda: self._expire_context(context["token"]))
                invocation.return_value(GLib.Variant(
                    "(sssssiiibs)", (
                        context["token"], context["selected"], context["nearby"],
                        context["application"], context["role"],
                        context["start"], context["end"], context["caret"], context["editable"],
                        json.dumps(self._capabilities_for(context)),
                    )))
            elif method == "ProviderStatus":
                def checked(status, error):
                    invocation.return_value(GLib.Variant("(s)", (json.dumps(status if not error else {"available": False, "models": [], "error": str(error)}),)))
                self._router.provider(args[0]).health(endpoint=args[1], cancellable=Gio.Cancellable(), callback=checked)
            elif method in ("Transform", "TransformStream"):
                self._start_transform(args[:14], invocation, _sender,
                    args[14] if method == 'TransformStream' else None,
                    json.loads(args[15]) if method == 'TransformStream' else None,
                    args[16] if method == 'TransformStream' else None)
            elif method == 'RequestStats':
                invocation.return_value(GLib.Variant('(s)', (json.dumps({'recent': self._request_stats, 'active': len(self._requests)}),)))
            elif method == "ReleaseContext":
                self._check_owner(args[0], _sender)
                self._release_context(args[0])
                invocation.return_value(GLib.Variant("()", ()))
            elif method == 'CancelRequest':
                self._check_owner(args[0], _sender)
                if self._requests.get(args[0], {}).get('request_id') == args[1]:
                    self._cancel_transform(args[0])
                invocation.return_value(GLib.Variant('()', ()))
            elif method == "CancelTransform":
                self._check_owner(args[0], _sender)
                self._cancel_transform(args[0])
                invocation.return_value(GLib.Variant("()", ()))
            elif method == "Replace":
                self._check_owner(args[0], _sender)
                success, message = self._replace(args[0], args[1], args[2])
                invocation.return_value(GLib.Variant("(bs)", (success, message)))
            elif method == "Undo":
                self._check_owner(args[0], _sender)
                def undo_when_settled():
                    try:
                        success, message = self._undo(args[0])
                        invocation.return_value(GLib.Variant("(bs)", (success, message)))
                    except Exception as error:
                        invocation.return_dbus_error(f"{INTERFACE}.Error.Failed", str(error)[:512])
                    return GLib.SOURCE_REMOVE
                if self._contexts.get(args[0], {}).get("awaiting_own"):
                    GLib.timeout_add(75, undo_when_settled)
                else:
                    undo_when_settled()
            elif method == "RecordSignal":
                self._check_owner(args[0], _sender)
                self._record_signal(*args)
                invocation.return_value(GLib.Variant("()", ()))
            elif method == "ClearLearning":
                self._passive.forget_learning()
                for context in self._contexts.values():
                    context["learning_enabled"] = False
                invocation.return_value(GLib.Variant(
                    "(b)", (self._learning.clear(),)))
            else:
                invocation.return_dbus_error(
                    f"{INTERFACE}.Error.UnknownMethod", "Unknown GDI method.")
        except Exception as error:
            invocation.return_dbus_error(
                f"{INTERFACE}.Error.Failed", str(error)[:512])

    def _check_owner(self, token, sender):
        record = self._contexts.get(token) or self._requests.get(token)
        if record and record.get("owner") != sender:
            raise ProviderError("This request belongs to another client.")

    def _expire_context(self, token):
        context = self._contexts.get(token)
        if context:
            context.pop("expiry_id", None)
        self._release_context(token)
        return GLib.SOURCE_REMOVE

    def _release_context(self, token):
        self._cancel_transform(token)
        context = self._contexts.pop(token, None)
        if not context:
            return
        for key in ("expiry_id", "settle_id"):
            if context.get(key):
                GLib.source_remove(context[key])
        if getattr(self, "_revision_listener", None) and not any(item.get("watched") for item in self._contexts.values()):
            self._revision_listener.deregister("object:text-changed")
            self._revision_listener = None

    def _prune_contexts(self):
        now = time.monotonic()
        for token, context in list(self._contexts.items()):
            if now - context["created"] > CONTEXT_LIFETIME_SECONDS:
                self._release_context(token)
        while len(self._contexts) >= MAX_CONTEXTS:
            oldest = min(self._contexts, key=lambda token: self._contexts[token]["created"])
            self._release_context(oldest)

    def _get_context(self, token, require_selection=True):
        self._prune_contexts()
        context = self._contexts.get(token)
        if context is None:
            raise ProviderError("The selected text context expired. Select the text again.")
        if require_selection and (context["accessible"] is None or (not context["selected"] and not context.get("insert"))):
            raise ProviderError("GDI could not read a selected text range in this field.")
        return context

    def _start_transform(self, args, invocation, sender, request_id=None, history=None, conversation_id=None):
        (token, action, selected, nearby, question, provider, endpoint,
         quick_model, intent_model, assistant_model, reasoning_model, timeout, context_tokens, output_tokens) = args
        self._check_owner(token, sender)
        if action not in ("assistant", "harder"):
            context = self._get_context(token)
            if selected != context["selected"] or nearby != context["nearby"]:
                raise ProviderError("The writing context changed. Select the text again.")
        elif selected or nearby:
            raise ProviderError("Standalone requests cannot include hidden selection context.")
        if request_id is not None and (not request_id or len(request_id) > 64):
            raise ProviderError('Invalid request identifier.')
        if conversation_id is not None and len(conversation_id) > 64:
            raise ProviderError('Invalid conversation identifier.')
        if len(self._requests) >= 4 and token not in self._requests:
            raise ProviderError("GDI is busy. Cancel an existing request first.")
        if token in self._requests:
            self._cancel_transform(token)

        cancellable = Gio.Cancellable()
        request = {"cancellable": cancellable, "invocation": invocation, "owner": sender, "request_id": request_id}
        self._requests[token] = request

        started = time.monotonic()
        request["started"] = started
        request["action"] = action
        first_token = None
        route = 'quick' if action in ('proofread', 'rewrite', 'concise', 'expand', 'professional',
                                      'casual', 'friendly', 'direct', 'continue', 'translate') else 'reasoning' if action == 'harder' else 'assistant'
        def chunk(delta):
            nonlocal first_token
            if self._requests.get(token) is not request or cancellable.is_cancelled():
                return
            if first_token is None:
                first_token = round((time.monotonic() - started) * 1000)
            self._connection.emit_signal(sender, OBJECT_PATH, INTERFACE, 'ResponseChunk',
                GLib.Variant('(sss)', (token, request_id, delta)))

        def completed(response, error):
            if self._requests.get(token) is not request:
                return
            self._requests.pop(token, None)
            persisted = None
            # Assistant answers land in the local conversation only when the
            # request carried a conversation id and history saving is enabled.
            if (not error and response and conversation_id and action in ('assistant', 'harder', 'ask', 'explain', 'summarize', 'keypoints')
                    and self._settings.get_boolean('save-intelligence-history')):
                try:
                    persisted = self._history_store().add_message(conversation_id, 'assistant', response)
                except Exception:
                    persisted = False
            self._request_stats.append({'action': action, 'route': route,
                'model': {'quick': quick_model, 'assistant': assistant_model, 'reasoning': reasoning_model}[route],
                'first_token_ms': first_token, 'total_ms': round((time.monotonic() - started) * 1000),
                'question_chars': len(question or ''),
                'conversation_id': conversation_id or None, 'persisted': persisted,
                'status': 'error' if error else 'complete'})
            self._request_stats[:] = self._request_stats[-50:]
            if error is not None:
                invocation.return_dbus_error(
                    f"{INTERFACE}.Error.Provider", str(error)[:512] if isinstance(error, ProviderError) else "Intelligence could not complete this request. Retry or check AI Settings.")
            else:
                invocation.return_value(GLib.Variant("(s)", (response,)))

        try:
            preferences = None
            if self._settings.get_boolean('enable-learning'):
                try:
                    preferences = self._learning.stats().get('preferences')
                except Exception:
                    pass
            self._router.run(
                action=action,
                selected=selected,
                context=nearby,
                question=question,
                provider_name=provider,
                endpoint=endpoint,
                quick_model=quick_model,
                intent_model=intent_model,
                assistant_model=assistant_model,
                reasoning_model=reasoning_model,
                cancellable=cancellable,
                callback=completed, timeout=timeout, context_tokens=context_tokens, output_tokens=output_tokens,
                on_chunk=chunk if request_id and route != 'quick' else None,
                history=history, preferences=preferences,
            )
        except Exception as error:
            completed(None, error)

    def _cancel_transform(self, token):
        request = self._requests.pop(token, None)
        if request is not None:
            if 'started' in request:
                self._request_stats.append({'action': request['action'], 'status': 'cancelled',
                    'total_ms': round((time.monotonic() - request['started']) * 1000)})
                self._request_stats[:] = self._request_stats[-50:]
            request["cancellable"].cancel()
            request["invocation"].return_dbus_error(
                f"{INTERFACE}.Error.Cancelled", "Writing request was cancelled.")

    def _record(self, context, action, signal):
        if not self._settings.get_boolean("enable-learning"):
            return
        if signal not in ("action_selected", "accepted", "rejected", "accepted_edited", "immediate_undo"):
            return
        try:
            self._learning.record(action[:64], signal, context["application"])
        except Exception as error:
            print(f"GDI learning store unavailable: {error}", flush=True)

    def _record_signal(self, token, action, signal, learning_enabled):
        if not learning_enabled or signal not in ("action_selected", "rejected"):
            return
        context = self._get_context(token, require_selection=False)
        context["action"] = action
        self._record(context, action, signal)



def main():
    try:
        Atspi.init()
        Atspi.set_timeout(250, 250)
    except Exception as error:
        print(f"GDI AT-SPI initialization failed: {error}", flush=True)

    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    service = GdiService(connection)
    loop = GLib.MainLoop()

    def on_name_acquired(_connection, _name):
        print("GDI session service ready", flush=True)

    def on_name_lost(_connection, _name):
        loop.quit()

    owner_id = Gio.bus_own_name_on_connection(
        connection,
        BUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        on_name_acquired,
        on_name_lost,
    )
    try:
        loop.run()
    finally:
        service._passive.stop()
        service._settings.disconnect(service._passive.settings_handler)
        for token in list(service._contexts):
            service._release_context(token)
        for token in list(service._requests):
            service._cancel_transform(token)
        if owner_id:
            Gio.bus_unown_name(owner_id)
        connection.signal_unsubscribe(service._owner_signal)
        if service._registration_id:
            connection.unregister_object(service._registration_id)


if __name__ == "__main__":
    main()
