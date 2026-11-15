// Direct transport acceptance; does NOT verify native picker consent or Kitty UI.
// Usage: bun tests/remote-upload-smoke.ts <ssh-alias> <absolute remote awrit path>
// Requires python3 on the host; opens one temporary IPv4 loopback HTTP fixture.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { encodeFrame, FrameDecoder } from '../src/browserOwner/protocol';
import { type ControlMessage, parseControl } from '../src/remote/protocol';
import { sshArgv, sshCommandArgv, sshScriptArgv } from '../src/remote/sshCommand';
import { writeUpload } from '../src/remote/uploadWriter';

const [alias, runtime] = process.argv.slice(2);
if (!alias || !runtime) throw Error('Usage: bun tests/remote-upload-smoke.ts <ssh-alias> <remote awrit path>');
const lanes: ChildProcessWithoutNullStreams[] = [];
const deadline = AbortSignal.timeout(60_000);
let failure: Error | undefined;
const start = (args: string[]) => {
  const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.pipe(process.stderr, { end: false });
  // Listeners are installed immediately, including for spawn failures.
  child.on('error', (error) => { failure ??= error; });
  lanes.push(child);
  return child;
};
let fixturePid: number | undefined;
let control: ChildProcessWithoutNullStreams | undefined;
let createSent = false;
const send = (message: ControlMessage) => {
  if (!control || control.stdin.destroyed) throw Error('Control lane unavailable');
  control.stdin.write(encodeFrame('control', Buffer.from(JSON.stringify(message))));
};
const messages: ControlMessage[] = [];
async function wait<T extends ControlMessage>(predicate: (m: ControlMessage) => m is T): Promise<T> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    deadline.throwIfAborted();
    if (failure) throw failure;
    const error = messages.find((m) => m.type === 'error' && !m.request?.startsWith('loaded-'));
    if (error) throw Error(JSON.stringify(error));
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`Timed out waiting for response; received: ${JSON.stringify(messages)}`);
}

try {
  const fixture = start(sshScriptArgv(alias));
  const lines = createInterface({ input: fixture.stdout });
  const firstLine = once(lines, 'line', { signal: deadline });
  fixture.stdin.end(`set -eu
exec python3 -u - <<'PY'
import http.server, os, threading
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  body=b'''<html><body><input type="file" style="position:absolute;left:0;top:0;width:300px;height:90px" onchange="this.files[0].text().then(t=>document.getElementById('result').textContent=t)"><pre id="result" style="margin-top:120px">WAITING</pre></body></html>'''
  self.send_response(200)
  self.end_headers()
  self.wfile.write(body)
 def log_message(self,*args): pass
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
# An orphaned fixture still has a hard lifetime if SSH or cleanup fails.
threading.Timer(60,lambda:os._exit(1)).start()
print(str(os.getpid())+' '+str(server.server_port),flush=True)
server.serve_forever()
PY
`);
  const [line] = await firstLine;
  lines.close();
  const match = /^(\d+) (\d+)$/.exec(String(line));
  if (!match) throw Error('Invalid fixture PID/port');
  fixturePid = Number(match[1]);
  const port = Number(match[2]);
  if (fixturePid < 2 || port < 1 || port > 65535) throw Error('Invalid fixture PID/port range');
  control = start(sshArgv(alias, 'control', runtime));
  const decoder = new FrameDecoder();
  control.stdout.on('data', (data) => {
    try {
      for (const frame of decoder.push(data)) messages.push(parseControl(JSON.parse(frame.payload.toString())));
    } catch (error) { failure = error instanceof Error ? error : Error(String(error)); }
  });
  control.on('close', (code) => { failure ??= Error(`Control lane exited: ${code}`); });
  send({ type: 'hello', version: 1, build: 'upload-ssh-smoke', codecs: ['png'] });
  send({ type: 'create', request: 'create', url: `http://127.0.0.1:${port}` });
  createSent = true;
  const ready = await wait((m): m is Extract<ControlMessage, { type: 'ready' }> => m.type === 'ready');
  send({ type: 'viewport', epoch: 0, width: 800, height: 600, cols: 100, rows: 40 });
  // Wait for actual page text rather than assuming a fixed load duration.
  let loaded = false;
  for (let i = 0; i < 50 && !loaded; i++) {
    const request = `loaded-${i}`;
    send({ type: 'request', request, tool: 'text', params: {} });
    const response = await wait((m): m is Extract<ControlMessage, { type: 'result' | 'error' }> => (m.type === 'result' || m.type === 'error') && m.request === request);
    loaded = response.type === 'result' && JSON.stringify(response.value).includes('WAITING');
    if (!loaded) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!loaded) throw Error('Fixture page did not load');
  let seq = 0;
  for (const action of ['down', 'up'] as const) send({
    type: 'input', seq: ++seq, generation: ready.generation, epoch: 0,
    event: { kind: 'pointer', action, x: 40, y: 30, button: 'left' },
  });
  const chooser = await wait((m): m is Extract<ControlMessage, { type: 'file-chooser' }> => m.type === 'file-chooser');
  const payload = Buffer.from('awrit-ssh-upload-exact-7c19');
  send({ type: 'upload-offer', chooser: chooser.chooser, offer: {
    id: 'smoke', name: 'fixture.txt', mime: 'text/plain', size: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
  } });
  const grant = await wait((m): m is Extract<ControlMessage, { type: 'upload-grant' }> => m.type === 'upload-grant' && m.chooser === chooser.chooser);
  const bulk = start(sshArgv(alias, 'bulk', runtime));
  await writeUpload({
    stdin: bulk.stdin, stdout: bulk.stdout, stderr: bulk.stderr,
    onClose: (listener) => { bulk.once('close', (code) => listener(code === 0 ? undefined : `exit ${code}`)); },
    kill: () => { bulk.kill(); },
  }, chooser.chooser, grant.token, (async function* () { yield payload; })(), deadline);
  await wait((m): m is Extract<ControlMessage, { type: 'upload-complete' }> => m.type === 'upload-complete' && m.chooser === chooser.chooser);
  // File.text() runs asynchronously after the change event; poll with unique IDs.
  let exact = false;
  for (let i = 0; i < 50 && !exact; i++) {
    const request = `text-${i}`;
    send({ type: 'request', request, tool: 'text', params: {} });
    const text = await wait((m): m is Extract<ControlMessage, { type: 'result' }> => m.type === 'result' && m.request === request);
    const value = text.value;
    exact = value !== null && typeof value === 'object' && !Array.isArray(value) && value.text === payload.toString();
    if (!exact) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!exact) throw Error('Exact uploaded bytes absent from lazy browser file read');
  console.log('SSH UPLOAD OK: real chooser, production writer, owner completion, exact lazy browser file read');
} finally {
  try {
    if (createSent && control && !control.stdin.destroyed) {
      send({ type: 'stop', request: 'cleanup' });
      await Promise.race([once(control, 'close'), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
  } finally {
    if (fixturePid) {
      const cleanup = start(sshCommandArgv(alias, ['kill', String(fixturePid)]));
      const closed = once(cleanup, 'close');
      const result = await Promise.race([closed, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000))]);
      if (!result || result[0] !== 0) process.exitCode = 1;
    }
    for (const child of lanes) child.kill();
  }
}
