# GNOME Desktop Intelligence

GNOME Desktop Intelligence (GDI) is a local intelligence layer for GNOME, not a
chat application. It should be summonable immediately, mostly invisible, useful
without an AI backend, and careful with user data.

## Product principles

- GNOME only, built on GNOME Shell/GJS, GTK4/libadwaita, GLib/GIO, GSettings,
  D-Bus, AT-SPI, and other appropriate Freedesktop APIs.
- Ubuntu GNOME on Wayland is the first target.
- Deterministic actions such as app launch, file opening, and web search take
  precedence over model calls.
- Model access is optional and provider-neutral. Ollama is the first provider.
- Model output never executes commands: the Phase 4 native action registry is
  the only execution surface, model-proposed actions are re-validated against
  it before use, and arbitrary shell access remains excluded.
- Focused writing assistance is explicit. Passive suggestions must be subtle,
  contextual, reversible, and never silently rewrite substantial text.
- Local learning is inspectable and can be disabled or cleared. No telemetry.

## Visual identity

GDI is a native flagship GNOME feature: no glassmorphism, blur, acrylic, glow or
colorful AI treatment. The supplied Intelligence mark is its permanent identity,
rendered as one scalable symbolic asset across panel, palette, AI and About.
GNOME provides light/dark colors and focus treatment. The palette stays 500px
wide, with a stable top edge as results and bounded AI previews grow downward.

## Phase 1 experience

- A small panel indicator opens a menu with status, Settings, and the normal UI's
  only Quit action. GDI has no dock entry and no persistent palette window.
- A configurable global shortcut opens a centered palette around 500 px wide,
  showing at most four normal launcher results before scrolling. Repeating the
  shortcut, Escape, or clicking outside dismisses it.
- The palette uses GDI's own GNOME Shell surface and deterministic result/action
  model, adapted from Rudra's launcher architecture. App search uses installed
  GIO applications; `open <name>` and `file <name>` search visible home-folder
  entries. Exact/prefix app matches rank first. `search <query>` opens a web
  search in the user's default browser, and arithmetic uses a safe parser.
- The palette inherits GNOME Shell's active theme through native
  `popup-menu-content`, `popup-menu-item`, and `search-entry` styles. GDI CSS
  controls layout only; it does not paint custom glass or hardcode surface,
  border, or selection colors.
- Search and launch work when no AI provider is running.
- Do not execute arbitrary shell commands or load executable plugins from the
  palette.

## Phase 2 — explicit writing intelligence

- An unmatched natural-language query offers Ask Intelligence. App matches,
  explicit file/web search and arithmetic stay deterministic and take priority.
  The explicit `ask` command enters Ask mode: a bare `ask` opens an empty
  focused prompt and sends nothing until the user types; `ask <question>`
  submits only the question. Intent verbs typed into the palette are routing
  metadata and never reach a model.
- Select text, then invoke the shortcut to offer Fix grammar, Improve writing,
  Make concise, Expand, Professional, Casual, Explain, Summarize, Key points, Translate,
  and Ask about selection. Read-only selections can produce responses to copy.
  Every action resolves to an explicit outcome — supported (preview and
  guarded Replace), readable but not replaceable (preview and Copy with an
  explanation), or a concise unavailable message — never a silent no-op.
- Generation is explicit and cancellable. A compact bounded preview shows the
  original and suggestion, with Replace, Copy, Retry and Cancel. Ask/Explain default to Copy; a supported target may also offer a secondary
  Insert at caret or Replace selection action. No persistent chat history is kept;
  passive assistance is a separate opt-in.
- Replacement checks the exact original selection and refuses stale snapshots.
  GDI Undo is available until the preview closes, provided the target has not
  been edited again. Unsupported accessibility targets use Copy. AT-SPI does
  not guarantee atomic edits across processes; failures are reported and never
  trigger blind whole-field replacement or simulated typing.
- Ollama is the first provider. Endpoint, writing/assistant/reasoning models,
  timeout and token limits are configurable. Settings can check availability
  and list installed text models without loading one. Launcher actions remain
  usable when the service, provider, or model is unavailable.
- Text is transient. GDI captures only the explicit selected range and bounded
  nearby context, never password/secret fields. The explicit workflow sends that text only after
  an explicit action. Closing the palette or a 15-minute expiry drops it.
- The existing optional learning store contains explicit action/outcome/app
  labels only. It is off by default and contains no selection/prompt/response.

## Phase 3 — optional passive proofreading

Enable **Passive writing assistance** in General → Writing. After a completed
English sentence and a short pause, GDI may offer a small correction near the
caret in a supported GTK editable field. It reads a bounded nearby sentence,
not a document, and does not send every keystroke to a model. A deterministic
gate suppresses clean text, stylistic rewrites and unsafe output. The configured
quick/writing model is used; reasoning models are never escalated automatically.

Ctrl+Alt+Enter accepts, Escape dismisses, and typing/focus/caret changes dismiss.
Optional Tab acceptance is limited to visible small corrections in GTK multiline
fields; default Tab behavior is preserved. Every accepted change revalidates the
original range and offers guarded GDI Undo. There are no silent edits, chat
bubbles or launcher redesign. Providers being unavailable is silent and leaves
all deterministic features working.

Personalization is independently optional: local metadata learns unwanted
corrections and offer frequency. Preferences can inspect counts and clear data.
Saving short accepted-and-edited text examples requires an additional explicit
opt-in. No ordinary typed text is permanently stored by default, and there is
no telemetry or model fine-tuning. Password, hidden and detectably sensitive
fields are excluded.

Initial support targets GNOME Text Editor and accessible GTK prose fields.
GTK 4 single-line fields are excluded from text capture because masked Entry
can omit secret-field markers. Firefox webpage **selections are supported
read-only**: GDI captures them end-to-end, and Explain/Summarize/Ask produce a
preview with Copy plus a clear note that direct replacement is unavailable.
Firefox editable-field replacement and passive offers are disabled because
Firefox's accessibility implementation acknowledges but never applies text
edits and does not deliver typing events on this platform. Unsupported,
sandboxed and custom editors do not receive brittle typing or clipboard-paste
fallbacks. See CURRENT_STATE.md for the measured capability matrix, exact
versions and validation.

## Phase 3.5 — coherent writing and Ask

Writing previews share a word/phrase diff: subdued struck-out removals, bold
proposals, quiet unchanged text. Small passive corrections show the relevant
excerpt in a content-sized native surface. The safe acceptance shortcut and
optional restricted Tab remain unchanged; typing, Escape and focus/caret changes
dismiss immediately. Explicit Replace remains primary, with Copy/Retry/Cancel
secondary and guarded Undo after acceptance.

Ask streams inside the same compact palette, then renders readable Markdown
headings, lists and code with safe, deliberately activated web links. Content
scrolls within a bounded height. Copy, Retry and Clear accompany a short-lived
follow-up field. Escape closes and cancels; no interaction survives closing.
Selected/nearby context and prior temporary conversation are labeled. A captured
multiline GTK caret may offer insertion, with its local guards excluded from the
model request. Text replacement/insertion always requires an explicit action.

Natural questions use predictable keyword checks, not a model classifier.
Strong deterministic app, calculation and explicit search actions remain first.
With selected text, typing “explain this” or “rewrite this naturally” chooses the
appropriate selected-text task. Models remain independently configurable.

Opt-in learning suppresses repeatedly unwanted categories and patterns. Repeated
accepted brevity/detail or casual-tone choices influence Improve writing only;
explicit tone choices take precedence. Preferences expose the learned direction,
counts and Clear. There is no weight training or autonomous prompt modification.

## Phase 4 — native GNOME actions

GDI understands common desktop requests and performs them through GNOME/Linux
native APIs. Most actions are parsed deterministically and execute instantly
without any model. There is no generic shell tool: every action is a registered
capability with a stable id, typed arguments, a risk class, an availability
backend and a validation rule, and model output can only ever name a registered
action (which is then re-validated) — never an arbitrary command.

Supported actions and examples (full registry in ARCHITECTURE.md):

- Launch and open: `open firefox` (app search), `open downloads`
  (Downloads folder), `open display settings` (the GNOME Settings panel),
  `open https://…` (web link), `find resume pdf` / `find pdfs modified today`
  (bounded file search).
- Audio: `volume 30`, `make the volume 40`, `mute`, `unmute`, `volume up`.
- Bluetooth: `turn bluetooth off` (compact confirmation when devices are
  connected), `bluetooth status`.
- Wi-Fi/network: `turn wifi on`, `turn wifi off` (confirm), `show my ip`,
  `network status`.
- Power: `switch to power saver`, `performance mode`, `power profile`,
  `battery`.
- Appearance: `turn on dark mode`, `light mode`, `night light off`,
  `text scaling 1.25` (always confirmed), `color scheme`.
- Brightness: `brightness 40`, `brighter` where a backlight exists.
- System information: `how much disk space do I have`, `memory usage`.

Results are shown as compact native rows and views — “✓ Bluetooth turned off”,
a disk/mem/IP answer, or a concise unavailable/error message. Mutating actions
verify the actual resulting state (the volume service, NetworkManager, BlueZ,
power-profiles-daemon or GSettings is read back) before success is shown; a
change that cannot be confirmed is reported as a failure, never as a silent
success. Small bounded
multi-step requests such as `turn bluetooth off and switch to power saver`
execute as an ordered plan (at most three steps, no recursion); if any step
needs confirmation, the whole plan is shown before execution. When
deterministic parsing finds nothing and the query plausibly names a desktop
capability, a small configurable routing model may propose one registered
action (marked “Suggested”); invalid proposals fall back to Ask Intelligence.
Personalization can reorder frequently used apps and folders only; it can never
change the confirmation policy. Deleting files, installing packages, killing
processes and arbitrary shell execution are excluded from this phase.

Developer diagnostics (never shown in normal UI) record parsed intent,
deterministic vs model routing, chosen action, arguments, risk class, latency,
result and invalid model tool calls; they are inspectable via the service's
`ActionStats` and, on the device, through the hidden `gdi diagnostics` palette
command, which lists recent action traces with Copy and Reset controls.
`tools/verify-live-actions.py` verifies the same native backends directly on
an installed machine (`--read-only`, or `--reversible` to exercise and restore
reversible state changes).

## Phase 5 — Writing Intelligence, predictive writing and Ask history

Writing Intelligence has three separate modes that never share prompts or
gates: **Correct** (grammar, spelling, punctuation), **Rewrite** (transform
selected or caret-scoped text) and **Continue** (predict what you are likely
to write next).

- **Predictive writing** (off by default, General → Writing) offers a short
  continuation as subdued ghost text near the caret in supported GTK
  multiline editors after a brief typing pause. It prefers a useful phrase
  over an obvious next word, fires at most once per pause (never per
  keystroke), uses the quick model with a small output budget, and discards
  anything stale, trivial, echoed, oversized, or corrupted with Markdown or
  commentarial text. Tab accepts the whole continuation, Right accepts one
  word, Escape dismisses; typing, caret movement and focus changes dismiss
  it immediately. The insertion is verified and undoable with Ctrl+Alt+Z.
  Local, inspectable learning records only acceptance labels and can
  suppress predictions where they are repeatedly ignored.
- **Writing Tools** become a compact contextual surface. With a selection:
  Improve, Fix, Shorten, Tone (Professional/Casual/Friendly/Direct) and
  More… (Expand, Summarize, Explain, Translate, Ask Intelligence) — shown
  progressively, not all at once. Without a selection, supported fields
  offer caret-scoped actions (Improve sentence, Continue writing, Fix
  paragraph, Tone, More…); the sentence or paragraph at the caret is read
  only when you pick an action. Every outcome is explicit — preview with
  guarded Replace, preview with Copy where replacement is impossible, or a
  concise unavailable message.
- **Ask Intelligence** keeps the 500 px palette with a stable top edge and a
  fixed width through loading, streaming, Markdown, code blocks and
  follow-ups. Height is dynamic: short answers stay compact, long answers
  grow to a sensible work-area maximum and scroll internally. Generation
  shows a small native processing animation; raw Markdown tokens never flash
  while streaming, and completed answers render as real formatted content —
  headings, lists, emphasis, inline code, fenced code blocks (distinct,
  horizontally scrollable, one-click Copy) and safe links. The question
  stays subtly visible; Copy, Retry, Clear/New Conversation and a follow-up
  field accompany the answer. Insert at caret / Replace selection appear
  only with a suitable captured target.
- **Intelligence History** (on by default, Privacy → Save Intelligence
  History) saves completed Ask conversations locally, grouped Today /
  Yesterday / Earlier in a dedicated view reachable from the panel menu or
  the `history` command. Conversations open for reading, continue where
  they left off, and can be renamed, deleted or fully cleared from
  Preferences. History is entirely local with no telemetry; only visible
  conversation content and minimal metadata are stored, and turning saving
  off keeps new interactions temporary without deleting anything.

Deterministic behavior is unchanged: apps, files, web search, calculator and
the Phase 4 action registry outrank everything, and everything works when no
model is available.

## Later phases

Broader system actions beyond the Phase 4 registry, autocomplete prediction and
model-weight training remain out of scope. Writing-input compatibility research
for Firefox/Gecko fields and IME paths is **deferred, not abandoned**: the
measured capability matrix stands (webpage selections supported read-only,
Gecko replacement and passive offers disabled) and no further passive-writing
research is scheduled while Phase 4 work continues.
