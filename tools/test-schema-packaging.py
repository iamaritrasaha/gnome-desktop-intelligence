#!/usr/bin/python3
"""Prove missing binaries fail both ZIP and installed-directory validation."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import zipfile
spec = importlib.util.spec_from_file_location('check_schemas', Path(__file__).with_name('check-schemas.py'))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
checker.check(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='gdi-schema-regression-') as temporary:
    root = Path(temporary)
    with zipfile.ZipFile(sys.argv[1]) as package:
        package.extractall(root / 'installed')
        with zipfile.ZipFile(root / 'broken.zip', 'w') as broken:
            for name in package.namelist():
                if name != 'schemas/gschemas.compiled':
                    broken.writestr(name, package.read(name))
    checker.check(root / 'installed')
    (root / 'installed/schemas/gschemas.compiled').unlink()
    for target in (root / 'broken.zip', root / 'installed'):
        try:
            checker.check(target)
        except ValueError as error:
            assert 'gschemas.compiled' in str(error), error
        else:
            raise AssertionError(f'Missing compiled schema was accepted: {target}')
    print('GDI regression: missing compiled schemas rejected in package and install: PASS')
