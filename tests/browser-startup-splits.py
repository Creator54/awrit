"""Measure source-launcher cold/warm page initialization in existing Kitty splits.

Run inside the project's Nix shell (or supply AWRIT_ELECTRON). Requires a running
Kitty remote-control socket and KITTY_WINDOW_ID. Does not stop existing owners.
Set AWRIT_PROBE_WRAPPER=1 to include ./awrit and its Nix-shell entry cost.
Set AWRIT_PROBE_SHOW=1 to measure agent-facing show and existing-viewer reuse.
Set AWRIT_PROBE_LAUNCHER to an absolute installed launcher to measure that build.
Timings include launcher/build overhead, not proof of the first visible frame.
"""
import http.server
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import threading
import time

repo = Path(__file__).resolve().parents[1]
installed_launcher = os.environ.get('AWRIT_PROBE_LAUNCHER')
if installed_launcher and not (Path(installed_launcher).is_absolute() and os.access(installed_launcher, os.X_OK)):
    raise SystemExit('AWRIT_PROBE_LAUNCHER must be an absolute executable path')
electron = os.environ.get('AWRIT_ELECTRON') or shutil.which('electron')
endpoint = os.environ.get('KITTY_LISTEN_ON')
source = os.environ.get('KITTY_WINDOW_ID')
if (not electron and not installed_launcher) or not endpoint or not source:
    raise SystemExit('Requires Electron on PATH/AWRIT_ELECTRON and Kitty remote control')
root = Path(tempfile.mkdtemp(prefix='awrit-startup-splits-'))
(root / 'home').mkdir()
(root / 'data/awrit').mkdir(parents=True)
(root / 'data/awrit/setup-offered').write_text('1')
initialized = {f'/{n}': threading.Event() for n in range(2)}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        event = initialized.get(self.path.removeprefix('/ready'))
        if self.path.startswith('/ready') and event:
            event.set()
        body = b'<body style="background:#164965;color:white;font:26px sans-serif">Awrit startup probe<script>fetch("/ready"+location.pathname)</script>'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def remote(*args):
    return subprocess.check_output(
        ['kitten', '@', '--to', endpoint, *args], text=True, timeout=5,
    ).strip()


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
panes = []
timings = []
try:
    env = {
        'HOME': str(root / 'home'),
        'XDG_CONFIG_HOME': str(root / 'config'),
        'XDG_DATA_HOME': str(root / 'data'),
        'AWRIT_IPC_SOCKET': str(root / 'agent.sock'),
    }
    if electron and not installed_launcher:
        env['AWRIT_ELECTRON'] = electron
    show_launcher = root / 'show-launcher'
    show_launcher.write_text('#!/bin/sh\nexec env ' + shlex.join([
        *[f'{key}={value}' for key, value in env.items()],
        installed_launcher or str(repo / 'awrit'), '--debug-port=disabled',
    ]) + ' "$@"\n')
    show_launcher.chmod(0o700)
    for n in range(2):
        launcher = ([installed_launcher] if installed_launcher else
                    [str(repo / 'awrit')] if os.environ.get('AWRIT_PROBE_WRAPPER') == '1'
                    else ['bun', str(repo / 'src/runner/index.ts')])
        command = shlex.join([
            *launcher, '--debug-port=disabled', f'http://127.0.0.1:{server.server_port}/{n}',
        ]) + ' 2>' + shlex.quote(str(root / f'pane{n}.stderr'))
        started = time.monotonic()
        if os.environ.get('AWRIT_PROBE_SHOW') == '1':
            show_command = launcher
            if installed_launcher:
                # The package wrapper resets AWRIT_LAUNCHER. Call its bundled CLI
                # directly so remote children retain our isolated env launcher.
                cli = Path(installed_launcher).resolve().parent.parent / 'lib/awrit/dist/presentation-cli.js'
                node = shutil.which('node')
                if not node or not cli.is_file():
                    raise RuntimeError('Packaged show probe requires node and lib/awrit/dist/presentation-cli.js')
                show_command = [node, str(cli)]
            result = subprocess.run([
                *show_command, 'show', f'http://127.0.0.1:{server.server_port}/{n}',
                '--mode', 'split', '--json',
            ], env={**os.environ, **env, 'KITTY_WINDOW_ID': os.environ['KITTY_WINDOW_ID'],
                     'AWRIT_LAUNCHER': str(show_launcher)},
                capture_output=True, text=True, timeout=25)
            (root / f'show{n}.stderr').write_text(result.stderr)
            if result.returncode:
                raise RuntimeError(f'show failed: {result.stderr}')
            receipt = json.loads(result.stdout)
            (root / f'show{n}.json').write_text(result.stdout)
            if receipt.get('mode') != 'split':
                raise RuntimeError(f'Expected split receipt: {receipt}')
            pane = str(receipt.get('id') or receipt.get('kittyWindowId') or '')
            if not pane.isdecimal():
                raise RuntimeError(f'Missing exact pane ID: {receipt}')
            first_pane = panes[0] if panes else None
            if pane not in panes:
                panes.append(pane)
            if n == 1 and (pane != first_pane or receipt.get('readiness') != 'navigated'):
                raise RuntimeError(f'Warm show did not reuse its owned pane: {receipt}')
        else:
            pane = remote(
                'launch', f'--match=window_id:{source}',
                f'--source-window=id:{source}', '--keep-focus', '--location=vsplit',
                *[f'--env={key}={value}' for key, value in env.items()],
                'sh', '-c', command,
            )
        if pane not in panes:
            panes.append(pane)
        if not initialized[f'/{n}'].wait(15):
            raise RuntimeError(f'Page did not initialize; see {root}/pane{n}.stderr')
        timings.append({'launch': 'cold' if n == 0 else 'warm',
                        'page_initialized_ms': round((time.monotonic() - started) * 1000)})
        source = pane
    remote('screenshot', str(root / 'splits.png'))
    (root / 'timings.json').write_text(json.dumps(timings, indent=2))
    print(json.dumps({'ok': True, 'timings': timings, 'evidence': str(root)}))
finally:
    for pane in reversed(panes):
        try:
            remote('close-window', f'--match=id:{pane}')
        except (subprocess.SubprocessError, OSError):
            pass  # Only our owned pane IDs are eligible for cleanup.
    server.shutdown()
    server.server_close()
