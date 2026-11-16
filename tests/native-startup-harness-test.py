#!/usr/bin/env python3
"""Isolated cleanup and signal tests for scripts/perf/native-startup.py (no Kitty)."""

import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import sys
import textwrap
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts/perf/native-startup.py'


def load_harness():
    spec = importlib.util.spec_from_file_location('native_startup', MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeKitty:
    def __init__(self, windows, failures=(), discovery_error=None):
        self.windows_list = list(windows)
        self.failures = set(failures)
        self.discovery_error = discovery_error
        self.closed = []

    def windows(self):
        if self.discovery_error:
            raise self.discovery_error
        return list(self.windows_list)

    def call(self, *args):
        if args[0] != 'close-window':
            raise AssertionError(f'unexpected Kitty call: {args}')
        window_id = int(args[2].split(':')[1])
        self.closed.append(window_id)
        if window_id in self.failures:
            raise subprocess.CalledProcessError(1, args)
        self.windows_list = [
            window for window in self.windows_list if window['id'] != window_id]
        return ''


def window(window_id, cmdline=()):
    return {'id': window_id, 'cmdline': list(cmdline)}


class CleanupTest(unittest.TestCase):
    def setUp(self):
        self.harness = load_harness()
        self.root = pathlib.Path('/tmp/awrit-startup-matrix-test')

    def fixture(self, kitty):
        return self.harness.Fixture(kitty, self.root)

    def test_closes_only_owned_windows_with_source_last(self):
        launcher = str(self.root / 'visible' / 'launch')
        kitty = FakeKitty([
            window(10, ['sleep', '600']),
            window(11, ['keeper']),
            window(12, ['helper']),
            window(13, ['unrelated']),
            window(14, [launcher]),
        ])
        fixture = self.fixture(kitty)
        fixture.source_id = 10
        fixture.keepers.add(11)
        fixture.helpers.add(12)

        self.assertEqual(fixture.cleanup(), [])
        self.assertEqual(set(kitty.closed), {10, 11, 12, 14})
        self.assertEqual(kitty.closed[-1], 10)

    def test_one_failed_close_does_not_skip_the_rest(self):
        kitty = FakeKitty(
            [window(10), window(11), window(12)], failures={11})
        fixture = self.fixture(kitty)
        fixture.source_id = 10
        fixture.keepers.add(11)
        fixture.helpers.add(12)

        errors = fixture.cleanup()
        self.assertEqual(set(kitty.closed), {10, 11, 12})
        self.assertEqual(len(errors), 1)
        self.assertIn('window 11', errors[0])
        kitty.failures.clear()
        self.assertEqual(fixture.cleanup(), [])
        self.assertEqual(kitty.closed[-1], 11)

    def test_missing_source_id_still_closes_discovered_launchers(self):
        launcher = str(self.root / 'unfocused' / 'launch')
        kitty = FakeKitty([window(20, [launcher]), window(21, ['unrelated'])])
        fixture = self.fixture(kitty)

        self.assertEqual(fixture.cleanup(), [])
        self.assertEqual(kitty.closed, [20])

    def test_discovery_failure_falls_back_to_known_ids(self):
        kitty = FakeKitty(
            [], discovery_error=subprocess.CalledProcessError(1, ['kitty']))
        fixture = self.fixture(kitty)
        fixture.source_id = 10
        fixture.keepers.add(11)

        errors = fixture.cleanup()
        self.assertEqual(kitty.closed, [11, 10])
        self.assertEqual(len(errors), 1)
        self.assertIn('discovery', errors[0])

    def test_cleanup_is_idempotent(self):
        kitty = FakeKitty([window(10)])
        fixture = self.fixture(kitty)
        fixture.source_id = 10

        self.assertEqual(fixture.cleanup(), [])
        self.assertEqual(fixture.cleanup(), [])
        self.assertEqual(kitty.closed, [10])


class LauncherTest(unittest.TestCase):
    def test_generated_launcher_is_executable_python_without_pathlib_objects(self):
        harness = load_harness()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            target = root / 'target'
            target.write_text('#!/usr/bin/env python3\nimport os\nprint(os.environ["XDG_RUNTIME_DIR"])\n')
            target.chmod(0o700)
            launcher = harness.write_launcher(root, target)
            completed = subprocess.run([sys.executable, str(launcher)], capture_output=True,
                                       text=True, timeout=10)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout.strip(), str(root))


class SignalTest(unittest.TestCase):
    def test_sigterm_handler_raises_system_exit(self):
        harness = load_harness()
        with self.assertRaises(SystemExit) as raised:
            harness.terminate_cleanly(signal.SIGTERM, None)
        self.assertEqual(raised.exception.code, 128 + signal.SIGTERM)

    def test_sigterm_handler_is_installed_for_sigterm(self):
        harness = load_harness()
        with patch.object(harness.signal, 'signal') as install:
            harness.install_termination_handler()
        install.assert_called_once_with(signal.SIGTERM, harness.terminate_cleanly)


class FinallyTest(unittest.TestCase):
    """Run the real main() against a fake Kitty in a child process."""

    CHILD = textwrap.dedent('''
        import importlib.util, json, os, signal, sys, time

        spec = importlib.util.spec_from_file_location('harness', sys.argv[1])
        harness = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(harness)

        closed = []
        class FakeKitty:
            def __init__(self, address):
                self.address = address
            def windows(self):
                return [{'id': 10, 'cmdline': ['sleep', '600']},
                        {'id': 11, 'cmdline': ['keeper']}]
            def call(self, *args):
                if args[0] == 'launch':
                    return '10'
                if args[0] == 'close-window':
                    closed.append(int(args[2].split(':')[1]))
                return ''

        harness.Kitty = FakeKitty

        def interrupted(fixture, awrit, chat_window_id):
            fixture.keepers.add(11)
            if os.environ['INTERRUPT'] == 'sigterm':
                os.kill(os.getpid(), signal.SIGTERM)
                time.sleep(5)
            raise KeyboardInterrupt

        harness.run_cases = interrupted
        os.environ['KITTY_LISTEN_ON'] = 'unix:/nonexistent'
        os.environ['KITTY_WINDOW_ID'] = '1'
        try:
            harness.main([sys.executable])
        except (SystemExit, KeyboardInterrupt):
            pass
        print(json.dumps(closed))
    ''')

    def run_child(self, interrupt):
        env = dict(os.environ, INTERRUPT=interrupt)
        completed = subprocess.run(
            [sys.executable, '-c', self.CHILD, str(MODULE_PATH)],
            env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_sigterm_reaches_finally_and_closes_source_last(self):
        self.assertEqual(self.run_child('sigterm'), [11, 10])

    def test_keyboard_interrupt_reaches_finally(self):
        self.assertEqual(self.run_child('keyboard'), [11, 10])


if __name__ == '__main__':
    unittest.main()
