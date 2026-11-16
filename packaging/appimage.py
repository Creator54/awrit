#!/usr/bin/env python3
"""Wrap a verified Linux payload using a supplied, trusted appimagetool."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
from verify import verify


def build(payload, output, tool, runtime):
    payload = payload.resolve()
    output = output.absolute()
    checksum = pathlib.Path(str(output) + '.sha256')
    if output.exists() or checksum.exists():
        raise ValueError('Refusing to overwrite an AppImage or checksum')
    verify(payload)
    identity = json.loads((payload / 'lib/awrit/build.json').read_text())
    architectures = {'x64': 'x86_64', 'arm64': 'aarch64'}
    if identity.get('platform') != 'linux' or identity.get('arch') not in architectures:
        raise ValueError('AppImage requires a Linux x64/arm64 payload')
    tool = str(pathlib.Path(tool).resolve()) if '/' in tool else shutil.which(tool)
    if not tool or not pathlib.Path(tool).is_file():
        raise ValueError('Supply a trusted appimagetool executable')
    with tempfile.TemporaryDirectory(prefix='awrit-appimage-') as directory:
        appdir = pathlib.Path(directory) / 'Awrit.AppDir'
        shutil.copytree(payload, appdir, symlinks=True)
        # Desktop metadata is for AppImage tooling, not automatic system installation.
        (appdir / 'awrit.desktop').write_text('[Desktop Entry]\nType=Application\nName=Awrit\nExec=awrit\nIcon=awrit\nTerminal=true\nCategories=Development;\n')
        (appdir / 'awrit.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="16" fill="#18242b"/><path d="M24 96 56 24h16l32 72H86l-6-16H48l-6 16zm30-32h20L64 38z" fill="#fff"/></svg>\n')
        (appdir / 'AppRun').write_text('#!/bin/sh\nset -eu\nAPPDIR=${APPDIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}\n# Never add sandbox-bypass flags. The payload launcher owns runtime paths.\nexec "$APPDIR/bin/awrit" "$@"\n')
        (appdir / '.DirIcon').symlink_to('awrit.svg')
        (appdir / 'AppRun').chmod(0o755)
        for path in appdir.rglob('*'):
            if not path.is_symlink():
                path.chmod(path.stat().st_mode | (0o555 if path.is_dir() else 0o444))
        staged = pathlib.Path(directory) / 'Awrit.AppImage'
        env = {**os.environ, 'ARCH': architectures[identity['arch']]}
        subprocess.run([tool, '--runtime-file', str(pathlib.Path(runtime).resolve()), str(appdir), str(staged)], env=env, check=True)
        if not staged.is_file():
            raise ValueError('appimagetool did not produce an image')
        # Exclusive creation avoids clobbering a concurrently created destination.
        created = False
        try:
            with output.open('xb') as destination, staged.open('rb') as source:
                created = True
                shutil.copyfileobj(source, destination)
            output.chmod(0o755)
        except BaseException:
            if created:
                output.unlink(missing_ok=True)
            raise
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    with checksum.open('x') as destination:
        destination.write(f'{digest}  {output.name}\n')
    print(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('payload', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--appimagetool', default='appimagetool', help='Trusted host appimagetool executable; never downloaded automatically')
    parser.add_argument('--runtime-file', required=True, help='Trusted type2 runtime file; avoids an implicit tool download')
    args = parser.parse_args()
    build(args.payload, args.output, args.appimagetool, args.runtime_file)
