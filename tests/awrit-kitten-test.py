import ast, json, sys, types, tempfile, unittest, importlib.util, os
from urllib.parse import unquote
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / 'kittens' / 'awrit.py').read_text()
ast.parse(SRC)  # syntax check without writing pycache

# Fake kitty modules so the kitten imports outside kitty.
tui = types.ModuleType('kittens.tui.handler')
tui.result_handler = lambda **kw: (lambda f: types.SimpleNamespace(impl=f, **kw))
for n in ('kittens', 'kittens.tui'):
    sys.modules[n] = types.ModuleType(n)
sys.modules['kittens.tui.handler'] = tui
mod = types.ModuleType('awrit_kitten')
exec(compile(SRC, 'awrit.py', 'exec'), mod.__dict__)


class Win:
    id = 7
    cwd_of_child = '/work'
    def __init__(self, layout='splits', env=None):
        self.child = types.SimpleNamespace(environ=env or {})
        self.padding = types.SimpleNamespace(serialize=lambda: dict(left=None, right=3, top=4, bottom=None))
        self.tabref = lambda: types.SimpleNamespace(current_layout=types.SimpleNamespace(name=layout))


class Boss:
    def __init__(self, win=None):
        self.window_id_map = {7: win} if win else {}
        self.calls, self.errors = [], []
    def call_remote_control(self, w, a): self.calls.append((w, a))
    def show_error(self, *a): self.errors.append(a)
    def run_kitten_with_metadata(self, kitten, args, window=None, action_on_removal=None):
        self.calls.append((window, (kitten, *args)))


class T(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        d = os.path.realpath(self.temp.name)
        self.exe = os.path.join(d, 'awrit')
        Path(self.exe).write_text('#!/bin/sh\n')
        os.chmod(self.exe, 0o755)
        self.html = os.path.join(d, 'a.html')
        Path(self.html).write_text('x')
        self.env = {'AWRIT_LAUNCHER': self.exe}

    def run_h(self, args, win=None):
        b = Boss(win); mod.handle_result.impl(args, '', 7, b); return b

    def test_design_restores_padding_on_overlay_close(self):
        w = Win(env=self.env)
        b = Boss(w)
        callbacks = []
        def launch(*a, **kw):
            callbacks.append(kw['action_on_removal'])
            return object()
        b.run_kitten_with_metadata = launch
        mod.handle_result.impl(['awrit.py', 'design'], '', 7, b)
        self.assertEqual(b.calls[0][1][-1], 'padding=0')
        callbacks[0](7, b)
        self.assertEqual(b.calls[-1][1][3:], ('padding-left=default', 'padding-right=3', 'padding-top=4', 'padding-bottom=default'))

    def test_design_restores_padding_on_launch_failure(self):
        w = Win(env=self.env)
        b = Boss(w)
        def fail(*a, **kw):
            raise ValueError('launch failed')
        b.run_kitten_with_metadata = fail
        mod.handle_result.impl(['awrit.py', 'design'], '', 7, b)
        self.assertEqual(len(b.calls), 2)
        self.assertIn('padding-left=default', b.calls[-1][1])
        self.assertTrue(b.errors)

    def test_no_ui_and_main_safe(self):
        self.assertTrue(mod.handle_result.no_ui)
        mod.main(['x'])  # prints usage, no Boss needed

    def test_split_url(self):
        w = Win(env=self.env); b = self.run_h(['awrit.py', 'split', 'https://e.com'], w)
        (src, a), = b.calls
        self.assertIs(src, w)
        self.assertIn('--keep-focus', a); self.assertIn('--bias=40', a); self.assertIn('--location=vsplit', a)
        self.assertIn('window_id:7', a)
        self.assertEqual(a[a.index('--') + 1:], (self.exe, 'https://e.com'))
        self.assertEqual(a[a.index('--cwd') + 1], '/work')
        self.assertFalse(any(x.startswith('goto') for x in a))

    def test_non_splits_fallback_and_modes(self):
        b = self.run_h(['split', self.html], Win('tall', self.env))
        self.assertEqual(b.calls, []); self.assertTrue(b.errors)  # explicit split is rejected, not downgraded
        for m, t in (('tab', 'tab'), ('overlay', 'overlay'), ('window', 'os-window')):
            b = self.run_h([m, 'http://x.io'], Win('tall', self.env))
            a = b.calls[0][1]
            self.assertEqual(len(b.calls), 1)  # one launch; never a follow-up spacing/recent:N action
            self.assertFalse(any('set-spacing' in x or 'recent:' in x for x in a))
            self.assertIn('--type=' + t, a)
            self.assertNotIn('--bias=40', a)
            self.assertEqual('--keep-focus' in a, m != 'overlay')
            self.assertEqual('--spacing=padding=0' in a, m != 'overlay')
            self.assertEqual('--spacing=margin=0' in a, m != 'overlay')
            self.assertEqual('--overlay' in a, m == 'overlay')

    def test_file_escaped_and_source_cwd(self):
        d = os.path.realpath(os.path.dirname(self.html))
        w = Win(env=self.env); w.cwd_of_child = d
        open(os.path.join(d, 'a b.html'), 'w').close()
        for t in ('a b.html', 'file://' + d.replace(' ', '%20') + '/a%20b.html'):
            a = self.run_h(['tab', t], w).calls[0][1]
            self.assertEqual(a[-1], Path(d, 'a b.html').resolve().as_uri())
            self.assertEqual(a[a.index('--cwd') + 1], d)
        w.cwd_of_child = None
        self.assertEqual(self.run_h(['tab', 'a b.html'], w).calls, [])

    def test_credentials_host_control(self):
        for t in ('http://u:p@x.io/', 'https://u@x.io', 'file://host/etc/passwd', 'file:///etc/passwd?x=1',
                  'http://x.io/\nfoo', 'http://', self.html + '\x1b'):
            b = self.run_h(['tab', t], Win(env=self.env))
            self.assertEqual(b.calls, [], t); self.assertTrue(b.errors, t)

    def test_device(self):
        a = self.run_h(['tab', 'device', 'view', 'emulator-5554'], Win(env=self.env)).calls[0][1]
        self.assertEqual(a[-3:], ('device', 'view', 'emulator-5554'))

    def test_rejects(self):
        for args in (['split', 'javascript:alert(1)'], ['split', 'ftp://x/y'], ['split', '/nonexistent'],
                     ['split', 'device', 'view', '-x'], ['bogus', 'http://x.io'], ['split', '--evil'], ['split']):
            b = self.run_h(args, Win(env=self.env))
            self.assertEqual(b.calls, [], args); self.assertTrue(b.errors, args)

    def test_design_uses_origin_and_does_not_stack_overlays(self):
        win = Win(env=self.env)
        boss = self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design'], win)
        self.assertEqual(len(boss.calls), 3)
        self.assertEqual(boss.calls[1][1][-2:], ('7', self.env['AWRIT_LAUNCHER']))
        explicit = self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design', '/chosen/awrit'], win)
        self.assertEqual(explicit.calls[1][1][-2:], ('7', '/chosen/awrit'))
        self.assertTrue(boss.calls[1][1][0].endswith('awrit_design.py'))
        win.overlay_for = 7
        self.assertEqual(self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design'], win).calls, [])
        sent = []
        win.write_to_child = sent.append
        win.child.argv = ('kitty', '+runpy', str(ROOT / 'kittens' / 'awrit_design.py'), '7', '/test/awrit')
        self.assertEqual(self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design'], win).calls, [])
        self.assertEqual(sent, [b'\x1b'])
        del win.overlay_for
        win.child.cmdline = win.child.argv
        win.child.argv = ('kitty',)
        sent.clear()
        self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design'], win)
        self.assertEqual(sent, [b'\x1b'])
        win.overlay_for = 7
        sent.clear()
        win.child.argv = ('kitty', 'unrelated_overlay.py')
        win.child.cmdline = win.child.argv
        self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design'], win)
        self.assertEqual(sent, [])

    def test_design_forwards_to_foreground_awrit(self):
        win = Win(env=self.env)
        sent = []
        win.send_key = sent.append
        win.child.foreground_processes = [{'cmdline': ['node', '/package/dist/terminal/main.js', 'https://example.com']}]
        boss = self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design', '--key', 'ctrl+shift+d'], win)
        self.assertEqual(boss.calls, [])
        self.assertEqual(sent, ['ctrl+shift+d'])
        win.child.foreground_processes = [{'cmdline': None}, {'cmdline': ['bun', '/repo/src/terminal/main.ts']}]
        sent.clear()
        self.assertEqual(self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design'], win).calls, [])
        self.assertEqual(sent, ['alt+d'])
        win.child.foreground_processes = [{'cmdline': ['fish']}]
        win.child.cmdline = ['node', '/package/dist/terminal/main.js']
        sent.clear()
        boss = self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design'], win)
        self.assertEqual(sent, [])
        self.assertEqual(len(boss.calls), 3)

    def test_design_passes_source_background(self):
        win = Win(env=self.env)
        win.screen = types.SimpleNamespace(color_profile=types.SimpleNamespace(default_bg=types.SimpleNamespace(as_sharp='#282a36')))
        boss = self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design'], win)
        self.assertEqual(boss.calls[1][1][-1], '#282a36')

    def test_design_reviews_only_the_focused_tuios_pane(self):
        child = types.ModuleType('kitty.child')
        child.environ_of_process = lambda pid: {'TUIOS_SERVER': 'work', 'PATH': os.path.dirname(self.exe)}
        fdt = types.ModuleType('kitty.fast_data_types')
        # The fake encoder flips Kitty's bottom-up rows the way the real one does.
        fdt.png_from_32bit_rgba_data = lambda data, w, h, flip: b''.join(
            data[r * w * 4:(r + 1) * w * 4] for r in reversed(range(h))) + bytes([w, h])
        sys.modules['kitty'] = types.ModuleType('kitty')
        sys.modules['kitty.child'] = child; sys.modules['kitty.fast_data_types'] = fdt
        for name in ('kitty.fast_data_types', 'kitty.child', 'kitty'):
            self.addCleanup(sys.modules.pop, name)
        tuios = os.path.join(os.path.dirname(self.exe), 'tuios')
        Path(tuios).write_text('#!/bin/sh\n'); os.chmod(tuios, 0o755)
        self.addCleanup(setattr, mod, 'group_cmdlines', mod.group_cmdlines)
        jobs = {2: [['fish']]}
        mod.group_cmdlines = lambda pid: jobs[pid]
        calls = []
        def run(cmd, **kw):
            calls.append(cmd)
            self.assertEqual(kw['env'].get('TUIOS_SERVER'), 'work')
            out = {'list-clients': [{'pid': 9, 'session': ''}, {'pid': 9, 'session': 'moved'}],
                   'list-windows': {'focused_window_id': 'b', 'windows': [
                       {'window_id': 'a', 'pid': 1}, {'window_id': 'b', 'pid': 2, 'x': 1, 'y': 0, 'width': 3, 'height': 2}]},
                   'ls': [{'name': 'moved', 'width': 4, 'height': 2}]}.get(cmd[1], {})
            if cmd[1] == 'popup':
                self.image = Path(unquote(cmd[-4].split('image=')[1]))
                self.assertEqual(self.image.read_bytes(), bytes(range(80, 88)) + bytes(range(48, 56)) + bytes([2, 2]))
            return types.SimpleNamespace(stdout=json.dumps(out))
        foreground = [{'pid': 9, 'cmdline': ['tuios', 'new', 'stale-name']}]
        pane = mod.tuios_pane(foreground, run)
        self.assertEqual((pane['session'], pane['jobs'], pane['window']['window_id']), ('moved', [['fish']], 'b'))
        self.assertIsNone(mod.tuios_pane([{'pid': 9, 'cmdline': ['fish']}], run))

        boss = Boss(); shots = []
        boss.request_thumbnail = lambda os_id, cb, window_id, no_scaling: shots.append((window_id, cb))
        source = types.SimpleNamespace(id=7, os_window_id=1)
        # An 8x4 pixel capture of a 4x4 cell grid, stored bottom-up, one byte per channel index.
        # Without its border the pane's inside is cell column 2, rows 1-2: pixel rows 1-2.
        pane['window'].update(x=1, y=0, width=3, height=4); pane['rows'] = 4
        mod.review_pane(boss, source, pane, self.exe, {'AWRIT_TERMINAL_SCHEME': 'dark'}, run)
        self.assertEqual(shots[0][0], 7)
        shots[0][1](1, 7, bytes(range(128)), 8, 4)
        self.assertEqual(boss.errors, [])
        popup = calls[-1]
        self.assertEqual(popup[:8], [tuios, 'popup', '-s', 'moved', '--over', 'b', '--dim', '0'])
        self.assertIn('AWRIT_SOURCE_WINDOW_ID=b', popup); self.assertIn('AWRIT_TERMINAL_SCHEME=dark', popup)
        self.assertEqual(popup[-2:], ['--source-window-id', 'b'])
        self.assertIn('awrit://terminal-review/b?image=', popup[-4])

        def refuse(cmd, **kw):
            raise mod.subprocess.CalledProcessError(1, cmd, stderr='no window')
        self.addCleanup(__import__('shutil').rmtree, self.image.parent)
        before = set(os.listdir(tempfile.gettempdir()))
        mod.review_pane(boss, source, pane, self.exe, {}, refuse)
        shots[1][1](1, 7, bytes(range(128)), 8, 4)
        self.assertIn('no window', boss.errors[0][1])
        self.assertEqual(set(os.listdir(tempfile.gettempdir())) - before, set())
        self.assertRaises(ValueError, mod.crop, b'', 8, 4, (0, 0, 5, 1), 4, 2)
        # 7x5 pixels on a 3x2 grid: cell edges round down to pixels.
        out, w, h = mod.crop(bytes(range(140)), 7, 5, (1, 1, 1, 1), 3, 2)
        self.assertEqual((w, h), (2, 3))
        self.assertEqual(out, b''.join(bytes(range(r * 28 + 8, r * 28 + 16)) for r in range(0, 3)))

    def test_design_in_tuios_awrit_pane_sends_its_key(self):
        win = Win(env=self.env)
        win.child.foreground_processes = [{'pid': 9, 'cmdline': ['tuios', 'new', 'x']}]
        sent = []; win.send_key = sent.append
        self.addCleanup(setattr, mod, 'tuios_pane', mod.tuios_pane)
        mod.tuios_pane = lambda fg: {'jobs': [['node', '/p/dist/terminal/main.js']]}
        self.assertEqual(self.run_h([str(ROOT / 'kittens' / 'awrit.py'), 'design'], win).calls, [])
        self.assertEqual(sent, ['alt+d'])

    def test_source_missing_and_no_launcher(self):
        b = self.run_h(['split', 'http://x.io'], None)
        self.assertEqual(b.calls, []); self.assertTrue(b.errors)
        env = {'AWRIT_LAUNCHER': 'relative/awrit'}
        b = self.run_h(['split', 'http://x.io'], Win(env=env))
        self.assertEqual(b.calls, [])

if __name__ == '__main__':
    unittest.main()
