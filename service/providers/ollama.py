"""Bounded asynchronous Ollama HTTP adapter; nothing runs in GNOME Shell."""
import json
from urllib.parse import urlsplit

import gi
gi.require_version("Soup", "3.0")
from gi.repository import Gio, GLib, Soup
from .base import ModelProvider, ProviderError

MAX_RESPONSE_BYTES = 256 * 1024


def _valid_text(text):
    if not isinstance(text, str) or any(ord(c) < 32 and c not in '\n\r\t' for c in text):
        raise ProviderError('The model returned invalid text. Retry the request.')
    try:
        text.encode('utf-8')
    except UnicodeError as error:
        raise ProviderError('The model returned invalid text. Retry the request.') from error
    return text


def _uri(endpoint, path):
    parsed = urlsplit(endpoint.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ProviderError("Enter a valid provider URL in GDI Settings.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ProviderError("Provider URLs cannot contain credentials or query data.")
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ProviderError("Provider URLs outside this computer must use HTTPS.")
    return endpoint.strip().rstrip("/") + path


class OllamaProvider(ModelProvider):
    def __init__(self):
        self._session = Soup.Session.new()

    def _request(self, endpoint, path, payload, cancellable, timeout, callback, on_object=None):
        cancel = cancellable or Gio.Cancellable()
        stream = None
        finished = False
        timer = 0
        chunks = bytearray()
        received = 0
        last_object = None

        def finish(value=None, error=None):
            nonlocal finished, timer
            if finished:
                return
            finished = True
            if timer:
                GLib.source_remove(timer)
                timer = 0
            if stream:
                stream.close_async(GLib.PRIORITY_DEFAULT, None, None, None)
            callback(value, error)

        def expired():
            nonlocal timer
            timer = 0
            finish(error=ProviderError("The model request timed out. Try a shorter request or increase the timeout in Settings."))
            cancel.cancel()
            return GLib.SOURCE_REMOVE

        def failed(error):
            if cancel.is_cancelled():
                finish(error=ProviderError("Request cancelled."))
            elif isinstance(error, ProviderError):
                finish(error=error)
            else:
                finish(error=ProviderError("Could not reach Ollama or read its response. Check the endpoint and model in Settings. Launcher search remains available."))

        def read_next():
            stream.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, cancel, read_done)

        def read_done(source, result):
            nonlocal received, last_object
            try:
                data = source.read_bytes_finish(result).get_data()
                if finished:
                    return
                if data:
                    chunks.extend(data)
                    received += len(data)
                    if received > MAX_RESPONSE_BYTES:
                        raise ProviderError("The provider response exceeded GDI's size limit.")
                    if on_object:
                        while b'\n' in chunks:
                            line, _, rest = chunks.partition(b'\n')
                            chunks[:] = rest
                            if line.strip():
                                last_object = json.loads(line.decode('utf-8'))
                                on_object(last_object)
                    read_next()
                else:
                    if on_object:
                        if chunks.strip():
                            last_object = json.loads(chunks.decode('utf-8'))
                            on_object(last_object)
                        finish(last_object)
                    else:
                        finish(json.loads(chunks.decode("utf-8")))
            except Exception as error:
                failed(error)

        def opened(session, result):
            nonlocal stream
            try:
                stream = session.send_finish(result)
                if finished:
                    stream.close_async(GLib.PRIORITY_DEFAULT, None, None, None)
                    return
                status = message.get_status()
                if not 200 <= status < 300:
                    raise ProviderError("The configured model is unavailable. Choose an installed text model in AI Settings." if status == 404 else "The AI provider is temporarily unavailable. Retry or check AI Settings.")
                read_next()
            except Exception as error:
                failed(error)

        try:
            message = Soup.Message.new("POST" if payload is not None else "GET", _uri(endpoint, path))
            message.set_flags(Soup.MessageFlags.NO_REDIRECT)
            if payload is not None:
                message.set_request_body_from_bytes("application/json", GLib.Bytes.new(json.dumps(payload).encode()))
            timer = GLib.timeout_add_seconds(timeout, expired)
            self._session.send_async(message, GLib.PRIORITY_DEFAULT, cancel, opened)
        except Exception as error:
            failed(error)

    def health(self, *, endpoint, cancellable, callback):
        def completed(payload, error):
            if error:
                callback(None, error)
                return
            try:
                models = [item['name'] for item in payload['models']
                          if isinstance(item.get('name'), str) and
                          ('capabilities' not in item or 'completion' in item['capabilities'])]
                callback({'available': True, 'models': models}, None)
            except (KeyError, TypeError, AttributeError):
                callback(None, ProviderError("Ollama returned an invalid model list."))
        self._request(endpoint, '/api/tags', None, cancellable, 5, completed)

    def running_models(self, *, endpoint, cancellable, callback):
        """Observe /api/ps: which models are resident, their VRAM footprint
        and expiry. Used for residency diagnostics and prewarm decisions, not
        polled."""
        def completed(payload, error):
            if error:
                callback(None, error)
                return
            models = payload.get('models') if isinstance(payload, dict) else None
            callback(models if isinstance(models, list) else [], None)
        self._request(endpoint, '/api/ps', None, cancellable, 5, completed)

    def preload(self, *, endpoint, model, keep_alive, cancellable, callback, timeout=180):
        """Load a model without generating: an empty /api/generate whose only
        effect is residency. This is Ollama's documented preloading path —
        no ollama shell-out anywhere."""
        if not model.strip():
            callback(None, ProviderError("Choose a model in GDI Settings first."))
            return
        self._request(endpoint, '/api/generate',
                      {'model': model.strip(), 'keep_alive': keep_alive, 'stream': False},
                      cancellable, timeout, callback)

    def generate(self, *, endpoint, model, system, prompt, cancellable, callback,
                 timeout=120, context_tokens=8192, output_tokens=1024, keep_alive=0,
                 response_schema=None, on_chunk=None, metadata=None):
        if not model.strip():
            callback(None, ProviderError("Choose a model in GDI Settings first."))
            return
        content = []
        size = 0
        done = False
        def streamed(item):
            nonlocal size, done
            if not isinstance(item, dict) or 'error' in item or done:
                raise ProviderError('The provider returned an invalid stream. Retry the request.')
            delta = item.get('message', {}).get('content', '')
            _valid_text(delta)
            size += len(delta)
            if size > 20000:
                raise ProviderError('The response exceeded GDI’s size limit.')
            content.append(delta)
            done = item.get('done') is True
            if delta:
                on_chunk(delta)

        def completed(payload, error):
            if error:
                callback(None, error)
                return
            try:
                if metadata is not None and isinstance(payload, dict):
                    # Ollama reports its own lifecycle timing in the final
                    # chunk; expose it so cold loads are never blended with
                    # inference in diagnostics.
                    if 'load_duration' in payload:
                        metadata['load_ms'] = round(payload['load_duration'] / 1e6)
                    if 'prompt_eval_duration' in payload:
                        metadata['prompt_eval_ms'] = round(payload['prompt_eval_duration'] / 1e6)
                    if 'eval_duration' in payload:
                        metadata['eval_ms'] = round(payload['eval_duration'] / 1e6)
                    if 'eval_count' in payload:
                        metadata['tokens'] = payload['eval_count']
                response = _valid_text(''.join(content) if on_chunk else payload['message']['content']).strip()
                if payload.get('done') is not True:
                    raise ProviderError("The provider returned an incomplete response.")
                if payload.get('done_reason') == 'length':
                    raise ProviderError("The response reached the output limit. Select less text or increase the output limit.")
                if not response or len(response) > 20000:
                    raise ProviderError("The model returned empty or oversized text.")
                callback(response, None)
            except (KeyError, TypeError, AttributeError):
                callback(None, ProviderError("Ollama returned an invalid response."))
            except ProviderError as error:
                callback(None, error)
        payload = {
            'model': model.strip(), 'stream': on_chunk is not None, 'think': False,
            'keep_alive': keep_alive,
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': prompt}],
            'options': {'temperature': 0.2, 'num_ctx': context_tokens, 'num_predict': output_tokens},
        }
        if response_schema is not None:
            payload['format'] = response_schema
        if on_chunk:
            self._request(endpoint, '/api/chat', payload, cancellable, timeout, completed, streamed)
        else:
            self._request(endpoint, '/api/chat', payload, cancellable, timeout, completed)
