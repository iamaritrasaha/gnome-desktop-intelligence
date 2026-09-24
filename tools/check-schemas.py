#!/usr/bin/python3
"""Reject incomplete/stale GDI packages and installs without a global fallback."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile
from gi.repository import Gio

SCHEMA_ID = 'org.gnome.shell.extensions.gdi'
DEFAULT_SHORTCUT = ['<Control><Super>space']


def check_directory(root):
    schema_dir = root / 'schemas'
    compiled = schema_dir / 'gschemas.compiled'
    if not compiled.is_file() or not compiled.stat().st_size:
        raise ValueError(f'Missing or empty {compiled}')
    xml = schema_dir / (SCHEMA_ID + '.gschema.xml')
    if not xml.is_file():
        raise ValueError(f'Missing {xml}')
    if json.loads((root / 'metadata.json').read_text())['settings-schema'] != SCHEMA_ID:
        raise ValueError('metadata.json settings-schema does not match GDI')
    subprocess.run(['glib-compile-schemas', '--strict', '--dry-run', str(schema_dir)], check=True)
    # Compiling a separate copy checks freshness without repairing the artifact.
    with tempfile.TemporaryDirectory(prefix='gdi-schema-check-') as fresh:
        for source in schema_dir.glob('*.xml'):
            shutil.copy2(source, fresh)
        subprocess.run(['glib-compile-schemas', '--strict', fresh], check=True)
        if compiled.read_bytes() != (Path(fresh) / 'gschemas.compiled').read_bytes():
            raise ValueError('gschemas.compiled is stale or invalid; rebuild it from the shipped XML')
    source = Gio.SettingsSchemaSource.new_from_directory(str(schema_dir), None, False)
    schema = source.lookup(SCHEMA_ID, False)
    if schema is None:
        raise ValueError('GDI schema cannot be resolved locally')
    if schema.get_key('shortcut').get_default_value().unpack() != DEFAULT_SHORTCUT:
        raise ValueError('Unexpected default shortcut')


def check(path):
    path = Path(path).resolve()
    if path.is_dir():
        check_directory(path)
    else:
        with zipfile.ZipFile(path) as archive, tempfile.TemporaryDirectory(prefix='gdi-package-check-') as temporary:
            required = ['metadata.json', 'schemas/gschemas.compiled', f'schemas/{SCHEMA_ID}.gschema.xml']
            for name in required:
                if name not in archive.namelist():
                    raise ValueError(f'{path.name} is missing {name}')
                archive.extract(name, temporary)
            check_directory(Path(temporary))
    print(f'GDI schemas valid: {path} (default shortcut: {DEFAULT_SHORTCUT[0]})')


if __name__ == '__main__':
    try:
        check(sys.argv[1])
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        raise SystemExit(f'Schema validation failed: {error}')
