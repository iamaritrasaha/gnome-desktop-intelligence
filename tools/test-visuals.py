#!/usr/bin/python3
"""Capture fixture UI on the private nested Shell, then assert its geometry.

Runs real installed Preferences/shortcut/lifecycle checks first. Model-dependent
visual previews use synthetic copy; intelligence-regression.js tests actual calls.
"""
import json
from pathlib import Path
import runpy
import time

checks = runpy.run_path(str(Path(__file__).with_name('test-installed-settings.py')))
bus, GLib, Gio = (checks[key] for key in ('bus', 'GLib', 'Gio'))


def visual(**request):
    result = bus.call_sync('org.gnome.Shell', '/org/gnome/GdiSettingsTest',
                          'org.gnome.GdiSettingsTest', 'Visual',
                          GLib.Variant('(s)', (json.dumps(request),)), None,
                          Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]
    return json.loads(result)


def hint_contrast(value):
    def color(text):
        return [int(text[i:i + 2], 16) / 255 for i in (1, 3, 5, 7)]
    background, foreground = color(value['surface']), color(value['hint'])
    alpha = foreground[3] * value['hintOpacity'] / 255
    blended = [f * alpha + b * (1 - alpha) for f, b in zip(foreground[:3], background[:3])]
    def luminance(rgb):
        linear = [c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb]
        return sum(c * weight for c, weight in zip(linear, (.2126, .7152, .0722)))
    a, b = luminance(background[:3]), luminance(blended)
    return (max(a, b) + .05) / (min(a, b) + .05)


allocations = []
for theme in ('dark', 'light'):
    for scale in (1.0, 1.1):
        prefix = f'{theme}-{scale:g}'
        base = None
        for state in ('idle', 'search', 'results', 'long', 'ask', 'loading', 'response', 'writing', 'panel'):
            result = visual(state=state, theme=theme, scale=scale, name=f'{prefix}-{state}')
            assert result['theme'] == theme, result
            surface = int(result['surface'][1:3], 16)
            assert (surface > 128) == (theme == 'light'), result
            if state == 'idle':
                assert hint_contrast(result) >= 4.5, result
                base = result
            if state != 'panel':
                assert result['width'] == 500, result
                assert abs(result['y'] - base['y']) <= .5, result
                assert result['y'] + result['height'] <= result['monitor']['height'] - 24, result
            if state == 'loading':
                assert result['mode'] == 'writing-loading', result
            allocations.append(dict(state=state, text_scale=scale, **result))
        visual(state='closed', name=f'{prefix}-desktop')
        for page in ('General', 'AI & Models', 'Privacy', 'About'):
            checks['select_page'](page)
            time.sleep(.25)
            visual(state='capture', name=f'{prefix}-preferences-{page.split()[0].lower()}')
        print(f'GDI_VISUAL {prefix}: panel, palette states, preview and Preferences=PASS', flush=True)

output = Path(__file__).resolve().parent.parent / 'build/validation/visual/allocations.json'
output.write_text(json.dumps(allocations, indent=2))
assert not checks['snapshot']()['errors']
print('GDI_VISUAL stable-500px-width-top-and-bottom-bounds-and-hint-contrast=PASS', flush=True)
