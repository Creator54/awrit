"""Kitty kitten: launch awrit via the normal launcher in a split/tab/overlay/window.

Usage in kitty.conf (not installed by this repo):
    map ctrl+shift+b kitten awrit.py split https://example.com
    map ctrl+shift+a kitten awrit.py tab device view SERIAL
"""
import os
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

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
            if any(any(str(arg).endswith(('/dist/terminal/main.js', '/src/terminal/main.ts')) for arg in (process.get('cmdline') or ())) for process in foreground):
                source.send_key(design_key)
                return
            review_launcher = command[1] if len(command) == 2 else launcher
            review_args = [str(target_window_id), review_launcher]
            profile = getattr(getattr(source, 'screen', None), 'color_profile', None)
            if profile is not None:
                background = profile.default_bg
                if not background:
                    from kitty.fast_data_types import get_options
                    background = get_options().background
                review_args.append(background.as_sharp)
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
