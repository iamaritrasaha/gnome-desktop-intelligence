# GNOME Desktop Intelligence

GNOME Desktop Intelligence (GDI) is a GNOME Shell launcher foundation for a
local intelligence layer. Phase 1 provides a compact keyboard-driven palette,
application and file search, web search, and a safe calculator. Deterministic
launcher actions work without an AI backend.

## Build and install

Requirements: GNOME Shell 46, GJS, `gnome-extensions`, GLib schema tools,
Python 3/PyGObject, AT-SPI 2 and libsoup 3 introspection libraries, plus `zip`/`unzip`. Ollama is
optional; a text-generation model is needed only for intelligence actions.

```sh
make lint pack
make install
gnome-extensions enable gdi@gnome.desktop.intelligence
```

The default shortcut is `Ctrl+Super+Space`; change it from the panel
indicator's Settings item. Enter an application name to find and launch it.
Use `open <name>` or `file <name>` to search files in your home folders, or
`search <words>` to open a web search in the default browser. Arithmetic such
as `15 * (2 + 3)` produces a calculator result that Enter copies.

If the running Shell has not indexed a newly installed extension directory,
enable GDI after your next normal login. Development commands do not restart
or log out the desktop session.

To remove the extension:

```sh
gnome-extensions disable gdi@gnome.desktop.intelligence
gnome-extensions uninstall gdi@gnome.desktop.intelligence
```

The launcher uses a GDI-owned palette and search/action pipeline. It does not
use Rudra's providers, plugin execution, clipboard history, or AI client, and
does not require Ollama. See `docs/` for product scope, architecture, decisions,
and current validation state. Upstream code attribution and licensing are in
`NOTICE.md` and `LICENSE`.

## Explicit intelligence

An unmatched question offers **Ask Intelligence**. Select text in an accessible
application before invoking the shortcut for writing tools. Review the preview
before Replace; Copy works without editing the target. Escape cancels.
Configure the endpoint and model names in Settings and use **Check** to discover
installed models. The default endpoint is `http://127.0.0.1:11434`.

Validate with `python3 tools/test-model-routing.py`,
`python3 tools/test-safety.py`, `python3 tools/test-provider.py --real`, and
`tools/validate-nested-wayland.sh` after `make lint pack`. The real-provider test
loads only configured existing models using synthetic text. See
`docs/CURRENT_STATE.md` for compatibility and physical testing instructions.

For physical Phase 2 testing without changing the running desktop, run
`tools/try-phase2.sh`. It opens an isolated nested GNOME desktop and a synthetic
sample in GNOME Text Editor. Close that desktop to clean up the test session.

The package includes both schema XML and `schemas/gschemas.compiled`. Packaging
rejects missing/stale compiled schemas; installation and the physical-test
runner compile and verify their own schema directory before use. Run
`tools/try-phase2.sh --check` for an automated check of the actual isolated
setup, including GNOME Preferences, shared settings, native Ctrl+Super+Space
and extension disable/re-enable. It leaves the active desktop unchanged.

For the visual regression pass, run `tools/try-phase2.sh --visual`. It checks
installed settings/shortcuts, then captures GNOME 46 light/dark palette and
Preferences fixtures at 100% and 110% text scaling under `build/validation/visual/`.
It uses a private mock endpoint for the generating-state capture; it does not
load a real model or change the active desktop theme.

## Passive writing (Phase 3)

Run `tools/try-phase3.sh` for the isolated physical-test desktop, then enable
**Passive writing assistance** in GDI Settings → General → Writing. Type a
completed sentence in GNOME Text Editor and pause. Ctrl+Alt+Enter accepts a
visible correction; Escape dismisses; Ctrl+Alt+Z performs guarded GDI Undo.
Optional Tab is limited to supported GTK multiline fields. Personalization
and retaining edited text examples are separate opt-ins in Privacy.

Initial scope is conservative English proofreading in accessible multiline GTK
editors. Firefox/Gecko range editing and GTK 4 single-line fields are excluded;
see `docs/CURRENT_STATE.md` for the tested API/privacy limitations. No ordinary
typed text is saved by default. No launcher redesign or broader system actions.

`make test-passive pack` checks schemas, syntax and quality/learning regressions.
`tools/try-phase3.sh --check` runs synthetic end-to-end tests and real-application
compatibility probes in nested GNOME 46; `--apps` runs only the compatibility
probes. `GSETTINGS_BACKEND=memory python3 tools/test-passive-model.py` checks the
configured default local writing model with three synthetic sentences.
