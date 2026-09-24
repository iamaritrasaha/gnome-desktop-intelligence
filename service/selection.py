"""Explicit AT-SPI selection snapshots. Only this module owns accessibility objects."""
import json
import secrets
import time
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib

MAX_TREE_NODES = 1200
MAX_TREE_DEPTH = 24
CONTEXT_CHARS = 360


class SelectionContext:
    @staticmethod
    def _editable(accessible):
        states = accessible.get_state_set()
        return ("EditableText" in accessible.get_interfaces()
                and states.contains(Atspi.StateType.EDITABLE)
                and states.contains(Atspi.StateType.SENSITIVE)
                and not states.contains(Atspi.StateType.READ_ONLY)
                and not SelectionContext._protected_ancestry(accessible))

    def _watch_context(self, context):
        # Listen only while an explicit selection token exists. Never inspect
        # event text; invalidate even an edit outside the bounded context.
        def changed_for(context, event):
            if event.source != context["accessible"]:
                return
            expected = context.get("own_events", [])
            kind = "insert" if "insert" in event.type else "delete"
            observed = (kind, event.detail1, event.detail2)
            if context.get("awaiting_own") and expected and observed == expected[0]:
                expected.pop(0)
                context["last_own_event"] = observed
            elif context.get("awaiting_own") and observed == context.get("last_own_event"):
                # GTK may emit the same AT-SPI notification twice. Only accept
                # an exact consecutive duplicate inside our verified edit.
                pass
            else:
                context["stale"] = True
        if not getattr(self, "_revision_listener", None):
            def changed(event, *_args):
                for item in list(self._contexts.values()):
                    if item.get("watched"):
                        changed_for(item, event)
            listener = Atspi.EventListener.new(changed, None, None)
            if not listener.register("object:text-changed"):
                context["editable"] = False
                return
            self._revision_listener = listener
        context["watched"] = True
        context["ready"] = True
        if context["editable"] and not self._selection_is_current(context, context["start"], context["end"], context["selected"]):
            context["stale"] = True

    def _rearm_after_edit(self, context):
        # A bounded one-shot drains duplicate notifications from our own edit.
        # Unexpected source/range events still invalidate the snapshot.
        context["ready"] = False
        def settled():
            context.pop("settle_id", None)
            context["ready"] = not context.get("own_events")
            context["awaiting_own"] = False
            context.pop("last_own_event", None)
            return GLib.SOURCE_REMOVE
        context["settle_id"] = GLib.timeout_add(50, settled)

    def _focused_editable(self, pid=0):
        """Return (accessible-or-None, reason): 'secret' when the focused
        element was rejected for privacy, 'none' when nothing was focused."""
        try:
            desktop = Atspi.get_desktop(0)
            deadline = time.monotonic() + 1.5
            queue = [(desktop, 0)]
            seen = 0
            focused_candidates = []
            focused_secret = False
            while queue and seen < MAX_TREE_NODES and time.monotonic() < deadline:
                accessible, depth = queue.pop(0)
                seen += 1
                try:
                    if depth == 1 and pid and accessible.get_process_id() != pid:
                        continue
                    role = accessible.get_role()
                    states = accessible.get_state_set()
                    is_focused = states.contains(Atspi.StateType.FOCUSED)
                    if self._is_secret(accessible):
                        if is_focused:
                            focused_secret = True
                        continue
                    elif (is_focused and states.contains(Atspi.StateType.SENSITIVE) and
                          not self._is_secret(accessible)):
                        focused_candidates.append((accessible, depth))

                    if depth < MAX_TREE_DEPTH:
                        child_count = min(accessible.get_child_count(), 160)
                        for index in range(child_count):
                            child = accessible.get_child_at_index(index)
                            if child is not None:
                                queue.append((child, depth + 1))
                except Exception:
                    continue

            for accessible, _depth in reversed(focused_candidates):
                try:
                    interfaces = set(accessible.get_interfaces())
                    if "Text" not in interfaces:
                        continue
                    Atspi.Text.get_n_selections(accessible)
                    return accessible, "ok"
                except Exception:
                    continue
            if focused_secret:
                return None, "secret"
        except Exception:
            return None, "error"
        return None, "none"

    @staticmethod
    def _public_text_range(source, start, end):
        # TextView invisible tags can hide only part of a paragraph. Check
        # bounded attribute runs before reading any portion of that paragraph.
        try:
            for _ in range(16):
                if start >= end: return True
                attrs, _begin, stop = Atspi.Text.get_attribute_run(source, start, True)
                if any(str(attrs.get(key, '')).lower() in ('true', '1', 'yes')
                       for key in ('invisible', 'hidden', 'protected', 'sensitive')):
                    return False
                if stop <= start: return False
                start = stop
        except Exception:
            return False
        return False

    @staticmethod
    def _protected_ancestry(accessible):
        try:
            for _ in range(MAX_TREE_DEPTH + 1):
                if accessible is None:
                    return False
                if SelectionContext._is_secret(accessible):
                    return True
                accessible = accessible.get_parent()
            return True
        except Exception:
            return True

    @staticmethod
    def _is_secret(accessible):
        try:
            if accessible.get_role() == Atspi.Role.PASSWORD_TEXT:
                return True
            states = accessible.get_state_set()
            if ('EditableText' in accessible.get_interfaces()
                    and not states.contains(Atspi.StateType.MULTI_LINE)):
                app = accessible.get_application()
                if app and app.get_toolkit_name() == 'GTK' and not (app.get_toolkit_version() or '').startswith('3.'):
                    # GTK4 masked Entry is indistinguishable from visible Entry
                    # in this API. Fail closed before explicit or passive reads.
                    return True
            attributes = accessible.get_attributes()
            if isinstance(attributes, dict):
                entries = attributes.items()
            else:
                entries = []
                for attribute in attributes or []:
                    key, separator, value = str(attribute).partition(":")
                    if separator:
                        entries.append((key, value))
            for key, value in entries:
                key = str(key).lower()
                value = str(value).lower()
                if any(marker in key or marker in value for marker in ("password", "secret", "protected", "sensitive")):
                    return True
            return False
        except Exception:
            return True

    def _capture_focused_context(self, pid=0):
        self._prune_contexts()
        token = secrets.token_urlsafe(24)
        empty = {
            "token": token,
            "selected": "",
            "nearby": "",
            "application": "",
            "role": "",
            "start": -1,
            "end": -1,
            "caret": -1,
            "created": time.monotonic(),
            "accessible": None,
            "editable": False,
            "stale": False,
        }
        accessible, focus_reason = self._focused_editable(pid) if pid > 0 else (None, "none")
        empty = {**empty, "focus_reason": focus_reason}
        if accessible is None:
            self._contexts[token] = empty
            return empty

        try:
            role = accessible.get_role()
            if self._protected_ancestry(accessible):
                self._contexts[token] = empty
                return empty
            application = ""
            try:
                app = accessible.get_application()
                application = (app.get_name() or "")[:128]
            except Exception:
                pass
            try:
                caret = int(Atspi.Text.get_caret_offset(accessible))
            except Exception:
                caret = -1

            selection_count = Atspi.Text.get_n_selections(accessible)
            metadata = {
                **empty,
                "application": application,
                "role": Atspi.Role.get_name(role) or str(role),
                "caret": caret,
                "accessible": accessible,
                "editable": self._editable(accessible) and accessible.get_application().get_toolkit_name() != "Gecko",
            }
            if selection_count != 1:
                # Explicit launcher invocation only: a bounded insertion guard,
                # never sent to the model. Restrict this new path to multiline GTK.
                if (selection_count == 0 and caret >= 0 and metadata['editable']
                        and accessible.get_application().get_toolkit_name() == 'GTK'
                        and accessible.get_state_set().contains(Atspi.StateType.MULTI_LINE)):
                    length = Atspi.Text.get_character_count(accessible)
                    if caret <= length and self._public_text_range(accessible, max(0, caret - 32), min(length, caret + 32)):
                        metadata.update(insert=True, start=caret, end=caret, length=length,
                            before=Atspi.Text.get_text(accessible, max(0, caret - 32), caret),
                            after=Atspi.Text.get_text(accessible, caret, min(length, caret + 32)))
                        self._contexts[token] = metadata
                        self._watch_context(metadata)
                        return metadata
                metadata['editable'] = False
                self._contexts[token] = metadata
                return metadata
            selection = Atspi.Text.get_selection(accessible, 0)
            start = int(selection.start_offset)
            end = int(selection.end_offset)
            if start < 0 or end <= start or end - start > 12000:
                self._contexts[token] = empty
                return empty
            text_length = Atspi.Text.get_character_count(accessible)
            if not self._public_text_range(accessible, max(0, start - CONTEXT_CHARS), min(text_length, end + CONTEXT_CHARS)):
                self._contexts[token] = empty
                return empty
            selected = Atspi.Text.get_text(accessible, start, end)
            if not selected or len(selected) > 12000:
                self._contexts[token] = empty
                return empty

            text_length = Atspi.Text.get_character_count(accessible)
            before = Atspi.Text.get_text(accessible, max(0, start - CONTEXT_CHARS), start)
            after = Atspi.Text.get_text(
                accessible, end, min(text_length, end + CONTEXT_CHARS))
            nearby = json.dumps({"before": before, "after": after}, ensure_ascii=False)
            captured = {
                **metadata,
                "selected": selected,
                "nearby": nearby,
                "start": start,
                "end": end,
                "accessible": accessible,
                "length": text_length,
                "before": before,
                "after": after,
            }
            self._contexts[token] = captured
            self._watch_context(captured)
            return captured
        except Exception:
            self._contexts[token] = empty
            return empty

    def _selection_is_current(self, context, start, end, expected):
        accessible = context["accessible"]
        try:
            states = accessible.get_state_set()
            if (context.get("stale") or not self._editable(accessible) or
                    Atspi.Text.get_character_count(accessible) != context["length"] or
                    accessible.get_role() == Atspi.Role.PASSWORD_TEXT or
                    self._protected_ancestry(accessible) or
                    not states.contains(Atspi.StateType.EDITABLE) or
                    not states.contains(Atspi.StateType.SENSITIVE) or
                    states.contains(Atspi.StateType.READ_ONLY)):
                return False
            if not self._public_text_range(accessible, max(0, start - len(context['before'])), end + len(context['after'])):
                return False
            count = Atspi.Text.get_n_selections(accessible)
            if context.get("passive") or context.get("insert"):
                return (count == 0 and states.contains(Atspi.StateType.FOCUSED)
                        and Atspi.Text.get_caret_offset(accessible) == context["caret"]
                        and Atspi.Text.get_text(accessible, start, end) == expected
                        and self._surroundings_match(context, start, end))
            if count != 1:
                return False
            selection = Atspi.Text.get_selection(accessible, 0)
            if (selection.start_offset != start or selection.end_offset != end or
                    Atspi.Text.get_text(accessible, start, end) != expected):
                return False
            before = Atspi.Text.get_text(
                accessible, max(0, start - len(context["before"])), start)
            after = Atspi.Text.get_text(
                accessible, end, end + len(context["after"]))
            return before == context["before"] and after == context["after"]
        except Exception:
            return False

    def _replace_range(self, context, start, end, replacement, original):
        accessible = context["accessible"]
        # AT-SPI has no atomic replace/compare-and-swap. Never blindly insert a
        # rollback after an exception: the remote edit may already have happened.
        before_length = Atspi.Text.get_character_count(accessible)
        context["mutating"] = True
        context["awaiting_own"] = True
        context.pop("last_own_event", None)
        context["own_events"] = ([("delete", start, end - start)] if end > start else []) + ([("insert", start, len(replacement))] if replacement else [])
        try:
            if end > start and not Atspi.EditableText.delete_text(accessible, start, end):
                return False
            if Atspi.Text.get_character_count(accessible) != before_length - (end - start):
                return False
            if not self._surroundings_match(context, start, start):
                return False
            if replacement and not Atspi.EditableText.insert_text(accessible, start, replacement, len(replacement.encode("utf-8"))):
                # Restore only a verified gap; ambiguity leaves recovery to Copy.
                if (Atspi.Text.get_character_count(accessible) == before_length - (end - start)
                        and self._surroundings_match(context, start, start)):
                    Atspi.EditableText.insert_text(accessible, start, original, len(original.encode("utf-8")))
                return False
            return (Atspi.Text.get_character_count(accessible) == before_length - (end - start) + len(replacement)
                    and Atspi.Text.get_text(accessible, start, start + len(replacement)) == replacement
                    and self._surroundings_match(context, start, start + len(replacement)))
        except Exception:
            return False
        finally:
            context["mutating"] = False

    def _surroundings_match(self, context, start, end):
        accessible = context["accessible"]
        return (self._public_text_range(accessible, max(0, start - len(context['before'])), end + len(context['after']))
                and Atspi.Text.get_text(accessible, max(0, start - len(context["before"])), start) == context["before"]
                and Atspi.Text.get_text(accessible, end, end + len(context["after"])) == context["after"])

    def _replace(self, token, replacement, learning_enabled):
        context = self._get_context(token)
        start = context["start"]
        end = context["end"]
        original = context["selected"]
        if not replacement or len(replacement) > 20000:
            return False, "The suggested text is empty or too long."
        if not context.get("editable") or context.get("replaced") or not context.get("ready", False) or not self._selection_is_current(context, start, end, original):
            return False, "The original selection changed. GDI left the text untouched."
        if not self._replace_range(context, start, end,
                                   replacement, original):
            context["stale"] = True
            return False, "The field could not verify the edit. Inspect it before continuing; the original remains in this preview for recovery."

        context["length"] += len(replacement) - len(original)
        context["replaced"] = replacement
        context["undo_original"] = original
        context["undo_end"] = start + len(replacement)
        context["learning_enabled"] = bool(learning_enabled)
        context["created"] = time.monotonic()
        if learning_enabled:
            self._record(context, context.get("action", "rewrite"), "accepted")
        self._rearm_after_edit(context)
        return True, "Text inserted. Use Undo in GDI to remove it." if context.get("insert") else "Selected text replaced. Use Undo in GDI to restore it."

    def _undo(self, token):
        context = self._get_context(token)
        replacement = context.get("replaced")
        original = context.get("undo_original")
        if not replacement or original is None:
            return False, "There is no recent GDI replacement to undo."
        accessible = context["accessible"]
        start = context["start"]
        end = context["undo_end"]
        try:
            states = accessible.get_state_set()
            if (context.get("stale") or not context.get("ready", False) or
                    Atspi.Text.get_character_count(accessible) != context["length"] or
                    not self._surroundings_match(context, start, end) or
                    accessible.get_role() == Atspi.Role.PASSWORD_TEXT or
                    self._protected_ancestry(accessible) or
                    not states.contains(Atspi.StateType.EDITABLE) or
                    not states.contains(Atspi.StateType.SENSITIVE) or
                    states.contains(Atspi.StateType.READ_ONLY) or
                    Atspi.Text.get_text(accessible, start, end) != replacement):
                return False, "The inserted text changed; GDI did not overwrite it."
            if not self._replace_range(context, start, end, original, replacement):
                context["stale"] = True
                return False, "This field could not restore the previous text."
            context["length"] += len(original) - len(replacement)
            context["selected"] = original
            context["start"] = start
            context["end"] = start + len(original)
            context.pop("replaced", None)
            context.pop("undo_original", None)
            self._rearm_after_edit(context)
            if context.get("learning_enabled"):
                self._record(context, context.get("action", "rewrite"), "immediate_undo")
            return True, "The original selection was restored."
        except Exception:
            return False, "This field no longer exposes a safe undo range."

