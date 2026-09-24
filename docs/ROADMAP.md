# Roadmap

## Phase 1 — accepted

- [x] Compact GNOME-native launcher with deterministic app/file/web/calculator actions.
- [x] Stable 500px width, header anchor, four visible rows, theme-native styling.
- [x] User accepted Phase 1 for now; no redesign is required for Phase 2.

## Phase 2 — explicit local intelligence

- [x] Separate GIO/D-Bus service, provider contract and Ollama adapter.
- [x] On-demand health/model discovery, endpoint/model settings, request budgets,
  cancellation and useful provider errors.
- [x] Inspectable deterministic/writing/assistant/harder routing.
- [x] Ask Intelligence fallback, bounded response preview and keyboard controls.
- [x] Explicit AT-SPI selection context, read-only metadata and password exclusion.
- [x] Writing actions, literal-token protection, preview, Copy/Retry/Cancel.
- [x] Exact range replacement, revision invalidation and checked GDI Undo.
- [x] Real local model generation for every action and provider failure tests.
- [x] Nested GNOME 46 end-to-end preview/keyboard checks, stale GTK fixture
  checks, and GNOME Text Editor replacement/Undo.
- [ ] Physical editing QA in real GTK editors and Firefox; see CURRENT_STATE.md
  for the exact automated validation and compatibility limits.

Streaming and shared word-level diffs are implemented in Phase 3.5. Harder reasoning is an
explicit service route, not automatic escalation. No persistent chat history.

## Phase 3 — passive proofreading and local learning

- [x] Separate opt-in event-driven observer, bounded sentence capture, 800ms debounce.
- [x] Deterministic preflight/quality gate; configured quick model, structured output.
- [x] Cancellation, one authoritative generation, rate limit, silent provider recovery.
- [x] Native caret-adjacent surface; safe shortcut by default, optional restricted Tab.
- [x] Exact range/caret/revision checks and guarded Undo; no synthetic edits.
- [x] Local SQLite outcome learning, pattern suppression, metadata statistics.
- [x] Separate consent for text examples, secure deletion and clear controls.
- [x] Nested GNOME tests and disposable physical runner; exact evidence in CURRENT_STATE.
- [ ] Physical everyday testing by the user, including IME, scrolling, multiple monitors,
  long sessions and application-native Undo behavior.
- [ ] GTK 4 single-line privacy: masked Entry is indistinguishable in exposed
  metadata; excluded from capture until a reliable sensitivity signal exists.
- [ ] Gecko exact replacement: fields/events detected, but Firefox 156's tested
  EditableText mutations do not change the DOM; passive offers disabled.

Conservative English proofreading is the current scope. No broad stylistic
rewrites, inline autocomplete prediction or model training. Current visual
identity and Phase 1/2 interactions remain accepted and frozen.

## Phase 3.5 — writing and Ask refinement

- [x] Shared bounded phrase diff; compact native passive and explicit previews.
- [x] Distinct writing prompts, literal/size/commentary validation.
- [x] Opt-in category suppression and bounded inspectable style preferences.
- [x] Real streamed Ask, bounded native Markdown, safe links, Copy/Retry/Clear.
- [x] RAM-only bounded follow-ups and transparent selected context.
- [x] Deterministic natural intent routing and selection-aware tasks.
- [x] Guarded multiline GTK caret insertion/Undo; stale snapshot refusal.
- [x] Request-ID cancellation, bounded diagnostics, transport/error regressions.
- [x] Ask command semantics fixed at the source: bare `ask` prompts empty,
  `ask <question>` strips the prefix; echo-fixture payload regressions.
- [x] Capability snapshot on GetFocusedContext; no silent writing-action
  no-ops (supported / readable-not-replaceable / unavailable outcomes).
- [x] Passive gate algebra for auxiliary agreement and irregular verb forms;
  reference sentence passes offer → accept → replace → undo.
- [x] Firefox per-field capability matrix measured; webpage selections
  supported read-only; IBus hybrid evaluated and rejected with evidence.
- [ ] User physical everyday acceptance after the nested validation handoff.

GTK4 single-line capture remains excluded. No broader agent automation,
webview/framework, model training or simulated editing fallback.

## Phase 4 — controlled system actions (not started)

No broader agent automation has been implemented. A future typed action registry
would need separate authorization and narrow capabilities; arbitrary shell
access remains excluded.
