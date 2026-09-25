# Current state

Updated: 2026-09-25 (live reliability audit — actions verified on the real host)

## Live reliability audit — actions verified on the real host (2026-09-25)

Triggered by the user's report that passing automated tests did not prove the
Phase 4/5 tools work in normal use. No new features were added. The pass
audited the live installation, built an end-to-end action trace, repaired
every defect found by real-host testing, and verified every Phase 4 action
against the actual machine — `tools/verify-live-actions.py`
(`--read-only` / `--reversible`) is the permanent real-host tool.

### Installation audit (before any code change)

Installed extension byte-matched the source tree (all JS, schemas, service
files compared with `cmp`), the D-Bus service file pointed at the installed
service path, exactly one `org.gnome.DesktopIntelligence1` instance ran
(D-Bus activated, "GDI session service ready" in the journal), live GSettings
matched the expected configuration (shortcut `<Alt>Control_L`, passive
writing on, learning on, `model-intent-routing` =
`LiquidAI/lfm2.5-1.2b-instruct:q4_k_m`), the extension reported ACTIVE on
GNOME Shell 46.0, and the journal contained no GDI JS errors (the only
`this.actor is null` error is GNOME Shell's own windowManager code). The
12:58 login had activated the Phase 4 install as recorded.

### Real defects found by live-host testing (all fixed, all regression-covered)

| # | Defect | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | `volume down`, `quieter`, `dimmer` never executed — they fell back to Ask Intelligence | `audio.adjustVolume`/`display.adjustBrightness` typed `step` as the 0–100 `percent`, so `validateArgs` vetoed `{step: -10}`; parser tests never ran validation over parsed values | Dedicated `step` arg type (−100…100, non-zero) in `registry.js`; nested + node regression coverage incl. validation |
| 2 | Routing model answered `enabled: "off"`, `profile: "Power Saver"` — valid intents rejected as invalid tool calls | Strict boolean/enum types rejected the model's word forms | Bounded representation repairs at the registry boundary (onoff words; profile/scheme human labels + aliases); out-of-registry values still rejected |
| 3 | `bluetooth technology` reached the routing model and could surface a Bluetooth action row | The keyword gate had no request-shape requirement | `mayNeedModelRouting` (pure parser export) requires an action verb or state question; capability noun phrases go to Ask |
| 4 | A model-proposed state change could execute immediately (e.g. Bluetooth off with no connected devices) | Model-sourced steps used the deterministic confirmation policy | Model-sourced STATE_CHANGE always plans a confirmation — the model can raise the bar, never lower it (nested probe) |
| 5 | Mutating actions reported success from a D-Bus return value without checking the state | No read-back | Every mutation verifies: GVC sink re-read (±2%, bounded retry), NM `WirelessEnabled`, BlueZ `Powered`, `ActiveProfile`, gsd `Brightness`, GSettings re-read; disagreement → `VerificationError` → visible failure |
| 6 | Results could render into a closed palette; an executed-while-closed result was invisible | No `_isOpen` guard in `_renderActionResult` | Trace records the outcome; UI renders only while open; closing a confirmation always cancels its plan |
| 7 | Launcher file/web launch failures only hit `console.error` (silent for the user) | Fire-and-forget launches | Failures notify; all launcher activations (app/file/web/calc) are now traced |
| 8 | App/file/web/calc launches left no diagnostics; `localDiagnostics()` was dead code | No end-to-end trace existed | One trace per invocation (raw/normalized text, routing source, intent, validated args, risk, confirmation, backend, per-step result+verification+latency, model reply, UI result, total latency), RAM-only, mirrored to `ActionStats`; hidden `gdi diagnostics` palette view with Copy/Reset (`ResetActionStats` service method) |

Live `RouteAction` probes against the running service with the real routing
model also confirmed the fail-closed behavior: a hallucinated id ("save some
battery" → action `save`) is rejected and falls back to Ask Intelligence with
the invalid-tool-call counter incremented. The tiny 1.2B model's semantic
accuracy (one wrong-direction suggestion) is a model-quality limit;
`model-intent-routing` remains a user setting.

### Real-host verification table (2026-09-25, `build/validation/verify-live-*.json`)

Read-only checks ran on the live host; reversible checks performed the
mutation, verified the read-back, and restored + re-verified the original
state. Wi-Fi and text scaling toggles were intentionally not executed on the
live desktop (session may depend on Wi-Fi; text scaling rescales the whole
desktop) — both are covered in nested sessions.

| Action | Parsed correctly | Executor called | Real state verified | Result |
| --- | --- | --- | --- | --- |
| Volume set/step | yes (`volume 30`, `set the volume to 40`, `volume 30 percent`, `make sound 30`) | yes (GVC/PipeWire) | yes — read-back 30%/60% on the live sink | PASS |
| Mute/unmute | yes (`mute`, `unmute`, `sound off/on`) | yes (GVC/PipeWire) | yes — muted state read back | PASS |
| Bluetooth | yes (`turn/switch/disable bluetooth off`, `is bluetooth on`) | yes (BlueZ `Powered`) | yes — powered read back; off→on restored (0 connected devices) | PASS |
| Wi-Fi | yes (`is wifi on`, `turn wifi off` + confirmation) | yes (NetworkManager) | read-only on live host; physical toggle intentionally skipped (session depends on it) | PASS (read-only) |
| Power profile | yes (`switch to/use power saver`, `performance mode`) | yes (power-profiles-daemon) | yes — `ActiveProfile` read back; performance restored | PASS |
| Dark mode | yes (`dark mode`, `turn on dark mode`, `light mode`) | yes (GSettings) | yes — `color-scheme` re-read; prefer-dark restored | PASS |
| Night Light | yes | yes (GSettings) | yes — re-read and restored | PASS |
| Brightness | yes | yes (gsd `Screen.Brightness`) | n/a — no backlight on this machine; reports unavailable correctly | PASS (graceful) |
| Disk | yes (`how much disk space do i have`, `tell me … i have`) | yes (GIO statvfs) | yes — real 234 GB volume numbers | PASS |
| Memory | yes (`memory usage`, `how much memory am i using`) | yes (/proc/meminfo) | yes — real 16.7 GB totals | PASS |
| IP / network | yes (`show my ip`, `what is my ip`, `network status`) | yes (NM addresses) | yes — live connectivity/addresses | PASS |
| Apps | yes (`open firefox` → app row) | yes (GIO launch) | yes — live learning shows real launches; failures now notify | PASS |
| Folders | yes (`open downloads`, `open documents`) | yes (GIO launch) | yes — `directory.open` traced; ranking live | PASS |
| Settings panels | yes (`open display settings`) | yes (whitelisted panels; `--list` verified 25/25) | yes — panel whitelist matches host | PASS |
| Multi-step plans | yes (`turn bluetooth off and switch to power saver`; `open downloads and tell me how much disk space i have`) | nested probes | stop-at-first-failure, ≤3 steps, plan view | PASS |
| Confirmation UX | Enter focuses Cancel; Esc/outside click cancels; stale plan dropped on close | nested probes | model-sourced state changes confirmed too | PASS |
| Model routing fallback | deterministic-first; noun phrases never routed | yes (live RouteAction) | invalid ids/args rejected + counted; Ask fallback | PASS |

### Validation performed (2026-09-25, audit pass)

| Check | Result |
| --- | --- |
| `make lint pack` | PASS (strict schemas, JS/Python syntax, packaging regressions) |
| `make test-refinement` (43 suite results incl. `test-actions.mjs`, `test-action-service.py`, prediction/history/writing/streaming/safety/provider) | PASS |
| `tools/validate-nested-wayland.sh` (fresh pack) | PASS — **132 GDI_TEST probes true, zero failures**: all prior launcher/Ask/writing/history/passive probes plus new `volume down` regression, model-sourced confirmation (`model-state-change-*`), noun-phrase gate (`noun-phrase-not-model-routed`), `multi-step-tell-me-disk`, and the `gdi diagnostics` view (`diagnostics-view-shown`/`reset-button`/`reset-clears`) |
| `tools/try-phase3.sh --check` | PASS — passive/prediction regression unchanged (see log) |
| `tools/verify-live-actions.py --read-only` | PASS — 10/10 real-host backend checks (1 intentional skip: brightness hardware absent) |
| `tools/verify-live-actions.py --reversible` | PASS — 25 passed / 0 failed: volume 30→60 verified, mute cycle verified, power profile, dark mode, Night Light, Bluetooth off→on all read back and restored; Wi-Fi/text-scaling skips intentional |
| Live `RouteAction` (running service, real model) | Fail-closed verified live; bounded coercion repairs accepted |
| Live diagnostics mirror | `RecordActionDiagnostic`→`ActionStats` verified on the running service |
| Installed build | Reinstalled with `make install` (backup `~/.local/state/gdi/install-backups/pre-audit-20260925-134550/`); installed files byte-match source; user settings preserved; extension ACTIVE. The running session keeps its imported modules and the running service until the next normal login (GNOME 46 module cache; the only service change is additive and backward compatible) |

### Exact next task

Physical everyday testing of the audited build after the next normal login
(installed 2026-09-25; `make lint install`). Verify in real use: `volume 30`,
`volume down` (previously broken), `mute`/`unmute`, `turn bluetooth off`
(confirmation appears when devices are connected), `open downloads`,
`open display settings`, `show my ip`, `switch to power saver`, dark/light
mode, a two-step request, and `gdi diagnostics` after running them. Report
any silent failure — none is expected; every mutation now verifies its own
state before showing success. Stop at this boundary; no new features.

---

## Phase 5 — implemented and validated (historical)

This pass added Writing Intelligence's third mode (**Continue**), redesigned
the Writing Tools presentation, overhauled the Ask Intelligence surface and
added local conversation history. The Phase 4 action registry, the
deterministic launcher, all existing writing/passive behavior, the provider
abstraction, the Intelligence mark and the native GNOME styling are
unchanged. IBus/browser writing research remains **deferred, not abandoned**.

### What is implemented

- **Predictive writing** (`service/prediction.py`, `service/passive.py`,
  `PassiveController.js`, off by default): after a 500 ms typing pause in a
  supported GTK multiline field with the caret at the end of the text and
  enough context (≥30 chars, ≥6 words, no code markers), the quick model
  predicts a short continuation with structured output. The deterministic
  gate suppresses echoes, trivial/one-word completions, >160-char output,
  commentary, Markdown syntax, JSON, URLs/emails/paths and multi-line
  answers before display; staleness is re-verified (caret + length
  unchanged) after generation. The ghost is a compact headerless surface at
  the caret: Tab (GTK multiline) or Ctrl+Alt+Enter accepts everything,
  Right accepts one word, Escape dismisses; typing, caret movement and
  focus changes dismiss. Acceptance uses the guarded caret-range editor with
  a working Ctrl+Alt+Z undo; the remainder of a partial acceptance stays as
  re-anchored ghost text. Learning records accepted/partial/dismissed/
  ignored/immediate-undo labels (no text); repeated negatives suppress
  predictions for that application. No model call happens per keystroke.
- **Writing Tools surface**: selection → `Improve / Fix / Shorten / Tone /
  More…` chips with a subdued selection preview; Tone expands to
  Professional/Casual/Friendly/Direct; More expands to Expand/Summarize/
  Explain/Translate/Ask Intelligence. No selection with
  `canReadCaretContext` → contextual chips (Improve sentence, Continue
  writing, Fix paragraph, Tone, More…) whose sentence/paragraph capture runs
  only on the explicit action and fails closed with a visible message. The
  on-demand **Continue writing** tool inserts its result at the caret via
  the guarded editor. Choosing an action transforms the same surface into
  the diff/Markdown preview with Replace primary and Copy/Retry/Cancel;
  unsupported replacement states keep Copy plus the explanatory note.
- **Ask Intelligence**: fixed 500 px width and stable top edge through
  loading, streaming, Markdown, code and follow-ups; content height is
  dynamic with a work-area-relative maximum and internal scrolling. A
  native processing animation (mark + three dots, reduced-motion aware)
  replaces textual generating states; buffered streaming never flashes raw
  Markdown tokens (completed lines render as blocks, the partial tail stays
  plain or hidden); completed answers render headings, lists, emphasis,
  inline code, fenced code blocks (distinct, horizontally scrollable, per-
  block Copy) and safe links. The question stays subdued above the answer;
  Copy/Retry/Clear and the follow-up field remain, plus Insert at caret /
  Replace selection only with a suitable target.
- **Intelligence History**: service-owned SQLite store
  (`history.py`, `~/.local/share/gnome-desktop-intelligence/history.sqlite3`)
  with conversations and messages, automatic titles, bounded housekeeping
  (200 conversations; messageless rows purged after an hour). The palette's
  history view (panel menu and the `history` command) groups conversations
  Today/Yesterday/Earlier and supports open, continue (same conversation
  id, bounded RAM context rebuilt), rename, delete and two-step Clear All.
  Persistence is enforced service-side while `save-intelligence-history` is
  on (default); disabling keeps new interactions temporary and deletes
  nothing; Preferences offer the switch and Clear Intelligence History.
  Retry trims the trailing assistant turn; no empty conversation junk is
  created (user turn stored on submission, assistant turn on completion).
- **Diagnostics**: `PassiveStats` gains prediction counters (requests,
  shown, gate suppressions, stale discards, cancellations, insert refusals,
  latency, acceptance) and prediction stage traces; `RequestStats` records
  question length, conversation id and persistence status. No content is
  ever logged.

### Safety and privacy envelope

Predictions only run in the same eligible fields as passive assistance
(non-secret, editable GTK multiline, public-text attribute checks before
every read, caret at end of text). Typed text is never stored: the
prediction learning signals are labels only, and history stores visible Ask
content and metadata only — never internal prompts, routing metadata,
hidden reasoning, or provider diagnostics. Password/sensitive fields remain
excluded from everything. `save-intelligence-history` (default on, per this
phase's explicit instruction) gates all history writes in the service; Clear
is always explicit. History is local-only; there is no telemetry.

### Validation performed (2026-09-25)

| Check | Result |
| --- | --- |
| `make lint pack` | PASS (strict schemas incl. the two new keys, JS/Python syntax, packaging regressions) |
| `make test-refinement` | PASS — 43 checks across all prior suites plus `tools/test-prediction.py` (gate decisions, trigger context, structured prediction payload, `continue`/`friendly`/`direct` routes), `tools/test-history.py` (lifecycle, titles, trim, housekeeping, delete/clear, corrupt-DB fail-closed), `tools/test-writing-menu.mjs` (chip structure, Tone/More disclosure, capability gating), extended `test-presentation.mjs` (streaming Markdown hygiene, history grouping) |
| `tools/validate-nested-wayland.sh` | PASS — 124 GDI_TEST probes true, zero failures: all prior launcher/Ask/writing/action probes plus the new fixed-width (loading/streaming/result), processing-animation, no-token-flash, code-copy, subdued-question, writing-tools chips/Tone/More/preview-transition/preview-diff, contextual caret surface, and full history probes (created → grouped list → restore → continue with same id → delete → armed clear → disabled mode) |
| `tools/try-phase3.sh --check` | PASS — 30 GDI_PASSIVE probes: the full passive suite (debounce 838 ms, privacy fields, cancellation, learning, provider recovery) plus the real-typing prediction flow (one request per pause, ghost shown with screenshot, Tab full acceptance, Ctrl+Alt+Z undo, Right word acceptance with re-anchored remainder, Escape dismissal, typing-cancels-stale, disable stops requests), idle CPU 0.0% over 10 s, and clean disable/re-enable lifecycle; real apps unchanged (GNOME Text Editor + reference sentence + light/110%, Zenity PASS; Firefox correctly unsupported) |
| Real models (local Ollama) | `phase5-real-prediction.json`: 5/5 predictions gated and shown on the configured LFM2.5 1.2B quick model, 1150–1186 ms total (mean 1162 ms) per prediction; `test-refinement-models.py` and `test-provider.py --real` PASS unchanged (writing 1.15–1.59 s; Ask first token ~3.0 s on qwen3.5:4b) |
| Visual light/dark | PASS (`try-phase2.sh --visual`): stable 500 px width, top edge, bottom bounds and hint contrast in dark/light at 100%/110% for all states including the new Writing Tools chips surface and Intelligence History list (screenshots in `build/validation/visual/`) |
| Nested runtime bugs found and fixed | ConfigurePassive introspection signature mismatch (silently disabled the observer *and* silently broke extension-disable notification), StScrollView.set_child requires an StScrollable (code blocks), stale anchor-request expiry killing fresh ghosts, input-method final caret echo dismissing fresh ghosts, own partial-insert echo dismissing the remainder ghost, unhandled async rejection in Ask requests, service-side prediction dismissal not notifying the Shell |
| Live session | Not restarted; no logout; nothing installed into the active desktop |

Performance (all measured in the isolated nested sessions; the model numbers
are single synthetic requests, not a benchmark):

| Measurement | Result |
| --- | --- |
| Prediction trigger pacing | one request per typing pause (asserted: a full burst produces exactly one request); 500 ms debounce; 2.5 s minimum interval; typing burst of 45 chars produced zero premature calls |
| Prediction latency (real LFM2.5 1.2B) | 1150–1186 ms total, mean 1162 ms, 5/5 gated; the ghost never blocks typing (generation is cancellable and the Shell only renders an anchored surface) |
| Prediction latency (mock) | 151–224 ms gate-to-decision; stale/late predictions discarded (asserted) |
| Ask first token / total (real qwen3.5:4b) | ~3.0 s / 3.1–3.4 s (unchanged from Phase 3.5) |
| Writing actions (real LFM2.5) | 1.15–1.59 s (unchanged) |
| History overhead | SQLite reads only on History use; the store opens lazily; no idle I/O (the 10 s idle window shows zero model calls and 0.0% service CPU) |
| Service idle CPU | 0.0% over a 10 s window with the observer enabled |

Evidence: `build/validation/nested-phase5-final.log` (and the earlier
`nested-phase5-run*.log` iteration logs), `shell.log`, `session.log`,
`atspi.log`, `phase5-passive-run45.log` (plus the `run*.log` iteration logs),
`phase5-real-prediction.json`, `phase5-visual.log`, `visual/` (including
`phase5-prediction-ghost.png`, `dark|light-*-writing-tools.png`,
`dark|light-*-history.png`), `ask-preview.png`, `phase35-markdown.png`,
`phase35-writing-diff.png`.

### What is intentionally not implemented

- Ghost text inside unsupported targets (browsers, single-line fields):
  prediction, like passive assistance, only runs where the field is provably
  safe and observable.
- Model-weight training, cloud providers, telemetry, history sync.
- History search/tagging (deliberately not overbuilt this phase).
- Markdown tables and images remain plain text in Ask rendering (unchanged).

### Exact next task

Physical everyday testing after the next normal login (the active session
still runs the Phase 4 build; install with `make lint install`). Verify in
real use: (1) enable **Predictive writing suggestions** and type in GNOME
Text Editor — a subdued continuation should appear after a pause, Tab
accepts, Right accepts a word, Escape dismisses; (2) the new Writing Tools
chips with a selection and the contextual caret actions without one; (3) Ask
width stability across a long answer, the processing animation, code-block
Copy; (4) History from the panel menu: ask something, close, reopen history,
continue the conversation, rename, delete, Clear from Preferences. Report
any silent failure. Stop at this Phase 5 boundary.

---

## Phase 4 — native GNOME actions implemented and validated (historical)

Phase 4 was explicitly authorized with the constraints: no unrestricted shell
execution, native APIs only, deterministic-first routing, and the existing
Writing/Ask/Passive behavior preserved. (Phase 5 above supersedes its
"exact next task" handoff; the Phase 4 everyday verification happened with
the 2026-09-25 install.) IBus/browser/system-wide writing
research is paused and recorded as **deferred, not abandoned** (see the
Firefox capability matrix below — it remains an accurate measured statement).

### What is implemented

- **Registry** (`src/actions/registry.js`, pure and node-testable): stable
  action ids, typed argument schemas, risk classes (READ_ONLY / LOW_RISK /
  STATE_CHANGE; SENSITIVE and DESTRUCTIVE exist in the policy with no Phase 4
  actions), availability backend tags, confirmation labels/notes.
  `validateArgs` is the trust boundary for every caller, including models.
- **Execution engine** (`src/actions/engine.js`, Shell process, fully async):
  GVC (GNOME Shell's own mixer library) for volume/mute; GSettings for color
  scheme, Night Light, text scaling; NetworkManager D-Bus for Wi-Fi and
  network/IP status; BlueZ D-Bus for Bluetooth state and power; the session
  SettingsDaemon `Screen.Brightness` property for backlight; power-profiles-
  daemon D-Bus (`net.hadess.PowerProfiles`, GNOME 47+ name as fallback);
  GIO for app/folder/link launch, whitelisted Settings panels and filesystem
  stats; `/proc/meminfo` and UPower DisplayDevice for memory/battery. No shell
  commands anywhere. Every failure is a readable result, never a Shell crash.
- **Deterministic parser** (`src/actions/parser.js`): anchored, inspectable
  rule table covering the phase's example phrasings plus common variants
  (`volume 30`, `mute`, `turn/switch/enable/disable bluetooth|wifi`,
  `switch to power saver`, `turn on dark mode`, `open display settings`,
  `open downloads`, `show my ip`, `how much disk space do i have`,
  `text scaling 1.25`, `find resume pdf`, `find pdfs modified today`, URLs).
  Bounded multi-step plans (`and`/`then`, ≤3 steps, all parts must parse).
- **Palette UI**: action rows (type "Action", model rows "Suggested"),
  compact confirmation view (Cancel / Turn Off with an explanatory note),
  "✓ …" result views with per-step lines for plans, Copy for info answers,
  concise unavailable/error messages. Launcher precedence and all existing
  modes are unchanged.
- **Service** (`gdi-service.py`): `RouteAction(question, registry)` runs the
  configured small routing model with structured output and normalization
  (`normalize_intent_response`), bounded question/registry sizes and a
  concurrency cap; `RecordActionDiagnostic`/`RecordActionUse`/`ActionStats`
  provide bounded RAM-only diagnostics and ranking data (NO_AUTO_START, so
  actions never spawn the service). `model-intent-routing` now defaults to the
  installed quick model (`ministral-3:3b` was never installed).
- **Learning (ranking only, existing opt-in)**: accepted app/folder actions
  store labels only; `ActionStats` returns per-app/per-folder counts used to
  reorder candidates within a search tier — never across match classes and
  never the confirmation policy. Queries, file contents and web-search terms
  are never stored.
- **File search**: `find <terms>` phrasing with trailing-type narrowing
  (`find resume pdf`), plural forms (`pdfs`) and `modified today` mtime filter;
  the scan bounds (depth, directory count, timeout) are unchanged and file
  contents are never read.

### Safety envelope (unchanged by personalization or models)

Immediate: read-only queries, app/folder/link launch, web search, volume,
mute, color scheme, Night Light, brightness, power profile. Compact
confirmation: Wi-Fi off ("may disconnect your network"), text-scaling changes,
and Bluetooth off when connected devices would be affected. Excluded from this
phase: file deletion, package management, process killing, arbitrary shell
execution, browser automation, email/calendar, autonomous agents, model
self-modification.

### Validation performed (2026-09-25)

| Check | Result |
| --- | --- |
| `make lint test-refinement pack` | PASS (schemas, JS/Python syntax, packaging regressions; 40 suite results, no failures) |
| `tools/test-actions.mjs` (new) | PASS — 100+ parse cases incl. every phase example, non-action guards (`open firefox`, `rm -rf /`, `install firefox`), argument validation, confirmation policy, model-routable surface |
| `tools/test-action-service.py` (new) | PASS — real service on a private bus with pinned mock provider: RouteAction passthrough (echo-verified), garbage normalization, oversized question/registry rejection, diagnostics bounded to 50 with newest kept, learning off/on ranking behavior |
| `tools/test-model-routing.py` | PASS — new intent-mapping payload assertions (bounded structured output, registry in prompt, no execution rights) + response normalization |
| `tools/validate-nested-wayland.sh` | PASS — 100 GDI_TEST probes true, zero failures, incl. new action probes: disk/memory info results, color-scheme change+restore in the disposable profile, graceful audio unavailability (no pipewire socket in the nested runtime), Wi-Fi-off confirmation view without execution, Bluetooth/power-profile/network read-only state over the host system bus, two-step plan execution, echo-verified model suggestion and invalid-tool-call Ask fallback |
| Regression | All prior probes still PASS: launcher, Ask (bare/prefix/echo payload), streaming/Markdown/follow-ups, explicit writing Replace/Undo/Insert, stale refusal, capability reports, passive lifecycle, provider failure, disable/re-enable |
| Live host APIs (read-only) | Verified directly: power profile (`net.hadess.PowerProfiles` active), NM `WirelessEnabled`, BlueZ adapter `Powered` + device inventory, gsd `Brightness` (reported −1: no backlight on this desktop — brightness actions correctly report unavailable), `color-scheme`, `night-light-enabled`, `gnome-control-center --list` panel set |
| Host settings changed | None by validation (reads only). Nested-session dark-mode toggles stayed inside the disposable dconf profile and were restored |
| Live session | Not restarted; no logout; nothing installed into the active desktop |

Evidence: `build/validation/shell.log`, `session.log`, `atspi.log`,
`nested-phase4.log` (and the first attempt with the pre-fix failures),
`nested-phase4-first-attempt.log`, `phase35-*` screenshots and logs.

### What is intentionally not implemented

- Deletion/moving/renaming files, package installation, process killing.
- Any model-facing execution surface beyond the validated single-action map.
- Brightness is available only where a backlight exists (this desktop has
  none; the action reports that cleanly rather than pretending).
- Writing-input compatibility research (Gecko replacement, GTK4 single-line
  capture, IBus paths) is **deferred, not abandoned**; the measured capability
  matrix and privacy fail-closed decisions stand unchanged.

### Exact next task

Physical everyday testing of Phase 4 after the next normal login (the active
session still runs the previously installed build; GNOME 46 caches extension
modules — do not restart the session). Install with `make lint install`.
Verify in real use: `volume 30` / `mute` (audible path), `turn bluetooth off`
with a connected device (confirmation appears; devices survive cancel),
`turn wifi off` confirmation + cancel, `open downloads`, `open display
settings`, `show my ip`, `disk space`, a two-step request, and that Ask/Writing
still behave. Report any silent failure. Stop at this Phase 4 boundary.

---

## Architecture correction — Ask semantics, capability model, gate algebra (historical, 2026-09-24)

This pass fixed the remaining architectural defects from the Phase 3.5
handoff. Native GNOME direction, 500px palette, stable top edge, Intelligence
mark, privacy model and no Phase 4 automation are unchanged.

### Root causes found

1. **Ask Intelligence leaked intent words into model prompts.** The palette
   passed the raw launcher query as the model question: typing `ask` sent the
   literal word `ask` ("User request: ask"), which the assistant model answered
   with "Request Received / Status / Awaiting input"; `ask <question>` sent the
   prefix too; typed selection intents (`explain this`, `ask why`) sent the
   verb as a "Focus"/"User question" instruction. Reproduced against the real
   configured qwen3.5:4b before the fix.
2. **Writing actions could fail silently.** A capture that found nothing (or a
   service error) opened the plain launcher with no explanation, and a failed
   Replace removed the Replace button with no way to retry.
3. **The passive quality gate could not express the reference correction.**
   `worth_checking` had no pronoun+auxiliary trigger (`I has …` never fired —
   the standalone-`i` trigger is case-sensitive by design), and the gate's
   algebra only allowed fixed bigram pairs and 1:1 word swaps, so
   `I has went to the market yesterday and buy some apples.` could never be
   corrected to `I went … bought` — and unjustified model tense swaps were the
   only thing standing between users and wrong corrections.
4. **Lifecycle races.** Disabling the extension before its D-Bus connection
   finished never told the service to stop passive observation.

### Architectural changes made

- **Ask semantics** (`palette.js`, `Presentation.js`): `ask` is now an explicit
  launcher command like `search` and outranks fuzzy app matches. Bare `ask`
  enters an empty focused Ask prompt and sends nothing (Enter on an empty
  prompt does nothing). `ask <question>` submits only the remainder. Natural
  questions still route to Ask verbatim. `selectionIntentParts` strips typed
  intent verbs; bare anaphora ("explain this") becomes an empty instruction
  rather than model text. Escape from a question prompt with captured text
  returns to the writing actions.
- **Capability model** (`selection.py`, `gdi-service.py`, `ServiceClient.js`,
  `extension.js`, `palette.js`): `GetFocusedContext` now also returns a
  capabilities snapshot (`canReadText`, `canReadSelection`, `canGetCaret`,
  `canReplaceSelection`, `canInsertText`, `canObserveTyping`,
  `canPassiveAssist`, `role`, `reason`). The palette renders one of three
  explicit outcomes for every writing action — Supported (preview + guarded
  Replace, retryable after transport failure via a fresh capture),
  Readable-but-not-replaceable (preview + Copy + explanatory note), or
  Unavailable (concise message; service failure states this on the launcher).
- **Passive gate algebra** (`quality.py`): closed derivation rules for
  subject/auxiliary agreement (same lemma only, subject-validated, including
  contractions), irregular verb forms from a closed lemma table
  (participle-after-aux, finite-participle→past, base→past with *locally*
  preceding past evidence), wrongly-agreed auxiliary deletion, and n:n diff
  block decomposition. Unjustified tense/agreement changes are still rejected.
  Preflight gained pronoun+aux triggers. The reference sentence now fires,
  derives and surfaces a correction.
- **Diagnostics** (`passive.py`): bounded `recent` stage trace in
  `PassiveStats` (focus, typing counts, debounce, captured metadata, request,
  model result, gate category, shown, replacement, dismissal reasons — no
  text, no secrets). The trace immediately identified two real defects during
  physical QA: a silent post-capture exit and a service-loop stall.
- **Anchor freshness** (`PassiveController.js`): the caret snapshot sent to
  `SetPassiveAnchor` is now valid for 8s instead of 3s. The service can
  legitimately take longer than 3s (debounce plus AT-SPI latency) to reach the
  anchor request; any real caret movement emits a fresh cursor event and focus
  changes clear the snapshot, so the longer window cannot misplace the
  surface. Previously the request returned an empty anchor and the offer was
  silently suppressed.
- **Event-loop protection** (`passive.py`): per-event eligibility checks
  (several remote AT-SPI property reads) are memoized per source for one
  second, so a typing burst on a busy session cannot stall the service main
  loop.
- **Lifecycle** (`PassiveController.js`): disable now always reaches the
  service, even when destruction precedes the bus connection.

### Firefox capability matrix (Firefox 156.0.1, nested GNOME 46 Wayland)

Measured with `tools/firefox-capability-matrix.py`; evidence in
`build/validation/firefox-capability-matrix.json`. Full table in
ARCHITECTURE.md. Summary: selection on ordinary webpages is captured
end-to-end through the `document web` accessible (`canReadSelection=true`,
reason `not-editable`) — Explain/Summarize/Ask-with-Copy are **supported** for
web selections. Textarea/input/contenteditable selections are readable (with
contenteditable offset quirks), caret is available, but both EditableText
mutation APIs (range delete+insert and whole-value setTextContents) acknowledge
without applying, and typing produces no delivered AT-SPI events — so
replacement and passive assistance remain impossible and stay disabled, now as
per-capability facts rather than one blanket flag.

**IBus was not needed and was not adopted.** AT-SPI already covers every field
GDI can replace (GTK). Gecko exposes no usable surrounding text or
committed-text signal to the input-method layer, so a hybrid IBus engine would
not add browser capability, and a full custom IME is out of scope. No
clipboard stealing, synthetic typing or pointer automation was introduced.

### What is physically working (validated in nested GNOME 46 Wayland)

- Launcher: deterministic apps/files/web/calculator; geometry, 500px width,
  stable top edge; disable/re-enable.
- Ask: `ask` → empty prompt with no request; `ask <question>` sends only the
  question (echo-fixture assertion on the provider payload); natural questions
  reach Ask verbatim; streaming, Markdown, links, follow-ups, Retry, Clear,
  Escape cancellation; provider-failure recovery; content-driven height within
  a 310px scroll cap on the stable top edge.
- Explicit writing on GTK: selection capture with capabilities, all writing
  actions, exact guarded Replace, GDI Undo, insertion at caret, stale refusal,
  read-only Copy path with explanation, password/secret exclusion.
- Passive writing on GTK (Text Editor, Zenity): typing → debounce → capture →
  request → gate → caret-anchored surface → accept → guarded Undo, including
  the reference sentence `I has went to the market yesterday and buy some
  apples.` (offer, accept, replace, undo) via `tools/try-phase3.sh --apps`.
- Deterministic behavior unchanged: app launch, calculator, explicit
  `search <query>`, file lookup, and the new explicit `ask` command all bypass
  the model.

### Remaining unsupported, and why

- Firefox/Gecko field replacement and passive assistance: Gecko's AT-SPI
  EditableText mutations do not apply and typing events are not delivered
  (measured). IBus cannot bridge this (no surrounding text from Gecko).
- GTK 4 single-line capture: masked Entry is indistinguishable from ordinary
  Entry; privacy fail-closed stands.
- Replace on read-only selections (web pages, PDFs): readable + Copy only.

### Validation performed

| Check | Result |
| --- | --- |
| `make lint pack` | PASS (strict schemas, JS/Python syntax, packaging negative regressions) |
| `make test-refinement` (passive unit/lifecycle, presentation, writing refinement, streaming, routing, safety, provider) | PASS, including new gate-algebra and ask-command cases |
| `tools/validate-nested-wayland.sh` | PASS — all probes incl. new `ask-bare-*`, `ask-prefix-stripped-for-provider` (echo-verified payload), `natural-question-verbatim`, `selection-intent-verb-stripped`, `capture-capabilities`, capability reports for editable/read-only/password fixtures |
| `tools/try-phase3.sh --apps` | PASS — GTK passive flow plus the reference sentence (offer → accept → replace → undo) |
| `tools/try-phase3.sh --firefox` | Matrix collected (see above) |
| `tools/test-provider.py --real`, `test-passive-model.py`, `test-refinement-models.py`, `test-ollama-lifecycle.py` | PASS against the configured local Ollama models (`LiquidAI/lfm2.5-1.2b-instruct:q4_k_m`, `qwen3.5:4b`); `--real` now treats a conservative gate refusal of a poor model answer as the correct outcome |
| Live session | Not restarted; no logout; nothing installed into the active desktop |

### Exact next task

Physical everyday testing of the corrected build: install with
`make lint install` (activates on next normal login), then in real use verify
(1) `ask`/`ask <question>` and natural questions, (2) Improve Writing in GNOME
Text Editor with Replace/Undo, (3) passive suggestions including the reference
sentence, (4) webpage selections in Firefox producing Explain/Summarize
previews with Copy and the "cannot replace here" note. Report any silent
failure — none is expected. No Phase 4 work.

---

## Phase 3.5 — Writing and Ask refinement (historical)

The supplied Intelligence mark, native GNOME appearance, no glassmorphism,
stable 500px launcher and Phase 3 opt-in safety model remain unchanged. Phase 4
and broader system automation have not started.

### Device installation — 2026-09-24

Installed Phase 3.5 with `make lint install` into
`~/.local/share/gnome-shell/extensions/gdi@gnome.desktop.intelligence` and
updated its D-Bus activation file. Strict schema compilation, package/install
schema regression checks, syntax checks and installed/package byte comparison
passed. All pre-existing GDI settings were preserved exactly. Backup:
`~/.local/state/gdi/install-backups/20260924-191920/`.

The live extension reports ACTIVE with no extension errors, but this session
still runs the previously imported extension and its older service. Neither was
restarted: GNOME 46 caches extension modules, and restarting only the service
would pair incompatible old/new D-Bus APIs. **Phase 3.5 activates after the next
normal logout/login.** No desktop restart or logout was performed. The preserved
custom shortcut is `['<Alt>Control_L']` (hold Alt and press left Ctrl), rather
than the schema default Ctrl+Super+Space. Passive assistance remains off, saved
text examples remain off, and the user's existing learning setting remains on.
Physical use of the newly installed version is pending that normal login;
the isolated Phase 3.5 validation below remains the runtime evidence.

### Implemented behavior

- Shared word/phrase diff in passive and explicit writing: subdued struck-out
  removals and bold proposals. Tiny passive corrections show only the existing
  local excerpt, in a 220–340px native surface; no paragraph duplication. A short
  fade honors reduced motion. Ctrl+Alt+Enter, optional restricted Tab, Escape,
  typing/focus/caret dismissal and guarded Undo retain the established behavior.
- Explicit action prompts preserve meaning, direct requests and deadlines.
  URL/email/path/backtick-code placeholders are restored only if every token is
  returned exactly once; literal multisets are verified afterward. Commentary,
  empty/oversized output, excessive expansion/omission and aggressive
  proofreading are rejected. Replace stays primary; Copy/Retry/Cancel remain
  secondary. Models can still make semantic mistakes: preview is mandatory.
- Ask streams real text, then renders headings, lists, bold/inline code, fenced
  code and native HTTP(S) link controls. It stays 500px wide, with a maximum
  310px response scroll area and a stable top edge. Copy/Retry/Clear and a
  follow-up field replace the fixed writing toolbar. Tab includes actions,
  links and follow-up; Page Up/Down scroll; Escape closes/cancels.
- Temporary follow-ups retain at most six messages/6,000 characters in RAM,
  clipping retained answers at 4,000 characters. Clear/close forget everything.
  Labels identify selected/nearby text and temporary conversation. No file,
  webpage or full-window capture is added. Markdown tables, images, nested-list
  layout and math rendering are not implemented.
- Deterministic app/calculator/explicit web/file queries keep priority. Natural
  question prefixes favor Ask over weak app matches. Selected-text commands
  route explain/summarize/key-points/rewrite/proofread without an LLM classifier.
  Writing uses quick; normal Ask uses assistant; reasoning never auto-escalates.
- Assistant Copy has keyboard priority. Optional Insert at caret / Replace
  selection are secondary and available only with a suitable captured target.
  Multiline GTK insertion retains revision/caret/length and at most 32 local
  guard characters on each side, never sent to the model. A native modal-grab
  handover permits a real focused-element check; changed focus or stale content
  refuses the operation. Empty-range editing and guarded Undo use AT-SPI, with
  no simulated keys or window activation.
- SQLite v3 adds no ordinary text retention. Existing app/pattern suppression is
  joined by conservative category scoring. Accepted/rejected/Undo explicit
  choices influence bounded casual-tone and brevity/detail hints for Improve
  writing; explicit tone actions win and passive proofreading stays stylistically
  conservative. Preferences show learned direction and category scores; Clear
  and consent revocation remain available.
- Request IDs, directed streaming signals and ID-scoped cancellation prevent
  obsolete replies/cancellation affecting newer work. Bounded NDJSON parsing
  rejects malformed, truncated and invalid text. Errors offer Retry/AI Settings.
  `RequestStats` exposes bounded RAM-only model/route/latency/status records and
  active count, with no prompts/answers and no idle polling.

### Validation and performance

The automated checks use synthetic text on disposable GNOME Shell 46 Wayland
sessions. They are not a claim of human everyday acceptance. The older explicit
fixture runner inherited the host's `GDK_BACKEND=x11`; this pass forces its GTK
fixtures onto the private Wayland compositor. The insertion focus guard exposed
and refused that misplaced fixture before the runner was fixed.

Real Ollama measurements in `build/validation/phase35-real-models.json`:

| Workload | Measured result |
| --- | --- |
| 11 writing requests on configured LFM2.5 1.2B | 1.15–1.58s total; mean 1.24s |
| Ask explanation on configured Qwen3.5 4B | First token 2.99s; total 4.75s |
| Ask short factual question | First token 2.99s; total 3.15s |
| Ask bounded follow-up | First token 3.08s; total 3.42s |
| Loaded models after requests | Empty `/api/ps`; `keep_alive: 0` retained |

These are single synthetic requests per case, not a statistically representative
quality/latency benchmark. Tiny grammar, spelling, punctuation, natural rewrite,
concise/expand/professional/casual/translation, long-paragraph rewrite and literal
preservation produced usable previews in the final run. An earlier literal
failure was safely blocked and motivated the placeholder protection. Aggressive
omission and commentary are also covered by deterministic negative tests.

Final validation:

| Check | Result / evidence |
| --- | --- |
| `make lint test-refinement pack` | PASS; strict schemas, package/install missing-schema regressions, preserved passive/safety/provider suites, new diff/Markdown/routing/learning/stream tests; `phase35-full-tests.log` |
| `tools/validate-nested-wayland.sh` | PASS; deterministic launcher/geometry, true incremental streaming, Markdown/code/link controls, follow-ups, retry/clear, obsolete-stream isolation, Escape, native keyboard navigation, selection-aware intent, exact Replace/Undo, caret Insert/Undo, stale insertion, provider failure/recovery and disable/re-enable; `phase35-explicit-nested.log` |
| `tools/try-phase3.sh --check` | PASS; full passive debounce/privacy/cancellation/learning/Undo/lifecycle suite; actual Text Editor in dark/100% and light/110%, GTK TextView and Zenity; `phase35-passive-nested.log`, `phase35-apps.json` |
| `tools/try-phase2.sh --check` | PASS; self-contained compiled schemas, Preferences open/shared read-write settings, symbolic mark, default Ctrl+Super+Space, empty-shortcut recovery and re-enable; `phase35-settings.log` |
| `tools/try-phase2.sh --visual` | PASS; 500px width/top/bounds and hint-contrast checks in dark/light at 100%/110%, panel, idle/search/results/loading/response/diff and all Preferences pages; `phase35-visual.log` |
| Screenshot inspection | Inspected actual passive GTK surfaces in both themes, Ask Markdown, writing diff, loading, panel, long-name ellipsizing and Preferences; images under `build/validation/visual/` plus `phase35-markdown.png` and `phase35-writing-diff.png` |
| Shell errors | No GDI JS errors or criticals in the final nested runs; unrelated isolated portal/AT-SPI cache/monitor warnings remain |

The final passive fixture measured **838ms debounce**, 10 requests across 802
AT-SPI text notifications (including duplicates), one intentional cancellation,
and one intentional provider failure. Average fixture latency was 116ms with a
100ms mock response delay. Ten idle seconds produced **zero service CPU ticks
(0.00%, about 0.1% resolution), zero HTTP calls and no active request/timer**.
Disable/re-enable removed observation listeners, timers and temporary bindings.
These measurements describe the service and synthetic workflow, not a claim of
zero CPU for the entire GNOME compositor. See `phase35-passive-metrics.json`.
Transport cancellation completed within 500ms in the controlled test; server-side
work after a disconnect remains provider-dependent. No idle GPU/model retention
was observed after the real-model benchmark.

The inherited Phase 3 compatibility matrix still applies: Text Editor 46.3,
GTK4 multiline TextView and Zenity editable text are supported; Firefox 156
replacement and GTK4 single-line capture remain excluded. The Firefox probes
again observed successful acknowledgements without actual range deletion and
correctly suppressed GDI offers. No compatibility claim was broadened to
unsupported toolkits. Native link controls/protocol filtering were validated;
external browser navigation and human everyday editing remain physical checks.

Next task: physical everyday testing of the refined writing and Ask experiences
with `tools/try-phase3.sh`. Enable passive assistance separately in Preferences.
Inspect model quality, IME/composition, multi-monitor/caret placement, scrolling,
long sessions, link activation and application-native Undo. GDI's verified Undo
remains the fallback; native toolkit Undo grouping is not promised. Stop here;
no Phase 4 or broader system-agent work is authorized.

## Phase 3 — supported GTK workflow ready for physical testing

Phase 3 is now explicitly authorized; the older Phase 2/visual milestones below
are historical. The accepted supplied Intelligence mark, native flagship GNOME
styling, no glassmorphism, stable 500px launcher and explicit workflow are frozen.

Implemented a separate opt-in event-driven observer, conservative English
proofreading, 800ms debounce, configured quick-model routing, structured output,
quality gate, exact replacement/caret guards, small nonmodal caret-adjacent
surface, cancellation and guarded Undo. Ctrl+Alt+Enter is the default acceptance
shortcut; optional Tab is restricted to supported GTK multiline editors as the
user requested. No system-agent automation or autocomplete prediction was added.

Local learning is a private SQLite v3 store with weighted outcomes, app/model
statistics and keyed correction-pattern digests. Personalization and retained
accepted-edit examples are separate opt-ins. Ordinary typed text is not stored
by default. Preferences expose both switches, counts and clear; revoking example
consent purges examples. Full schema/weights/retention are in ARCHITECTURE.md.

Compatibility findings from actual nested GNOME 46 testing:

- GTK 4.14 cannot return AT-SPI character extents. A coordinate-only native
  GNOME input-method/IBus fallback places the surface; invalid coordinates fail
  closed. No input-method surrounding text or keystrokes are collected.
- GTK 4 masked `Gtk.Entry` can expose ordinary-text roles/attributes with no
  hidden/password hint. All GTK 4 single-line capture is therefore disabled,
  including explicit capture. This necessary privacy correction preserves
  multiline editing. Invisible TextView tags are checked through bounded text
  attribute runs before any text read.
- The Shell adapter checks both native and IBus password/PIN/private metadata.
  GTK 4.14 PRIVATE hints alone were not exposed through either API in this
  nested environment; an explicit password input purpose was exposed. Fields
  whose application conceals sensitivity metadata cannot be identified by GDI.
  Use passive assistance only in trusted prose editors; this remains a platform
  compatibility limit, not a claim of universal sensitive-content detection.
- Firefox 156.0.1 fresh-profile onboarding blocked the old tests. The disposable
  profile now bypasses that notification with telemetry disabled. Textarea,
  input and contenteditable fields are accessible, but EditableText deletion
  acknowledges success without changing their text in this runtime. Gecko
  passive offers are disabled. No simulated typing fallback was added.

### Validation and supported applications

All text used in automated validation was synthetic. GNOME Shell 46.0,
GTK 4.14.5, Text Editor 46.3 / GtkSourceView 5.12.0, Zenity 4.0.1 and Firefox
156.0.1 were exercised on private nested Wayland sessions.

| Check | Result |
| --- | --- |
| `make test-passive pack`, `make lint pack` | PASS: strict schemas, Python/GJS syntax, quality/privacy/learning tests, schema packaging negative regressions |
| Routing, safety and provider suites | PASS: exact-edit failure handling, ownership, protected literals, bounded HTTP, timeout/cancellation and stopped endpoint |
| Full Phase 2 nested suite | PASS: deterministic launcher, fixed geometry, Ask, provider failures, preview Copy/Retry/Cancel, native keys, exact GTK Replace/Undo, stale/read-only/password protection |
| Installed Preferences / shared settings | PASS: real window opens, schema read/write, supplied symbolic logo, Ctrl+Super+Space, unset-shortcut recovery, disable/re-enable |
| Passive trigger and debounce | PASS: no model call while typing an incomplete sentence or for clean prose; one request after completed punctuation/pause |
| Cancellation and dismissal | PASS: continued typing cancels a slow request, no late offer; Escape, caret movement and stale acceptance refusal |
| Replacement / Undo | PASS: safe shortcut, opt-in multiline Tab, exact target with preceding paragraph preserved, guarded GDI Undo |
| Privacy | PASS: PasswordEntry, masked Entry exclusion, exported sensitive input purpose, invisible TextView tags; ordinary text absent from default learning database |
| Learning | PASS: rejection, continued typing, accepted unchanged, accepted-and-edited, GDI Undo; consented example retention, revocation/purge, clear, negative pattern suppression; revoked/cleared in-flight consent and unwritable-store fallback |
| Failure / lifecycle | PASS: provider error backoff and recovery on later typing; disable removes listeners/timers/bindings, re-enable works; no idle model calls |
| GNOME Text Editor 46.3 | PASS: actual typing → offer → accept → GDI Undo; dark/100% and light/110% screenshots inspected |
| GTK4 TextView / libadwaita editor | PASS: native field metadata, safe edits and privacy gates |
| Zenity 4.0.1 editable text dialog | PASS: actual offer, acceptance and GDI Undo; screenshot inspected |
| GTK 4 single-line Entry | UNSUPPORTED: intentionally excluded before text capture because masked entries omit reliable secret markers |
| Firefox textarea / input / contenteditable | UNSUPPORTED for passive replacement: fields/events accessible; synthetic direct deletion acknowledges but leaves text unchanged; GDI correctly suppresses offers |
| Real Ollama writing model | Three bounded structured requests; two usable corrections, one unchanged result safely suppressed; no model remained loaded afterward |

Performance evidence is in `build/validation/phase3-metrics.json` and
`phase3-real-model.json`. The final GTK behavior run measured about 851ms from
last punctuation to HTTP request start for the 800ms timer. The controlled
provider's average completed-request latency was 116ms (100ms fixture
response delay). The real configured LFM2.5 writing model took 1.20–1.53 seconds
per short request, about 1.33 seconds average, plus debounce. This is a three-case
smoke measurement, not a language-quality benchmark; the spelling miss was
suppressed rather than displayed as a correction.

The controlled behavior suite generated ten requests across 802 AT-SPI
text notifications (including toolkit duplicates), with one deliberate slow-call
cancellation and one deliberate provider failure. Incomplete/clean/protected
cases and the ten-second idle interval made zero unnecessary requests. The
service consumed zero measured CPU ticks during that idle interval (0.00%
reported, approximately 0.1% measurement resolution). `/api/ps` was empty after
real generation. There are no idle health checks or periodic inference timers.

No GDI JavaScript errors were found in the completed nested checks. Portal,
AT-SPI cache and nested monitor-barrier warnings occur in this isolated runtime.
A shutdown-only Clutter hash-iteration critical was traced with GDB to GNOME
`layout.js` reparenting window actors while native close animations were still
running. The Phase 3 runner now lets those animations settle for 500ms before
terminating its nested Shell. A fatal-critical debugger rerun then exited
normally. No live-session restart/logout or host extension installation occurred.

### Physical-test handoff and remaining limits

Run `tools/try-phase3.sh`, open GDI Settings from its panel, and enable **Passive
writing assistance** under General → Writing. Type a fresh sentence such as
“This are a useful sentence.” in the sample Text Editor and pause. Accept with
Ctrl+Alt+Enter, dismiss with Escape, and use Ctrl+Alt+Z for guarded GDI Undo.
The launcher shortcut remains Ctrl+Super+Space. Personalization is separately
opt-in under Privacy; saving accepted-edited examples requires another switch.
The isolated setup compiles/validates its own packaged schemas and starts with
private settings; it does not inherit or change the live desktop installation.

Next task: physical everyday testing in supported prose editors—fast typing,
focus switching, scrolling, multi-monitor placement/scaling, IME/composition,
long sessions, preference choices, false positives and native application Undo.
The automated tests use native virtual input on a disposable compositor; they
are not a claim of human physical acceptance. Native Undo grouping remains
application-specific; GDI's verified eight-second Undo is the supported fallback.
GTK's unexposed PRIVATE-only hints and unknown/sandboxed/custom editor APIs
remain compatibility limits. English sentence proofreading is intentionally
narrow; no style rewriting, inline autocomplete prediction or broader system
agent automation has been added. Do not proceed to Phase 4 from this handoff.

The following sections preserve earlier milestones and their original scope.

## Visual polish — ready for physical review

The finalized direction is **native flagship GNOME, no glassmorphism**. The
**supplied Intelligence mark is the permanent GDI identity**, directly traced
as `icons/hicolor/scalable/apps/gdi-intelligence-symbolic.svg`. It is included
in the ZIP and shared by the panel, palette header, Ask Intelligence result,
AI/writing headers and Preferences/About. GNOME recolors the same symbolic
geometry in both themes; no separate invented AI/search identity remains.
The GTK hicolor layout matters: an initial flat icon search path rendered the
mark as a regular dark image. This was caught in screenshots, corrected, and
covered by the installed-symbolic-icon regression check. Light-theme screenshots
also exposed a pale inherited search placeholder; it now inherits the palette
foreground, with a measured minimum 4.5:1 hint-contrast regression check.

The 500px launcher, stable top edge and four compact result rows are preserved.
Padding and typography are balanced, the input stays integrated, and native
Shell colors/radii/focus states are retained. AI/writing previews now stay at
500px and the same top anchor, growing downward within monitor bounds. Original
is secondary, Suggestion is full contrast, and Replace uses the native primary
button. Opening/closing uses a short opacity fade without translation or zoom.

Preferences uses native libadwaita pages for General, AI & Models, Privacy and
About, with Shortcuts, Search, Writing, Provider, Models and Request limits
grouped clearly. Existing settings and the on-demand provider check remain.
Phase 2 provider/service/model/replacement behavior was not redesigned. The
existing nonstreaming request lifecycle still displays “Generating…” and Cancel.
No new framework, model traffic while idle, or passive behavior was introduced.

Validation for this pass:

- `make lint pack`: strict schema compilation, JavaScript/Python syntax checks,
  packaged/installed compiled-schema negative regressions passed. The ZIP
  contains the symbolic mark and does not contain test observers.
- Full nested GNOME 46 functional suite: deterministic launcher, long-name
  ellipsizing, stable geometry, Ask/provider-error/Copy/Retry/Cancel, native
  keyboard focus/navigation, preview Replace/Undo, password/stale protection,
  reduced motion and disable/re-enable passed.
- `tools/try-phase2.sh --visual`: real installed Preferences opening, shared
  GSettings read/write, Ctrl+Super+Space, empty shortcut recovery, installed GTK
  symbolic classification, and disable/re-enable passed. It then captured idle,
  search, result rows, long labels, Ask, generating, response, writing preview,
  panel menu and all Preferences pages in light/dark at 100% and 110% text scale.
- Host monitor scale is 1.0 and text scaling is 1.1. The visual session uses a
  1280×900 nested display; the functional suite also exercises 800×600 and
  smaller/signed-origin layout cases. Ubuntu can retain dark Shell menus with
  light applications, so the visual probe explicitly loads GNOME 46's shipped
  native light/dark Shell stylesheets **only inside the isolated test session**.
  Palette surface colors are asserted, not inferred from the preference value.
- Rendered screenshots were visually inspected, including the 16px panel mark,
  light/dark writing previews, AI states, and all Preferences pages. Original/
  suggestion screenshots use synthetic fixture copy; separate functional tests
  exercise the actual asynchronous request and exact replacement paths.
- No GDI JavaScript/extension errors in the final nested Shell logs; unrelated
  nested-session/portal shutdown warnings remain. A test-runner cleanup race
  from activated clients finishing cache writes now has a bounded retry.

Evidence: `build/validation/visual/` (screenshots and allocation assertions),
`build/validation/visual-polish.log`, `nested-polish.log`, `polish-build.log`,
and the functional suite's `shell.log`, `atspi.log`, `real-editors.log`.
This is automated nested-session validation plus screenshot inspection, not
human approval or new Firefox compatibility certification.

**Next task:** user physical review with `tools/try-phase2.sh`. The active
installation/session has not been replaced, restarted or logged out. Stop at
this visual-polish boundary; **Phase 3/passive assistance remains paused**.

## Phase 2 installation defect — fixed

Physical testing exposed a missing `schemas/gschemas.compiled` in the ZIP and
therefore the isolated extension copy. GNOME Preferences failed in
`getSettings()` at `prefs.js:14`, and the Shell extension could not load its
settings to register the shortcut. The XML itself was valid. GNOME 46's
`gnome-extensions pack --schema` bundles XML but omits compiled schemas, even
when the schema directory is supplied as an extra source. Compiling only the
workspace did not fix the artifact. The old nested validator compiled after
extraction and concealed the missing file; the physical runner only unpacked.
The earlier startup-only physical-runner smoke check was insufficient.

The build now strictly compiles the XML, explicitly adds the compiled database
to the ZIP, and validates the resulting archive. `tools/check-schemas.py`
checks presence, freshness against an independently compiled copy, and local
GIO schema resolution with **no parent/global schema source**. Negative
regressions remove the compiled file from both a ZIP and an extracted install
and require rejection. These checks run during `make pack`.

`make install` honors `XDG_DATA_HOME`, compiles and validates the destination
before completing, and installs D-Bus activation under the same data directory.
Both nested runners validate the archive before extraction; the physical
runner also compiles and validates its own temporary extension directory before
starting GNOME. Its private D-Bus activation environment now points Preferences
and other activated clients at the nested Wayland display. No live-installation
schema, hardcoded temporary directory, or host environment change is required.

The exact default shortcut is `['<Control><Super>space']`, shown as
**Ctrl+Super+Space** in Preferences. An absent setting uses the schema default;
an empty override is reset to that default. Shell records the actual keybinding
action returned by Mutter rather than assuming registration succeeded.

Validation for this fix:

- Clean build, strict schema compilation, and `make lint pack` passed.
- ZIP and installed-directory missing-schema regression checks passed.
- A real `make install` into a fresh temporary HOME and XDG data directory passed;
  the installed schema loaded without a global fallback.
- The full nested GNOME 46 suite passed with archive validation performed
  **before** its own schema compilation.
- `tools/try-phase2.sh --check` exercised the physical runner's actual isolated
  setup with an unmodified packaged GDI extension and a separate test observer.
  GNOME's real Preferences service opened `prefs.js` successfully and displayed
  the default shortcut. An accessibility-driven change to its timeout control
  was read back by both a separate GSettings client and the Shell extension.
- Shell and Preferences resolved `org.gnome.shell.extensions.gdi` from the same
  temporary extension path. Native Ctrl+Super+Space opened and closed GDI,
  including after disabling/re-enabling the extension; empty-shortcut recovery
  also passed. No active desktop restart or logout was performed.

Current evidence: `build/validation/schema-build.log`, `install-schema.log`,
`physical-settings.log`, and `nested-schema.log`. The physical runner's
`--check` mode exits with failure on a missing schema, Preferences load failure,
unregistered/nonworking shortcut, or lifecycle regression; the test observer
is never packaged into GDI. Phase 3 and passive assistance remain unstarted.

## Handoff

Phase 2 is implemented and packaged for physical testing. Phase 1's accepted
500px launcher and deterministic actions are retained. Passive suggestions,
autocomplete, unrestricted commands, automatic model escalation and persistent
chat history have not been added.

The active desktop extension was **not replaced or restarted** by this phase.
GNOME 46 caches imported extension modules, so a simple disable/enable of that
older installed build is not a reliable way to load these changes. Use the
fresh isolated physical-test session below; install with `make install` for
your next normal login when ready. No logout or desktop restart was performed.

```sh
# From this project, using the packaged build:
tools/try-phase2.sh
```

This opens a nested GNOME Wayland desktop with GDI and a synthetic document in
GNOME Text Editor. Click the editor if Overview is visible. Select a passage,
then press Ctrl+Super+Space. The nested session has temporary settings, home,
D-Bus and accessibility sockets; it uses the configured local Ollama endpoint.
Closing the nested desktop removes its temporary data. Do not use irreplaceable
documents for initial compatibility testing.

Package: `build/gdi@gnome.desktop.intelligence.shell-extension.zip`.
Evidence: `build/validation/` (synthetic fixture text only).

## Implemented behavior

- Provider-neutral asynchronous service contract; Ollama health and model
  discovery on demand, configurable endpoint/model slots, cancellation,
  deadlines, context/output budgets and bounded response reads.
- Deterministic app/file/web/calculator actions remain model-free. Unmatched
  natural-language queries expose Ask Intelligence, invoked explicitly.
- Writing actions use the writing slot; explanation/summary/selection questions
  use the assistant slot. Explicit harder task metadata uses reasoning. Model
  names are settings, not architecture. The unused intent slot remains only
  for settings compatibility.
- Selected-text snapshots include focused app, role, offsets, caret and
  editability. PID filtering prevents an inactive app's stale FOCUSED flag from
  winning capture. No selection means no document text read. Password/secret
  controls and protected ancestors are excluded.
- Original/suggestion preview, Replace, Copy, Retry, Cancel and checked GDI Undo.
  Read-only text can be processed for copying; Ask and Explain cannot replace.
  A Copy original recovery control appears for errors involving a selection.
- Temporary revision tracking rejects edits outside the nearby excerpt and
  edit-and-revert changes. Replacement checks exact selection/value, length,
  surrounding text and current editability. Undo rejects intervening edits.
- The GTK duplicate-notification case is handled only within a bounded 50ms
  settlement of GDI's own verified edit. Unexpected event ranges still mark
  the snapshot stale. Immediate Undo waits for that settlement. There is no
  continuous polling or background text collection.
- Tokens/listeners/text are released on palette close, extension disable,
  client disconnect, eviction, or a 15-minute expiry. Existing optional learning
  records explicit action/outcome labels only; post-edit learning monitoring
  was removed.

## Validation performed

| Check | Result |
| --- | --- |
| `make lint pack` | PASS: strict schemas, Python compilation, JS syntax, extension ZIP |
| `tools/test-model-routing.py` | PASS: configurable routes and single-model lifecycle payload |
| `tools/test-safety.py` | PASS: protected literals, ambiguous-edit failure handling, request cleanup, ownership, cancellation/late replies and listener release |
| `tools/test-provider.py` | PASS: actual libsoup HTTP with success, HTTP errors, malformed/oversized bodies, timeout, cancellation, responsive GLib loop, empty models and closed endpoint |
| `tools/test-ollama-lifecycle.py` | PASS: separately started/stopped real Ollama instance, empty model discovery, stopped-server error; main Ollama daemon untouched |
| `tools/test-provider.py --real` | PASS: all ten writing/selection actions, standalone Ask and harder reasoning with existing local models and synthetic prompts |
| Nested GNOME 46 Wayland launcher | PASS: geometry including signed monitor origins, app launch, file/web/calculator, result navigation/completion, reduced motion, shortcut, disable/re-enable |
| Nested Ask UI | PASS: fallback, loading, actual clipboard Copy, Retry, provider failure, native Escape cancellation, launcher after cancel, wrapped/scrollable bounded answer; screenshot visually inspected |
| Nested full writing UI | PASS: real GTK selection -> D-Bus -> controlled HTTP response -> preview -> native Tab/Shift+Tab/Enter -> exact Replace -> GDI Undo -> Escape; surrounding text preserved |
| GTK4 AT-SPI fixture | PASS: selection/caret, bounded nearby text, Unicode edit/Undo, different selection refusal, edits outside nearby context followed by revert, stale Undo, read-only capture/refusal, released tokens and password exclusion |
| GNOME Text Editor | PASS: synthetic selected document capture, precise replacement and GDI Undo through the real application's AT-SPI implementation |
| Firefox | NOT VERIFIED: isolated profile/page probe did not expose a focused EditableText range; no browser replacement attempted |
| Interactive physical-test runner | Schema packaging, real Preferences, shared settings, native shortcut and disable/re-enable now pass with `--check`; physical user acceptance still pending |

Real writing model: `LiquidAI/lfm2.5-1.2b-instruct:q4_k_m`. Assistant and harder
route: `qwen3.5:4b`. Health discovery also listed other existing completion
models. All tested actions returned usable short output; no models were
downloaded. The main Ollama `/api/ps` inventory was empty after generation.
Generation requests use `keep_alive: 0`; no idle model requests or polling are
scheduled by GDI.

Nested runs emitted some portal/session warnings and an AT-SPI cache warning
from the isolated environment. The final GDI checks and extension lifecycle
passed; this is not a claim that the entire desktop journal is warning-free.
Temporary nested Shell, GTK fixture, mock HTTP and isolated Ollama processes
were cleaned up. The user's active GNOME session remains running.

## Known limits and next task

- AT-SPI does not provide atomic compare-and-swap replacement. Concurrent app
  changes between remote calls cannot be made fully transactional. GDI refuses
  stale/ambiguous ranges, verifies edits, and avoids blind rollback; uncertain
  edits require inspection and may need Copy original recovery.
- GDI Undo is available only while its preview/token is live. Native editor Undo
  grouping is not promised. Model output is complete-response only; streaming
  and sophisticated diffs are deferred.
- Browser multiprocess accessibility, sandboxed apps, widgets with missing
  Text/EditableText or change notifications, and read-only web-page selection
  need per-application physical verification. No simulated typing replacement
  fallback exists. Native input in tests only drives selection/UI controls.
- Preferences loading, shared settings read/write, default shortcut display and
  native shortcut activation are now tested in the isolated runner. Visual
  acceptance on the active desktop remains physical QA.

Next task: physical testing in the nested session, beginning with GNOME Text
Editor: each writing action, Replace/Undo, moving/changing selections during
requests, Copy/Retry/Escape, Ask, provider settings and failure recovery. Then
investigate Firefox accessibility without weakening replacement checks. Do not
begin passive writing assistance as part of that QA.
