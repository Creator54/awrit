#!/usr/bin/env python3
"""Small command dispatcher for the repository's just recipes."""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def executable(value):
    found = shutil.which(value) if value else None
    if not found:
        raise ValueError(f'Required executable not found: {value or "(unset)"}')
    return str(pathlib.Path(found).resolve())


def inputs(node, electron):
    if not node:
        raise ValueError('Set NODE_DIST to an unpacked official Node distribution (with bin/node).')
    node = pathlib.Path(node).resolve()
    electron = pathlib.Path(electron).resolve()
    binary = 'Electron.app/Contents/MacOS/Electron' if sys.platform == 'darwin' else 'electron'
    if not (node / 'bin/node').is_file() or not (electron / binary).is_file():
        raise ValueError('NODE_DIST and ELECTRON_DIST must contain matching target runtime distributions.')
    for command in ('bun', 'cargo', 'sh'):
        executable(command)
    return str(node), str(electron)


def build(destination, node, electron):
    node, electron = inputs(node, electron)
    destination = pathlib.Path(destination).absolute()
    if destination.exists():
        raise ValueError(f'Refusing to overwrite: {destination}')
    subprocess.run(['sh', str(ROOT / 'packaging/build-native.sh')], check=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.awrit-build-', dir=destination.parent) as temporary:
        staged = pathlib.Path(temporary) / 'payload'
        subprocess.run(['bun', str(ROOT / 'packaging/build.ts'), str(staged), node, electron], check=True, cwd=ROOT)
        subprocess.run([sys.executable, str(ROOT / 'packaging/verify.py'), str(staged), '--record'], check=True)
        if destination.exists():
            raise ValueError(f'Refusing to overwrite: {destination}')
        staged.rename(destination)


def main(args):
    if not args:
        raise ValueError('Use just --list for available commands.')
    command, *args = args
    arities = {'build': 3, 'test': 1}
    if command in arities and len(args) != arities[command] or command == 'run' and not args:
        raise ValueError(f'Invalid arguments for {command}; use just --list.')
    if command == 'build':
        build(*args)
    elif command in ('run', 'test'):
        artifact, *extra = args
        artifact = pathlib.Path(artifact).absolute()
        if artifact.is_dir():
            artifact = artifact / 'bin/awrit'
        if not artifact.is_file() or not os.access(artifact, os.X_OK):
            raise ValueError(f'Artifact is missing or not executable: {artifact}')
        if command == 'run':
            subprocess.run([str(artifact), *extra], check=True)
        else:
            probe(artifact)
    else:
        raise ValueError(f'Unknown command: {command}')


def probe(artifact):
    subprocess.run([str(artifact), '--version'], check=True)
    subprocess.run([str(artifact), 'capabilities', '--json'], check=True)
    print('CLI checks passed; graphical rendering and sandbox acceptance are separate.')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'Build command failed: {error}', file=sys.stderr)
        sys.exit(1)
