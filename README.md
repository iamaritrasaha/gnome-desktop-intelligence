<p align="center">
  <img src="icons/hicolor/scalable/apps/gdi-intelligence-symbolic.svg" width="96" alt="GNOME Desktop Intelligence logo">
</p>

<h1 align="center">GNOME Desktop Intelligence</h1>

<p align="center">
  <strong>Local intelligence, built into the GNOME desktop.</strong><br>
  One native launcher that finds and opens things instantly — and adds a fully
  local AI layer for writing, questions and desktop actions when you want it.
</p>

<p align="center">
  <a href="#compatibility"><img alt="GNOME 46" src="https://img.shields.io/badge/GNOME-46-4a86cf?logo=gnome&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/badge/License-GPL--3.0-blue.svg"></a>
  <a href="#privacy-and-safety"><img alt="Local-first" src="https://img.shields.io/badge/Local--first-no%20telemetry-2e7d32"></a>
  <img alt="Linux" src="https://img.shields.io/badge/OS-Linux-f9a825?logo=linux&logoColor=black">
</p>

---

## Why GDI

Most launchers stop at finding apps. Most assistants live in a browser tab.
GDI combines both into one native GNOME surface:

* an **instant launcher** that works without any AI backend,
* a **local AI assistant** for questions, writing help and predictive typing,
* **real desktop control** through GNOME's own APIs — volume, Bluetooth,
  Wi-Fi, power profiles, appearance and more,
* **Intelligence History** kept entirely on your machine.

No accounts. No cloud. No telemetry. Your text stays on your computer.

## Features

**Instant launcher** — Apps, files, web search and a calculator. Deterministic
results appear immediately; nothing waits on a model.

**Ask Intelligence** — A local conversational assistant with streaming
answers, Markdown, code blocks and follow-up questions.

**Writing Intelligence** — Select text anywhere GDI can read it: proofread,
rewrite, shorten, expand, change tone, translate — or continue writing from
the caret. Every edit shows a preview before it replaces anything.

**Predictive writing** — Optional short continuations as subdued ghost text
while you type in supported GTK editors. Tab accepts, Escape dismisses.

**Native GNOME actions** — `volume 30`, `mute`, `turn bluetooth off`,
`switch to power saver`, `turn on dark mode`, `show my ip`, `open downloads`,
`how much disk space do I have` — and small chains like `turn bluetooth off
and switch to power saver`. Disruptive changes ask first; every mutation
verifies its own result.

**Local-first** — Runs against [Ollama](https://ollama.com) on your machine.
History is a local database you can disable or clear. There is no telemetry
and no network service anywhere in the product.

## Native by design

GDI is built from the GNOME stack, not on top of a cross-platform framework:

* **GNOME Shell / GJS** for the palette, panel indicator and desktop actions
* **GTK 4 / libadwaita** for the Preferences window
* **GIO, GSettings, D-Bus, AT-SPI** for apps, files, settings, accessibility
* **GVC** — GNOME Shell's own mixer — for audio

There is no Qt, KDE, Electron or Tauri code, and no arbitrary shell execution
at any layer: every desktop action goes through a small, inspectable registry
of typed, validated actions.

## Installation

Requirements: Ubuntu (or any distribution) with **GNOME Shell 46**, and the
standard development tools plus introspection libraries:
`gjs`, `gnome-extensions`, `libglib2.0-dev-bin` (schema compiler),
`gir1.2-atspi-2.0`, `gir1.2-soup-3.0`, Python 3 with PyGObject, and `zip`.

```sh
git clone https://github.com/iamaritrasaha/gnome-desktop-intelligence
cd gnome-desktop-intelligence
make install
gnome-extensions enable gdi@gnome.desktop.intelligence
```

The extension activates on your next normal login (GNOME caches loaded
extension modules). To remove it:

```sh
gnome-extensions disable gdi@gnome.desktop.intelligence
gnome-extensions uninstall gdi@gnome.desktop.intelligence
```

## Models and Ollama

The launcher, desktop actions, files and calculator are **deterministic and
never need a model** — GDI works fully without Ollama installed. Intelligence
features (Ask, Writing Tools, predictive writing) use
[Ollama](https://ollama.com) locally.

Models are configured by role in **Settings → AI & Models**:

| Role | Used for | Default |
| --- | --- | --- |
| Quick | Writing tools, passive correction, prediction | `LiquidAI/lfm2.5-1.2b-instruct:q4_k_m` |
| Assistant | Ask Intelligence | `qwen3.5:4b` |
| Reasoning | Explicitly requested harder tasks | `qwen3.5:4b` |

The **Resource mode** setting controls how models are kept warm:

* **Low GPU** — shortest warm periods, no preloading, one request at a time.
* **Balanced** (default) — the quick model stays warm briefly after use, the
  assistant model preloads while you type an Ask question, one generation at
  a time.
* **Performance** — longer warm periods and two concurrent requests.

Models always expire on their own after their warm period; GDI never
force-unloads a model, so anything another application loaded stays exactly
where it is. Task-appropriate context sizes keep VRAM use small for
prediction and routing. On very limited GPUs you can also tune the Ollama
server itself — `tools/ollama-desktop-profile.sh` shows an optional,
explicitly applied and fully reversible systemd profile.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+Super+Space` (configurable) | Open or dismiss the palette |
| Type | Search apps, files, actions — or just ask a question |
| `open <name>` · `find <terms>` · `search <words>` · `ask <question>` | Direct commands |
| `↑` / `↓` · `Enter` | Navigate and activate results |
| `Tab` | Complete an app name |
| `Page Up` / `Page Down` | Scroll an Ask answer |
| `Escape` | Step back, cancel, or close |

While writing assistance is enabled: `Ctrl+Alt+Enter` accepts a correction,
`Ctrl+Alt+Z` is GDI's guarded undo, `Right` accepts a predicted word,
`Escape` dismisses. Passive `Tab` acceptance is optional and limited to
supported GTK multiline editors.

## Privacy and safety

* **Local-first**: intelligence runs against your local Ollama. No cloud
  calls, no telemetry, no accounts.
* **Password fields are excluded** from every capture; GDI fails closed when
  a field cannot be proven non-sensitive.
* **No shell execution**: desktop actions come from a fixed registry of
  native, typed actions. Model output can only ever *suggest* one of them and
  is re-validated before anything runs.
* **History is yours**: Ask conversations are stored in a local database you
  can disable or clear from Settings. Typed text is never stored.

## Compatibility

GDI targets **GNOME Shell 46** on Wayland (Ubuntu 24.04 and similar).
Writing tools work where the toolkit exposes safe, editable text — GTK 4
multiline editors are fully supported; browsers and single-line fields are
read-limited or excluded by design. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full capability and
privacy model.

## Development

```sh
make lint        # strict schema compile + JS/Python syntax checks
make pack        # build and verify the extension package
make test-refinement  # parser, service, provider, history, residency suites
```

Integration tests run in disposable nested GNOME 46 Wayland sessions —
including real pointer-driven UI tests injected through Mutter. Nothing in
the test suite touches your running desktop session.

## Credits and license

GNOME Desktop Intelligence is licensed under
[GPL-3.0](LICENSE). The launcher's palette and search architecture is adapted
from [Rudra by NarkAgni](https://github.com/NarkAgni/rudra); upstream
attribution details are in [NOTICE.md](NOTICE.md).
