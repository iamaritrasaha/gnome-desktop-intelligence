# GDI Intelligence identity

`hicolor/scalable/apps/gdi-intelligence-symbolic.svg` is the permanent GDI mark,
traced directly from the user's supplied `images.png` (447 × 447), preserving
the silhouette, crossings and negative spaces. Source SHA-256:
`c8d384e626a4c06db210e110fb5e9a49503f1287a44457d3a4e25f2aa4bf5827`.

The transparent, monochrome SVG serves both light and dark themes. Shell uses
a file icon; GTK resolves the same file through hicolor and applies its native
symbolic foreground. Keep this theme directory structure: a flat unthemed GTK
search-path icon can appear black instead of recoloring. No circle, gradient,
or replacement AI/search glyph should be added. Standard action icons remain
appropriate for ordinary search and editing commands.

Potrace 1.16 was used only to author the vector trace. It is not a GDI build or
runtime dependency. All installed copies receive the finished SVG from the ZIP.
