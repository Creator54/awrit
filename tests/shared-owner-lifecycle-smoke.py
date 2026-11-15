"""Real Electron lifecycle checks. Build dist/browserOwner/main.js first.

Run with AWRIT_ELECTRON pointing to Electron, or electron available on PATH.
Uses disposable storage; never touches the installed Awrit profile.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[1]
entry = repo / 'dist/browserOwner/main.js'
electron = os.environ.get('AWRIT_ELECTRON') or shutil.which('electron')
if not electron or not entry.is_file():
    raise SystemExit('Build owner bundle and provide AWRIT_ELECTRON or electron on PATH')
if os.uname().sysname != 'Linux':
    raise SystemExit('This lifecycle smoke currently verifies Linux only')
root = Path(tempfile.mkdtemp(prefix='awrit-owner-lifecycle-'))
print(root, flush=True)
env = dict(os.environ, HOME=str(root), XDG_CONFIG_HOME=str(root / 'config'),
           XDG_DATA_HOME=str(root / 'data'), AWRIT_IPC_SOCKET=str(root / 'agent.sock'))
identity = hashlib.sha256(str(root / 'data/awrit').encode()).hexdigest()[:20]
transport_dir = Path(os.environ.get('XDG_RUNTIME_DIR') or tempfile.gettempdir())
transport = transport_dir / f'awrit-owner-{os.getuid()}-{identity}' / 'terminal.sock'
children = []
log = open(root / 'owner.log', 'w')


def launch():
    child = subprocess.Popen([electron, str(entry), '--debug-port=disabled'], env=env,
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    children.append(child)
    return child


def connect():
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        peer = socket.socket(socket.AF_UNIX)
        peer.settimeout(3)
        try:
            peer.connect(str(transport))
            return peer
        except (FileNotFoundError, ConnectionRefusedError):
            peer.close()
            time.sleep(.05)
    raise AssertionError(f'Owner not ready; see {root / "owner.log"}')


def reject(payload):
    with connect() as peer:
        body = b'\x01' + json.dumps(payload).encode()
        peer.sendall(struct.pack('>I', len(body)) + body)

        def read(count):
            data = b''
            while len(data) < count:
                chunk = peer.recv(count - len(data))
                assert chunk, 'Early EOF'
                data += chunk
            return data

        length = struct.unpack('>I', read(4))[0]
        assert 1 < length <= 65537, length
        frame = read(length)
        assert frame[0] == 1, frame[:1]
        reply = json.loads(frame[1:])
        assert reply['type'] == 'error', reply
        return reply


try:
    for _ in range(4):
        launch()
    with connect():
        time.sleep(1)
        alive = [child for child in children if child.poll() is None]
        assert len(alive) == 1, [(child.pid, child.poll()) for child in children]
    alive[0].wait(timeout=8)
    assert alive[0].returncode == 0

    child = launch()
    with connect():
        request = dict(type='attach', version=1,
                       build=hashlib.sha256(entry.read_bytes()).hexdigest(),
                       debugPort='disabled', url='https://example.com',
                       settings=dict(overlay=False, design=False, transparent=False,
                                     noPaint=False, debugPaint=False),
                       size=dict(width=800, height=600, cols=80, rows=30),
                       features=dict(keyboard=True, images=True, loadFrame=True, compositeFrame=True))
        mismatch = reject(dict(request, build='wrong-build'))
        assert 'Incompatible' in mismatch['message'], mismatch
        debug = reject(dict(request, debugPort='9222'))
        assert 'debugging port' in debug['message'], debug
        invalid = reject(dict(type='attach', version=99))
    child.wait(timeout=8)
    assert child.returncode == 0

    child = launch()
    with connect():
        child.kill()
        child.wait(timeout=4)
    child = launch()
    with connect():
        pass
    child.wait(timeout=8)
    assert child.returncode == 0
    results = dict(parallelStarts=4, liveOwners=1, lastDetachExit=0,
                   crashRecoveryExit=0, buildMismatch=mismatch, debugMismatch=debug,
                   invalidAttach=invalid)
    (root / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
finally:
    for child in children:
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=4)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    log.close()
