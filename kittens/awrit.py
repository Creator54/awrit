"""Kitty kitten: launch awrit via the normal launcher in a split/tab/overlay/window.

Usage in kitty.conf (not installed by this repo):
    map ctrl+shift+b kitten awrit.py split https://example.com
    map ctrl+shift+a kitten awrit.py tab device view SERIAL
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

MODES = {'split': 'window', 'tab': 'tab', 'overlay': 'overlay', 'window': 'os-window'}
USAGE = (
    'usage: kitten awrit.py <split|tab|overlay|window> (<url|html-file> | device view SERIAL)\n'
    'Run from a kitty mapping; standalone, run awrit directly instead.\n'
)
_CTRL = re.compile(r'[\x00-\x1f\x7f]')
_SERIAL = re.compile(r'[A-Za-z0-9._:\-]{1,128}')


def parse_args(args, cwd):
    """Return (mode, target_arg_list). Raises ValueError on bad input."""
    rest = list(args[1:]) if args and args[0] not in MODES else list(args)
    if not rest or rest[0] not in MODES:
        raise ValueError('first argument must be one of: ' + ', '.join(MODES))
    mode, rest = rest[0], rest[1:]
    if any(_CTRL.search(x) for x in rest):
        raise ValueError('control characters are not allowed')
    if len(rest) == 3 and rest[:2] == ['device', 'view']:
        if not _SERIAL.fullmatch(rest[2]) or rest[2].startswith('-'):
            raise ValueError('invalid device serial')
        return mode, rest
    if len(rest) != 1:
        raise ValueError('expected one target or device view SERIAL')
    t = rest[0]
    if t.startswith('-'):
        raise ValueError('target must not start with "-"')
    if '://' not in t:
        return mode, [_file_url(t, cwd)]
    u = urlsplit(t)
    if u.scheme == 'file':
        if u.netloc or u.query or u.fragment:
            raise ValueError('file URLs must be local, without host/query/fragment')
        return mode, [_file_url(unquote(u.path), cwd)]
    if u.scheme not in ('http', 'https') or not u.hostname:
        raise ValueError('only http, https, file URLs are allowed')
    if '@' in u.netloc:
        raise ValueError('credentials in URLs are not allowed')
    return mode, [t]


def _file_url(path, cwd):
    if _CTRL.search(path):
        raise ValueError('control characters are not allowed')
    p = Path(path).expanduser()
    if not p.is_absolute():
        if not cwd:
            raise ValueError('cannot resolve relative path: source cwd unknown')
        p = Path(cwd) / p
    p = p.resolve()
    if not p.is_file():
        raise ValueError(f'not a regular file: {p}')
    return p.as_uri()


def resolve_launcher(env):
    cand = env.get('AWRIT_LAUNCHER') or shutil.which('awrit')
    if not cand or not os.path.isabs(cand) or not os.access(cand, os.X_OK) or not os.path.isfile(cand):
        raise ValueError('awrit launcher not found; set AWRIT_LAUNCHER to an absolute executable path')
    return cand


def build_launch(source, mode, target, launcher):
    wid = f'id:{source.id}'
    cmd = ['launch', '--source-window', wid, '--match', f'window_id:{source.id}', '--next-to', wid,
           '--type=' + MODES[mode]]
    if mode != 'overlay':  # overlays are interactive: they take focus
        cmd += ['--keep-focus', '--spacing=padding=0', '--spacing=margin=0']
    if mode == 'split':
        cmd += ['--location=vsplit', '--bias=40']
    if source.cwd_of_child:
        cmd += ['--cwd', source.cwd_of_child]
    overlay_flags = ['--overlay'] if mode == 'overlay' else []
    return tuple(cmd + ['--', launcher] + target + overlay_flags)


_AWRIT_MAIN = ('/dist/terminal/main.js', '/src/terminal/main.ts')


def runs_awrit(cmdlines):
    return any(any(str(arg).endswith(_AWRIT_MAIN) for arg in (cmdline or ())) for cmdline in cmdlines)


def group_cmdlines(pid):
    """Command lines of the foreground job on the terminal that pid belongs to."""
    tpgid = int(subprocess.run(['ps', '-o', 'tpgid=', '-p', str(pid)], capture_output=True,
                               text=True, timeout=2, check=True).stdout)
    from kitty.child import cmdline_of_pid, processes_in_group
    return [cmdline_of_pid(p) for p in processes_in_group(tpgid)]


def tuios_pane(foreground, run=subprocess.run):
    """Find the focused pane when Kitty runs a TUIOS client.

    Kitty only sees the client, so ask the client's daemon which pane has focus.
    Returns None when no TUIOS client runs.
    """
    for process in foreground:
        cmdline = process.get('cmdline') or ()
        if len(cmdline) < 2 or os.path.basename(cmdline[0]) != 'tuios' or cmdline[1] not in ('new', 'attach'):
            continue
        from kitty.child import environ_of_process
        client_env = environ_of_process(process['pid'])
        tuios = shutil.which(cmdline[0], path=client_env.get('PATH')) or cmdline[0]
        env = {k: v for k, v in os.environ.items() if k != 'TUIOS_SERVER'}
        if client_env.get('TUIOS_SERVER'):
            env['TUIOS_SERVER'] = client_env['TUIOS_SERVER']
        def ask(*args):
            return json.loads(run([tuios, *args, '--json'], capture_output=True, text=True,
                                  timeout=2, check=True, env=env).stdout)
        # A client can switch sessions after it starts, so its argv may be stale.
        session = next((c['session'] for c in ask('list-clients')
                        if c.get('pid') == process['pid'] and c.get('session')), None)
        if session is None:
            return None
        listing = ask('list-windows', '-s', session)
        window = next(w for w in listing['windows'] if w.get('window_id') == listing.get('focused_window_id'))
        screen = next(s for s in ask('ls') if s.get('name') == session)
        return {'jobs': group_cmdlines(window['pid']), 'tuios': tuios, 'env': env, 'session': session,
                'window': window, 'columns': int(screen['width']), 'rows': int(screen['height'])}
    return None


def terminal_colors(background):
    """Review colours that match the source terminal's #rrggbb background."""
    if background is None:
        return {}
    if len(background) != 7 or background[0] != '#' or any(c not in '0123456789abcdefABCDEF' for c in background[1:]):
        raise ValueError('Invalid Kitty background color')
    channels = [int(background[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    light = sum(c * weight for c, weight in zip(channels, (0.2126, 0.7152, 0.0722))) > 0.5
    return {'AWRIT_TERMINAL_BACKGROUND': background.lower(), 'AWRIT_TERMINAL_SCHEME': 'light' if light else 'dark'}


def crop(pixels, image_width, image_height, box, columns, rows):
    """Cut the cell box (x, y, width, height) out of Kitty's bottom-up RGBA capture, top row first."""
    x, y, width, height = box
    if columns <= 0 or rows <= 0 or width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > columns or y + height > rows:
        raise ValueError('Invalid TUIOS pane: ' + repr((box, columns, rows)))
    left, right = x * image_width // columns * 4, (x + width) * image_width // columns * 4
    top, bottom = y * image_height // rows, (y + height) * image_height // rows
    stride = image_width * 4
    # Rows run bottom-up, so image row r is stored at image_height - 1 - r.
    out = [pixels[row * stride + left:row * stride + right]
           for row in reversed(range(image_height - bottom, image_height - top))]
    return out, (right - left) // 4, bottom - top


def png(rows, width, height):
    """Encode top-down RGBA rows as PNG.

    zlib level 1 is about three times faster than Kitty's encoder; the file is
    a temporary capture, so speed matters more than size.
    """
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    raw = b''.join(b'\0' + row for row in rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 1)) + chunk(b'IEND', b''))


def review_pane(boss, source, pane, launcher, extra_env, run=subprocess.run):
    """Freeze one TUIOS pane: a popup over that pane alone shows its capture.

    The popup keeps the pane's border, so the capture is the pane's inside.
    """
    window = pane['window']
    x, y, width, height = (int(window[k]) for k in ('x', 'y', 'width', 'height'))

    def captured(_os_window_id, _window_id, pixels, image_width, image_height):
        directory = None
        try:
            if not pixels:
                raise ValueError('Kitty returned no screenshot')
            encoded = png(*crop(pixels, image_width, image_height, (x + 1, y + 1, width - 2, height - 2),
                                pane['columns'], pane['rows']))
            directory = tempfile.mkdtemp(prefix='awrit-review-')
            image = os.path.join(directory, 'capture.png')
            with open(image, 'xb') as f:
                f.write(encoded)
            # Every pane shares this Kitty window, so the pane id names the review's source agent.
            pane_id = window['window_id']
            target = f'awrit://terminal-review/{pane_id}?image=' + quote(image, safe='')
            env = ['AWRIT_SOURCE_WINDOW_ID=' + pane_id, *(k + '=' + v for k, v in extra_env.items())]
            # The review exits on Escape or the design key; its capture goes with it.
            command = ['/bin/sh', '-c', 'trap \'rm -rf -- "$0"\' EXIT HUP INT TERM; env "$@"', directory, *env,
                       launcher, target, '--overlay', '--source-window-id', pane_id]
            run([pane['tuios'], 'popup', '-s', pane['session'], '--over', window['window_id'], '--dim', '0',
                 '--cwd', directory, '--', *command],
                capture_output=True, text=True, timeout=3, check=True, env=pane['env'])
        except Exception as error:  # Kitty's event loop drops callback errors silently.
            # After a timeout the popup may still start; its shell removes the capture.
            if directory and not isinstance(error, subprocess.TimeoutExpired):
                shutil.rmtree(directory, ignore_errors=True)
            detail = getattr(error, 'stderr', None) or str(error)
            if isinstance(detail, bytes):
                detail = detail.decode(errors='replace')
            boss.show_error('awrit', 'Could not open the pane review: ' + detail.strip())

    boss.request_thumbnail(source.os_window_id, captured, window_id=source.id, no_scaling=True)


def main(args):
    sys.stderr.write(USAGE)
    return ''


from kittens.tui.handler import result_handler  # noqa: E402


@result_handler(no_ui=True)
def handle_result(args, answer, target_window_id, boss):
    source = boss.window_id_map.get(target_window_id)
    if source is None:
        boss.show_error('awrit', 'source window not found')
        return
    try:
        env = getattr(getattr(source, 'child', None), 'environ', None) or {}
        launcher = resolve_launcher(env)
        command = list(args)
        if command and command[0].endswith('.py'):
            command.pop(0)
        if command and command[0] == 'design':
            helper = str(Path(args[0]).with_name('awrit_design.py'))
            # Kitty consumes the global shortcut before the review can see it.
            # Identify our helper by argv: overlay_for is not exposed on all Kitty versions.
            if helper in getattr(source.child, 'cmdline', getattr(source.child, 'argv', ())):
                source.write_to_child(b'\x1b')
                return
            if getattr(source, 'overlay_for', None) is not None:
                return
            design_key = 'alt+d'
            if len(command) >= 3 and command[-2] == '--key':
                design_key = command[-1]
                command = command[:-2]
            if len(command) > 2:
                raise ValueError('design takes no target')
            # Inspect the foreground job, not the shell's initial argv or title.
            # A global Kitty mapping otherwise steals the browser's own toggle.
            foreground = getattr(source.child, 'foreground_processes', ())
            if runs_awrit(process.get('cmdline') for process in foreground):
                source.send_key(design_key)
                return
            review_launcher = command[1] if len(command) == 2 else launcher
            background = None
            profile = getattr(getattr(source, 'screen', None), 'color_profile', None)
            if profile is not None:
                background = profile.default_bg
                if not background:
                    from kitty.fast_data_types import get_options
                    background = get_options().background
                background = background.as_sharp
            try:
                pane = tuios_pane(foreground)
            except (OSError, ValueError, KeyError, TypeError, ImportError, StopIteration, subprocess.SubprocessError) as error:
                raise ValueError('Could not find the focused TUIOS pane: ' + str(error))
            if pane is not None:
                if runs_awrit(pane['jobs']):
                    source.send_key(design_key)
                else:
                    review_pane(boss, source, pane, review_launcher, terminal_colors(background))
                return
            review_args = [str(target_window_id), review_launcher]
            if background is not None:
                review_args.append(background)
            # Kitty overlays share their source's cell grid. Expand that grid
            # for review, then restore the exact overrides (including defaults).
            padding = source.padding.serialize()
            def restore_padding(*_):
                if boss.window_id_map.get(target_window_id) is source:
                    values = ['padding-' + edge + '=' + ('default' if value is None else str(value))
                              for edge, value in padding.items()]
                    try:
                        boss.call_remote_control(source, ('set-spacing', '--match', 'id:' + str(target_window_id), *values))
                    except Exception as error:
                        boss.show_error('awrit', 'Could not restore source padding: ' + str(error))
            try:
                boss.call_remote_control(source, ('set-spacing', '--match', 'id:' + str(target_window_id), 'padding=0'))
                overlay = boss.run_kitten_with_metadata(
                    helper, review_args, window=source, action_on_removal=restore_padding)
                if overlay is None:
                    restore_padding()
            except Exception:
                restore_padding()
                raise
            return
        mode, target = parse_args(args, source.cwd_of_child)
        if mode == 'split':
            tab = source.tabref()
            if getattr(getattr(tab, 'current_layout', None), 'name', None) != 'splits':
                raise ValueError('split needs the "splits" layout; use tab, overlay or window')
        boss.call_remote_control(source, build_launch(source, mode, target, launcher))
    except ValueError as e:
        boss.show_error('awrit', str(e))
