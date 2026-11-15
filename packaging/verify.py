#!/usr/bin/env python3
"""Verify a staged product without executing its GUI or requiring build tools."""
import hashlib
import json
import pathlib
import sys


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            if pathlib.Path(path.readlink()).is_absolute():
                raise ValueError(f'Absolute symlink is not relocatable: {path}')
            target = path.resolve()
            if not target.is_relative_to(root.resolve()):
                raise ValueError(f'Escaping symlink: {path}')
            if not path.exists():
                raise ValueError(f'Broken symlink: {path}')
            result[str(path.relative_to(root))] = 'symlink:' + str(path.readlink())
        elif path.is_file() and path != root / 'manifest.json':
            result[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def verify(root):
    manifest = json.loads((root / 'manifest.json').read_text())
    if inventory(root) != manifest['files']:
        raise ValueError('Artifact contents differ from manifest')
    app = root / 'lib/awrit'
    for name in ['bin/awrit', 'lib/awrit/dist/browserOwner/main.js',
                 'lib/awrit/dist/terminal/main.js', 'lib/awrit/runtime/node/bin/node']:
        if not (root / name).is_file():
            raise ValueError(f'Missing required file: {name}')
    binaries = list((app / 'node_modules/awrit-native-rs').glob('*.node'))
    if len(binaries) != 1:
        raise ValueError('Expected exactly one platform native binding')
    # This is a host-path rejection gate, not a substitute for ELF/Mach-O ABI auditing.
    for path in app.rglob('*'):
        if not path.is_file():
            continue
        with path.open('rb') as source:
            tail = b''
            while chunk := source.read(1024 * 1024):
                data = tail + chunk
                if b'/nix/store/' in data:
                    raise ValueError(f'Nix dependency in artifact: {path.relative_to(root)}')
                tail = data[-32:]
    return manifest


if __name__ == '__main__':
    root = pathlib.Path(sys.argv[1]).resolve()
    if sys.argv[2:] == ['--record']:
        (root / 'manifest.json').write_text(json.dumps({'files': inventory(root)}, indent=2) + '\n')
    verify(root)
    print('Artifact integrity and basic layout verified; graphical/OS acceptance is separate.')
