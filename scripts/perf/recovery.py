"""Linux/X11-only: compare two paint.ts implementations in real Kitty. Requires Bun, Kitty,
Xvfb, xdotool and ImageMagick. NATIVE_MODULE_DIR points to a built native module.
Usage: python3 scripts/perf/recovery.py BASELINE_PAINT_TS CANDIDATE_PAINT_TS
Artifacts are retained in a temporary directory; no installed config is changed.
"""
import os
import pathlib
import shutil
import signal
import select
import re

CHECKPOINTS = ('partial', 'cover', 'uncover', 'suppression', 'shrink',
               *(f'motion-{i}' for i in range(6)))
import subprocess
import sys
import tempfile
import time


def wait_for(predicate, message, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise RuntimeError(message)


def run(source, root):
    root.mkdir()
    ready = root / 'ready'
    with (root / 'xvfb.log').open('w') as log:
        xv = subprocess.Popen([os.environ.get('XVFB_BIN', 'Xvfb'), '-displayfd', '1',
                               '-nolisten', 'tcp', '-screen', '0', '800x600x24', '-dpi', '96'],
                              stdout=subprocess.PIPE, stderr=log)
    kitty = None
    try:
        if not select.select([xv.stdout], [], [], 10)[0]:
            raise RuntimeError(f'Xvfb display allocation timed out: {root}/xvfb.log')
        number = xv.stdout.readline().decode().strip()
        if not number.isdigit():
            raise RuntimeError(f'Xvfb failed: {root}/xvfb.log')
        display = ':' + number
        env = dict(os.environ, DISPLAY=display, RECOVERY_READY=str(ready),
                   PAINT_SOURCE=str(source.resolve()))
        env.pop('WAYLAND_DISPLAY', None)
        with (root / 'kitty.log').open('w') as log:
            kitty = subprocess.Popen(['kitty', '--config', 'NONE', '--dump-bytes', str(root / 'wire.bin'),
                                      '-o', 'linux_display_server=x11', '-o', 'remember_window_size=no',
                                      '-o', 'cursor_blink_interval=0',
                                      '-o', 'initial_window_width=600', '-o', 'initial_window_height=500',
                                      'bun', str(pathlib.Path(__file__).with_suffix('.ts'))],
                                     env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        for name in CHECKPOINTS:
            marker = pathlib.Path(str(ready) + '.' + name)
            wait_for(lambda: marker.exists() or kitty.poll() is not None, f'Checkpoint timed out: {name}, {root}')
            if not marker.exists():
                raise RuntimeError(f'Driver exited before {name}: {root}/kitty.log')
            subprocess.run(['magick', 'import', '-window', 'root', str(root / f'{name}.png')], env=env, check=True)
            pathlib.Path(str(marker) + '.captured').touch()
        wait_for(lambda: ready.exists() or kitty.poll() is not None, f'No ready marker: {root}')
        if not ready.exists():
            raise RuntimeError(f'Driver exited early: {root}/kitty.log')
        ids = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--class', 'kitty'], env=env).split()
        if len(ids) != 1:
            raise RuntimeError(f'Expected one isolated Kitty X11 window, found {ids}')
        window = ids[0].decode()
        subprocess.run(['xdotool', 'windowsize', '--sync', window, '700', '550'], env=env, check=True)
        geometry = subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', window], env=env).decode()
        (root / 'geometry.txt').write_text(geometry)
        if 'WIDTH=700\n' not in geometry or 'HEIGHT=550\n' not in geometry:
            raise RuntimeError(f'Resize not confirmed: {geometry}')
        pathlib.Path(str(ready) + '.resized').touch()
        wait_for(lambda: pathlib.Path(str(ready) + '.refreshed').exists(), f'Refresh timed out: {root}')
        time.sleep(0.5)
        wire = (root / 'wire.bin').read_bytes()
        headers = re.findall(rb'\x1b_G([^;]+);', wire)
        if not any(b's=360' in header and b'v=260' in header for header in headers):
            raise RuntimeError('No post-resize graphics transfer in terminal wire output')
        subprocess.run(['magick', 'import', '-window', 'root', str(root / 'screen.png')], env=env, check=True)
    finally:
        if kitty is not None:
            try:
                os.killpg(kitty.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                kitty.wait(5)
            except subprocess.TimeoutExpired:
                os.killpg(kitty.pid, signal.SIGKILL)
                kitty.wait()
        xv.terminate()
        try:
            xv.wait(5)
        except subprocess.TimeoutExpired:
            xv.kill()
            xv.wait()


if __name__ == '__main__':
    if len(sys.argv) != 3 or not os.environ.get('NATIVE_MODULE_DIR'):
        sys.exit(__doc__)
    for tool in ('kitty', 'bun', 'xdotool', 'magick', os.environ.get('XVFB_BIN', 'Xvfb')):
        if not shutil.which(tool):
            sys.exit(f'Required executable not found: {tool}')
    root = pathlib.Path(tempfile.mkdtemp(prefix='awrit-recovery-'))
    print(f'Artifacts: {root}', flush=True)
    for label, source in zip(('full', 'candidate'), sys.argv[1:]):
        run(pathlib.Path(source), root / label)
    for name in (*CHECKPOINTS, 'screen'):
        result = subprocess.run(['magick', 'compare', '-metric', 'AE', str(root / f'full/{name}.png'),
                                 str(root / f'candidate/{name}.png'), str(root / f'{name}-difference.png')],
                                capture_output=True, text=True)
        if result.returncode != 0 or result.stderr.strip().split()[0:1] != ['0']:
            sys.exit(f'Pixel comparison failed at {name}: {result.stderr}')
    # Cover must actually change the visible state; matching blank runs are not evidence.
    transition = subprocess.run(['magick', 'compare', '-metric', 'AE', str(root / 'candidate/partial.png'),
                                 str(root / 'candidate/cover.png'), 'null:'], capture_output=True, text=True)
    if transition.returncode != 1:
        sys.exit('Cover transition was not visibly different, or comparison failed')
    motion_names = [name for name in CHECKPOINTS if name.startswith('motion-')]
    for previous, current in zip(motion_names, motion_names[1:]):
        moved = subprocess.run(['magick', 'compare', '-metric', 'AE',
                                str(root / f'candidate/{previous}.png'),
                                str(root / f'candidate/{current}.png'), 'null:'],
                               capture_output=True, text=True)
        try:
            changed_pixels = float(moved.stderr.strip().split()[0])
        except (ValueError, IndexError):
            sys.exit(f'Moving-block comparison failed: {moved.stderr}')
        if moved.returncode != 1 or changed_pixels < 200:
            sys.exit('Moving block produced fewer than 200 changed capture pixels, or comparison failed')
    colors = subprocess.check_output(['magick', str(root / 'candidate/screen.png'), '-format', '%k', 'info:'], text=True)
    if int(colors) < 3:
        sys.exit('Blank or nearly blank capture; cannot verify rendering')
    print('Twelve checkpoint comparisons: zero differing pixels; block visibly moved; final capture non-blank. Sampled motion only.')
