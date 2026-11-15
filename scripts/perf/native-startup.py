#!/usr/bin/env python3
"""Manual current-Kitty-tab startup matrix. Keeps evidence in its printed temp dir.

Linux only: owner identity is measured through /proc. Requires Kitty remote
control, Python and an absolute Awrit executable. Does not install anything.
"""

import argparse
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlparse

REPO = pathlib.Path(__file__).resolve().parents[2]
CASES = ('visible', 'unfocused', 'resized')
STATES = ('cold', 'warm')
KITTY_TIMEOUT_SECONDS = 10
READY_TIMEOUT_SECONDS = 15.0
CLOSE_TIMEOUT_SECONDS = 5.0
KEEPER_WARMUP_SECONDS = 3.0

LAUNCHER_TEMPLATE = """#!/usr/bin/env python3
import os
import sys

os.environ['XDG_CONFIG_HOME'] = {config!r}
if os.environ.get('WAYLAND_DISPLAY') and not os.path.isabs(os.environ['WAYLAND_DISPLAY']):
    os.environ['WAYLAND_DISPLAY'] = os.path.join(
        os.environ['XDG_RUNTIME_DIR'], os.environ['WAYLAND_DISPLAY'])
os.environ['XDG_RUNTIME_DIR'] = {profile!r}
os.environ['AWRIT_IPC_SOCKET'] = {socket!r}
os.execv({awrit!r}, ['awrit'] + sys.argv[1:])
"""


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('awrit', type=pathlib.Path)
    args = parser.parse_args(argv)
    if not args.awrit.is_absolute() or not args.awrit.is_file():
        parser.error('awrit must be an absolute executable path')
    if not pathlib.Path('/proc/self/environ').exists():
        parser.error('Linux /proc is required')
    return args


def terminate_cleanly(signum, _frame):
    """Turn SIGTERM into SystemExit so the fixture cleanup block still runs."""
    raise SystemExit(128 + signum)


def install_termination_handler():
    signal.signal(signal.SIGTERM, terminate_cleanly)


class Kitty:
    """Thin remote-control client for the Kitty session running this harness."""

    def __init__(self, address):
        self.address = address

    def call(self, *args):
        command = ['kitty', '@', '--to', self.address, *map(str, args)]
        return subprocess.check_output(
            command, text=True, timeout=KITTY_TIMEOUT_SECONDS).strip()

    def windows(self):
        """Every window in the session, across all OS windows and tabs."""
        listing = json.loads(self.call('ls'))
        return [
            window
            for os_window in listing
            for tab in os_window['tabs']
            for window in tab['windows']
        ]


class Fixture:
    """Windows and files this run owns; cleanup closes nothing else."""

    def __init__(self, kitty, root):
        self.kitty = kitty
        self.root = root
        self.source_id = None
        self.keepers = set()
        self.helpers = set()

    def launcher_paths(self):
        return [str(self.root / case / 'launch') for case in CASES]

    def launch_source(self, chat_window_id):
        self.source_id = int(self.kitty.call(
            'launch',
            '--match', f'window_id:{chat_window_id}',
            '--type=window',
            '--location=vsplit',
            '--title=Awrit startup matrix',
            'sleep', '600',
        ))
        return self.source_id

    def cleanup(self):
        """Close owned windows, source last. One failure never skips the rest."""
        errors = []
        known = {window_id for window_id in
                 (self.source_id, *self.keepers, *self.helpers)
                 if window_id is not None}
        launchers = self.launcher_paths()
        owned = []
        try:
            for window in self.kitty.windows():
                cmdline = window.get('cmdline') or []
                if window['id'] in known or any(path in cmdline for path in launchers):
                    owned.append(window['id'])
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            errors.append(f'window discovery: {error}')
            owned = sorted(known)
        ordered = [window_id for window_id in owned if window_id != self.source_id]
        if self.source_id in owned:
            ordered.append(self.source_id)
        failed = set()
        for window_id in ordered:
            try:
                self.kitty.call('close-window', '--match', f'id:{window_id}')
            except (OSError, subprocess.SubprocessError) as error:
                errors.append(f'window {window_id}: {error}')
                failed.add(window_id)
        self.keepers.intersection_update(failed)
        self.helpers = failed - {self.source_id} - self.keepers
        if self.source_id not in failed:
            self.source_id = None
        return errors


def owner_pids(profile):
    """PIDs of browser owners started with this run's profile (Linux only)."""
    matches = []
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            environ = (entry / 'environ').read_bytes().split(b'\0')
            cmdline = (entry / 'cmdline').read_bytes()
        except OSError:
            continue
        if ('XDG_RUNTIME_DIR=' + str(profile)).encode() in environ \
                and b'/browserOwner/main.js' in cmdline \
                and b'--type=' not in cmdline:
            matches.append(int(entry.name))
    return sorted(matches)


def capture_marker(window):
    """This helper's own capture marker; another review's marker must not match."""
    for process in window['foreground_processes']:
        for argument in process['cmdline']:
            if not argument.startswith('awrit://terminal-review/'):
                continue
            images = parse_qs(urlparse(argument).query).get('image', [])
            if images and pathlib.Path(images[0] + '.ready').exists():
                return pathlib.Path(images[0] + '.ready')
    return None


def write_launcher(profile, awrit):
    launcher = profile / 'launch'
    launcher.write_text(LAUNCHER_TEMPLATE.format(
        config=str(profile / 'config'),
        profile=str(profile),
        socket=str(profile / 'feedback.sock'),
        awrit=str(awrit),
    ))
    launcher.chmod(0o700)
    return launcher


def wait_for_helper(fixture, launcher, label):
    """Wait for the overlay window whose command line names this launcher."""
    deadline = time.monotonic() + READY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        for window in fixture.kitty.windows():
            cmdline = window.get('cmdline') or []
            if str(launcher) not in cmdline or str(fixture.source_id) not in cmdline:
                continue
            fixture.helpers.add(window['id'])
            marker = capture_marker(window)
            if marker is not None:
                return window['id'], marker
        time.sleep(0.1)
    raise RuntimeError(f'{label}: readiness missing')


def wait_until_closed(fixture, window_id):
    deadline = time.monotonic() + CLOSE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not any(window['id'] == window_id for window in fixture.kitty.windows()):
            return True
        time.sleep(0.1)
    return not any(window['id'] == window_id for window in fixture.kitty.windows())


def measure_state(fixture, case, state, launcher, chat_window_id):
    profile = fixture.root / case
    baseline = next(
        window for window in fixture.kitty.windows()
        if window['id'] == fixture.source_id)
    grid = (baseline['columns'], baseline['lines'])
    focus_id = chat_window_id if case == 'unfocused' else fixture.source_id
    fixture.kitty.call('focus-window', '--match', f'id:{focus_id}')
    owners_before = owner_pids(profile)
    assert bool(owners_before) == (state == 'warm'), \
        f'Unexpected owner state: {owners_before}'

    start = time.monotonic()
    fixture.kitty.call(
        'kitten',
        '--match', f'id:{fixture.source_id}',
        REPO / 'kittens/awrit.py',
        'design', launcher,
    )
    overlay, _ = wait_for_helper(fixture, launcher, f'{case}/{state}')
    elapsed = time.monotonic() - start
    owners_ready = owner_pids(profile)
    assert len(owners_ready) == 1, f'Expected one ready owner: {owners_ready}'
    if state == 'warm':
        assert owners_before == owners_ready, 'Warm owner changed'

    fixture.kitty.call('focus-window', '--match', f'id:{overlay}')
    fixture.kitty.call('send-key', '--match', f'id:{overlay}', 'ctrl+d')
    assert wait_until_closed(fixture, overlay), f'{case}/{state}: overlay stayed open'
    after = next(
        window for window in fixture.kitty.windows()
        if window['id'] == fixture.source_id)
    assert (after['columns'], after['lines']) == grid, f'{case}/{state}: grid changed'
    fixture.helpers.discard(overlay)

    result = {
        'case': case,
        'state': state,
        'seconds': round(elapsed, 3),
        'grid': grid,
        'sourceSurvived': True,
        'ownersBefore': owners_before,
        'ownersReady': owners_ready,
    }
    print(json.dumps(result), flush=True)
    return result


def run_cases(fixture, awrit, chat_window_id):
    results = []
    for case in CASES:
        profile = fixture.root / case
        profile.mkdir()
        launcher = write_launcher(profile, awrit)
        if case == 'resized':
            fixture.kitty.call(
                'resize-window',
                '--match', f'id:{fixture.source_id}',
                '--axis', 'horizontal', '--increment', -4,
            )
        keeper = None
        for state in STATES:
            if state == 'warm':
                keeper = int(fixture.kitty.call(
                    'launch',
                    '--match', f'window_id:{fixture.source_id}',
                    '--type=window',
                    '--location=vsplit',
                    launcher,
                    'data:text/html,<title>Startup keeper</title>Keeper',
                ))
                fixture.keepers.add(keeper)
                time.sleep(KEEPER_WARMUP_SECONDS)
            results.append(measure_state(
                fixture, case, state, launcher, chat_window_id))
        if keeper is not None:
            fixture.kitty.call('close-window', '--match', f'id:{keeper}')
            fixture.keepers.discard(keeper)
    return results


def main(argv=None):
    args = parse_args(argv)
    install_termination_handler()
    root = pathlib.Path(tempfile.mkdtemp(prefix='awrit-startup-matrix-'))
    fixture = Fixture(Kitty(os.environ['KITTY_LISTEN_ON']), root)
    chat_window_id = int(os.environ['KITTY_WINDOW_ID'])
    try:
        fixture.launch_source(chat_window_id)
        results = run_cases(fixture, args.awrit, chat_window_id)
        (root / 'results.json').write_text(json.dumps(results, indent=2))
        print(root, flush=True)
    finally:
        errors = fixture.cleanup()
        if errors:
            message = 'Fixture cleanup failed: ' + '; '.join(errors)
            if sys.exc_info()[0] is None:
                raise RuntimeError(message)
            print(message, file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
