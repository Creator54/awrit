"""Isolated live Kitty regression probe: slow navigation reuse.

Verifies that slow navigation (>1s) does not spawn a redundant second split
when an existing viewer accepted it.

Constraints:
- Isolated temporary HOME/XDG/userData/agent socket.
- Dedicated Kitty with allow_remote_control.
- Local HTTP endpoints: /initial and /slow2s.
- Spawns actual terminal client, then runs presentation CLI `show` targeting same source.
- Asserts that Kitty windows count remains 2 (not 3) and receipt records navigated URL.
- Cleans up only owned processes via private peer credentials / PID evidence.
"""
import os, sys, json, time, tempfile, subprocess, threading, http.server, signal, socket, shutil, struct
from pathlib import Path
from urllib.parse import urlparse

repo = Path(__file__).resolve().parents[1]

# Discover Electron
electron = os.environ.get('AWRIT_ELECTRON') or shutil.which('electron')
if not electron:
    nm_electron = repo / 'node_modules/electron/dist/electron'
    if nm_electron.is_file() and os.access(nm_electron, os.X_OK):
        electron = str(nm_electron)
    else:
        try:
            nix_out = subprocess.check_output(['nix-shell', 'shell.nix', '--run', 'which electron'], text=True).strip()
            if nix_out and Path(nix_out).is_file():
                electron = nix_out
        except Exception:
            pass

if not electron:
    sys.exit('Provide AWRIT_ELECTRON or electron in PATH / node_modules / nix-shell')

root = Path(tempfile.mkdtemp(prefix='awrit-nav-probe-', dir='/tmp'))
(root / 'home').mkdir()
(root / 'config').mkdir()
(root / 'data').mkdir()

# Local HTTP server with initial + slow2s
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/slow2s':
            time.sleep(2.0)
            body = b'<html><body style="background:#224422;color:white"><h1>SLOW 2S PAGE</h1></body></html>'
        else:
            body = b'<html><body style="background:#164965;color:white"><h1>INITIAL VIEWER</h1></body></html>'
        with open(root / 'http.log', 'a') as f:
            f.write(f"{self.path}\n")
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
port = httpd.server_port

agent_sock = root / 'agent.sock'
kitty_sock = root / 'kitty.sock'
endpoint = f'unix:{kitty_sock}'
process_log = open(root / 'process.log', 'w')

env = {k: v for k, v in os.environ.items() if not k.startswith(('KITTY_', 'AWRIT_'))}
env.update(
    HOME=str(root / 'home'),
    XDG_CONFIG_HOME=str(root / 'config'),
    XDG_DATA_HOME=str(root / 'data'),
    AWRIT_ELECTRON=electron,
    AWRIT_OWNER_ENTRY=str(repo / 'dist/browserOwner/main.js'),
    AWRIT_IPC_SOCKET=str(agent_sock),
)

kitty_proc = None
owner_pid = None

def get_peer_pid(sock_path):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2.0)
            s.connect(str(sock_path))
            cred = s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            pid, _, _ = struct.unpack('3i', cred)
            return pid
    except Exception:
        return None

try:
    kitty_proc = subprocess.Popen(
        [
            'kitty',
            '--config', 'NONE',
            '-o', 'allow_remote_control=yes',
            '-o', 'enabled_layouts=splits',
            '--listen-on', endpoint,
            'sh', '-c', 'sleep 180'
        ],
        env=env,
        stdout=process_log,
        stderr=process_log
    )

    def rc(*args, timeout=10):
        r = subprocess.run(['kitten', '@', '--to', endpoint, *args], capture_output=True, text=True, timeout=timeout)
        if r.returncode:
            raise RuntimeError(f"kitten @ error ({r.returncode}): {r.stderr}")
        return r.stdout

    # Wait for kitty to be responsive
    source = None
    for _ in range(60):
        try:
            ls_data = json.loads(rc('ls'))
            source = ls_data[0]['tabs'][0]['windows'][0]['id']
            break
        except Exception:
            time.sleep(0.1)

    if not source:
        raise RuntimeError("Failed to obtain initial Kitty source window")

    # Launch initial viewer terminal client in split
    viewer_wid = rc(
        'launch',
        f'--source-window=id:{source}',
        '--location=vsplit',
        'node', str(repo / 'dist/terminal/main.js'), f'http://127.0.0.1:{port}/initial'
    ).strip()

    # Wait for agent socket to appear and initial page to be requested
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if agent_sock.exists() and (root / 'http.log').exists():
            break
        time.sleep(0.1)

    # Get owner PID via SO_PEERCRED on agent socket for explicit scoped cleanup
    owner_pid = get_peer_pid(agent_sock)

    # Check window count: should be 2
    windows = json.loads(rc('ls'))[0]['tabs'][0]['windows']
    assert len(windows) == 2, f"Expected 2 windows after initial launch, found {len(windows)}"

    # Take baseline screenshot
    rc('screenshot', str(root / 'baseline-two-windows.png'))

    # Run presentation CLI show targeting slow endpoint
    show_env = dict(env)
    show_env.update(
        KITTY_LISTEN_ON=endpoint,
        KITTY_WINDOW_ID=str(source),
        AWRIT_LAUNCHER=str(repo / 'dist/terminal/main.js')
    )

    cmd = [
        'bun',
        str(repo / 'src/presentation/main.ts'),
        'show',
        f'http://127.0.0.1:{port}/slow2s',
        '--mode', 'split',
        '--json'
    ]

    show_result = subprocess.run(
        cmd,
        env=show_env,
        capture_output=True,
        text=True,
        timeout=15
    )

    (root / 'show_stdout.log').write_text(show_result.stdout)
    (root / 'show_stderr.log').write_text(show_result.stderr)

    # Take post-navigation screenshot
    rc('screenshot', str(root / 'post-navigation.png'))

    # Inspect current Kitty windows
    post_windows = json.loads(rc('ls'))[0]['tabs'][0]['windows']
    window_count = len(post_windows)

    # Parse JSON receipt from show
    receipt = {}
    try:
        receipt = json.loads(show_result.stdout.strip().splitlines()[-1])
    except Exception as e:
        print(f"Failed to parse receipt from stdout: {show_result.stdout} (err: {e})", file=sys.stderr)

    print(f"Show stdout: {show_result.stdout.strip()}")
    print(f"Show stderr: {show_result.stderr.strip()}")
    print(f"Windows count: {window_count} (expected 2)")
    print(f"Receipt: {receipt}")

    # Assertions
    assert window_count == 2, f"Window regression detected: expected 2 windows, but got {window_count} (a duplicate split was created!)"
    assert receipt.get('readiness') == 'navigated', f"Expected readiness 'navigated', got {receipt.get('readiness')}"
    assert '/slow2s' in receipt.get('url', ''), f"Expected url to contain '/slow2s', got {receipt.get('url')}"

    print("SUCCESS: Navigation reuse probe passed without spawning duplicate split.")

finally:
    # Dedicated kitty close first should detach/exit owner cleanly
    if kitty_proc is not None:
        kitty_proc.terminate()
        try:
            kitty_proc.wait(4)
        except subprocess.TimeoutExpired:
            kitty_proc.kill()
            kitty_proc.wait()

    # Clean up owner only if still running and confirmed via socket peer PID
    try:
        if owner_pid and get_peer_pid(agent_sock) == owner_pid:
            try:
                os.kill(owner_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    except Exception:
        pass

    httpd.shutdown()
    process_log.close()
    print('Probe Evidence Dir:', root, flush=True)
