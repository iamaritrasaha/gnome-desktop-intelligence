"""Provider-neutral, asynchronous text-only inference contract."""


class ProviderError(RuntimeError):
    """A provider could not return a usable completion."""


class ModelProvider:
    """Callbacks receive (value, error) once. Cancelling closes network work.

    health returns {available, models}; generate returns completed plain text.
    response_schema optionally requests a constrained JSON object. A provider
    must reject unsupported structured output rather than silently execute tools.
    on_chunk optionally receives text deltas before the once-only completion.
    No tool execution, conversation storage, preload, or background polling.
    """

    def health(self, *, endpoint, cancellable, callback):
        raise NotImplementedError

    def generate(self, *, endpoint, model, system, prompt, cancellable, callback,
                 timeout=120, context_tokens=8192, output_tokens=1024, keep_alive=0, response_schema=None, on_chunk=None):
        raise NotImplementedError
