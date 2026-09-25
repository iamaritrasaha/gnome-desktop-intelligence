# Architecture

## Layers and ownership

```text
GNOME Shell (GJS)                      Session service (Python/PyGObject)
  palette UI, keyboard, clipboard  -->   GIO D-Bus request lifecycle
  focused-window PID                     selection.py: AT-SPI snapshots, capability facts, edits
  opaque context token + capability      router.py: explicit action -> model slot, prompt gates
  GTK4/libadwaita preferences           providers/: provider contract, Ollama HTTP
           GSettings                    passive.py: opt-in observation, debounce, offers
                                        quality.py: deterministic preflight/output gate
                                        learning.py: opt-in SQLite metadata
```

The Shell process contains UI only: no model HTTP, no synchronous
accessibility calls, no SQLite, and no text storage beyond the open
interaction. The service owns all accessibility objects (`selection.py`,
`passive.py`), all model routing, the quality gate, and the learning store.
`GetFocusedContext` returns a capability snapshot (JSON) beside the plain
context so the UI can always tell the user what is possible: `canReadText`,
`canReadSelection`, `canGetCaret`, `canReplaceSelection`, `canInsertText`,
`canObserveTyping`, `canPassiveAssist`, plus a `reason` when a capability is
missing (`no-accessible-field`, `protected-field`, `no-readable-selection`,
`not-editable`). The palette turns that snapshot into one of three explicit
outcomes for every writing action — supported (preview + guarded Replace),
readable but not replaceable (preview + Copy with an explanatory note), or
unavailable (a concise message) — and never a silent no-op.

## Deterministic launcher

The accepted GNOME Shell/GJS palette stays at 500 logical pixels with four
visible launcher results, a fixed header anchor, and GNOME theme styling.
Rudra attribution remains in source and NOTICE.md. Application lookup, bounded
GIO file lookup, explicit `search <query>`, and the safe arithmetic parser run
without a service or model. File contents are never read by launcher search.
No model tools or command execution interfaces exist.

## Explicit intelligence boundary

```text
GNOME Shell (GJS)                     Session service (Python/PyGObject)
  palette, keyboard, clipboard  -->    GIO D-Bus request lifecycle
  focused-window PID                  selection.py: AT-SPI snapshots and edits
  opaque context token                router.py: explicit action -> model slot
  GTK4/libadwaita preferences          providers/base.py: provider contract
           GSettings                  providers/ollama.py: async libsoup HTTP
```

The service is D-Bus activated under `org.gnome.DesktopIntelligence1`. Shell
never performs model HTTP requests or synchronous accessibility calls. Only the service accessibility modules (`selection.py` and `passive.py`) own
raw accessibility objects. UI receives a plain context:
token, selection, bounded nearby text, app, role, start/end/caret, and editable
flag. Calls are asynchronous from Shell. Discovery and generation share a
provider-neutral callback contract with availability, model inventory,
endpoint, cancellation, deadline, and token limits. Assistant responses stream through directed, request-ID-scoped D-Bus signals.
Writing replacements appear only after a complete validated response. Temporary
follow-up context lives only in the open palette; there is no persistent chat history. In-flight UI generations prevent late replies reopening or
altering a newer palette.

Ollama uses `/api/tags` for on-demand health and discovery and `/api/chat` for
text generation. Model names come from settings, never routing code. Defaults
retain the user's existing LFM2.5 writing and Qwen3.5 assistant/reasoning slots;
all can be changed independently. No model download/preload occurs. Requests
use `keep_alive: 0`, `think: false`, temperature 0.2, and configured context and
output budgets. HTTP bodies are read asynchronously in bounded chunks (256 KiB
maximum); output is limited to 20,000 characters. Redirects are refused. HTTP is
allowed only for localhost; a deliberately configured remote endpoint requires
HTTPS. Check does not load a model. Errors include missing model, absent server,
invalid response, output truncation, and timeout. Cancellation closes local I/O;
remote providers may finish outstanding server work after disconnect.

## Routing and UI

| Intent/action | Execution |
| --- | --- |
| Application match, explicit file/web query, arithmetic | Deterministic; no LLM |
| Explicit `ask` / `ask <question>` launcher command | Ask mode; outranks fuzzy app matches like the `search` prefix. Bare `ask` opens an empty focused prompt and sends nothing; `ask <question>` sends only the remainder |
| Natural question (`why…`, `how…`, `what…`) with no exact app match | Ask Intelligence row; the raw query is the prompt, verbatim |
| Query with no application match or explicit deterministic intent | Ask Intelligence row; assistant model only on activation |
| Fix grammar, Improve writing, concise, expand, tone, translate | Writing model |
| Explain, summarize, ask about selection | Assistant model |
| Explicit `harder` service task metadata | Reasoning model; no automatic escalation |

Intent verbs typed into the palette are routing metadata and are stripped
before anything reaches a provider: `selectionIntentParts` removes the leading
verb (`explain`, `fix`, `summarize`, `key points`, `rewrite`/`improve`,
`ask`) and collapses bare anaphora (`explain this`) to an empty instruction.
Nested probes assert the exact provider payload with an echo fixture, so no
internal name, prefix, or status text can reach a model unnoticed.

The old intent-model setting is retained for settings compatibility but has no
active routing behavior. There is no LLM intent classifier. Translation asks
for a target language; selection questions ask for an instruction. Rewrite
prompts request replacement text only. URLs, email addresses, obvious paths,
and backtick code fragments are compared as literal multisets; a changed token
rejects a rewrite. This is conservative protection, not a code parser.

Generation displays a Cancel button and Escape works throughout. Completed
responses use the existing bounded preview, with Original/Suggestion,
Replace (editable transformations only), Copy, Retry, Cancel. Ask and Explain default to Copy. A supported captured selection can also expose
an explicitly activated secondary Replace selection action. Read-only selections can be explained or transformed for
copying, never replaced. Keyboard focus moves to the first available control;
Enter activates it and Tab navigates controls. Long writing-action lists scroll
as the arrow selection changes. Copy confirms inline. No fullscreen chat UI.

## Selection and replacement safety

Explicit capture runs only on shortcut invocation, before Shell takes modal focus. The
focused window's PID restricts the accessibility traversal; if the window
changes before capture returns, Shell discards the token. The service uses a
bounded tree/time search and short AT-SPI remote-call timeouts. Password roles
and password/secret/protected attributes are rejected before text reads. Without a selection, supported multiline GTK fields retain only a caret snapshot
and up to 32 characters on each side for optional insertion guards. Those guards
never become model context; other unselected fields are not read. Exactly one range, up to 12,000 characters, and
up to 360 characters on each side are captured; the whole document is not read.

Each explicit snapshot installs a temporary text-change
listener. They compare source/range metadata, never collect event text or
keystrokes. Any intervening edit, including outside the nearby excerpt or an
edit subsequently reverted, invalidates replacement. Live checks also require
the same accessible, editable/sensitive state, nonsecret role, exact selected
range/value, total character count, and unchanged bounded surroundings.

AT-SPI has no atomic compare-and-swap or replace-selection transaction. GDI uses
range deletion/insertion and verifies the gap, inserted text, length and
surroundings. It never sets the whole field or synthesizes typing. An uncertain
remote exception must **not** blindly restore text: insertion might already
have succeeded. Only a confirmed failed insertion into an unchanged verified
gap permits restoration. Otherwise the preview reports an uncertain edit and
retains the original for recovery. App changes between AT-SPI calls cannot be
made fully atomic; physical compatibility testing remains required.

GDI Undo is available in the open preview. Expected notifications from GDI's
own edit, including consecutive GTK duplicates, settle in a bounded 50ms
one-shot window. Unexpected ranges still invalidate the token; subsequent
text revisions block Undo, even if the
inserted substring still matches. Undo verifies length, range, editability and
surroundings before restoring. Native application Undo grouping is toolkit
specific and is not assumed. Closing the preview releases its Undo snapshot.

Tokens belong to the D-Bus caller. Close, disable, disconnect, eviction, or a
15-minute one-shot expiry cancels requests, deregisters listeners and drops
selected text. The service may remain D-Bus activated but does no polling,
health probes, model traffic, or GPU work while idle. Explicit learning records action/outcome/app labels. Phase 3 adds a separately
opted-in observer and bounded post-acceptance learning, described below.

### Passive quality gate: closed correction algebra

`quality.py` accepts a passive suggestion only when every difference between
the source sentence and the model's replacement is independently derivable by
a closed, local rule — never because a threshold was loosened:

- Spelling: the shared COMMON map, plus a single-word substitution where the
  original word is invalid and the proposal is valid with ≥0.7 similarity.
- Capitalization: standalone `i` → `I`; first-word capitalization.
- Repeated function words (`the the`) collapse.
- Subject/auxiliary agreement: a same-lemma auxiliary swap (`be`, `have`,
  `do`, including `don't/doesn't` contractions) is accepted only when the new
  form is valid for the preceding subject and the old form is not
  (`I has` → `I have`, `He don't` → `He doesn't`).
- Irregular verb forms (closed lemma table): participle required after an
  auxiliary (`has went` → `has gone`); a finite participle without an
  auxiliary reverts to simple past (`I seen` → `I saw`); base → past needs
  local past evidence in the preceding words (`… yesterday and buy` →
  `… bought`); a wrongly agreed `has/have` before a past verb may drop out
  (`I has went` → `I went`). A different lemma is a rewrite, not a
  correction, and is rejected.

Reference sentence from physical QA: `I has went to the market yesterday and
buy some apples.` now fires the preflight trigger, and the corrections the
quick model proposes (`I went/have gone/had gone … bought`) are derived and
accepted, with `has→had`-style unjustified tense swaps still rejected. All
gate rules are covered by `tools/test-passive-unit.py`.

### Developer diagnostics

`PassiveStats` additionally returns a bounded `recent` trace (last 30 stages,
metadata only, never text): focus changes, typing-event counts, debounce
fires, captured role/toolkit/length, provider request/response, gate
accept/reject with category, suggestion shown, replacement result, and
dismissal reasons. It powers the physical-QA stage identification without
logging secrets or prose.

## Compatibility boundaries

GTK TextView/EditableText is the first test target. Unsupported or ambiguous
ranges fail closed; Copy remains available. See the Firefox findings below and
CURRENT_STATE.md for actual tests. GNOME 46 caches imported extension modules:
installing new files and toggling an already-imported extension does not
guarantee new code is running. Test fresh code in nested GNOME, and distinguish
that from the active desktop build.

## Firefox/Gecko capability matrix (measured)

Firefox 156.0.1, GNOME 46 Wayland, disposable profile, synthetic page
(`tools/firefox-capability-matrix.py`, evidence
`build/validation/firefox-capability-matrix.json`):

| Capability | textarea | input | contenteditable | static page text |
| --- | --- | --- | --- | --- |
| Focused accessible exposed | yes (`entry`) | yes | yes | yes |
| Read selection | yes | yes | offsets inconsistent | yes, via `document web` ancestor |
| Read surrounding text / caret | yes | yes | yes | n/a |
| Character extents (WINDOW) | no | no | contenteditable: yes | n/a |
| Replace via range delete+insert | refused: acknowledged, never applied | refused | refused | read-only |
| Replace via whole-value `setTextContents` | refused: acknowledged, never applied | refused | refused | read-only |
| Observe typing (AT-SPI text/caret events) | no events delivered | no events delivered | no events delivered | n/a |
| GDI end-to-end | readable, not replaceable (Copy) | readable, not replaceable | readable, not replaceable | **captured end-to-end** (`canReadSelection=true`) |

Conclusions enforced by the capability model:

- Static webpage selections are **readable and supported** end-to-end:
  Explain/Summarize/Ask-about-selection produce a preview with Copy; the UI
  states that direct replacement is unavailable. This is the primary Firefox
  writing-support win.
- Gecko editable replacement is **impossible through AT-SPI on this runtime**:
  both mutation APIs acknowledge without applying, and typing events are not
  delivered, so passive assistance cannot observe or replace. GDI keeps Gecko
  excluded from replacement and passive offers, but no longer as a blanket
  flag — the per-capability snapshot reports exactly what works.
- The hybrid IBus architecture was evaluated for this gap and is **not
  adopted**: AT-SPI already covers every field GDI can replace (GTK), while
  Gecko exposes neither usable surrounding text nor committed-text signals to
  the input-method layer, so an IBus engine would add no Firefox capability
  and a full custom IME is out of scope. Clipboard stealing, synthetic typing
  and pointer automation remain excluded.

## Phase 3.5: writing presentation and temporary Ask interaction

`Presentation.js` implements toolkit-independent word-token LCS, Markdown block
parsing, URL checks and deterministic natural-query checks. Its LCS allocation
is capped at 180,000 cells; longer passages use a common-prefix/suffix phrase
fallback. `ResponseView.js` renders escaped Pango in native St labels/buttons.
Both explicit and passive writing use this shared diff. Passive still receives
only the existing short changed excerpt; the whole paragraph is not duplicated.
No markup from a provider is accepted as trusted Pango or HTML.

Ask keeps the 500px launcher and the stable top edge, with a scroll area capped
at 310px and reduced further for smaller monitors. Streaming uses a plain-text
label refreshed at most every 80ms; completed responses render headings, lists,
bold, inline code, fenced code and native focusable HTTP(S) links. Links with
credentials and non-web schemes are not activated. Code is display/copy only.
Markdown tables, images, nested-list layout and LaTeX are plain text, not a web
renderer. Tab traverses response actions, links and the follow-up field;
Page Up/Down scroll, Enter submits a focused follow-up, Escape closes/cancels.

Copy, Retry and Clear are normal assistant controls. Retry reuses the context
from before that response. Follow-ups add RAM-only turns: at most six messages,
6,000 characters total, and 4,000 characters per retained answer. Older turns
are dropped; long answers are clipped for follow-up context. Clear and close
drop both conversation and accessibility tokens. Context labels identify
selected/nearby text and temporary conversation. No file, webpage or whole
window content is silently added. File search results still do not read files.

`TransformStream` adds a request ID and validated bounded history to the existing
`Transform` contract. `ResponseChunk(token, requestId, delta)` is directed to the
requesting D-Bus owner; Shell subscribes before dispatch and unsubscribes on
completion, error, cancel, clear or disable. `CancelRequest` checks both token
and request ID, so an obsolete cancellation cannot stop a newer stream. Service
and UI each reject late completions. The Ollama adapter asynchronously parses
bounded NDJSON, including split UTF-8 sequences, checks the terminal done flag,
and rejects truncated, oversized, invalid Unicode/control text and malformed
responses. Writing/passive output remains unstreamed until its quality checks
pass. No network or SQLite work runs in Shell.

Natural questions such as “explain …” and “why …” rank Ask ahead of weak app
matches; exact app names, arithmetic and explicit file/web intents retain
priority. With a selection, typed explain/summarize/key-points/rewrite/proofread
commands select explicit task metadata, with other requests going to selection
Ask. Writing uses quick, normal Ask/Explain/Summarize/Key points use assistant,
and harder remains an explicit service route with no automatic escalation.

Explicit rewriting masks URL/email/path/code literals with numbered placeholders,
requires each placeholder once, restores the original literals, then verifies
their multisets. It rejects empty/oversized output, common commentary prefixes,
aggressive omissions and disproportionate expansion (3× for expand/translate, 1.8× for other
rewrites, with a 160-character minimum allowance). Proofreading also requires substantial
word overlap; long normal rewrites must retain at least half the original length,
and long proofreading at least 70%. This is a conservative guard,
not a semantic-equivalence guarantee. The model can still make factual/style
mistakes, so replacements always require preview and acceptance.

### Optional caret insertion

Only explicitly captured, nonsecret multiline GTK fields expose Insert at
caret. A snapshot retains the accessible, caret, total length, revision listener
and 32-character guards on either side, but sends **none** of those guards to the
model. The UI states that the original caret is retained locally. The operation
reuses exact range editing with an empty original range; zero-length delete or
insert calls are skipped. Undo deletes only the verified inserted range.

A Shell modal grab temporarily removes keyboard focus from the target. Before
inserting, GDI releases its own grab, allows a 75ms one-shot focus handover, then
requires the original GNOME window and AT-SPI focused editable element, original
caret/no selection, revision, length and guards. It never activates another
window or simulates a key. It reacquires its grab for the result/Undo controls.
Changed focus or stale text refuses insertion. Close/disable removes the timer.
Firefox and GTK4 single-line fields cannot expose this action. Read-only targets
retain Copy only. Existing selected-range editing and passive acceptance keep
their established guards.

### Personalization and diagnostics

The SQLite v3 schema is unchanged. In addition to existing pattern/app gates,
six or more recent outcomes for an application/category totaling ≤−5 suppress
that category's proposal. This affects the offer gate; an unknown pattern may
still require one inference before its category is known. Preference scoring
uses accepted explicit actions +1, rejection −0.5 and guarded GDI Undo −2; a
clear winner with score ≥3 can influence general Improve writing. Casual tone
and concise/detail preferences are bounded prompt additions. Explicit tone and
length actions override them. Passive proofreading never adopts stylistic
preferences, and professional preference does not automatically formalize prose.
Preferences display tone/length and category counts/scores; Clear removes them.

`RequestStats` exposes up to 50 RAM-only records (action, route/model, first-token
and total milliseconds, completion/error/cancellation) plus the active count.
It contains no prompts or answers. `PassiveStats` retains its existing request,
cancellation, latency and listener/timer counters. Neither API polls or runs
model work. Diagnostics are not displayed as normal response chrome. See
CURRENT_STATE for actual measured timings and remaining physical tests.

## Phase 5: Writing Intelligence, predictive writing and Ask UX/history

### Predictive writing (Continue mode)

Predictive writing is a distinct Writing Intelligence capability with its own
prompt, gate, pacing and surface — never shared with Correct (proofreading)
or Rewrite. The observer in `passive.py` schedules a prediction on every text
change in an eligible field; a 500 ms pause, a 2.5 s minimum interval between
predictions, a caret at the very end of the text, and a useful-context
minimum (`prediction_source`: ≥30 chars, ≥6 words, no code markers) gate the
single quick-model request. There is no per-keystroke model call: a typing
burst produces at most one request, and continued typing cancels the
in-flight request and restarts the pause.

`router.run_prediction` asks a structured-output schema
(`{"continuation": string}`) with the quick model, ≤96 output tokens and an
8 s timeout. The answer passes `prediction.clean_prediction` before it can be
shown: multi-line output is cut to its first line; commentary openings,
Markdown syntax (`*_#[]>~\``), braces/JSON, URLs, email and paths are
rejected; one-word and trivial completions are suppressed; any 4-word run
copied from the source, and any continuation beginning with the source's
final words, is treated as an echo and dropped; length is capped at 160
characters and 28 words; leading whitespace is normalized to the exact
source. A model producing text is never a suggestion.

Before display the trigger re-verifies freshness (`_prediction_current`): the
same field focused, caret and length unchanged — a prediction that arrives
after the user kept typing is discarded. The ghost renders as a compact
headerless, buttonless surface (subdued italic text + hint line) anchored at
the caret through the shared anchor resolution. Tab (GTK multiline only) or
Ctrl+Alt+Enter accepts the whole continuation; Right accepts exactly one
word (`prediction-word-key`); Escape dismisses; typing, real caret movement
or focus changes dismiss it. Acceptance reuses the guarded caret-range
editor (`_replace` with an insert context): the insertion is verified, the
remainder stays as ghost text re-anchored at the new caret, and a short
guarded undo watch offers Ctrl+Alt+Z (an immediate undo is recorded as a
negative signal).

The service owns prediction staleness. The Shell never hides a ghost on
input-method caret events — the service sees the real AT-SPI caret offset
and distinguishes the final typing echo (same offset) from navigation
(different offset), hiding stale ghosts through `PassiveHidden`. Dismissals
always notify the Shell, so a surface is never visible without a live
prediction behind it. Learning signals (labels only, no text) extend the
existing store: `prediction` rows with accepted/partial/dismissed/ignored/
immediate_undo; five-plus recent signals totalling ≤ −3 suppress predictions
for that application; acceptance rates feed `LearningStats.predictions`.

### Compact contextual Writing Tools

The plain launcher list is replaced by a compact contextual surface
(`src/intelligence/WritingMenu.js` holds the pure, node-testable structure).
With a selection the surface shows a subdued selection preview and one chip
row: Improve, Fix, Shorten, Tone, More…. Tone expands to Professional,
Casual, Friendly, Direct; More expands to Expand, Summarize, Explain,
Translate, Ask Intelligence; both expose Back, and Escape unwinds a submenu
before closing. Without a selection but with `canReadCaretContext`
(editable GTK multiline, non-secret, non-Gecko), the surface offers
caret-scoped actions — Improve sentence, Continue writing, Fix paragraph,
Tone, More… — gated by the capability snapshot (Continue requires insertion
capability); unsupported targets keep the plain launcher with its capture
note. Typed selection intents keep the established verb-stripping semantics;
typed free text on the contextual surface keeps plain launcher routing.

No-selection actions capture the sentence/paragraph at the caret on the
explicit user action only: `GetCaretContext(pid, kind)` in `selection.py`
bounds the window (600/200 chars sentence, 1000/300 paragraph), requires the
public-text attribute-run check, and fails closed when a boundary cannot be
determined. `continue` captures the sentence ending at the caret as model
context but builds an insert-mode context (start = end = caret) so the
result is inserted at the caret via the guarded editor. Activation failures
are visible messages, never silent no-ops. Choosing an action transforms the
same surface into the existing diff/Markdown preview with Replace primary,
Copy/Retry/Cancel secondary and guarded Undo after acceptance.

### Ask Intelligence layout, streaming and history

The palette stays 500 px with a stable top edge and horizontal center in
every Ask state; the content area grows with content up to a
work-area-relative maximum (60% of the available work area, clamped to
220–520 px) and scrolls internally afterwards. While waiting for the first
meaningful content, a small native processing animation (Intelligence mark +
three pulsing dots, static under reduced motion) holds the surface — no
"Generating…" text and no raw Markdown.

Streaming is buffered by `Presentation.stableStreamView`: only completed
lines become rendered Markdown blocks (incrementally kept by
`ResponseView.StreamRenderer`); the trailing partial line renders as plain
text — and is hidden entirely while it still contains raw syntax tokens — so
`#`, `**`, backticks or list markers never flash. The first delta stops the
processing animation. Completed responses render through `addMarkdown`:
headings, lists, bold/italic, inline code, fenced code in distinct blocks
that scroll horizontally instead of widening anything, each with its own
Copy control, and safe, deliberately activated HTTP(S) links. The user's
question stays visible but subdued above the answer.

Every Ask interaction belongs to a conversation. The palette persists the
user turn on submission (`HistoryStart`/`HistoryAdd`); the service persists
the assistant turn when the request (which now carries a conversation id)
completes, so persistence survives client crashes. Retry trims the trailing
assistant turn first. Conversations are stored in a local SQLite database
(`history.py`, 0700/0600, `~/.local/share/gnome-desktop-intelligence/
history.sqlite3`) with `conversations` (id, auto title from the first user
question, timestamps, model metadata) and `messages` (conversation_id, role,
content, timestamp). Only user-visible content and metadata are stored — no
internal prompts, routing metadata or hidden reasoning. Messageless rows are
housecleaned after an hour; the store keeps the 200 newest conversations.
Writes happen only while `save-intelligence-history` is enabled (enforced in
the service, not just the UI); disabling keeps new interactions temporary
and never deletes existing history; Clear is explicit (Preferences and the
history list).

History is reachable from the panel menu ("Intelligence History") and the
`history` palette command. The list groups conversations Today / Yesterday /
Earlier with title, message count and question preview; opening one restores
the messages for reading (Markdown rendered) and Continue resumes the same
conversation id with the bounded RAM context rebuilt from the stored turns;
Rename, Delete and Clear All (two-step) are provided. Closing the palette or
Clear/New Conversation never deletes stored history.

Diagnostics stay bounded and content-free: `RequestStats` records
question length, conversation id and persistence status; `PassiveStats`
gains prediction counters (requests, shown, gate suppressions, staleness,
cancellation, insert refusals, latency) and the stage trace records
prediction stages with decisions but never text.

## Phase 4: native action registry, routing and execution

```text
GNOME Shell (GJS)                          Session service (Python/PyGObject)
  palette: action rows, confirm/          RouteAction(question, registry) -> JSON
  result views; learning/ranking            small routing model, structured output,
  src/actions/registry.js (pure data)       RecordActionDiagnostic, RecordActionUse,
  src/actions/parser.js (pure rules)        ActionStats (RAM-only, bounded)
  src/actions/engine.js (execution)
```

### Registry and trust boundary

`src/actions/registry.js` is pure data (importable by node): every action has a
stable id (`audio.setVolume`, `bluetooth.setState`, `system.diskUsage`, …), a
risk class (READ_ONLY, LOW_RISK, STATE_CHANGE; SENSITIVE/DESTRUCTIVE exist in
the policy but no Phase 4 action uses them), a backend tag, typed argument
schemas (`percent`, `step`, `factor`, `onoff`, `profile`, `scheme`, `panel`,
`dirname`, `url`, `text`, `app`), row/confirmation strings, and an availability
backend. `validateArgs` is the trust boundary: unknown ids, unknown keys and
out-of-type/out-of-range values are rejected, so neither the parser nor the
routing model can construct an unregistered or mistyped call. Relative-change
arguments use a dedicated `step` type (−100…100, non-zero) — the original
single `percent` type rejected negative steps, which silently diverted
`volume down`/`quieter`/`dimmer` to Ask Intelligence (found by live-host
testing and covered by regression). Two bounded representation repairs exist
at the same boundary for routing-model output only: `onoff` accepts the words
"on"/"off"/"true"/"false", and `profile`/`scheme` accept human-label forms
("Power Saver", "dark mode"); out-of-registry values are still rejected.

Backends are native only: GVC (the mixer library GNOME Shell itself uses) for
volume/mute; GSettings for color scheme, Night Light and text scaling;
NetworkManager D-Bus for Wi-Fi and network state; BlueZ D-Bus (adapter
`Powered`, device `Connected`) for Bluetooth; power-profiles-daemon D-Bus
(`net.hadess.PowerProfiles`, with the GNOME 47+ `org.freedesktop.UPower.PowerProfiles`
name as fallback) for power profiles; the session-bus SettingsDaemon Power
`Screen.Brightness` property for backlight; GIO for apps, folders, links,
Settings panels (whitelisted `gnome-control-center <panel>` names only) and
filesystem statistics; `/proc/meminfo` and UPower DisplayDevice for memory and
battery facts. There are no shell commands anywhere in the engine.

### Deterministic routing

`src/actions/parser.js` is a bounded, inspectable rule table (checked by
`tools/test-actions.mjs`) that normalizes phrasings — `volume 30`,
`turn bluetooth off`, `switch off bluetooth`, `disable wifi`,
`switch to power saver`, `turn on dark mode`, `open display settings`,
`open downloads`, `show my ip`, `how much disk space do i have`,
`tell me how much disk space i have`, `text scaling 1.25`,
`find resume pdf`, `find pdfs modified today` — onto registry actions.
Launcher precedence stays: `search` prefix (web), calculator, `ask` prefix,
then actions, then apps/files, then Ask Intelligence. Multi-step queries split
on `and`/`then`; every part must parse, at most three steps, no recursion.
`find <terms> <ext>` and a trailing `modified today` narrow the existing
bounded file search (extension and mtime filters in FileSearch.js, never a
wider scan and never file contents).

`mayNeedModelRouting` is a pure parser export: the query must name a desktop
capability (bounded keyword list) *and* have request shape — an action verb or
a state question. Capability noun phrases ("bluetooth technology", "dark
matter", "the history of wifi") go to Ask Intelligence and can never reach the
routing model.

### Execution, confirmation, verification and results

`src/actions/engine.js` runs inside the Shell process but is fully
asynchronous: D-Bus property/method calls with timeouts, a lazily opened GVC
control, and GSettings writes. `preparePlan(query)` re-validates parsed steps
and attaches confirmation decisions; the confirmation policy is a pure
registry function plus machine facts — immediate for READ_ONLY, launches,
volume/mute, color scheme, Night Light, brightness and power profile; explicit
compact confirmation for Wi-Fi off, text-scaling changes, and Bluetooth off
only when connected devices would be affected. A state-changing action
proposed by the routing model always plans a confirmation, even when the
deterministic policy would execute immediately: the model can raise the
confirmation bar, never lower it. Personalization never participates in this
decision.

Every mutating action verifies its own effect before reporting success: the
audio implementations re-read the GVC sink after the daemon applies the change
(bounded retry, ±2% tolerance), Wi-Fi and Bluetooth re-read
NetworkManager/BlueZ state, the power profile re-reads `ActiveProfile`,
brightness re-reads the gsd property, and the GSettings-backed actions re-read
the key after `Gio.Settings.sync()`. A disagreeing read-back raises a
`VerificationError` and the action reports a visible failure instead of a
false success.

Results render in the palette's native surface: "✓ …" for executed changes,
the structured answer for info actions (Copy available), per-step ✓/✗ lines
for plans (stopping at the first failure), and a concise
unavailable/service-down message otherwise. A failing action can never crash
the Shell: every backend error is mapped to a readable message. Closing the
palette during a confirmation always cancels the pending plan (trace closed as
cancelled, `_pendingPlan` dropped), and a result arriving after close records
its outcome without rendering into a closed palette.

### End-to-end action traces and developer diagnostics

One user invocation produces one bounded RAM-only trace (`engine.js`
`beginActionTrace`/`finishTrace`): raw launcher text, normalized text,
routing source (deterministic, model, launcher-app/file/web/calc),
deterministic match, proposed steps, chosen action, validated arguments, risk
class, confirmation decision, backend tag, per-step result, verification and
latency, the routing model's reply and latency, the final UI result and total
latency. Traces are capped at 50 records and mirrored to the service's
existing RAM-only `RecordActionDiagnostic` (records >4096 bytes are dropped
service-side) with `NO_AUTO_START`, so executing an action never spawns the
intelligence service. Launcher activations (app/file/web/calc) are traced as
well, and their launch failures notify the user instead of only logging. The
hidden palette command `gdi diagnostics` (never advertised in normal UI)
renders the recent traces with Copy and Reset buttons; Reset also clears the
service mirror via the new `ResetActionStats` method. Traces contain no
writing-tool text and no secrets; launcher text is truncated to 200
characters.

### Model fallback and diagnostics

Only when deterministic parsing finds nothing and `mayNeedModelRouting` says
the query plausibly names a desktop capability as a request does the palette
call the service's `RouteAction(question, registry)`. The service runs the
configured small routing model (`model-intent-routing`) with a
structured-output schema and a compact registry description, returns
normalized JSON (`normalize_intent_response`), and imposes a 200-character
question cap, a 16 KiB registry cap and a concurrency limit of 2. The Shell
re-validates the reply against the registry (`prepareAction`); unknown actions
or invalid arguments are recorded as invalid tool calls (a running counter
lives in `diagnosticsSummary` and each trace) and fall back to the Ask
Intelligence row. Suggested rows are marked "Suggested"; launch/file/web/url
actions are never model-routable. The model's reply text is kept in the trace
for debugging. Measured on this host, the configured 1.2B routing model often
produces invalid calls; the fail-closed path (rejection → Ask → counter) is
the designed behavior and a stronger `model-intent-routing` model is a user
setting, not code.

Learning is ranking-only and gated by the existing opt-in `enable-learning`
setting: accepted app/folder actions record labels (`app.open`, target) into
the existing bounded signals table; `ActionStats` returns per-app and
per-folder counts that can reorder candidates within a search-score tier (an
exact match always outranks a boosted weaker match). Queries, file contents and
web-search terms are never stored.

Diagnostics mirror bounded records (source, action, args, risk, latency,
status, reason) to the service's RAM-only `ActionStats` via `NO_AUTO_START`
calls, so executing an action never spawns the intelligence service; records
cover deterministic vs model routing, execution latency, failure reasons and
invalid model tool calls, and never appear in normal UI.

### Regression coverage

`tools/test-actions.mjs` (node) asserts the rule table, argument validation,
confirmation policy and model-routable surface. `tools/test-model-routing.py`
covers the routing-model payload and response normalization. Nested GNOME 46
probes (`validateActions` in `tools/intelligence-regression.js`) exercise rows,
immediate execution, the confirmation view without execution, graceful audio
unavailability, read-only system-bus state, a two-step plan, and the
echo-fixture-verified model fallback with an invalid-tool-call fallback.

## Phase 3: passive writing boundary

`PassiveController.js` is separate from the launcher. It owns only the small
nonmodal Shell surface, temporary shortcuts, focused-window PID/geometry and
coordinate-only input-method signals. `passive.py` owns accessibility events,
debouncing, snapshots, cancellation and the eight-second post-edit watch.
`quality.py` provides deterministic preflight and output validation;
`learning.py` owns SQLite. No HTTP, SQLite, synchronous AT-SPI calls, document
reads or inference run in Shell. The existing explicit workflow is unchanged.

Observation is off by default. When enabled and a normal application has focus,
the service subscribes to four AT-SPI event types: text changed, caret moved,
selection changed, focused state changed. It ignores event text payloads,
filters the focused application's PID, excludes protected ancestors, and reads
only after an 800ms pause. The internal GSettings debounce range is 600–2000ms.
There is no accessibility-tree polling. Password/hidden/sensitive input-method
hints, when exposed by the compositor or IBus, also disable observation; GTK 4 single-line fields are excluded because
masked Gtk.Entry can omit all these markers. Bounded Text attribute runs must
also confirm that no invisible text tags occur before reading a range; AT-SPI visible/showing/editable/focused states
are required independently before a text read. Lock, overview, launcher open,
extension disable and client disconnect stop passive work.

The initial trigger is deliberately narrower than autocomplete: a completed
English sentence, 16–280 characters and at least four words, ending in `. ! ?`.
Only up to 320 preceding characters, 32 following characters, and 32-character
replacement guards are read. Mid-sentence carets, selected ranges, clipped long
sentences and obvious code are suppressed. Optional system Enchant checks
English dictionary coverage and misspellings; without it the built-in grammar,
capitalization, repeated-word and spelling rules still work. Unsupported
languages are not translated or rewritten automatically.

Preflight requires an identifiable potential correction. A clean or incomplete
sentence makes no request. At most one passive generation is authoritative;
new typing cancels obsolete work immediately. Requests are separated by at
least five seconds, use only the configured quick/writing model, cap output at
512 tokens and timeout at 20 seconds, and retain `keep_alive: 0`. Provider errors
are silent, with 15–60 second backoff. A later eligible typing event retries;
there are no idle health probes or permanently loaded passive models.

The provider-neutral `response_schema` option requests a JSON replacement and
reason. Ollama maps this to its documented [structured output format](https://docs.ollama.com/capabilities/structured-outputs).
Explicit Phase 2 requests do not use this option. A model's reason is not trusted
as evidence: the gate independently reconstructs a limited local correction.
Identical/whitespace-only output, commentary, style changes, unsupported word
substitutions, changed numbers/protected literals and disproportionate rewrites
are rejected. No model tools or executable actions exist.

### Placement and acceptance

AT-SPI WINDOW character extents are preferred. GTK 4.14 reports this operation
unsupported; Firefox Wayland may return sentinel coordinates. The fallback
uses GNOME 46's existing input-method cursor-location signal (or IBus's cursor
location when no Wayland input focus exists), as Shell's own keyboard tracker
does. Only coordinates are observed, never surrounding-text or keystroke
signals. The service requests a fresh coordinate snapshot after debounce;
Shell returns it only for the same window and within three seconds. Invalid
anchors suppress inference/UI. Coordinate movement invalidates pending UI.

The surface uses 220–340px width according to its content, and at most 200px height, below the caret or above it
when the monitor edge requires it. It shows two local phrase lines with subdued struck-out removals and bold
proposals, the permanent Intelligence mark, Accept and Escape. Its 90ms opacity
transition respects the existing reduced-motion setting. It takes no modal grab or
application focus. Ctrl+Alt+Enter accepts; Escape dismisses. Optional Tab is an
additional temporary binding only for visible small corrections in GTK
multiline fields. It is off by default because Tab normally indents/navigates;
single-line and browser fields never take Tab. Ctrl+Alt+Enter remains usable
with optional Tab. Bindings disappear immediately when the surface does.

Acceptance reuses the Phase 2 range editor. It additionally requires the same
focused app/accessible, no selection, identical caret, exact source range,
unchanged length and surrounding guards, and no intervening text revision.
It never writes without acceptance. It restores the caret best-effort and
offers guarded GDI Undo (Ctrl+Alt+Z) for eight seconds. Native Undo transaction
grouping is toolkit-dependent; GDI's fallback does not synthesize keys. An
uncertain edit retains a bounded original for Copy original recovery until
dismissal/expiry; GDI never blindly reinserts text after an uncertain API call.

GTK 4 single-line fields are excluded from **both explicit capture and passive
reading**, because masked and ordinary Gtk.Entry expose indistinguishable
accessibility metadata on this host. This privacy correction is the only Phase
2 compatibility restriction introduced. GTK multiline fields remain supported.
Gecko is currently excluded from passive offers: Firefox 156.0.1 exposes the
fields and events, but its EditableText deletion acknowledged success without
changing the tested controls. The test runner bypasses first-run onboarding
only in a disposable profile, with browser telemetry disabled. No user profile
or browser preference is modified. No browser extension, clipboard paste or
simulated typing workaround is installed.

### Learning and privacy

Personalization and retaining edit examples are separate opt-ins, both off.
SQLite lives at `$XDG_DATA_HOME/gnome-desktop-intelligence/learning.sqlite3`
(default `~/.local/share/...`), directory 0700 and database 0600, schema version 3.

| Table | Stored fields |
| --- | --- |
| `signals` | Existing explicit action, outcome, application, timestamp |
| `outcomes` | Passive action/model/app, broad field type, correction category, keyed pattern digest, outcome/weight, word-count delta, timestamp |
| `metadata` | Random local HMAC key for opaque correction pattern IDs |
| `examples` | Outcome ID, consent version, original/suggestion/final text; only separately consented accepted-and-edited examples |

Weights: accepted unchanged +3; accepted then edited +1; dismissed −1;
continued typing −0.25; immediate GDI/native Undo detected within the watch −4.
The short post-edit watch observes offset/count metadata, not event text. Only
a still-focused, matching bounded range can be read for the final edit. Edited
ranges whose event sequence or length is ambiguous never become examples.
Turning learning off/clearing data invalidates in-flight learning consent,
including callbacks that finish later. An unwritable learning database disables
learning for that suggestion without breaking proofreading.
Turning example retention off purges examples with SQLite secure-delete and
VACUUM; startup also enforces the setting. Filesystem backups/SSD physical
remanence are outside SQLite's guarantees.

Repeated negative patterns (at least three recent outcomes totaling ≤−3) are
suppressed. Eight or more recent app outcomes totaling ≤−6 suppress inference
for that app until learned data is cleared. Positive outcomes offset negatives.
Pattern IDs use keyed HMAC of changed words, not plaintext sentences. Explicit
accepted tone/length actions provide inspectable preference counts; passive
proofreading preserves tone and wording rather than imposing a guessed style.
Model/task usage and accepted word-count deltas are available in statistics.
No weights are trained, and no model can alter prompts, code or configuration.
Retention is bounded to 5,000 metadata outcomes and 500 consented examples.
Ordinary typed text, model prompts and responses are never persisted by default.

GTK 4.14 PRIVATE-only input hints were not forwarded by this nested runtime.
GDI cannot infer sensitivity that an application does not expose. The password
input purpose and AT-SPI secret/invisible markers are independently checked.
