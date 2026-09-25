"""One-GPU-friendly request scheduling.

GDI targets machines where loading two large models at once either thrashes
VRAM or serializes inside Ollama anyway. The scheduler gives every model
request a priority and one place where yielding, preemption and concurrency
are decided:

    1  explicit system/user request (reserved; nothing model-based today)
    2  Ask Intelligence
    3  explicit Writing Tool / intent routing
    4  passive correction
    5  speculative prediction

Explicit work never preempts other explicit work — it queues. Background work
(passive, prediction) never queues: it is dropped when no slot is free and is
cancelled immediately when a higher-priority request arrives. Dropped or
cancelled background requests must be treated by their callers as ordinary
unavailability, never as provider failures to back off from.
"""

ASK = 2
WRITING = 3
PASSIVE = 4
PREDICTION = 5

BACKGROUND_KINDS = ('passive', 'prediction')
MAX_QUEUE = 3


class Ticket:
    """A scheduler grant. The caller releases it when its request completes;
    `drop` is used by the service when the client cancels a queued request."""

    def __init__(self, scheduler, kind, priority):
        self._scheduler = scheduler
        self.kind = kind
        self.priority = priority
        self.state = 'pending'
        self._seq = 0
        self._start = None
        self._dropped = None
        self._cancellable = None

    def release(self):
        self._scheduler._release(self)

    def drop(self):
        self._scheduler._remove(self)


class RequestScheduler:
    def __init__(self, max_concurrent=1):
        self.max_concurrent = max(1, int(max_concurrent))
        self._running = set()
        self._queue = []
        self._seq = 0

    def set_max_concurrent(self, value):
        self.max_concurrent = max(1, int(value))
        self._promote()

    def release(self, ticket):
        """Public form of Ticket.release() for callers holding the ticket."""
        self._release(ticket)

    @property
    def active(self):
        return len(self._running)

    def submit(self, kind, priority, start, dropped=None, cancellable=None, on_ticket=None):
        """Request a slot for one model request.

        Returns a Ticket; `start` has been called (now or later, when a slot
        frees) by the time this returns a running ticket. `on_ticket`, when
        given, is invoked with the ticket BEFORE `start` runs, so the caller
        can register it for release even when the request fails synchronously.
        Returns None when the request must fail fast: background kinds are
        dropped whenever no slot is free, and any kind is dropped when the
        queue is full.
        """
        self._preempt_below(priority)
        if len(self._running) < self.max_concurrent:
            return self._start_now(kind, priority, start, cancellable, on_ticket)
        if kind in BACKGROUND_KINDS:
            return None
        if len(self._queue) >= MAX_QUEUE:
            return None
        ticket = Ticket(self, kind, priority)
        ticket.state = 'queued'
        ticket._seq = self._seq
        ticket._start = start
        ticket._dropped = dropped
        ticket._cancellable = cancellable
        self._seq += 1
        if on_ticket is not None:
            on_ticket(ticket)
        self._queue.append(ticket)
        self._queue.sort(key=lambda item: (item.priority, item._seq))
        return ticket

    # ------------------------------------------------------------ internal

    def _start_now(self, kind, priority, start, cancellable=None, on_ticket=None):
        ticket = Ticket(self, kind, priority)
        ticket.state = 'running'
        ticket._cancellable = cancellable
        self._running.add(ticket)
        if on_ticket is not None:
            on_ticket(ticket)
        start()
        return ticket

    def _preempt_below(self, priority):
        """Cancel running background work that a higher-priority request
        supersedes. Explicit work (ask/writing/routing) is never preempted."""
        for ticket in list(self._running):
            if (ticket.priority > priority and ticket.kind in BACKGROUND_KINDS):
                self._running.discard(ticket)
                ticket.state = 'done'
                if ticket._cancellable is not None:
                    ticket._cancellable.cancel()

    def _release(self, ticket):
        if ticket.state == 'running':
            self._running.discard(ticket)
        ticket.state = 'done'
        self._promote()

    def _remove(self, ticket):
        """Caller-initiated removal: queued requests are dropped with a
        callback so the D-Bus caller receives an error; running requests are
        released (their own cancellation path reports the error)."""
        if ticket.state == 'queued':
            self._queue.remove(ticket)
            ticket.state = 'done'
            if ticket._dropped is not None:
                ticket._dropped()
        elif ticket.state == 'running':
            self._release(ticket)

    def _promote(self):
        while self._queue and len(self._running) < self.max_concurrent:
            ticket = self._queue.pop(0)
            if ticket.state != 'queued':
                continue
            ticket.state = 'running'
            self._running.add(ticket)
            start = ticket._start
            ticket._start = None
            start()
