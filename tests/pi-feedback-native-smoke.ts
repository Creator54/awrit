import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { PI_EXTENSION_SCRIPT } from '../src/presentation/extensions/piAwrit.ts';

// Run with PI_SDK_PATH pointing to the installed pi-coding-agent package:
// PI_SDK_PATH=/path/to/pi-coding-agent bun tests/pi-feedback-native-smoke.ts
// Uses the real extension host and native user turns with an offline model.
// This does not exercise the graphical viewer or a provider-backed model.

const sdkPath = process.env.PI_SDK_PATH;
if (!sdkPath) {
  console.error(JSON.stringify({ ok: false, error: 'PI_SDK_PATH environment variable is required' }));
  process.exit(1);
}

const piSdk = await import(sdkPath);
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = piSdk;

// Resolve pi-ai the way the SDK does, so PI_SDK_PATH may be the package folder or its entry file.
const sdkDir = fs.statSync(sdkPath).isDirectory() ? sdkPath : path.dirname(sdkPath);
const piAiPath = Bun.resolveSync('@earendil-works/pi-ai', sdkDir);
const piAi = await import(piAiPath);
const { createAssistantMessageEventStream } = piAi;

const isWorker = process.argv.includes('--worker');

const mockModel = {
  type: 'chat' as const,
  id: 'offline-mock-model',
  name: 'Offline Mock Model',
  provider: 'offline-mock',
  api: 'offline-mock-api' as any,
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 2048,
};

let holdStream = false;
let releaseStream: (() => void) | undefined;

const providerFactory = (pi: any) => {
  pi.registerProvider('offline-mock', {
    baseUrl: 'http://127.0.0.1:0',
    apiKey: 'none',
    api: 'offline-mock-api',
    models: [mockModel],
    streamSimple: (model: any) => {
      const stream = createAssistantMessageEventStream();
      const output: any = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Offline response.' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      };
      console.log(JSON.stringify({ type: 'worker:model_start', windowId: process.env.KITTY_WINDOW_ID }));
      const finish = () => {
        stream.push({ type: 'text_start', contentIndex: 0, partial: output });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Offline response.', partial: output });
        stream.push({ type: 'text_end', contentIndex: 0, content: 'Offline response.', partial: output });
        stream.push({ type: 'done', message: output });
        stream.end();
      };
      if (holdStream) releaseStream = finish;
      else queueMicrotask(finish);
      return stream;
    },
  });
};

if (isWorker) {
  const windowId = process.env.KITTY_WINDOW_ID || 'unknown';
  const sessionCwd = process.cwd();
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(sessionCwd, 'agent');
  const extDir = path.join(agentDir, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });

  const extScriptPath = path.join(extDir, 'awrit-pi.ts');
  fs.writeFileSync(extScriptPath, PI_EXTENSION_SCRIPT, 'utf8');

  const resourceLoader = new DefaultResourceLoader({
    cwd: sessionCwd,
    agentDir,
    additionalExtensionPaths: [extScriptPath],
    extensionFactories: [providerFactory],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: sessionCwd,
    sessionManager: SessionManager.create(sessionCwd, path.join(sessionCwd, 'sessions')),
    settingsManager: SettingsManager.inMemory(),
    resourceLoader,
    model: mockModel,
  });

  await session.bindExtensions({ mode: 'rpc', onError: (error: unknown) => {
    console.error(error);
    process.exit(1);
  } });

  session.subscribe((event: any) => {
    if (event.type === 'message_end' && event.message?.role === 'user') {
      const text = Array.isArray(event.message.content)
        ? event.message.content.map((c: any) => c.text || '').join('')
        : event.message.content || '';
      console.log(JSON.stringify({ type: 'worker:user_message', windowId, text }));
    }
  });

  let commandBuffer = '';
  process.stdin.on('data', (chunk) => {
    commandBuffer += chunk.toString();
    let end: number;
    while ((end = commandBuffer.indexOf('\n')) >= 0) {
      const command = commandBuffer.slice(0, end);
      commandBuffer = commandBuffer.slice(end + 1);
      if (command === 'start') {
        holdStream = true;
        void session.prompt('Isolated busy-turn fixture').catch((error: unknown) => {
          console.error(error);
          process.exit(1);
        });
      } else if (command === 'new-session') {
        void session.waitForIdle().then(async () => {
          session.sessionManager.newSession();
          await session.reload();
          console.log(JSON.stringify({ type: 'worker:session_changed', windowId,
            sessionId: session.sessionManager.getSessionId() }));
        }).catch((error: unknown) => { console.error(error); process.exit(1); });
      } else if (command === 'clear') {
        const cleared = session.clearQueue();
        console.log(JSON.stringify({ type: 'worker:cleared', windowId, followUp: cleared.followUp }));
      } else if (command === 'release') {
        holdStream = false;
        releaseStream?.();
        releaseStream = undefined;
        void session.waitForIdle().then(() => {
          console.log(JSON.stringify({ type: 'worker:idle', windowId }));
        });
      }
    }
  });
  console.log(JSON.stringify({ type: 'worker:ready', windowId }));
  await new Promise(() => {});
} else {
  // Parent: owns the socket and drives the worker.
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-pi-smoke-'));
  const socketPath = path.join(tmpBase, 'ipc.sock');

  interface ConnectedClient {
    id: number;
    socket: net.Socket;
    handshakes: any[];
    acks: any[];
  }
  let nextClientId = 1;
  const clients: ConnectedClient[] = [];

  const server = net.createServer((socket) => {
    const client: ConnectedClient = {
      id: nextClientId++,
      socket,
      handshakes: [],
      acks: [],
    };
    clients.push(client);

    let buf = '';
    socket.on('data', (data) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'handshake') {
            client.handshakes.push(msg);
            socket.write(JSON.stringify({ type: 'handshake:ack', adopted: false }) + '\n');
          } else if (msg.type === 'design:feedback-ack') {
            client.acks.push(msg);
          }
        } catch {}
      }
    });

    socket.on('close', () => {});
    socket.on('error', () => {});
  });

  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

  const workers: ChildProcess[] = [];
  const workerMessagesA: string[] = [];
  const workerMessagesB: string[] = [];
  const readyWorkers = new Set<string>();
  const modelStarts = new Map<string, number>();
  const clearedFollowUps: string[] = [];
  let workerAIdleCount = 0;
  let changedSessionId: string | undefined;
  let workerError: Error | undefined;

  function spawnWorker(windowId: string, messagesList: string[]) {
    const workerCwd = path.join(tmpBase, `worker-${windowId}`);
    const homeDir = path.join(tmpBase, `home-${windowId}`);
    const agentDir = path.join(tmpBase, `agent-${windowId}`);
    fs.mkdirSync(workerCwd, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const proc = spawn('bun', [path.resolve(process.argv[1]), '--worker'], {
      cwd: workerCwd,
      env: {
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: path.join(homeDir, 'config'),
        XDG_CACHE_HOME: path.join(homeDir, 'cache'),
        HOME: homeDir,
        PI_CODING_AGENT_DIR: agentDir,
        KITTY_WINDOW_ID: windowId,
        AWRIT_IPC_SOCKET: socketPath,
        AWRIT_TRACE_FEEDBACK: path.join(tmpBase, 'trace-' + windowId + '.jsonl'),
        PI_SDK_PATH: sdkPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('error', (error) => { workerError = error; });
    proc.on('exit', (code, signal) => {
      workerError = new Error(`Worker ${windowId} exited: ${signal ?? code}`);
    });
    let stdoutBuf = '';
    proc.stderr?.on('data', (chunk) => console.error('[worker ' + windowId + '] ' + chunk.toString().slice(0, 4000)));
    proc.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'worker:session_changed' && parsed.windowId === '101') changedSessionId = parsed.sessionId;
          if (parsed.type === 'worker:ready') readyWorkers.add(String(parsed.windowId));
          if (parsed.type === 'worker:idle' && parsed.windowId === '101') workerAIdleCount++;
          if (parsed.type === 'worker:cleared' && parsed.windowId === '101' && Array.isArray(parsed.followUp)) {
            clearedFollowUps.push(...parsed.followUp);
          }
          if (parsed.type === 'worker:model_start') {
            const id = String(parsed.windowId);
            modelStarts.set(id, (modelStarts.get(id) ?? 0) + 1);
          }
          if (parsed.type === 'worker:user_message' && parsed.text) {
            messagesList.push(parsed.text);
          }
        } catch {}
      }
    });

    workers.push(proc);
    return proc;
  }

  async function pollUntil(condition: () => boolean, desc: string, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (workerError) throw workerError;
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${desc}`);
  }

  const cleanup = async () => {
    for (const proc of workers) {
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGTERM'); } catch {}
      }
    }
    const termStart = Date.now();
    while (Date.now() - termStart < 1000) {
      const anyAlive = workers.some((p) => p.exitCode === null && p.signalCode === null);
      if (!anyAlive) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const proc of workers) {
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }
    for (const c of clients) {
      try { c.socket.destroy(); } catch {}
    }
    try { server.close(); } catch {}
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  };

  const watchdog = setTimeout(() => {
    console.error('Native Pi smoke timed out');
    void cleanup().finally(() => process.exit(1));
  }, 20000);
  watchdog.unref();

  try {
    const workerA = spawnWorker('101', workerMessagesA);
    spawnWorker('202', workerMessagesB);

    // 1. Wait for initial handshakes from both workers
    await pollUntil(
      () =>
        readyWorkers.has('101') &&
        readyWorkers.has('202') &&
        clients.some((c) => c.handshakes.some((h) => String(h.windowId) === '101')) &&
        clients.some((c) => c.handshakes.some((h) => String(h.windowId) === '202')),
      'handshakes from workers 101 and 202',
      8000
    );

    const client101Initial = clients.find((c) =>
      c.handshakes.some((h) => String(h.windowId) === '101')
    )!;
    const client202 = clients.find((c) =>
      c.handshakes.some((h) => String(h.windowId) === '202')
    )!;

    // 2. Broadcast feedback targeted to window 101
    const draftId1 = 'draft-test-101-aaa';
    const feedbackPayload1 = JSON.stringify({
      event: 'design:send-feedback',
      sourceWindowId: '101',
      draftId: draftId1,
      summary: '[Design Feedback] Change color to blue',
    }) + '\n';

    for (const c of clients) {
      if (!c.socket.destroyed) {
        c.socket.write(feedbackPayload1);
      }
    }

    // 3. Assert A ACK true + user text received, B no user receipt
    await pollUntil(
      () =>
        client101Initial.acks.some((a) => a.draftId === draftId1 && a.ok === true) &&
        workerMessagesA.some((m) => m.includes('[Design Feedback] Change color to blue')),
      'worker 101 ACK true and user message receipt',
      8000
    );

    // Verification check for isolation
    if (workerMessagesB.length > 0) {
      throw new Error(`Worker 202 isolation failed: received messages ${JSON.stringify(workerMessagesB)}`);
    }
    if (client202.acks.length > 0) {
      throw new Error(`Worker 202 sent unexpected ACKs: ${JSON.stringify(client202.acks)}`);
    }

    // 4. Duplicate same draft: one actual turn
    const prevTurnCount = workerMessagesA.length;
    if (prevTurnCount !== 1) throw new Error('Expected exactly one native user turn');
    client101Initial.acks = [];

    for (const c of clients) {
      if (!c.socket.destroyed) {
        c.socket.write(feedbackPayload1);
      }
    }

    await pollUntil(
      () => client101Initial.acks.some((a) => a.draftId === draftId1 && a.ok === true),
      'duplicate ACK on client 101',
      8000
    );

    await new Promise((r) => setTimeout(r, 200));
    if (workerMessagesA.length !== prevTurnCount) {
      throw new Error(
        `Duplicate draft caused second turn! Count was ${workerMessagesA.length}, expected ${prevTurnCount}`
      );
    }

    // 5. Disconnect A, await new handshake 2s, resend duplicate ACK without second turn
    client101Initial.socket.destroy();

    await pollUntil(
      () =>
        clients.filter((c) =>
          c.id !== client101Initial.id &&
          c.handshakes.some((h) => String(h.windowId) === '101')
        ).length >= 1,
      'reconnection and new handshake from worker 101 after disconnect',
      8000
    );

    const client101Reconnected = clients.find(
      (c) =>
        c.id !== client101Initial.id &&
        c.handshakes.some((h) => String(h.windowId) === '101')
    )!;

    // Resend duplicate feedback over new connection
    client101Reconnected.socket.write(feedbackPayload1);

    await pollUntil(
      () => client101Reconnected.acks.some((a) => a.draftId === draftId1 && a.ok === true),
      'duplicate ACK over reconnected client 101 socket',
      8000
    );

    await new Promise((r) => setTimeout(r, 200));
    if (workerMessagesA.length !== prevTurnCount) {
      throw new Error(
        `Duplicate draft after reconnect caused second turn! Count was ${workerMessagesA.length}, expected ${prevTurnCount}`
      );
    }

    if (workerMessagesB.length !== 0) throw new Error(`Expected workerMessagesB length 0, got ${workerMessagesB.length}`);
    if (client202.acks.length !== 0) throw new Error(`Expected client202.acks length 0, got ${client202.acks.length}`);

    client202.socket.write(
      JSON.stringify({
        event: 'design:send-feedback',
        sourceWindowId: '202',
        draftId: 'positive-202',
        summary: 'B positive control',
      }) + '\n'
    );
    await pollUntil(
      () => client202.acks.some((a) => a.draftId === 'positive-202' && a.ok === true) && workerMessagesB.length === 1,
      'B positive control'
    );
    if (workerMessagesB[0] !== 'B positive control') throw new Error('Unexpected B turn');

    // Queue feedback during a real streaming turn, not only while idle.
    const startsBefore = modelStarts.get('101') ?? 0;
    workerA.stdin!.write('start\n');
    await pollUntil(() => (modelStarts.get('101') ?? 0) > startsBefore, 'busy model turn');
    client101Reconnected.socket.write(JSON.stringify({
      event: 'design:send-feedback',
      sourceWindowId: '101',
      draftId: 'busy-101',
      summary: 'Feedback queued during busy turn',
    }) + '\n');
    await pollUntil(
      () => client101Reconnected.acks.some((a) => a.draftId === 'busy-101' && a.ok === true),
      'feedback ACK while model stream is held open',
    );
    if (workerMessagesA.includes('Feedback queued during busy turn')) {
      throw new Error('Follow-up arrived before the held stream completed');
    }
    workerA.stdin!.write('release\n');
    await pollUntil(
      () => workerMessagesA.includes('Feedback queued during busy turn'),
      'busy-turn feedback ACK and actual user-message receipt',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (workerMessagesA.filter((m) => m === 'Feedback queued during busy turn').length !== 1) {
      throw new Error('Busy feedback did not arrive exactly once');
    }

    // Negative control: Pi explicitly clearing its queue can discard an ACKed note.
    const startsBeforeClear = modelStarts.get('101') ?? 0;
    workerA.stdin!.write('start\n');
    await pollUntil(() => (modelStarts.get('101') ?? 0) > startsBeforeClear, 'held turn for queue-clear control');
    const discardedNote = 'Negative control: explicitly cleared feedback';
    client101Reconnected.socket.write(JSON.stringify({
      event: 'design:send-feedback', sourceWindowId: '101',
      draftId: 'cleared-101', summary: discardedNote,
    }) + '\n');
    await pollUntil(
      () => client101Reconnected.acks.some((a) => a.draftId === 'cleared-101' && a.ok === true),
      'queue-clear control ACK',
    );
    workerA.stdin!.write('clear\n');
    await pollUntil(() => clearedFollowUps.includes(discardedNote), 'ACKed note returned by clearQueue');
    const idleBeforeClearRelease = workerAIdleCount;
    workerA.stdin!.write('release\n');
    await pollUntil(() => workerAIdleCount > idleBeforeClearRelease, 'idle after queue-clear control');
    if (workerMessagesA.some((text) => text.includes(discardedNote))) {
      throw new Error('Explicitly cleared note was delivered');
    }

    const traceText = fs.readFileSync(path.join(tmpBase, 'trace-101.jsonl'), 'utf8');
    const trace = traceText.trim().split('\n').map((line) => JSON.parse(line));
    if (!trace.every((entry) => Number.isSafeInteger(entry.pid) && entry.windowId === '101'
      && typeof entry.sessionId === 'string' && entry.sessionId.length > 0)) {
      throw new Error('Feedback trace missing receiver process/window/session identity');
    }
    for (const event of ['received', 'send-call-resolved', 'user-message-observed']) {
      if (!trace.some((entry) => entry.draftId === 'busy-101' && entry.event === event)) {
        throw new Error('Missing busy feedback trace: ' + event);
      }
    }
    if (trace.some((entry) => entry.draftId === 'cleared-101' && entry.event === 'user-message-observed')) {
      throw new Error('Trace falsely claims cleared feedback was delivered');
    }
    if (traceText.includes(discardedNote) || traceText.includes('Feedback queued during busy turn')) {
      throw new Error('Feedback trace leaked note text');
    }

    const sessionDir = path.join(tmpBase, 'worker-101', 'sessions');
    const transcriptTexts = fs.readdirSync(sessionDir)
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => fs.readFileSync(path.join(sessionDir, name), 'utf8').trim().split('\n'))
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'message' && entry.message?.role === 'user')
      .map((entry) => entry.message.content.map((part: { text?: string }) => part.text ?? '').join(''));
    if (transcriptTexts.filter((text) => text === 'Feedback queued during busy turn').length !== 1) {
      throw new Error('Busy feedback missing or duplicated in persisted session transcript');
    }
    if (transcriptTexts.some((text) => text.includes(discardedNote))) {
      throw new Error('Cleared feedback incorrectly persisted as a delivered user message');
    }

    // Exercise real SDK session identity and extension reload, not a mock context.
    const oldSessionId = trace.find((entry) => entry.draftId === 'busy-101').sessionId;
    const previousClientCount = clients.length;
    workerA.stdin!.write('new-session\n');
    await pollUntil(() => changedSessionId !== undefined && clients.length > previousClientCount
      && clients.slice(previousClientCount).some((client) => client.handshakes.some((h) => h.windowId === '101')),
      'SDK session change and extension reload');
    const changedClient = clients.slice(previousClientCount).find((client) => client.handshakes.some((h) => h.windowId === '101'))!;
    changedClient.socket.write(JSON.stringify({ event: 'design:send-feedback', sourceWindowId: '101',
      draftId: 'changed-session-101', summary: 'Isolated session-change check' }) + '\n');
    await pollUntil(() => workerMessagesA.includes('Isolated session-change check'), 'changed session receipt');
    const changedTrace = fs.readFileSync(path.join(tmpBase, 'trace-101.jsonl'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line)).filter((entry) => entry.draftId === 'changed-session-101');
    if (!changedTrace.length || changedSessionId === oldSessionId
      || !changedTrace.every((entry) => entry.sessionId === changedSessionId)) {
      throw new Error('Trace retained stale session identity after SDK session change/reload: ' + JSON.stringify({ oldSessionId, changedSessionId, changedTrace }));
    }

    // Clean up resources
    await cleanup();

    console.log(
      JSON.stringify(
        {
          ok: true,
          gate: 'pi-feedback-native-smoke',
          verified: {
            handshake: true,
            isolatedAck: true,
            userMessageDelivered: true,
            workerBIsolated: true,
            duplicateDeduplicated: true,
            reconnectHandshake: true,
            reconnectDuplicateDeduplicated: true,
            workerBPositiveControl: true,
            busyTurnFollowUpDelivered: true,
            explicitQueueClearCanDiscardAckedFeedback: true,
            persistedTranscriptMatchesDeliveryTrace: true,
          },
        },
        null,
        2
      )
    );
    process.exit(0);
  } catch (err: any) {
    await cleanup();
    console.error(
      JSON.stringify({
        ok: false,
        gate: 'pi-feedback-native-smoke',
        error: err?.message || String(err),
      })
    );
    process.exit(1);
  }
}
