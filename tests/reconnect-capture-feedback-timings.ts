import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { startIpcServer, type ConnectedClient } from '../src/ipc/socketServer';

/**
 * Benchmark end-to-end timings for:
 * 1. Initial connect + handshake
 * 2. Reconnect + handshake
 * 3. Capture-like bounded payload round-trip (~250 KB base64 PNG)
 * 4. Feedback delivery and ACK settlement round-trip
 */
async function runBenchmarks() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-timing-bench-'));
  const sockPath = path.join(tmpDir, 'test-bench.sock');
  process.env.AWRIT_IPC_SOCKET = sockPath;

  const server = await startIpcServer();

  server.onHandshake = async (client) => {
    return { adopted: true, paneId: 'pane-test-1', kittyWindowId: '101' };
  };

  // Mock capture handler returning typical 1280x800 base64 PNG payload (~250 KB)
  const mockPngBase64 = Buffer.alloc(256 * 1024, 0x41).toString('base64');
  server.onRequest('capture:request', async () => {
    return {
      base64: mockPngBase64,
      width: 1280,
      height: 800,
      url: 'https://example.com/app',
      paneId: 'pane-test-1',
      kittyWindowId: '101',
    };
  });

  interface SampleStats {
    count: number;
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
  }

  function stats(samples: number[]): SampleStats {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0;
    return {
      count: sorted.length,
      medianMs: Math.round(median * 1000) / 1000,
      p95Ms: Math.round(p95 * 1000) / 1000,
      minMs: Math.round((sorted[0] ?? 0) * 1000) / 1000,
      maxMs: Math.round((sorted[sorted.length - 1] ?? 0) * 1000) / 1000,
    };
  }

  async function connectAndHandshake(windowId: string): Promise<{ client: net.Socket; elapsedMs: number }> {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const client = net.createConnection(sockPath, () => {
        const hs = JSON.stringify({
          type: 'handshake',
          windowId,
          harness: 'test-harness',
          pid: process.pid,
          feedbackAck: true,
        });
        client.write(hs + '\n');
      });

      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('\n')) {
          const elapsed = performance.now() - start;
          client.removeAllListeners('data');
          resolve({ client, elapsedMs: elapsed });
        }
      });
      client.on('error', reject);
    });
  }

  try {
    // 1. Initial Handshake & Reconnect timings
    const initialSamples: number[] = [];
    const reconnectSamples: number[] = [];

    for (let i = 0; i < 50; i++) {
      const { client, elapsedMs } = await connectAndHandshake(`win-${i}`);
      initialSamples.push(elapsedMs);

      // Disconnect
      await new Promise<void>((r) => {
        client.on('close', () => r());
        client.destroy();
      });

      // Reconnect with same windowId
      const { client: reconnected, elapsedMs: reconElapsed } = await connectAndHandshake(`win-${i}`);
      reconnectSamples.push(reconElapsed);

      await new Promise<void>((r) => {
        reconnected.on('close', () => r());
        reconnected.destroy();
      });
    }

    // 2. Capture payload round-trip timings
    const { client: persistentClient } = await connectAndHandshake('win-bench');
    const captureSamples: number[] = [];

    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const reqId = `req-cap-${i}`;
      const payload = JSON.stringify({
        type: 'capture:request',
        requestId: reqId,
      });

      await new Promise<void>((resolve, reject) => {
        let buf = '';
        const onData = (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes('\n')) {
            persistentClient.removeListener('data', onData);
            const line = buf.split('\n')[0];
            try {
              const res = JSON.parse(line);
              if (res.requestId === reqId && res.ok) {
                captureSamples.push(performance.now() - start);
                resolve();
              } else {
                reject(new Error(`Unexpected response: ${line}`));
              }
            } catch (e) {
              reject(e);
            }
          }
        };
        persistentClient.on('data', onData);
        persistentClient.write(payload + '\n');
      });
    }

    // 3. Feedback delivery & ACK settlement round-trip timings
    persistentClient.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'design:send-feedback' && msg.draftId) {
            persistentClient.write(
              JSON.stringify({
                type: 'design:feedback-ack',
                draftId: msg.draftId,
                ok: true,
              }) + '\n'
            );
          }
        } catch {}
      }
    });

    const targetClient = server.getClients().find((c) => c.windowId === 'win-bench');
    if (!targetClient) throw new Error('Target client win-bench not found');

    const feedbackSamples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const draftId = `draft-${i}`;
      const result = await server.sendFeedback(targetClient, {
        draftId,
        text: 'Test design feedback',
      } as any);
      if (!result.ok) throw new Error(`Feedback failed: ${result.error}`);
      feedbackSamples.push(performance.now() - start);
    }

    persistentClient.destroy();

    const results = {
      ok: true,
      connectHandshake: stats(initialSamples),
      reconnectHandshake: stats(reconnectSamples),
      capture250kbRoundTrip: stats(captureSamples),
      feedbackAckRoundTrip: stats(feedbackSamples),
    };

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await server.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

await runBenchmarks();
