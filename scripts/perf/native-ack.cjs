// Manual Linux/macOS check: node scripts/perf/native-ack.cjs /absolute/path/to/awrit
// Requires Node with WebSocket support, Kitty remote control and a graphical session.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert/strict');

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)
    || !process.env.KITTY_LISTEN_ON || !process.env.KITTY_WINDOW_ID) {
  throw Error('Provide an absolute Awrit executable and run inside remote-control-enabled Kitty');
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-native-ack-'));
const kitten = path.resolve(__dirname, '../../kittens/awrit.py');
const rc = (...args) => cp.execFileSync('kitty', ['@', '--to', process.env.KITTY_LISTEN_ON, ...args],
  { encoding: 'utf8', timeout: 10000 }).trim();
const windows = () => JSON.parse(rc('ls')).flatMap(o => o.tabs.flatMap(t => t.windows));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw Error('Condition not reached within ten seconds');
}

async function run(mode) {
  const dir = path.join(root, mode);
  fs.mkdirSync(dir, { mode: 0o700 });
  const metadata = path.join(dir, 'launch.json');
  const launcher = path.join(dir, 'launch');
  // Python is already required by the native review kitten. JSON strings are valid
  // Python string literals here; paths originate locally, never from screen text.
  fs.writeFileSync(launcher, `#!/usr/bin/env python3
import os,socket,json,sys
root=${JSON.stringify(dir)}
if os.environ.get('WAYLAND_DISPLAY') and not os.path.isabs(os.environ['WAYLAND_DISPLAY']):
 os.environ['WAYLAND_DISPLAY']=os.path.join(os.environ['XDG_RUNTIME_DIR'],os.environ['WAYLAND_DISPLAY'])
os.environ['XDG_CONFIG_HOME']=root+'/config'
os.environ['XDG_DATA_HOME']=root+'/data'
os.environ['XDG_RUNTIME_DIR']=root
os.environ['AWRIT_IPC_SOCKET']=root+'/feedback.sock'
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
with open(${JSON.stringify(metadata)},'w') as f: json.dump({'port':port},f)
os.execv(${JSON.stringify(executable)},['awrit','--debug-port='+str(port)]+sys.argv[1:])
`, { mode: 0o700 });
  const source = rc('launch', '--match', 'window_id:' + process.env.KITTY_WINDOW_ID,
    '--type=window', '--location=vsplit', '--title=Awrit isolated ACK check', 'sleep', '180');
  let overlay, ws, socket, expectedClose = false;
  const pending = new Map();
  const cleanup = () => {
    expectedClose = true;
    socket?.destroy();
    ws?.close();
    if (!overlay) {
      try { overlay = windows().find(w => w.cmdline.includes(launcher) && w.cmdline.includes(source))?.id; }
      catch (error) { console.error('Cleanup discovery:', error.message); process.exitCode = 1; }
    }
    for (const id of [overlay, source]) {
      try { if (id && windows().some(w => String(w.id) === String(id))) rc('close-window', '--match', 'id:' + id); }
      catch (error) { console.error('Cleanup:', error.message); process.exitCode = 1; }
    }
  };
  const watchdog = setTimeout(() => { console.error('ACK check exceeded time budget:', dir); cleanup(); process.exit(1); }, 45000);
  try {
    rc('kitten', '--match', 'id:' + source, kitten, 'design', launcher);
    const target = await until(async () => {
      // Kitty exposes the helper command, not its overlay-parent relation.
      overlay = windows().find(w => w.cmdline.includes(launcher) && w.cmdline.includes(source))?.id;
      if (!fs.existsSync(metadata)) return false;
      try {
        const { port } = JSON.parse(fs.readFileSync(metadata));
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`,
          { signal: AbortSignal.timeout(1000) })).json();
        return targets.find(t => t.url.includes('/toolbar/index.html'));
      } catch { return false; } // The debug endpoint may not have started yet.
    });
    assert.ok(overlay, 'No overlay owned by test source');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let sequence = 0;
    const closed = () => {
      for (const reject of pending.values()) reject.fail(Error('CDP target closed'));
      pending.clear();
      if (!expectedClose) { console.error('Unexpected CDP closure:', dir); process.exitCode = 1; }
    };
    ws.onclose = closed;
    ws.onerror = closed;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const handler = pending.get(message.id);
      pending.delete(message.id);
      if (handler) message.error ? handler.fail(Error(JSON.stringify(message.error))) : handler(message);
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      resolve.fail = reject;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const message = await call('Runtime.evaluate', { expression, returnByValue: true });
      if (message.result.exceptionDetails) throw Error(JSON.stringify(message.result.exceptionDetails));
      return message.result.result.value;
    };
    await until(() => evaluate('!!document.querySelector(".design-review img")?.naturalWidth'));
    socket = net.connect(path.join(dir, 'feedback.sock'));
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    let buffer = '', feedback, count = 0, handshake = false;
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === 'handshake:ack') handshake = true;
        if (message.event === 'design:send-feedback') { feedback = message; count++; }
      }
    });
    socket.write(JSON.stringify({ type: 'handshake', harness: 'isolated-ack-check',
      windowId: source, pid: process.pid, feedbackAck: true }) + '\n');
    await until(() => handshake);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 130, y: 140, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 310, y: 220, button: 'left', buttons: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 310, y: 220, button: 'left', clickCount: 1 });
    await until(() => evaluate('!!document.querySelector("textarea")'));
    await evaluate('document.querySelector("textarea").focus()');
    await call('Input.insertText', { text: 'Isolated receiver state check' });
    await evaluate('document.querySelector(\'button[aria-label="Send this note"]\').click()');
    await until(() => feedback);
    const sending = () => evaluate('document.body.innerText.includes("Sending…")');
    await sleep(300); // Acknowledge only after a visible in-flight interval.
    assert.equal(await sending(), true);
    const draftFile = path.join(dir, 'data/awrit/design-drafts', feedback.draftId + '.json');
    const draft = () => JSON.parse(fs.readFileSync(draftFile));
    assert.notEqual(draft().state, 'accepted');
    // Native success closes the renderer immediately after persisting acceptance.
    // The independent persisted-state assertion below must still pass.
    if (mode === 'success') expectedClose = true;
    if (mode === 'disconnect') socket.destroy();
    else socket.write(JSON.stringify({ type: 'design:feedback-ack', draftId: feedback.draftId,
      ok: mode === 'success', error: mode === 'reject' ? 'Isolated rejection' : undefined }) + '\n');
    if (mode === 'success') {
      await until(() => draft().state === 'accepted' && !windows().some(w => w.id === overlay));
    } else {
      await until(async () => !(await sending()));
      assert.equal(draft().state, 'editing');
      assert.ok(windows().some(w => w.id === overlay));
    }
    assert.ok(windows().some(w => String(w.id) === source));
    assert.equal(count, 1);
    const result = { mode, feedbackEvents: count, persistedState: draft().state, sourceSurvived: true };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { clearTimeout(watchdog); cleanup(); }
}
(async () => {
  console.log('Evidence:', root);
  for (const mode of ['success', 'reject', 'disconnect']) await run(mode);
})().catch(error => { console.error(error); process.exitCode = 1; });
