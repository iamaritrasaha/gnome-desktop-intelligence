# Decisions


## 2026-09-25 — live reliability audit: verified actions, tracing and model-routing repairs

The user reported that passing automated tests did not prove the Phase 4/5
tools work in normal use and authorized a live reliability audit and repair
pass (no new features). The live installation was audited first: the installed
extension matched the source byte-for-byte, schemas matched, exactly one
D-Bus-activated service instance ran from the installed path, and the journal
showed no GDI errors — the earlier "Phase 4 activates next login" install had
indeed activated.

**Real-host testing found defects the mock/nested suites could not.** All of
them are recorded in CURRENT_STATE's verification table with root causes:

- `volume down`, `quieter`, `dimmer` parsed to `{step: -10}` but the registry
  typed `step` as the 0–100 `percent`, so validation vetoed every negative
  step and the palette silently fell back to Ask Intelligence. The registry
  now has a dedicated `step` type (−100…100, non-zero). Lesson: a parse-level
  unit test that never runs `validateArgs` over the parsed value is an
  incomplete test; the gap survived because `test-actions.mjs` asserted only
  the parse.
- The live routing model (LFM2.5 1.2B) answered `enabled: "off"` (string),
  `profile: "Power Saver"` (human label), hallucinated ids, and one
  wrong-direction suggestion. The registry boundary now performs bounded
  representation repairs only — `"on"/"off"/"true"/"false"` for onoff, human
  label/alias forms for profile and scheme — while out-of-registry values are
  still rejected and counted as invalid tool calls. Fail-closed behavior was
  verified live; the tiny model's semantic accuracy is a model-quality limit,
  not an architecture defect, and `model-intent-routing` stays user-fixable.
- The routing-model keyword gate let noun phrases such as "bluetooth
  technology" reach the model. `mayNeedModelRouting` (now a pure parser
  export) additionally requires request shape — an action verb or a state
  question — so capability *mentions* go to Ask Intelligence, and a
  model-proposed STATE_CHANGE always plans a confirmation even when the
  deterministic policy would execute immediately. The routing model can only
  raise the confirmation bar, never lower it.

**Every mutating action now verifies its own state read-back.** Volume/mute
re-read the GVC sink after the daemon applies the change, Wi-Fi and Bluetooth
re-read NetworkManager/BlueZ state with a bounded retry, power profile
re-reads ActiveProfile, brightness re-reads gsd, and the GSettings-backed
actions re-read the key. A disagreeing read-back is a visible failure
(`VerificationError`), never a success message. The real-host verifier
exercised every reversible mutation live with restore-verification passing.

**One invocation produces one end-to-end trace.** `engine.beginActionTrace`
records raw text, normalized text, routing source, deterministic match,
chosen action, validated arguments, risk class, confirmation decision,
backend, per-step result/verification/latency, the routing model's reply and
latency, the UI result and total latency — RAM-only, bounded to 50, mirrored
to the service's existing `RecordActionDiagnostic` (4096-byte records) with
`NO_AUTO_START`. Plain launcher activations (app/file/web/calc) are traced
too, and their file/web launch failures now notify instead of only logging.
A hidden palette command (`gdi diagnostics`) renders the traces with Copy and
Reset (which also clears the service mirror via the new `ResetActionStats`
method); it is documented as developer-only and never shown in normal flows.

**Closing a confirmation always cancels its plan.** `close()` finishes the
pending trace as cancelled and drops `_pendingPlan`, so Escape, the Cancel
button, an outside click or a newer query can never leave an actionable plan
behind, and `_renderActionResult` refuses to render into a closed palette
while still recording the outcome. Nested probes now cover the
model-sourced confirmation, the noun-phrase gate, the "tell me" multi-step
form and the diagnostics view; `tools/verify-live-actions.py`
(`--read-only`/`--reversible`) is the permanent real-host regression tool.


## 2026-09-25 — Phase 5: Writing Intelligence, predictive writing, Ask UX and history

The user authorized a single pass covering predictive writing, the Writing
Tools redesign and the Ask Intelligence UX/history overhaul, with the
existing architecture, native GNOME styling, provider abstraction, safety
checks, Intelligence mark and deterministic launcher preserved. IBus/browser
writing research stays deferred.

**Prediction is its own capability, not a third proofreading mode.** The
Continue prompt, structured-output schema, quality gate and pacing live in
`prediction.py`/`router.run_prediction` and never touch the correction
algebra. The trigger reuses the passive observer's event stream because that
is the only sanctioned way to know a user paused in a supported field, but it
is a separate state machine: 500 ms pause, 2.5 s minimum interval,
end-of-text caret, ≥30 chars/6 words of context, no per-keystroke calls,
aggressive cancellation, and a freshness re-check before showing anything
that arrives after continued typing.

**The gate, not the model, decides what is worth showing.** Echoes (any
4-word run already present, or a continuation starting with the source's
final words), one-word/trivial completions, >160 chars, commentary openings,
Markdown syntax, braces, URLs/emails/paths and multi-line output are all
suppressed deterministically. False negatives are preferred to an unwanted
interruption, consistent with the passive gate philosophy.

**Ghost text is a service-anchored surface, not fake inline text.** GNOME
cannot draw inside another application's text view, so the continuation
renders as a compact headerless surface at the caret with visibly secondary
styling; the task explicitly prefers this over pretending the text is
inline. Keyboard acceptance is deliberately limited: full Tab acceptance
only where Tab is safe (GTK multiline, the same gate as passive Tab), Right
for one word behind its own configurable key, Escape always. Two concrete
races were found by the nested suites and fixed at the source rather than
worked around: the anchor-request expiry armed for the first (failed)
extents attempt survived the successful retry and killed fresh ghosts
(`set_anchor` now drops both feature timers), and the input method's final
typing caret event dismissed a ghost anchored at that very position —
prediction staleness now belongs entirely to the service, which sees the
real AT-SPI caret offset and hides stale ghosts through `PassiveHidden`.
Dismissal always notifies the Shell: a visible surface without a live
prediction behind it is a bug.

**Undo after prediction acceptance expects the post-insert caret.** The
guarded undo verification is caret-sensitive; the full-accept path now
records the post-insert caret position (and sets it), so Ctrl+Alt+Z works
where the naive expectation (caret unchanged) would refuse every undo.

**Writing Tools move from a list to a surface with progressive disclosure.**
Pure, node-testable `WritingMenu.js` holds the structure: Improve, Fix,
Shorten, Tone, More… with Tone (Professional/Casual/Friendly/Direct) and
More (Expand/Summarize/Explain/Translate/Ask Intelligence) behind explicit
expansion. No-selection support uses a new explicit capture
(`GetCaretContext`) — the sentence/paragraph at the caret is read only when
the user actually picks an action, bounded and fail-closed, GTK multiline
only. `continue` captures the sentence as model context but inserts its
result at the caret through an insert-mode context; on-demand Continue and
ghost prediction share the router action but not the gates. Typed free text
on the contextual surface keeps launcher routing so `ask`-prefix and
insert-at-caret semantics stay exactly as validated in Phase 3.5.

**Ask keeps the launcher's 500 px and gains real reading layout.** Width is
fixed through every state; height grows to a work-area-relative maximum
then scrolls internally. The processing animation replaces textual
"Generating…" indicators, and streaming is buffered (`stableStreamView` +
`StreamRenderer`): completed lines render as native Markdown blocks, the
partial tail is plain text or hidden while it holds raw syntax, and the
first delta retires the animation. Code blocks scroll horizontally with
their own Copy control rather than widening anything.

**History is local-first and default-on by explicit instruction.** The
service owns persistence (assistant turns are written when the request
completes, so a crash cannot lose them); the schema keeps only visible
conversation content, auto titles and minimal metadata; messageless rows are
housecleaned and the store keeps 200 conversations. `save-intelligence-history`
is enforced service-side — disabling it makes new interactions temporary and
deletes nothing; clearing is always explicit. Retry trims the trailing
assistant turn instead of duplicating it. Selection-Ask persists the
question and answer but not the selection text itself.

**Validation lesson:** fixture mocks that match keywords anywhere in the
prompt misfire once conversation history legitimately contains those words —
match the actual request line. And a D-Bus signature change must be made in
the introspection XML too; the nested runtime caught the `(bis)`→`(bbis)`
mismatch as a silent ConfigurePassive failure that disabled the whole
observer.


## 2026-09-25 — Phase 4: native GNOME actions with a closed registry

The user authorized Phase 4 (native GNOME actions), paused all further
IBus/browser/passive-writing research as deferred-not-abandoned, and required
the existing Writing/Ask behavior to be preserved.

**Execution lives in the Shell process, by constraint of the audio backend.**
The only stable native volume interface is GVC — the mixer library GNOME Shell
itself ships and uses — and it is only introspectable inside the Shell process
(the typelib lives in gnome-shell's private directory; Python cannot import
it). Rather than split execution between processes, the whole action engine
runs in Shell (`src/actions/engine.js`): GVC for audio, GSettings for color
scheme/Night Light/text scaling, system-bus D-Bus for NetworkManager, BlueZ and
power-profiles-daemon (with the GNOME 47+ interface name as fallback), the
session-bus SettingsDaemon Power `Screen.Brightness` property for backlight,
GIO for apps/folders/links/Settings panels/filesystem facts, `/proc/meminfo`
and UPower for memory/battery. Every call is asynchronous with a timeout and
every failure maps to a readable message; a failed action can never crash the
Shell. No shell commands exist anywhere in the engine; Settings panels use a
whitelisted `gnome-control-center <panel>` name list verified with
`gnome-control-center --list` on GNOME 46 (with `appearance` aliased to
Ubuntu's `ubuntu` panel).

**The registry is the trust boundary.** Pure, node-testable
`registry.js`/`parser.js` hold ids, typed argument schemas, risk classes and
phrasing rules. `validateArgs` rejects unknown actions, unknown keys and
out-of-range values; the parser vetoes invalid values at parse time and all
information rules are anchored so that multi-step splitting stays unambiguous.
Launching apps, opening files/folders/links and web search remain purely
deterministic and are never model-routable.

**Deterministic first, model rarely.** The routing model (the previously
reserved `model-intent-routing` slot, defaulted to the installed quick model
because `ministral-3:3b` is not installed) runs only when deterministic
parsing found nothing and a bounded keyword gate says the query plausibly
names a desktop capability. The service's new `RouteAction` maps the query to
at most one registered action via structured output and returns normalized
JSON; the Shell re-validates it, marks the row "Suggested", and records
invalid tool calls in diagnostics. No `run_shell` tool exists at any layer.

**Confirmation policy is code, not learning.** READ_ONLY and LOW_RISK execute
immediately; volume, mute, color scheme, Night Light, brightness and power
profile are treated as reversible/obvious; Wi-Fi off, text-scaling changes and
Bluetooth-off-with-connected-devices require a compact confirmation. The
Bluetooth device check reads BlueZ state (2s cache) — the one conditional
confirmation this phase. Multi-step plans (max three steps, both halves must
parse, no recursion) show a plan before execution when any step needs
confirmation and stop at the first failure.

**Diagnostics and learning mirror to the service with NO_AUTO_START**, so
executing an action never spawns the intelligence service: bounded RAM-only
`ActionStats` records source (deterministic/model), action, args, risk,
latency, result and invalid tool calls; usage learning (existing opt-in only)
records app/folder labels for within-tier ranking boosts that can never
outweigh a stronger deterministic match or alter safety. Queries, file
contents and web-search terms are never stored. `find <terms> <ext>` and
`modified today` narrow the existing bounded file search; they never widen the
scan or read contents.

**Validation lesson:** a `RouteAction` fixture with text after the echo marker
made the mock return unparseable JSON (correct conservative behavior), and a
test staging without a pinned provider endpoint silently reached the host's
real Ollama. Fixtures now put the echo marker at end-of-line and pin
`model-endpoint` to the loopback mock inside a private bus/HOME
(`tools/test-action-service.py`).


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
