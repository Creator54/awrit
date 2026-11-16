import os, pathlib, tempfile, subprocess, json, time, sys, shutil, shlex, socket, select

PAGES = pathlib.Path(__file__).resolve().parent
TB = os.environ.get('TB_BIN', 'terminal-browser')
AWRIT = os.environ.get('AWRIT_BIN', 'awrit')
SECS = int(os.environ.get('SECS', '12'))
which = sys.argv[1]  # tb | awrit
page = sys.argv[2]   # static | anim | scroll

root = pathlib.Path(tempfile.mkdtemp(prefix=f'bench-{which}-{page}-'))
home = root / 'home'; home.mkdir()
runtime = root / 'runtime'; runtime.mkdir(mode=0o700)
xvfb = subprocess.Popen([os.environ.get('XVFB_BIN', shutil.which('Xvfb') or 'Xvfb'), '-displayfd', '1', '-screen', '0', '1600x1000x24', '-dpi', '96'],
                        stdout=subprocess.PIPE, stderr=(root / 'xvfb.log').open('w'))
if not select.select([xvfb.stdout], [], [], 10)[0]:
    xvfb.terminate()
    try: xvfb.wait(5)
    except subprocess.TimeoutExpired:
        xvfb.kill(); xvfb.wait()
    raise RuntimeError(f'Xvfb display allocation timed out; see {root}/xvfb.log')
display_number = xvfb.stdout.readline().decode().strip()
if not display_number.isdigit():
    xvfb.terminate()
    try: xvfb.wait(5)
    except subprocess.TimeoutExpired:
        xvfb.kill(); xvfb.wait()
    raise RuntimeError(f'Xvfb failed before display allocation; see {root}/xvfb.log')
display = ':' + display_number
env = dict(os.environ, DISPLAY=display, HOME=str(home), XDG_RUNTIME_DIR=str(runtime), XDG_CONFIG_HOME=str(home / 'c'), XDG_DATA_HOME=str(home / 'd'),
           XDG_CACHE_HOME=str(home / 'k'), XDG_STATE_HOME=str(home / 's'), WAYLAND_DISPLAY='', XDG_SESSION_TYPE='x11',
           ELECTRON_OZONE_PLATFORM_HINT='x11', TERMINAL_BROWSER_NO_TELEMETRY='1', DO_NOT_TRACK='1')
env.pop('WAYLAND_DISPLAY', None)
trace = root / 'trace.jsonl'
env['AWRIT_TRACE_FRAMES'] = str(trace)
url = f'file://{PAGES}/{page}.html'
with socket.socket() as port_probe:
    port_probe.bind(('127.0.0.1', 0))
    debug_port = port_probe.getsockname()[1]
cmd = shlex.join([TB, 'open', url] if which == 'tb' else [AWRIT, f'--debug-port={debug_port}', url])
dump = root / 'wire.bin'
kitty = subprocess.Popen(['kitty', '--dump-bytes', str(dump), '--config', 'NONE', '-o', 'linux_display_server=x11', '-o', 'allow_remote_control=yes',
                          '-o', 'remember_window_size=no', '-o', 'initial_window_width=1400', '-o', 'initial_window_height=900',
                          'sh', '-c', cmd], env=env, stdout=(root / 'kitty.log').open('w'), stderr=subprocess.STDOUT)

def tree_cpu():
    rows = {}
    for d in os.listdir('/proc'):
        if not d.isdigit(): continue
        try:
            t = open(f'/proc/{d}/stat').read()
            f = t[t.rindex(')') + 2:].split()
            rows[int(d)] = (int(f[1]), int(f[11]) + int(f[12]), int(f[21]) * 4096 // 1048576)
        except Exception: pass
    kids = {}
    for pid, (pp, *_r) in rows.items(): kids.setdefault(pp, []).append(pid)
    todo = list(kids.get(kitty.pid, [])); seen = []
    while todo:
        x = todo.pop(); seen.append(x); todo += kids.get(x, [])
    return sum(rows[x][1] for x in seen if x in rows), sum(rows[x][2] for x in seen if x in rows), len(seen)

def kitty_cpu():
    s = open(f'/proc/{kitty.pid}/stat').read().split()
    return int(s[13]) + int(s[14])

try:
    # Shared-memory commands are small even for a complete static page.
    t0 = time.monotonic(); first = None
    while time.monotonic() - t0 < 60:
        if dump.exists() and b'a=c,' in dump.read_bytes():
            first = time.monotonic() - t0; break
        if kitty.poll() is not None:
            raise RuntimeError(f'Kitty exited before graphics output; see {root}/kitty.log')
        time.sleep(0.05)
    if first is None:
        raise RuntimeError(f'No graphics output within 60 seconds; see {root}/kitty.log')
    time.sleep(3)  # settle
    if page == 'static':
        # Startup repaints may arrive after initial navigation. Require a quiet window.
        deadline = time.monotonic() + 15
        quiet_since = time.monotonic()
        previous_size = dump.stat().st_size
        while time.monotonic() - quiet_since < 3:
            if time.monotonic() > deadline:
                raise RuntimeError(f'Static page did not settle; see {root}')
            time.sleep(0.1)
            size = dump.stat().st_size
            if size != previous_size:
                quiet_since = time.monotonic()
                previous_size = size
    trace_start = len(trace.read_text().splitlines()) if trace.exists() else 0
    b0 = dump.stat().st_size if dump.exists() else 0
    o0 = b0
    c0, _, _ = tree_cpu(); k0 = kitty_cpu(); w0 = time.monotonic()
    time.sleep(SECS)
    if kitty.poll() is not None or xvfb.poll() is not None:
        raise RuntimeError(f'Benchmark display exited during measurement; see {root}')
    b1 = dump.stat().st_size if dump.exists() else 0
    c1, rss, n = tree_cpu(); k1 = kitty_cpu(); w1 = time.monotonic()
    import re
    raw = open(dump,'rb').read()[o0:b1]
    ncmd = len(re.findall(rb'\x1b_G', raw))
    tick = os.sysconf('SC_CLK_TCK'); dt = w1 - w0
    print(json.dumps({'tool': which, 'page': page, 'first_composite_s': None if first is None else round(first, 2),
                      'gfx_cmds_per_s': round(ncmd / (w1 - w0), 1), 'bytes_per_s_to_terminal': round((b1 - b0) / dt), 'app_cpu_pct': round((c1 - c0) / tick / dt * 100, 1),
                      'kitty_cpu_pct': round((k1 - k0) / tick / dt * 100, 1), 'app_rss_mb': rss, 'procs': n}))
    if which == 'awrit' and trace.exists():
        # A writer may still be appending the final line; only read complete records.
        lines = [json.loads(l) for l in trace.read_text().splitlines(keepends=True) if l.endswith('\n') and l.strip()]
        # The first new bucket overlaps settling; keep only complete buckets.
        window = lines[trace_start:]
        durations = [(b['t'] - a['t']) / 1000 for a, b in zip(window, window[1:])]
        lines = window[1:]
        if not lines and page == 'static':
            print(json.dumps({'trace_path': str(trace), 'trace_buckets': 0,
                              'graphics_commands_in_window': ncmd,
                              'metric': 'static CPU window; insufficient latency samples, not a missing-render failure'}))
        elif not lines:
            raise RuntimeError(f'No complete trace buckets during measurement; see {trace}')
        if not lines:
            sys.exit(0)
        import statistics
        def med(k, f):
            return statistics.median(l[k][f] for l in lines)
        elapsed = sum(durations)
        print(json.dumps({'trace_path': str(trace), 'trace_buckets': len(lines),
                          'trace_elapsed_s': round(elapsed, 3),
                          'paint_callbacks_per_s': round(sum(l['frames'] for l in lines) / elapsed, 2),
                          'paint_skips_per_s': round(sum(l['skipped'] for l in lines) / elapsed, 2),
                          'metric': 'paint callbacks, not presentation FPS; complete trace buckets within CPU window',
                          'latency_summary': 'median of per-bucket percentiles, not pooled percentiles',
                          **{f'{k}_p50_p95_ms': [med(k,'p50'), med(k,'p95')] for k in ('toBitmap','write','emit','total','ack')}}))
finally:
    kitty.terminate()
    try: kitty.wait(5)
    except Exception: kitty.kill()
    subprocess.run(['pkill', '-f', str(root)], check=False)
    xvfb.terminate()
