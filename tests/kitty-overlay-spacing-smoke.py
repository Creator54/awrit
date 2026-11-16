#!/usr/bin/env python3
"""Verify Awrit's kitten overlay preserves a padded source in isolated Kitty.
Run with TMPDIR set to the session scratchpad and --evidence-dir inside it.
Uses a fake viewer: no device, browser, host terminal or user config is changed.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', required=True)
    args = parser.parse_args()
    evidence = Path(args.evidence_dir).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='awrit-spacing-') as directory:
        directory = Path(directory)
        viewer = directory / 'viewer.sh'
        viewer.write_text("#!/bin/sh\nprintf '\\033[47m\\033[2J\\033[HOVERLAY'\nsleep 120\n")
        viewer.chmod(0o700)
        source = directory / 'source.sh'
        source.write_text("#!/bin/sh\nprintf '\\033[47m\\033[2J\\033[HSOURCE'\nsleep 120\n")
        source.chmod(0o700)
        endpoint = f'unix:@awrit-spacing-{os.getpid()}'
        env = {k: v for k, v in os.environ.items() if not k.startswith(('KITTY_', 'AWRIT_', 'CLAUDE', 'CODEX'))}
        env.update(HOME=str(directory), AWRIT_LAUNCHER=str(viewer))
        kitty = subprocess.Popen([
            'kitty', '--config', 'NONE', '-o', 'allow_remote_control=yes',
            '-o', 'window_padding_width=20', '-o', 'background=#223344',
            '--listen-on', endpoint, str(source),
        ], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        def rc(*command):
            result = subprocess.run(['kitten', '@', '--to', endpoint, *command], capture_output=True, text=True, timeout=5)
            if result.returncode:
                raise RuntimeError(result.stderr)
            return result.stdout

        def windows():
            return [w for o in json.loads(rc('ls')) for t in o['tabs'] for w in t['windows']]

        def wait(predicate):
            deadline = time.monotonic() + 20
            last = None
            while time.monotonic() < deadline:
                try:
                    value = predicate()
                    if value:
                        return value
                except (RuntimeError, ValueError) as error:
                    last = error
                time.sleep(.2)
            raise RuntimeError(f'Timed out: {last}')

        try:
            original = wait(lambda: next((w for w in windows() if 'source.sh' in ' '.join(w['cmdline'])), None))
            source_id = original['id']
            wait(lambda: 'SOURCE' in rc('get-text', '--match', f'id:{source_id}'))
            rc('screenshot', str(evidence / 'source-before.png'))
            rc('kitten', '--match', f'id:{source_id}', str(ROOT / 'kittens' / 'awrit.py'), 'overlay', 'https://example.invalid')
            overlay = wait(lambda: next((w for w in windows() if w['id'] != source_id), None))
            overlay_id = overlay['id']
            wait(lambda: 'OVERLAY' in rc('get-text', '--match', f'id:{overlay_id}'))
            rc('screenshot', str(evidence / 'overlay.png'))
            rc('close-window', '--match', f'id:{overlay_id}')
            restored = wait(lambda: next((w for w in windows() if w['id'] == source_id and w['is_focused']), None))
            assert (restored['columns'], restored['lines']) == (original['columns'], original['lines']), (original['columns'], restored['columns'])
            rc('screenshot', str(evidence / 'source-after.png'))

            # Reuse the existing fixture PNG decoder, without a new image dependency.
            spec = importlib.util.spec_from_file_location('presentation_e2e', ROOT / 'tests' / 'kitty-presentation-e2e.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            def content_left(file):
                width, height, bpp, rows = module.png_pixels(file)
                row = rows[height // 2]
                return next((x for x in range(width) if all(c > 200 for c in row[x*bpp:x*bpp+3])), None)
            edges = [content_left(evidence / name) for name in ('source-before.png', 'overlay.png', 'source-after.png')]
            assert edges[0] is not None and edges[0] > 0, edges
            assert edges[0] == edges[1] == edges[2], edges
            print(f'PASS: source focus/geometry unchanged; inherited padding preserved (content starts at x={edges[0]}).')
            print(f'Evidence: {evidence}')
        finally:
            kitty.terminate()
            try:
                kitty.wait(5)
            except subprocess.TimeoutExpired:
                kitty.kill()
                kitty.wait()


if __name__ == '__main__':
    main()
