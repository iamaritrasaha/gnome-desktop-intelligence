# Upstream attribution

## Rudra

GDI's Phase 1 palette/search adaptation uses selected work from [Rudra by
NarkAgni](https://github.com/NarkAgni/rudra), inspected at upstream commit
`ecc3abd5b52f0cd1e698967dbdacbebad264bbbe` (2026-03-25). Adapted areas include
the standalone GNOME Shell launcher/result architecture, fuzzy app matching,
GIO app/file search patterns, keyboard navigation/autocomplete, and the safe
calculator grammar. GDI's implementation has been narrowed and rewritten to
retain only the deterministic Phase 1 features. See source headers for
component-level attribution.

Rudra is GPL-3.0. GDI is distributed under GPLv3; the full license is in
`LICENSE`.

## Search Light evaluation

The initial GDI prototype adapted a small overlay/accelerator path from
[Search Light](https://github.com/icedman/search-light/tree/gnome-47), branch
`gnome-47`, commit `591cadb98f88635b17a1b9671acc9ff958c9f9f9`, under
GPL-2.0-or-later. That implementation was removed during the Rudra migration;
no Search Light source code remains in the current launcher.
