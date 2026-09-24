# Decisions


## 2026-09-24 — architecture correction: Ask commands, capability model, gate algebra

The Phase 3.5 handoff was physically broken in three places, fixed at the
source rather than patched. (1) The palette fed raw launcher queries to the
model, so `ask` reached the provider as "User request: ask" and produced
"Request Received" style answers. `ask`/`ask <question>` is now an explicit
deterministic command like `search`: bare `ask` opens an empty focused prompt
and sends nothing; only the remainder after the prefix is submitted; typed
selection-intent verbs are stripped from instructions. A nested echo fixture
asserts the exact provider payload so intent names can never leak again.

(2) Writing actions now resolve through a capability snapshot returned by
`GetFocusedContext` alongside the plain context. Every explicit action ends in
supported (preview + guarded Replace, retryable after a transport failure via a
fresh capture), readable-but-not-replaceable (preview + Copy + note), or an
explicit unavailable message. Silent no-ops are regressions and have nested
coverage. The service remains the single owner of accessibility facts; the UI
only renders them.

(3) The passive quality gate was extended with a closed correction algebra —
same-lemma auxiliary agreement (subject-validated, contractions included),
irregular verb forms (participle after aux, finite participle→past, base→past
with locally preceding past evidence), wrongly-agreed auxiliary deletion, and
n:n diff decomposition — because the reference sentence
"I has went to the market yesterday and buy some apples." could not fire or
derive otherwise. No threshold was loosened: every accepted difference must be
independently derivable, unjustified tense/agreement changes are still
rejected, and the rules are unit-covered.

Firefox 156.0.1 was measured per field on nested Wayland
(`tools/firefox-capability-matrix.py`): webpage selections read end-to-end
through the document accessible (supported: Explain/Summarize/Ask + Copy);
editable fields are readable but both EditableText mutation APIs acknowledge
without applying and typing events are not delivered, so replacement/passive
stay excluded as per-capability facts. The hybrid IBus architecture was
evaluated for this gap and rejected: AT-SPI already covers everything GDI can
replace, Gecko exposes no surrounding text to the input-method layer, and a
custom IME is out of scope. No simulated typing or clipboard fallback.

Extension disable now always signals the service even when destruction
precedes the D-Bus connection. `--real` provider tests treat a conservative
gate refusal of a poor model answer as the correct outcome; model output
quality remains non-deterministic and gated by design.
## 2026-09-24 — Phase 3.5 writing and temporary Ask refinement

The user accepted Phase 3 and authorized this refinement only. Freeze native
flagship GNOME, no glassmorphism, the supplied Intelligence identity, stable
500px launcher and existing passive safety/privacy behavior. Phase 4 is not
started. Supported multiline GTK editors remain the compatibility boundary.

Use one escaped native phrase-diff renderer for passive and explicit writing.
Keep whole-input LCS work bounded; long passages use a prefix/suffix fallback.
A completed assistant answer gets native Markdown blocks and HTTP(S) link
buttons; streamed text stays simple until complete. No HTML/webview renderer,
chat bubbles, persistent chat history or model-controlled executable actions.

Follow-ups retain bounded text only in the open interaction. Label contextual
text, preserve deterministic routing, and use the configured general model for
Ask. Keep quick/writing for corrections and no automatic reasoning escalation.
Scoped request IDs protect streamed results and cancellation from obsolete work.

Learned explicit brevity/detail and casual-tone preferences may refine Improve
writing, with explicit tone/action intent taking priority. Do not make passive
proofreading stylistic. Add inspectable negative category scoring without
retaining ordinary text or training weights. Undo/rejection reduce preference
scores; consent and Clear continue to control storage.

Caret insertion is limited to explicitly captured multiline GTK fields and
reuses guarded AT-SPI editing. At most 32 characters on either side remain
local as integrity guards. A native modal-grab release lets the service verify
actual field focus before editing; no window activation or synthetic key is
used. Copy is the default assistant response action; Insert/Replace selection
are secondary. Firefox replacement and GTK4 single-line capture stay excluded.

Validation uncovered an inherited host `GDK_BACKEND=x11` in the older nested
explicit fixture runner. Force its GTK processes to Wayland so focus and input
tests genuinely target the isolated compositor. The refusal guard correctly
rejected the misplaced fixture. Native application Undo grouping and everyday
IME/multi-monitor usage still need physical acceptance. Exact evidence is in
CURRENT_STATE; stop at this handoff, with no Phase 4 work.

## 2026-09-24 — Phase 3 explicitly authorized; conservative native proofreading

The user accepted Phase 1/2 and visual polish, then explicitly authorized Phase
3. Earlier “do not begin passive” milestones below are historical. The supplied
Intelligence mark, native flagship GNOME styling, no glassmorphism, stable 500px
launcher and existing explicit workflow remain frozen.

Passive observation and personalization default off. The user's shortcut choice
is **safe shortcut by default; optional Tab in supported editors**. Ctrl+Alt+Enter
accepts; optional Tab temporarily accepts only a visible small correction in a
GTK multiline field. Browser/single-line Tab navigation is never intercepted.
Escape, typing, caret movement, focus changes and lifecycle transitions dismiss.
A separate native nonmodal surface provides acceptance and guarded GDI Undo.

Keep the observer in the existing service, use AT-SPI events and bounded text,
and never subscribe to raw keystrokes or input-method surrounding text. GTK
4.14's missing character extents require a coordinate-only GNOME input-method
fallback. Invalid coordinates suppress suggestions. The quick model receives
only completed suspect sentences after an 800ms debounce, with no idle polling,
a five-second minimum request interval and cancellation of obsolete work.

Structured model output is necessary: the installed small writing model ignored
JSON-only prompting in the first test. The neutral provider contract now accepts
an optional response schema; only the Ollama adapter maps it to `format`. The
quality gate independently validates concrete local corrections and suppresses
style changes. False negatives are preferable to unwanted rewrites; English
proofreading is explicitly the initial compatibility boundary.

Reuse exact range revision checks. Keep no-op/ambiguous mutations fail-closed
and provide Copy original recovery. Firefox investigation fixed the disposable
test's onboarding obstruction and invalid coordinate handling, but Firefox
156.0.1 still acknowledged EditableText deletion without changing textarea,
input or contenteditable text. Gecko passive offers are disabled until that
API can be validated. GTK 4 masked Entry also omits password/hidden metadata
in this runtime, so all GTK 4 single-line text capture fails closed. Bounded
attribute-run checks exclude invisible TextView tags before capture. This is a
necessary privacy correction to the explicit workflow too. No simulated typing or broad browser privileges are added.

Learning stores bounded local metadata with keyed correction-pattern digests,
weighted accept/reject/edit/Undo outcomes and model/app statistics. Approved
text examples require a separate opt-in and are purged when revoked. Tone and
verbosity preferences are inspectable from explicit accepted actions; passive
proofreading preserves style. No prompt self-modification or model-weight
training. Next work is physical everyday testing, not Phase 4.

## 2026-09-24 — permanent Intelligence identity and native GNOME polish

**Status:** Finalized visual direction. Phase 3 and passive assistance paused.

Use **native flagship GNOME**, with **no glassmorphism**: no blur, acrylic,
glow, gradients or macOS styling. Keep GNOME Shell's opaque native themed
surfaces, radii, selection colors and focus treatment. GDI adjusts spacing,
typography and compact geometry. Opening/closing is a 120 ms opacity fade;
reduced motion remains immediate. Keep 500 logical pixels and the stable search
header anchor; completed AI/writing previews now use that same width and grow
downward within the available monitor height, instead of widening to 600px.

The **supplied Intelligence mark is the permanent GDI identity**. Its directly
traced SVG lives in `icons/hicolor/scalable/apps/gdi-intelligence-symbolic.svg`.
Use the same geometry in the panel, palette header, Ask Intelligence result,
AI/writing preview header and Preferences/About. Search/edit action icons are
still action symbols, not substitutes for the product mark. One symbolic asset
recolors natively for both themes; do not maintain divergent light/dark drawings.
GTK needs the hicolor directory layout to recognize and recolor it symbolically.
The build ships the asset and the isolated settings check verifies that GTK
loads the installed file as symbolic.

Use libadwaita Preferences pages for General, AI & Models, Privacy and About,
with groups for Shortcuts, Search, Writing, Provider, Models and Request limits.
Keep the existing settings and on-demand provider check. Original and Suggestion
have explicit labels; Replace uses Shell's native primary action and secondary
controls remain subdued. Do not add fake streaming: the existing complete-
response provider lifecycle and all Phase 2 architecture/model behavior remain.

Validation uses isolated GNOME 46 functional checks and screenshot captures in
light/dark themes at 100% and the host's 110% text scaling. Visual fixtures are
synthetic; separate integration checks exercise real request/cancel/replace
paths. Physical approval by the user remains the next step.


## 2026-09-24 — Phase 2 explicit intelligence and stale-edit protection

**Status:** Phase 1 accepted by the user; its feature-development pause is
superseded for Phase 2 only. Passive assistance remains out of scope.

Keep the accepted launcher unchanged and extend its existing preview. Add Ask
Intelligence only after deterministic intent checks. Explain uses the assistant
slot; harder reasoning requires explicit metadata. Preserve existing model
preferences but keep names outside routing code. Use provider health/discovery
only on demand. Ollama requests use bounded async libsoup I/O, explicit deadlines
and token budgets; complete responses were chosen over streaming for this phase.

Move accessibility details into `service/selection.py`. Capture against the
focused-window PID before modal focus, and expose plain metadata plus an opaque
caller-owned token. Permit safe read-only selections for explanation/copy.
Temporary revision listeners exist only during the explicit snapshot lifecycle;
they invalidate stale edits without reading event content. Closing/disconnecting
or expiring a token removes listeners and text. Remove the previous opt-in
post-edit watcher; no passive keystroke collection or suggestions are added.

AT-SPI delete/insert is not atomic. Check the live range, value, length,
surroundings and revision; verify the result; never blindly roll back an
ambiguous exception. GDI Undo is revision checked and available in the open
preview. Unsupported fields fail closed. Protected URLs, email addresses,
paths and backtick fragments must survive rewrites literally or the output is
rejected. Model output never enters an execution API.

Validation now distinguishes real local-model responses, controlled HTTP
failure tests, nested Shell UI integration, GTK accessibility fixtures and
physical application QA. Earlier entries below are historical records, not
claims about the current build. Sources consulted for the adapter:
[Ollama chat](https://docs.ollama.com/api/chat) and
[model discovery](https://docs.ollama.com/api/tags).


## 2026-09-24 — invariant compact launcher geometry and model defaults

**Status:** Supersedes the earlier 540px/five-result dimensions. Awaiting the
user's physical approval; feature development and passive writing remain paused.

Use `Clutter.FixedLayout` for the stage-sized overlay and explicitly disable
palette expansion. `BinLayout` inherited descendant expansion and allocated the
palette through the monitor's right edge despite its requested width. Anchor
normal mode at 500px, four 44–48px rows, and a fixed search-header top coordinate.
Results grow downwards. Include the selected monitor's x/y origins and retain
that monitor during query refresh. Long title, file-detail, and type labels
ellipsize. GNOME Shell owns stylesheet loading; duplicate manual registration
was retaining old large/translucent theme rules during live updates.

Defaults: `LiquidAI/lfm2.5-1.2b-instruct:q4_k_m` for quick writing,
`ministral-3:3b` for the reserved structured tool route, and `qwen3.5:4b` for both
assistant and reasoning. Preferences remain editable. Deterministic launcher
operations make no model call. Explicit Ollama requests use `keep_alive: 0`;
the provider accepts a per-request override for future lifecycle management.
No models are preloaded, no FunctionGemma is added, and no structured-action
feature or passive writing assistance is introduced.

## 2026-09-24 — replace Search Light with a Rudra-derived launcher foundation

**Status:** Adopted for Phase 1. This supersedes the earlier Search Light
foundation choice recorded below.

**Choice:** Keep GDI's project identity, top-panel indicator, status/Settings/
Quit menu, libadwaita preferences, packaging, validation runner, and product
documents. Replace the Search Light overview-reparenting integration with a
compact GDI-owned GNOME Shell palette and deterministic search/action pipeline
adapted selectively from Rudra. Keep the launcher restricted to apps, files,
web search, and calculator actions.

**Research:** Inspected Rudra's current repository at commit
`ecc3abd5b52f0cd1e698967dbdacbebad264bbbe` (2026-03-25), including its
extension lifecycle, custom palette, input/navigation, results, app/file
search, query parser, action executor, preferences/settings schema, styling,
AI client, metadata, Makefile, and license. Rudra declares GPL-3.0 and its
source marks GPL-3.0-or-later. The GDI license is GPLv3, so the selected code
can be adapted under the compatible combined license with attribution.

Rudra's current source is GNOME Shell/GJS based: its runtime imports use
Clutter, GLib, GIO, Shell, St, and GNOME Shell modules; preferences use GTK and
libadwaita. A repository-wide source/dependency scan found no Qt/QML, KDE
libraries, Electron, or Tauri dependencies. Its metadata lists Shell 45–50;
GDI itself remains scoped to Shell 46 until each other version is tested.
The latest upstream commit present when cloned was dated 2026-03-25, about six
months before this evaluation. That is a maintenance/compatibility caveat; the
decision is based on the inspected GNOME-native code and GDI's own Shell 46
validation, not an assumption of frequent upstream releases.

The useful technical fit is its own keyboard-first launcher surface, modular
app/file search, fuzzy ranking, result rows, keyboard selection, completion,
and safe arithmetic parser. Search Light was smaller and already used Shell
search providers, but that provider reuse required reparenting GNOME's private
Overview search entry/controller and patching Overview methods. That shape
provides less control over GDI's command/result model and makes GDI depend on
unstable Overview internals.

**Selective adaptation:** GDI keeps the existing panel indicator, settings
window, schema, build/package targets, and nested-Wayland test workflow. It
adapts Rudra's palette/result architecture, fuzzy app matching, GIO desktop app
search, bounded asynchronous home-folder file search, and safe calculator
grammar. GDI owns its result types, action validation/dispatch, web search
handling, UI styling, shortcut registration, and lifecycle. `open <name>` and
`file <name>` expose file search; `search <query>` opens a web search; a plain
application name resolves without a prefix.

**Excluded:** Rudra's AIClient and cloud providers, chat/history UI, plugin
manager and plugin guide, arbitrary `>` shell execution, provider/prefix menu
system, clipboard history, snippets, emoji/icon browsers, and broad theme
controls. These are outside this stable Phase 1 migration; future GDI
intelligence will use its own provider-neutral service architecture.

**Trade-offs:** A GDI-owned palette avoids modifying Overview internals but
uses GNOME Shell actors and modal APIs that still need Shell-version testing.
File search is deliberately explicit and bounded to visible entries under the
home directory, at most three directory levels and a short timeout; it is not
a desktop indexer. Rudra itself has no project test/lint target in the checked
source, so GDI validates adapted modules with its own lint/package and nested
Shell checks.

**Sources:**

- https://github.com/NarkAgni/rudra
- https://github.com/NarkAgni/rudra/tree/main/src
- https://github.com/NarkAgni/rudra/blob/main/LICENSE
- https://github.com/icedman/search-light/tree/gnome-47

## 2026-09-24 — theme-native compact palette and separate writing service

**Status:** Adopted for the launcher correction and Phase 2.

**Palette choice:** Use the active GNOME Shell theme's `popup-menu-content`,
`popup-menu-item`, and `search-entry` styles. GDI CSS sets geometry, padding,
spacing, and typography only; it does not simulate glass or encode theme colors.
Set the normal launcher width to 540 logical pixels and cap the visible result
list at five rows. Keep AI preview mode separately sized and scrollable.

**Service choice:** Keep Shell focus capture and UI in GJS, and move AT-SPI,
provider requests, exact text edits, and local learning into a separately
D-Bus-activated user-session service using PyGObject, GIO, AT-SPI, and libsoup.
This keeps a provider failure out of the Shell process and leaves deterministic
search/launch independent of Ollama. The provider contract and task-category
router own the Ollama adapter; GDI preferences hold model names and endpoint.

**Text safety:** Capture only a focused editable selection and bounded nearby
context. Refuse password roles/attributes. Before edit, verify the live
selection offsets, selected value, editability, and adjacent context; use
AT-SPI range deletion/insertion, never whole-field replacement or synthetic
keystrokes. Undo succeeds only when the inserted range is still unchanged.
Do not persist selected text, prompts, or responses.

**Learning:** Store only action/outcome/timestamp/application labels in a local
SQLite file, disabled by default and clearable from preferences. Event-based
accepted-edit detection is enabled only with learning and only for a short
window after an accepted replacement. Passive sentence suggestions stay
deferred until explicit range replacement is validated in GTK apps and Firefox.

**Trade-offs:** The AT-SPI target may not expose selection or editable-text
interfaces. GDI fails closed and leaves the original text untouched in that
case. GTK4/libadwaita remains the settings toolkit; no cross-desktop UI stack or
unrestricted command execution is introduced.

## 2026-09-24 — keep Writing Tools complete without widening launcher results

**Status:** Adopted and validated in nested GNOME 46.

**Choice:** Keep the normal launcher result limit at five. Writing Tools has ten
explicit actions, so it uses the same bounded scroll surface with its own
ten-item limit. This avoids silently hiding half the actions while preserving
the compact normal launcher.

**Validation:** The nested Wayland probe verifies five normal results and all
ten Writing Tools rows. A GTK4 fixture verifies selection/caret metadata,
precise replacement and undo, password-field exclusion, and clean Ollama
connection failure. A temporary GNOME Text Editor check confirmed its focused
editable text interface is exposed, but AT-SPI's selection setter did not work
for that widget in the automated check. Metadata-only scans of the running and
isolated Firefox instances found no editable nodes; Firefox documents that its
accessibility engine may remain off until accessibility tooling activates it.
See the [Firefox Accessibility Inspector documentation](https://firefox-source-docs.mozilla.org/devtools-user/accessibility_inspector/).
Do not claim either app's manual selection path as validated until that
physical check is completed.

## 2026-09-24 — initial Search Light prototype (superseded)

The first Phase 1 prototype used Search Light's `gnome-47` branch at commit
`591cadb98f88635b17a1b9671acc9ff958c9f9f9` for a minimal GNOME Shell
overlay/shortcut. The choice was reasonable for validating a compact Shell
surface, but did not give GDI a standalone command-oriented result pipeline.
After inspecting Rudra, Search Light's code was removed and Rudra was selected
as the stronger product foundation. No Search Light code remains in the current
Phase 1 tree.
