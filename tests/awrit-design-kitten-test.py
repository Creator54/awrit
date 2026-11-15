#!/usr/bin/env python3
"""Failure cleanup for the native review helper; no Kitty instance required."""
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

root = pathlib.Path(__file__).resolve().parent.parent
handler = types.ModuleType('kittens.tui.handler')
handler.kitten_ui = lambda **kwargs: lambda fn: fn
handler.result_handler = lambda **kwargs: lambda fn: fn
sys.modules['kittens'] = types.ModuleType('kittens')
sys.modules['kittens.tui'] = types.ModuleType('kittens.tui')
sys.modules['kittens.tui.handler'] = handler
spec = importlib.util.spec_from_file_location('design_helper', root / 'kittens/awrit_design.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class CleanupTests(unittest.TestCase):
    def test_startup_timeout_terminates_child_and_removes_capture(self):
        process = Mock()
        process.poll.return_value = None
        screenshot = types.SimpleNamespace(returncode=0, stdout=b'capture', stderr=b'')
        helper.main.remote_control = Mock(return_value=screenshot)
        with patch.dict(helper.os.environ, {'AWRIT_LAUNCHER': '/test/awrit'}), \
                patch.object(helper.subprocess, 'Popen', return_value=process) as launch, \
                patch.object(helper.time, 'monotonic', side_effect=[0, 21]):
            with self.assertRaisesRegex(RuntimeError, 'too long'):
                helper.main(['awrit_design.py', '7'])
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)
        target = launch.call_args.args[0][1]
        from urllib.parse import parse_qs, urlparse
        capture = pathlib.Path(parse_qs(urlparse(target).query)['image'][0])
        self.assertFalse(capture.parent.exists())

    def test_timeout_reports_last_native_startup_stage(self):
        stages = [None, 'toolbar load failed (-105)', 'waiting for decoded frame', 'waiting for first paint']
        for stage in stages:
            with self.subTest(stage=stage):
                process = Mock()
                process.poll.return_value = None
                helper.main.remote_control = Mock(return_value=types.SimpleNamespace(returncode=0, stdout=b'capture', stderr=b''))
                captures = []
                def launch(argv, **kwargs):
                    from urllib.parse import parse_qs, urlparse
                    capture = pathlib.Path(parse_qs(urlparse(argv[1]).query)['image'][0])
                    captures.append(capture)
                    if stage is not None:
                        pathlib.Path(str(capture) + '.startup').write_text(stage)
                    return process
                with patch.object(helper.subprocess, 'Popen', side_effect=launch), \
                        patch.object(helper.time, 'monotonic', side_effect=[0, 21]):
                    with self.assertRaises(RuntimeError) as raised:
                        helper.main(['awrit_design.py', '7', '/test/awrit'])
                self.assertIn('Native review startup: ' + (stage or 'waiting for browser owner'), str(raised.exception))
                process.terminate.assert_called_once()
                self.assertEqual(len(captures), 1)
                self.assertFalse(captures[0].parent.exists())

    def test_invalid_background_never_launches_review(self):
        helper.main.remote_control = Mock(return_value=types.SimpleNamespace(returncode=0, stdout=b'capture'))
        with patch.object(helper.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(ValueError, 'Invalid Kitty background'):
                helper.main(['awrit_design.py', '7', '/test/awrit', '#nothex'])
        launch.assert_not_called()

    def test_source_background_reaches_packaged_launcher(self):
        process = Mock()
        process.poll.return_value = 0
        process.wait.return_value = 0
        helper.main.remote_control = Mock(return_value=types.SimpleNamespace(returncode=0, stdout=b'capture'))
        with patch.object(helper.subprocess, 'Popen', return_value=process) as launch:
            with self.assertRaisesRegex(RuntimeError, 'closed before it became ready'):
                helper.main(['awrit_design.py', '7', '/test/awrit', '#FAFAFA'])
        env = launch.call_args.kwargs['env']
        self.assertEqual(env['AWRIT_TERMINAL_BACKGROUND'], '#fafafa')
        self.assertEqual(env['AWRIT_TERMINAL_SCHEME'], 'light')

    def test_termination_unwinds_capture_and_stops_child(self):
        process = Mock()
        process.poll.return_value = None
        helper.main.remote_control = Mock(return_value=types.SimpleNamespace(returncode=0, stdout=b'capture'))
        def terminate(_):
            helper.signal.raise_signal(helper.signal.SIGTERM)
        with patch.dict(helper.os.environ, {'AWRIT_LAUNCHER': '/test/awrit'}), \
                patch.object(helper.subprocess, 'Popen', return_value=process) as launch, \
                patch.object(helper.time, 'sleep', side_effect=terminate):
            with self.assertRaises(SystemExit):
                helper.main(['awrit_design.py', '7'])
        process.terminate.assert_called_once()
        from urllib.parse import parse_qs, urlparse
        capture = pathlib.Path(parse_qs(urlparse(launch.call_args.args[0][1]).query)['image'][0])
        self.assertFalse(capture.parent.exists())

    def test_resize_exposes_source_then_restores_overlay_without_relaunch(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.return_value = 0
        state = {}
        def launch(argv, **kwargs):
            from urllib.parse import parse_qs, urlparse
            capture = pathlib.Path(parse_qs(urlparse(argv[1]).query)['image'][0])
            state['capture'] = capture
            pathlib.Path(str(capture) + '.ready').touch()
            pathlib.Path(str(capture) + '.refresh').write_text('generation-1')
            return process
        def remote(argv, **kwargs):
            if argv == ['focus-window', '--match', 'id:9'] and 'capture' in state:
                process.poll.return_value = 0
            return types.SimpleNamespace(returncode=0, stdout=b'fresh', stderr=b'')
        def sleep(_):
            capture = state['capture']
            if pathlib.Path(str(capture) + '.updated').exists():
                # Waiting for the new frame must happen after restoring Design,
                # not while the source terminal is exposed.
                self.assertEqual(helper.main.remote_control.call_args.args[0], ['focus-window', '--match', 'id:9'])
                pathlib.Path(str(capture) + '.ready').write_text('generation-1')
        helper.main.remote_control = Mock(side_effect=remote)
        with patch.dict(helper.os.environ, {'AWRIT_LAUNCHER': '/test/awrit', 'KITTY_WINDOW_ID': '9'}), \
                patch.object(helper.subprocess, 'Popen', side_effect=launch) as popen, \
                patch.object(helper.time, 'sleep', side_effect=sleep):
            helper.main(['awrit_design.py', '7'])
        self.assertEqual(popen.call_count, 1)
        self.assertEqual([call.args[0] for call in helper.main.remote_control.call_args_list], [
            ['focus-window', '--match', 'id:7'],
            ['screenshot', '--match', 'id:7'],
            ['focus-window', '--match', 'id:9'],
            ['focus-window', '--match', 'id:7'],
            ['screenshot', '--match', 'id:7'],
            ['focus-window', '--match', 'id:9'],
        ])
        self.assertFalse(state['capture'].parent.exists())

    def test_launch_error_includes_only_stderr_tail(self):
        with tempfile.TemporaryFile() as diagnostics:
            diagnostics.write(b'old detail' + b'x' * 5000 + b'\nlauncher failed')
            position = diagnostics.tell()
            error = str(helper.launch_error('Review could not open', diagnostics))
            self.assertEqual(diagnostics.tell(), position)
            self.assertTrue(error.endswith('launcher failed'))
            self.assertNotIn('old detail', error)
            self.assertLessEqual(len(error), len('Review could not open\n') + 4096)

    def test_capture_and_restore_failures_are_both_reported(self):
        helper.main.remote_control = Mock(side_effect=[
            subprocess.CompletedProcess([], 0, b'', b''),
            subprocess.CompletedProcess([], 1, b'', b'screenshot failed'),
            subprocess.CompletedProcess([], 1, b'', b'focus failed'),
        ])
        with patch.dict(os.environ, {'KITTY_WINDOW_ID': '9'}):
            with self.assertRaisesRegex(RuntimeError, 'screenshot failed\nCould not restore Design focus: focus failed'):
                helper.main(['awrit_design.py', '7', '/test/awrit'])

    def test_failed_capture_never_launches_review(self):
        helper.main.remote_control = Mock(return_value=types.SimpleNamespace(returncode=1, stderr=b'not visible'))
        with patch.dict(helper.os.environ, {'AWRIT_LAUNCHER': '/test/awrit'}), \
                patch.object(helper.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(RuntimeError, 'not visible'):
                helper.main(['awrit_design.py', '7'])
        launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
