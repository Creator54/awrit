#!/usr/bin/env python3
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('commands', pathlib.Path(__file__).resolve().parents[1] / 'packaging/commands.py')
commands = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commands)


class CommandsTest(unittest.TestCase):
    def test_invalid_arguments_have_clear_errors(self):
        for arguments in ([], ['build'], ['run'], ['appimage', 'output']):
            with self.assertRaises(ValueError):
                commands.main(arguments)

    def test_failed_build_does_not_leave_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / 'output'
            with patch.object(commands, 'inputs', return_value=('node', 'electron')):
                def run(args, **kwargs):
                    if args[0] == 'bun':
                        pathlib.Path(args[2]).mkdir()
                        raise subprocess.CalledProcessError(1, args)
                with patch.object(commands.subprocess, 'run', side_effect=run):
                    with self.assertRaises(subprocess.CalledProcessError):
                        commands.build(destination, 'node', 'electron')
            self.assertFalse(destination.exists())
            self.assertEqual(list(pathlib.Path(directory).iterdir()), [])

    def test_missing_inputs_fail_before_build(self):
        with patch.object(commands.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'NODE_DIST'):
                commands.build('/tmp/not-created', '', 'missing')
            run.assert_not_called()

    def test_run_uses_exact_artifact_and_preserves_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = pathlib.Path(directory) / 'App Image'
            artifact.write_text('#!/bin/sh\n')
            artifact.chmod(0o755)
            with patch.object(commands.subprocess, 'run') as run:
                commands.main(['run', str(artifact), 'design', 'argument with spaces'])
                run.assert_called_once_with([str(artifact), 'design', 'argument with spaces'], check=True)

    def test_test_checks_both_cli_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = pathlib.Path(directory) / 'image'
            artifact.touch(mode=0o755)
            with patch.object(commands.subprocess, 'run') as run:
                commands.main(['test', str(artifact)])
                self.assertEqual(run.call_count, 2)
                self.assertEqual(run.call_args.args[0], [str(artifact), 'capabilities', '--json'])

    def test_existing_output_never_starts_native_build(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(commands, 'inputs', return_value=('node', 'electron')), patch.object(commands.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'overwrite'):
                    commands.build(directory, 'node', 'electron')
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
