import importlib.util
import pathlib
import tempfile
import unittest
import json

spec = importlib.util.spec_from_file_location('verify', pathlib.Path(__file__).resolve().parents[1] / 'packaging/verify.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class ArtifactTest(unittest.TestCase):
    def test_integrity_and_nix_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            files = ['bin/awrit', 'lib/awrit/dist/browserOwner/main.js',
                     'lib/awrit/dist/terminal/main.js', 'lib/awrit/runtime/node/bin/node',
                     'lib/awrit/node_modules/awrit-native-rs/test.node']
            for name in files:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'test')
            def record():
                (root / 'manifest.json').write_text(json.dumps({'files': verify.inventory(root)}))
            record()
            verify.verify(root)
            binding = root / files[-1]
            binding.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'contents differ'):
                verify.verify(root)
            binding.write_bytes(b'/nix/store/builder-library')
            record()
            with self.assertRaisesRegex(ValueError, 'Nix dependency'):
                verify.verify(root)

    def test_internal_symlink_changes_affect_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'first').write_text('same')
            (root / 'second').write_text('same')
            link = root / 'link'
            link.symlink_to('first')
            recorded = verify.inventory(root)
            self.assertEqual(recorded['link'], 'symlink:first')
            link.unlink()
            link.symlink_to('second')
            self.assertNotEqual(verify.inventory(root), recorded)
            link.unlink()
            self.assertNotEqual(verify.inventory(root), recorded)
            link.symlink_to('missing')
            with self.assertRaisesRegex(ValueError, 'Broken symlink'):
                verify.inventory(root)

    def test_external_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'escape').symlink_to('../outside')
            with self.assertRaisesRegex(ValueError, 'Escaping symlink'):
                verify.inventory(root)

    def test_absolute_internal_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'target').write_text('x')
            (root / 'link').symlink_to(root / 'target')
            with self.assertRaisesRegex(ValueError, 'Absolute symlink'):
                verify.inventory(root)


if __name__ == '__main__':
    unittest.main()
