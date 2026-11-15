"""Frozen review of the originating Kitty split. No global remote control required."""
import os
import pathlib
import shutil
import signal
from contextlib import contextmanager
import subprocess
import tempfile
import time
from urllib.parse import quote

from kittens.tui.handler import kitten_ui, result_handler


@contextmanager
def cancellation_cleanup():
    def cancel(signum, frame):
        raise SystemExit(128 + signum)

    previous = {sig: signal.signal(sig, cancel) for sig in (signal.SIGHUP, signal.SIGTERM)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def launch_error(message, diagnostics):
    diagnostics.flush()
    size = os.fstat(diagnostics.fileno()).st_size
    detail = os.pread(diagnostics.fileno(), 4096, max(0, size - 4096)).decode(errors='replace').strip()
    return RuntimeError(message + ('\n' + detail if detail else ''))


@kitten_ui(allow_remote_control=True, remote_control_password='screenshot focus-window')
def main(args):
    source = os.environ.get('KITTY_OVERLAY_PARENT')
    # Kitty supplies the original window through this explicit argument.
    if len(args) > 1:
        source = args[1]
    if not source or not source.isdecimal() or int(source) <= 0:
        raise ValueError('Could not find the Kitty split')
    launcher = args[2] if len(args) > 2 else os.environ.get('AWRIT_LAUNCHER') or shutil.which('awrit')
    if not launcher:
        raise ValueError('awrit is not available; run awrit setup first')
    with cancellation_cleanup(), tempfile.TemporaryDirectory(prefix='awrit-review-') as directory:
        capture = pathlib.Path(directory) / 'capture.png'
        overlay = os.environ.get('KITTY_WINDOW_ID')
        focused = main.remote_control(['focus-window', '--match', 'id:' + source], capture_output=True, timeout=3)
        if focused.returncode:
            raise RuntimeError(focused.stderr.decode(errors='replace'))
        failure = None
        try:
            result = main.remote_control(['screenshot', '--match', 'id:' + source], capture_output=True, timeout=10)
            if result.returncode:
                raise RuntimeError(result.stderr.decode(errors='replace'))
        except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
            failure = str(error)
        finally:
            if overlay and overlay.isdecimal():
                try:
                    restored = main.remote_control(['focus-window', '--match', 'id:' + overlay], capture_output=True, timeout=3)
                    if restored.returncode:
                        raise RuntimeError(restored.stderr.decode(errors='replace'))
                except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
                    focus_failure = 'Could not restore Design focus: ' + str(error)
                    failure = failure + '\n' + focus_failure if failure else focus_failure
        if failure is not None:
            raise RuntimeError(failure)
        capture.write_bytes(result.stdout)
        target = 'awrit://terminal-review/' + source + '?image=' + quote(str(capture), safe='')
        ready = pathlib.Path(str(capture) + '.ready')
        environment = dict(os.environ)
        environment['AWRIT_SOURCE_WINDOW_ID'] = source
        if len(args) > 3:
            background = args[3]
            if len(background) != 7 or background[0] != '#' or any(c not in '0123456789abcdefABCDEF' for c in background[1:]):
                raise ValueError('Invalid Kitty background color')
            environment['AWRIT_TERMINAL_BACKGROUND'] = background.lower()
            channels = [int(background[i:i + 2], 16) / 255 for i in (1, 3, 5)]
            light = sum(c * weight for c, weight in zip(channels, (0.2126, 0.7152, 0.0722))) > 0.5
            environment['AWRIT_TERMINAL_SCHEME'] = 'light' if light else 'dark'
        diagnostics = (pathlib.Path(directory) / 'launcher.stderr').open('w+b')
        try:
            process = subprocess.Popen(
                [launcher, target, '--overlay', '--source-window-id', source],
                env=environment, stderr=diagnostics)
        except BaseException:
            diagnostics.close()
            raise
        try:
            deadline = time.monotonic() + 20
            while not ready.exists() and process.poll() is None:
                if time.monotonic() >= deadline:
                    stage = 'waiting for browser owner'
                    try:
                        stage = pathlib.Path(str(capture) + '.startup').read_text()[:160]
                    except OSError:
                        pass
                    raise launch_error('Review took too long to open. Try again.\nNative review startup: ' + stage, diagnostics)
                time.sleep(0.05)
            if not ready.exists():
                status = process.wait()
                if status:
                    raise launch_error(f'Review could not open (exit {status})', diagnostics)
                raise launch_error('Review closed before it became ready. Try again.', diagnostics)
            request = pathlib.Path(str(capture) + '.refresh')
            updated = pathlib.Path(str(capture) + '.updated')
            overlay = os.environ.get('KITTY_WINDOW_ID')
            while process.poll() is None:
                if request.exists() and overlay and overlay.isdecimal():
                    generation = request.read_text()
                    request.unlink(missing_ok=True)
                    ready.unlink(missing_ok=True)
                    error_path = pathlib.Path(str(capture) + '.error')
                    failure = None
                    try:
                        focused = main.remote_control(['focus-window', '--match', 'id:' + source], capture_output=True, timeout=3)
                        if focused.returncode:
                            raise RuntimeError(focused.stderr.decode(errors='replace'))
                        # One capture keeps the source exposed as briefly as possible;
                        # a second stability check doubled the visible blink.
                        refreshed = main.remote_control(['screenshot', '--match', 'id:' + source], capture_output=True, timeout=3)
                        if refreshed.returncode:
                            raise RuntimeError(refreshed.stderr.decode(errors='replace'))
                        temporary = capture.with_suffix('.next.png')
                        temporary.write_bytes(refreshed.stdout)
                        temporary.replace(capture)
                        marker = updated.with_suffix('.next')
                        marker.write_text(generation)
                        marker.replace(updated)
                    except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
                        failure = str(error)
                    finally:
                        try:
                            restored = main.remote_control(['focus-window', '--match', 'id:' + overlay], capture_output=True, timeout=3)
                            if restored.returncode:
                                raise RuntimeError(restored.stderr.decode(errors='replace'))
                        except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
                            focus_failure = 'Could not restore Design focus: ' + str(error)
                            failure = failure + '\n' + focus_failure if failure else focus_failure
                        # Restore the retained Design frame before waiting for
                        # Electron to decode and paint the replacement capture.
                        if failure is None:
                            deadline = time.monotonic() + 3
                            while process.poll() is None:
                                if ready.exists() and ready.read_text() == generation:
                                    break
                                if time.monotonic() >= deadline:
                                    failure = 'Resized review did not become ready.'
                                    break
                                time.sleep(0.01)
                        if failure:
                            destination = error_path
                            message = generation + '\n' + failure
                        else:
                            destination = pathlib.Path(str(capture) + '.done')
                            message = generation
                        marker = destination.with_suffix('.next')
                        marker.write_text(message)
                        marker.replace(destination)
                time.sleep(0.02)
            status = process.wait()
            if status:
                raise launch_error(f'Review could not open (exit {status})', diagnostics)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            diagnostics.close()


@result_handler(has_ready_notification=True)
def handle_result(args, answer, target_window_id, boss):
    pass
