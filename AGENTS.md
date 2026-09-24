# GNOME Desktop Intelligence contributor guide

Read `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`,
`docs/CURRENT_STATE.md`, and `docs/DECISIONS.md` before making project changes.

## Project constraints

- Target Ubuntu GNOME and Wayland first. Keep the product GNOME and Freedesktop
  native: GJS/GNOME Shell, GTK4/libadwaita, GIO, GSettings, D-Bus, and AT-SPI.
- Do not add Qt/QML, KDE libraries, Electron, Tauri, or cross-desktop UI stacks.
- Keep the Shell extension small. Search and launch should work without an AI
  provider. Do not add general shell execution.
- Do not fake compositor blur. Use a translucent, sufficiently opaque palette
  when backdrop blur is unavailable.
- Do not read or retain document text in the Phase 1 launcher.
- Never restart or log out the desktop session as part of development.
- Keep upstream license and attribution notices when adapting third-party code.
- Update `docs/CURRENT_STATE.md` at each stable milestone and before handoff.

## Validation

For requested validation, compile schemas, package the extension, inspect GJS
syntax, and exercise it under the live Wayland session when safe. Clearly record
which interactive checks were and were not performed.
