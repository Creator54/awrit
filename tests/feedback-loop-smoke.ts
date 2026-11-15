/**
 * Run: bun tests/feedback-loop-smoke.ts
 * Real sandboxed Electron rendering + production capture/feedback delivery.
 * The agent is a deterministic stub, NOT an LLM or UI acceptance test.
 * Set AWRIT_FEEDBACK_SMOKE_NO_UPDATE=1 to prove stale software fails verification.
 * Evidence stays in the printed /tmp directory; owned worker/profile are cleaned up.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const electron = process.env.AWRIT_ELECTRON || Bun.which('electron') || String((await import('electron')).default);
if (!electron) throw new Error('Electron unavailable; set AWRIT_ELECTRON');
const evidence = mkdtempSync(join(tmpdir(), 'awrit-feedback-loop-'));
const cache = join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const buildDir = mkdtempSync(join(cache, 'feedback-loop-'));
const profile = join(evidence, 'profile');
const worker = join(buildDir, 'worker.cjs');
const source = `
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const net = require('node:net');
const { writeFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePagePng } = require(${JSON.stringify(join(root, 'src/browserOwner/pageCapture.ts'))});
const { startIpcServer } = require(${JSON.stringify(join(root, 'src/ipc/socketServer.ts'))});
const evidence = ${JSON.stringify(evidence)};
app.setPath('userData', ${JSON.stringify(profile)});
const stages = [];
let window, ipc, socket, http;
let result;
const deadline = setTimeout(() => { console.error('Probe deadline exceeded'); app.exit(1); }, 30000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  throw new Error('Timed out: ' + label);
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
(async () => {
try {
  await app.whenReady();
  const fixture = join(evidence, 'application.html');
  const html = marker => '<!doctype html><html style="background:white;color:black"><title>Feedback loop ' + marker + '</title><h1 id="build">BUILD ' + marker + '</h1><p>Disposable application fixture</p></html>';
  writeFileSync(fixture, html('A'));
  http = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(readFileSync(fixture));
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const url = 'http://127.0.0.1:' + http.address().port;
  window = new BrowserWindow({ width: 800, height: 600, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(url);
  const view = { content: window };
  const before = await capturePagePng(view);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#build").textContent'), 'BUILD A');
  assert(before.width > 0 && before.height > 0);
  writeFileSync(join(evidence, 'before.png'), before.png);
  stages.push('application-A-captured');

  ipc = await startIpcServer({ socketPath: join(evidence, 'agent.sock') });
  ipc.onHandshake = () => ({ adopted: true, paneId: 'fixture-pane' });
  socket = net.createConnection(ipc.socketPath);
  let buffer = '', received;
  let agentError;
  socket.on('error', error => { agentError = error; });
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.event !== 'design:send-feedback') continue;
        assert.equal(message.captureSha256, hash(before.png));
        assert.equal(message.targetUrl, url);
        assert.equal(message.annotations[0].comment, 'Change BUILD A to BUILD B');
        received = message;
        socket.write(JSON.stringify({ type: 'design:feedback-ack', draftId: message.draftId, ok: true }) + '\\n');
      } catch (error) { agentError = error; }
    }
  });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(JSON.stringify({ type: 'handshake', windowId: 'fixture-agent', pid: process.pid,
    harness: 'deterministic-smoke-stub', feedbackAck: true }) + '\\n');
  await waitFor(() => ipc.getClients().some(client => client.windowId === 'fixture-agent' && client.feedbackAck), 'agent registration');
  const client = ipc.getClients().find(client => client.windowId === 'fixture-agent');
  const feedback = { draftId: 'fixture-draft', captureSha256: hash(before.png), targetUrl: url,
    annotations: [{ id: 'note-1', selection: { kind: 'region', bounds: { x: 0, y: 0, width: 200, height: 100 } }, comment: 'Change BUILD A to BUILD B' }] };
  const delivered = await ipc.sendFeedback(client, feedback);
  if (agentError) throw agentError;
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  assert(received, 'Agent must receive feedback before updating fixture');
  stages.push('feedback-acknowledged-by-stub');
  if (process.env.AWRIT_FEEDBACK_SMOKE_NO_UPDATE !== '1') writeFileSync(fixture, html('B'));
  await window.loadURL(url);
  const after = await capturePagePng(view);
  writeFileSync(join(evidence, 'after.png'), after.png);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#build").textContent'), 'BUILD B', 'Acknowledgement is not proof of updated software');
  assert.notEqual(hash(after.png), hash(before.png), 'Updated screenshot must differ');
  stages.push('application-B-rendered-and-captured');
  result = { ok: true, scope: 'local-render-capture-ipc-stub-update', stages, evidence,
    beforeSha256: hash(before.png), afterSha256: hash(after.png),
    notChecked: ['real LLM', 'remote transport', 'Android', 'target incarnation binding'] };
} catch (error) {
  result = { ok: false, stages, evidence, error: String(error.stack || error) };
} finally {
  socket?.destroy();
  if (ipc) await ipc.stop();
  window?.destroy();
  if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
  clearTimeout(deadline);
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log('PROBE_RESULT ' + JSON.stringify(result));
  app.exit(result.ok ? 0 : 1);
}
})();
`;

try {
  const entry = join(buildDir, 'worker.js');
  writeFileSync(entry, source);
  const build = await Bun.build({ entrypoints: [entry], outdir: buildDir, naming: 'worker.cjs', target: 'node', format: 'cjs', external: ['electron'] });
  if (!build.success) throw new AggregateError(build.logs, 'Probe bundle failed');
  const child = Bun.spawn([electron, worker], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 40000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  const line = stdout.split('\n').find(item => item.startsWith('PROBE_RESULT '));
  if (!line) throw new Error(`Probe returned no result (${exitCode}): ${stderr.slice(-2000)}`);
  console.log(line.slice('PROBE_RESULT '.length));
  if (exitCode !== 0 || JSON.parse(line.slice('PROBE_RESULT '.length)).ok !== true) process.exitCode = 1;
} finally {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
