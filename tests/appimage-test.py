import pathlib
import importlib.util
import json
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'packaging'))
from verify import inventory
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'packaging/appimage.py'


class AppImageTest(unittest.TestCase):
    def test_help(self):
        result = subprocess.run(['python3', str(SCRIPT), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('appimagetool', result.stdout)

    def test_stages_apprun_and_preserves_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            payload = root / 'payload'
            files = ['bin/awrit', 'lib/awrit/dist/browserOwner/main.js', 'lib/awrit/dist/terminal/main.js', 'lib/awrit/runtime/node/bin/node', 'lib/awrit/node_modules/awrit-native-rs/test.node']
            for name in files:
                path = payload / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('test')
            launcher = payload / 'bin/awrit'
            launcher.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            launcher.chmod(0o755)
            (payload / 'lib/awrit/build.json').write_text(json.dumps({'platform': 'linux', 'arch': 'x64'}))
            (payload / 'manifest.json').write_text(json.dumps({'files': inventory(payload)}))
            tool = root / 'tool'
            tool.write_text('#!/bin/sh\nset -eu\n"$3/AppRun" show "a b" > "$4"\n')
            tool.chmod(0o755)
            output = root / 'Awrit.AppImage'
            result = subprocess.run(['python3', str(SCRIPT), str(payload), str(output), '--appimagetool', str(tool), '--runtime-file', str(tool)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_text(), 'show\na b\n')
            self.assertTrue(pathlib.Path(str(output) + '.sha256').is_file())

    def test_nonexistent_payload_fails_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'Awrit.AppImage'
            result = subprocess.run(['python3', str(SCRIPT), str(pathlib.Path(directory) / 'absent'), str(output), '--appimagetool', '/absent'], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
