import { describe, expect, test, afterEach } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getSocketPath,
  isSocketAlive,
  startIpcServer,
  stopIpcServer,
} from './socketServer';

function createLineReader(socket: net.Socket) {
  let buffer = '';
  const queue: any[] = [];
  const waiters: Array<(msg: any) => void> = [];

  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (waiters.length > 0) {
          const waiter = waiters.shift();
          if (waiter) waiter(parsed);
        } else {
          queue.push(parsed);
        }
      } catch {}
    }
  });

  return {
    nextMessage(timeoutMs = 1500): Promise<any> {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift());
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for IPC message`));
        }, timeoutMs);

        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
  };
}

const clientsToCleanup: net.Socket[] = [];

function connectClient(testSock: string): net.Socket {
  const client = net.createConnection(testSock);
  client.on('error', () => {});
  clientsToCleanup.push(client);
  return client;
}

describe('socketServer', () => {
  afterEach(async () => {
    for (const c of clientsToCleanup) {
      try {
        c.removeAllListeners();
        c.on('error', () => {});
        c.destroy();
      } catch {}
    }
    clientsToCleanup.length = 0;
    await stopIpcServer();
  });

  test('getSocketPath respects environment and length', () => {
    const oldSocket = process.env.AWRIT_IPC_SOCKET;
    const oldXdg = process.env.XDG_RUNTIME_DIR;
    try {
      process.env.AWRIT_IPC_SOCKET = '/custom/path.sock';
      expect(getSocketPath()).toBe('/custom/path.sock');

      delete process.env.AWRIT_IPC_SOCKET;
      process.env.XDG_RUNTIME_DIR = '/run/user/1000';
      expect(getSocketPath()).toBe('/run/user/1000/awrit/ipc.sock');

      delete process.env.XDG_RUNTIME_DIR;
      const fallback = getSocketPath();
      expect(fallback.startsWith('/tmp/awrit-')).toBe(true);
      expect(fallback.endsWith('/ipc.sock')).toBe(true);
    } finally {
      if (oldSocket) process.env.AWRIT_IPC_SOCKET = oldSocket;
      else delete process.env.AWRIT_IPC_SOCKET;
      if (oldXdg) process.env.XDG_RUNTIME_DIR = oldXdg;
      else delete process.env.XDG_RUNTIME_DIR;
    }
  });

  test('broadcast sends newline-delimited JSON to connected clients', async () => {
    const testSock = path.join(tmpdir(), `test-awrit-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const server = await startIpcServer({ socketPath: testSock });
    expect(fs.existsSync(testSock)).toBe(true);

    const received: any[] = [];
    const client = connectClient(testSock);
    let buffer = '';

    await new Promise<void>((resolve) => {
      client.on('connect', () => resolve());
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) received.push(JSON.parse(line));
      }
    });

    // Wait for server to register client
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getClientCount()).toBe(1);

    server.broadcast('design:send-feedback', {
      draftId: 'draft-123',
      summary: 'Test summary',
      capturePath: '/tmp/test.png',
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(1);
    expect(received[0]).toEqual({
      event: 'design:send-feedback',
      draftId: 'draft-123',
      summary: 'Test summary',
      capturePath: '/tmp/test.png',
    });

    client.destroy();
    await server.stop();
    expect(fs.existsSync(testSock)).toBe(false);
  });

  test('detects and cleans up stale socket file before listening', async () => {
    const testSock = path.join(tmpdir(), `stale-awrit-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    // Create a dummy file at socket path (simulating dead socket)
    fs.writeFileSync(testSock, 'dead');
    expect(await isSocketAlive(testSock)).toBe(false);

    // Starting server should unlink stale file and succeed
    const server = await startIpcServer({ socketPath: testSock });
    expect(fs.existsSync(testSock)).toBe(true);
    expect(await isSocketAlive(testSock)).toBe(true);

    await server.stop();
    expect(fs.existsSync(testSock)).toBe(false);
  });

  test('rejects partial no-newline data exceeding line limit and cleans up client', async () => {
    const testSock = path.join(tmpdir(), `test-overlimit-nonewline-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const server = await startIpcServer({ socketPath: testSock });

    const client1 = connectClient(testSock);
    await new Promise<void>((r) => client1.on('connect', () => r()));
    await new Promise((r) => setTimeout(r, 20));
    expect(server.getClientCount()).toBe(1);

    const client1Closed = new Promise<void>((resolve) => {
      client1.on('close', () => resolve());
      client1.on('end', () => resolve());
    });

    // Send fragmented data exceeding 1 MiB without newline (2 chunks of 600 KiB)
    const chunk600k = Buffer.alloc(600 * 1024, 0x61); // 'a'
    client1.write(chunk600k);
    await new Promise((r) => setTimeout(r, 20));
    // Still 1 client before limit exceeded
    expect(server.getClientCount()).toBe(1);

    client1.write(chunk600k); // total 1.2 MiB > 1 MiB
    await client1Closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(server.getClientCount()).toBe(0);

    // Second client connects, survives and performs valid handshake
    const client2 = connectClient(testSock);
    await new Promise<void>((r) => client2.on('connect', () => r()));

    const ackPromise = new Promise<any>((resolve) => {
      client2.on('data', (d) => {
        resolve(JSON.parse(d.toString().trim()));
      });
    });

    client2.write(JSON.stringify({ type: 'handshake', harness: 'client2' }) + '\n');
    const ack = await ackPromise;
    expect(ack.type).toBe('handshake:ack');
    expect(ack.ok).toBe(true);

    client2.destroy();
    await server.stop();
  });

  test('rejects newline-terminated line exceeding line limit without crashing other clients', async () => {
    const testSock = path.join(tmpdir(), `test-overlimit-newline-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const server = await startIpcServer({ socketPath: testSock });

    // Client 1 (good client)
    const goodClient = connectClient(testSock);
    await new Promise<void>((r) => goodClient.on('connect', () => r()));
    goodClient.write(JSON.stringify({ type: 'handshake', harness: 'good' }) + '\n');
    await new Promise((r) => setTimeout(r, 20));

    // Client 2 (bad client sends >1 MiB line terminated by \n)
    const badClient = connectClient(testSock);
    await new Promise<void>((r) => badClient.on('connect', () => r()));
    const badClosed = new Promise<void>((resolve) => {
      badClient.on('close', () => resolve());
      badClient.on('end', () => resolve());
    });

    const bigLine = Buffer.concat([Buffer.alloc(1100 * 1024, 0x62), Buffer.from('\n')]);
    badClient.write(bigLine);
    await badClosed;

    // Bad client closed and cleaned up, good client still alive
    await new Promise((r) => setTimeout(r, 20));
    expect(server.getClientCount()).toBe(1);

    goodClient.destroy();
    await server.stop();
  });

  test('allows coalesced messages whose total exceeds limit if individual lines are valid', async () => {
    const testSock = path.join(tmpdir(), `test-coalesced-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const server = await startIpcServer({ socketPath: testSock });

    const client = connectClient(testSock);
    await new Promise<void>((r) => client.on('connect', () => r()));

    // Set up an echo request handler
    server.onRequest('echo', (msg) => ({ echoLen: (msg.data as string).length }));

    const responses: any[] = [];
    client.on('data', (d) => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    // Two messages of 600 KiB each (total 1.2 MiB > 1 MiB), coalesced in one write
    const payload600k = 'x'.repeat(600 * 1024);
    const msg1 = JSON.stringify({ type: 'echo', requestId: 'req-1', data: payload600k }) + '\n';
    const msg2 = JSON.stringify({ type: 'echo', requestId: 'req-2', data: payload600k }) + '\n';
    const coalescedBuffer = Buffer.from(msg1 + msg2);

    expect(coalescedBuffer.length).toBeGreaterThan(1024 * 1024);
    client.write(coalescedBuffer);

    // Wait for responses
    const start = Date.now();
    while (responses.length < 2 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(responses.length).toBe(2);
    expect(responses[0].requestId).toBe('req-1');
    expect(responses[0].data.echoLen).toBe(600 * 1024);
    expect(responses[1].requestId).toBe('req-2');
    expect(responses[1].data.echoLen).toBe(600 * 1024);

    client.destroy();
    await server.stop();
  });

  test('preserves multibyte UTF-8 characters split across chunk boundaries', async () => {
    const testSock = path.join(tmpdir(), `test-utf8-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const server = await startIpcServer({ socketPath: testSock });

    const client = connectClient(testSock);
    await new Promise<void>((r) => client.on('connect', () => r()));

    const handshakeAck = new Promise<void>((resolve) => {
      client.on('data', () => resolve());
    });

    // Handshake message with a 4-byte UTF-8 emoji: 🚀 (0xF0 0x9F 0x9A 0x80)
    // We split right in the middle of the 4-byte sequence!
    const part1 = Buffer.concat([
      Buffer.from('{"type":"handshake","harness":"rocket-'),
      Buffer.from([0xf0, 0x9f]),
    ]);
    const part2 = Buffer.concat([
      Buffer.from([0x9a, 0x80]),
      Buffer.from('-launch"}\n'),
    ]);

    client.write(part1);
    await new Promise((r) => setTimeout(r, 20));
    client.write(part2);

    await handshakeAck;

    const clients = server.getClients();
    expect(clients.length).toBe(1);
    expect(clients[0].harness).toBe('rocket-🚀-launch');

    client.destroy();
    await server.stop();
  });

  describe('feedback ACK real server integration', () => {

    test('reconnect replaces only the same process and split registration', async () => {
      const testSock = path.join(tmpdir(), `test-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const sockets: net.Socket[] = [];
      const disconnected: number[] = [];
      server.onDisconnect = client => { if (client.pid) disconnected.push(client.pid); };
      try {
        for (const pid of [101, 102, 101]) {
          const client = connectClient(testSock);
          sockets.push(client);
          const reader = createLineReader(client);
          await new Promise<void>(resolve => client.on('connect', resolve));
          client.write(JSON.stringify({ type: 'handshake', harness: 'pi', windowId: '7', pid, feedbackAck: true }) + '\n');
          expect((await reader.nextMessage()).ok).toBe(true);
        }
        const registered = server.getClients();
        expect(registered.map(client => client.pid).sort()).toEqual([101, 102]);
        expect(registered.find(client => client.pid === 101)?.socket.destroyed).toBe(false);
        expect(disconnected).toEqual([101]);
      } finally {
        for (const client of sockets) client.destroy();
        await server.stop();
      }
    });

    test('handshake feedbackAck: true then sendFeedback -> write ack succeeds', async () => {
      const testSock = path.join(tmpdir(), `test-feedback-ack-ok-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const client = connectClient(testSock);
      const reader = createLineReader(client);

      try {
        await new Promise<void>((r) => client.on('connect', () => r()));
        client.write(JSON.stringify({ type: 'handshake', harness: 'test-agent', feedbackAck: true }) + '\n');

        const ack = await reader.nextMessage();
        expect(ack.type).toBe('handshake:ack');
        expect(ack.ok).toBe(true);

        const clients = server.getClients();
        expect(clients.length).toBe(1);
        expect(clients[0].feedbackAck).toBe(true);

        const sendPromise = server.sendFeedback(clients[0], {
          draftId: 'draft-ack-1',
          text: 'Feedback text for agent',
        });

        const receivedMsg = await reader.nextMessage();
        expect(receivedMsg.event).toBe('design:send-feedback');
        expect(receivedMsg.draftId).toBe('draft-ack-1');
        expect(receivedMsg.text).toBe('Feedback text for agent');

        // Client ACKs the feedback
        client.write(JSON.stringify({
          type: 'design:feedback-ack',
          draftId: 'draft-ack-1',
          ok: true,
        }) + '\n');

        const deliveryResult = await sendPromise;
        expect(deliveryResult).toEqual({ ok: true });
      } finally {
        client.destroy();
        await server.stop();
      }
    });

    test('foreign socket ACK does not settle, correct socket ACK resolves', async () => {
      const testSock = path.join(tmpdir(), `test-feedback-foreign-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const client1 = connectClient(testSock);
      const client2 = connectClient(testSock);
      const reader1 = createLineReader(client1);
      const reader2 = createLineReader(client2);

      try {
        await Promise.all([
          new Promise<void>((r) => client1.on('connect', () => r())),
          new Promise<void>((r) => client2.on('connect', () => r())),
        ]);

        client1.write(JSON.stringify({ type: 'handshake', harness: 'agent-1', feedbackAck: true }) + '\n');
        client2.write(JSON.stringify({ type: 'handshake', harness: 'agent-2', feedbackAck: true }) + '\n');

        await Promise.all([reader1.nextMessage(), reader2.nextMessage()]);

        const registeredClient1 = server.getClients().find((c) => c.harness === 'agent-1');
        expect(registeredClient1).toBeDefined();
        if (!registeredClient1) throw new Error('Missing registered client');

        let settled = false;
        const sendPromise = server.sendFeedback(registeredClient1, {
          draftId: 'draft-foreign-test',
        }).then((res) => {
          settled = true;
          return res;
        });

        await reader1.nextMessage();

        // Foreign client (client2) sends ACK for draft-foreign-test
        client2.write(JSON.stringify({
          type: 'design:feedback-ack',
          draftId: 'draft-foreign-test',
          ok: true,
        }) + '\n');

        // Tick to let server process client2's ACK
        await new Promise((r) => setTimeout(r, 60));
        expect(settled).toBe(false);

        // Correct client (client1) sends ACK
        client1.write(JSON.stringify({
          type: 'design:feedback-ack',
          draftId: 'draft-foreign-test',
          ok: true,
        }) + '\n');

        const result = await sendPromise;
        expect(settled).toBe(true);
        expect(result).toEqual({ ok: true });
      } finally {
        client1.destroy();
        client2.destroy();
        await server.stop();
      }
    });

    test('legacy handshake (feedbackAck: false) returns unsupported and sends no event', async () => {
      const testSock = path.join(tmpdir(), `test-feedback-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const client = connectClient(testSock);
      const reader = createLineReader(client);

      try {
        await new Promise<void>((r) => client.on('connect', () => r()));
        client.write(JSON.stringify({ type: 'handshake', harness: 'legacy-agent', feedbackAck: false }) + '\n');

        const ack = await reader.nextMessage();
        expect(ack.type).toBe('handshake:ack');

        const clients = server.getClients();
        expect(clients.length).toBe(1);
        expect(clients[0].feedbackAck).toBe(false);

        const res = await server.sendFeedback(clients[0], {
          draftId: 'draft-legacy',
        });

        expect(res.ok).toBe(false);
        expect(res.error).toBe('Agent does not support feedback acceptance acknowledgement');

        // Verify no design:send-feedback event received by client
        let receivedUnexpected = false;
        reader.nextMessage(150).then(() => {
          receivedUnexpected = true;
        }).catch(() => {});

        await new Promise((r) => setTimeout(r, 200));
        expect(receivedUnexpected).toBe(false);
      } finally {
        client.destroy();
        await server.stop();
      }
    });

    test('client disconnect while pending resolves with unknown/disconnection error', async () => {
      const testSock = path.join(tmpdir(), `test-feedback-dc-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const client = connectClient(testSock);
      const reader = createLineReader(client);

      try {
        await new Promise<void>((r) => client.on('connect', () => r()));
        client.write(JSON.stringify({ type: 'handshake', harness: 'dc-agent', feedbackAck: true }) + '\n');

        await reader.nextMessage();
        const clients = server.getClients();
        expect(clients.length).toBe(1);

        const sendPromise = server.sendFeedback(clients[0], {
          draftId: 'draft-disconnect',
        });

        await reader.nextMessage();

        // Abruptly destroy client socket while feedback is pending
        client.destroy();

        const result = await sendPromise;
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/closed|disconnected|unknown/i);
      } finally {
        client.destroy();
        await server.stop();
      }
    });
  });

  describe('concurrency bound', () => {
    test('enforces max 16 in-flight handlers per client: 17th rejected, freeing slot allows new request', async () => {
      const testSock = path.join(tmpdir(), `test-concurrency-16-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const client = connectClient(testSock);
      const reader = createLineReader(client);

      const resolvers: Array<(val: any) => void> = [];
      let executeCount = 0;

      server.onRequest('test:rpc', () => {
        executeCount++;
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      });

      try {
        await new Promise<void>((r) => client.on('connect', () => r()));

        // Send 17 requests
        for (let i = 0; i < 17; i++) {
          client.write(JSON.stringify({ type: 'test:rpc', requestId: `req-${i}`, i }) + '\n');
        }

        // The 17th request should immediately receive the overcapacity error
        const overcapMsg = await reader.nextMessage();
        expect(overcapMsg).toEqual({
          type: 'test:rpc:response',
          requestId: 'req-16',
          ok: false,
          error: 'Too many outstanding requests',
        });

        // Exactly 16 handlers should have executed
        expect(executeCount).toBe(16);
        expect(resolvers.length).toBe(16);

        // Release the first deferred handler
        const firstResolver = resolvers.shift();
        if (!firstResolver) throw new Error('Missing resolver');
        firstResolver({ success: true, index: 0 });

        // First request receives its response
        const firstResponse = await reader.nextMessage();
        expect(firstResponse).toEqual({
          type: 'test:rpc:response',
          requestId: 'req-0',
          ok: true,
          data: { success: true, index: 0 },
        });

        // Now that capacity is freed (15 in flight), sending an 18th request succeeds
        client.write(JSON.stringify({ type: 'test:rpc', requestId: 'req-17', i: 17 }) + '\n');

        // Wait a tick for server to invoke handler
        await new Promise((r) => setTimeout(r, 30));
        expect(executeCount).toBe(17);
        expect(resolvers.length).toBe(16); // 15 original + 1 new

        // Resolve req-17
        const newResolver = resolvers.pop();
        if (!newResolver) throw new Error('Missing new resolver');
        newResolver({ success: true, index: 17 });

        const req17Response = await reader.nextMessage();
        expect(req17Response).toEqual({
          type: 'test:rpc:response',
          requestId: 'req-17',
          ok: true,
          data: { success: true, index: 17 },
        });

        // Clean up remaining resolvers
        for (const r of resolvers) {
          r({ cleaned: true });
        }
      } finally {
        client.destroy();
        await server.stop();
      }
    });

    test('handler error/throw frees capacity slot', async () => {
      const testSock = path.join(tmpdir(), `test-concurrency-throw-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const client = connectClient(testSock);
      const reader = createLineReader(client);

      const resolvers: Array<(val: any) => void> = [];
      let rejectFirst: ((err: any) => void) | null = null;

      server.onRequest('test:rpc', (msg) => {
        if (msg.requestId === 'req-throw') {
          return new Promise((_, reject) => {
            rejectFirst = reject;
          });
        }
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      });

      try {
        await new Promise<void>((r) => client.on('connect', () => r()));

        // Send 1 request that will throw
        client.write(JSON.stringify({ type: 'test:rpc', requestId: 'req-throw' }) + '\n');

        // Send 15 normal deferred requests
        for (let i = 0; i < 15; i++) {
          client.write(JSON.stringify({ type: 'test:rpc', requestId: `req-${i}` }) + '\n');
        }

        // Wait a bit to ensure 16 handlers are active
        await new Promise((r) => setTimeout(r, 30));

        // 17th request exceeds cap
        client.write(JSON.stringify({ type: 'test:rpc', requestId: 'req-over' }) + '\n');
        const overMsg = await reader.nextMessage();
        expect(overMsg.ok).toBe(false);
        expect(overMsg.error).toBe('Too many outstanding requests');

        // Trigger rejection on req-throw
        if (!rejectFirst) throw new Error('Missing rejectFirst');
        (rejectFirst as (err: any) => void)(new Error('Deliberate handler failure'));

        const throwMsg = await reader.nextMessage();
        expect(throwMsg.requestId).toBe('req-throw');
        expect(throwMsg.ok).toBe(false);
        expect(throwMsg.error).toContain('Deliberate handler failure');

        // Slot freed! Next request succeeds
        client.write(JSON.stringify({ type: 'test:rpc', requestId: 'req-after-throw' }) + '\n');
        await new Promise((r) => setTimeout(r, 30));
        expect(resolvers.length).toBe(16); // 15 + 1 new

        const popResolver = resolvers.pop();
        if (!popResolver) throw new Error('Missing resolver');
        popResolver({ ok: true });
        const successMsg = await reader.nextMessage();
        expect(successMsg.requestId).toBe('req-after-throw');
        expect(successMsg.ok).toBe(true);

        for (const r of resolvers) r({ ok: true });
      } finally {
        client.destroy();
        await server.stop();
      }
    });

    test('different clients have independent concurrency limits', async () => {
      const testSock = path.join(tmpdir(), `test-concurrency-clients-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const client1 = connectClient(testSock);
      const client2 = connectClient(testSock);
      const reader1 = createLineReader(client1);
      const reader2 = createLineReader(client2);

      const resolvers: Array<(val: any) => void> = [];

      server.onRequest('test:rpc', (msg) => {
        if (msg.quick) return { quick: true };
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      });

      try {
        await Promise.all([
          new Promise<void>((r) => client1.on('connect', () => r())),
          new Promise<void>((r) => client2.on('connect', () => r())),
        ]);

        // Client 1 fills 16 slots
        for (let i = 0; i < 16; i++) {
          client1.write(JSON.stringify({ type: 'test:rpc', requestId: `c1-req-${i}` }) + '\n');
        }

        // Client 1's 17th request fails
        client1.write(JSON.stringify({ type: 'test:rpc', requestId: 'c1-over' }) + '\n');
        const c1Over = await reader1.nextMessage();
        expect(c1Over.ok).toBe(false);
        expect(c1Over.error).toBe('Too many outstanding requests');

        // Client 2 sends a request - should succeed immediately!
        client2.write(JSON.stringify({ type: 'test:rpc', requestId: 'c2-req-0', quick: true }) + '\n');
        const c2Resp = await reader2.nextMessage();
        expect(c2Resp.requestId).toBe('c2-req-0');
        expect(c2Resp.ok).toBe(true);
        expect(c2Resp.data).toEqual({ quick: true });

        for (const r of resolvers) r({ ok: true });
      } finally {
        client1.destroy();
        client2.destroy();
        await server.stop();
      }
    });

    test('feedback ACK still works when request concurrency limit is full', async () => {
      const testSock = path.join(tmpdir(), `test-concurrency-ack-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const client = connectClient(testSock);
      const reader = createLineReader(client);

      const resolvers: Array<(val: any) => void> = [];
      server.onRequest('test:rpc', () => {
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      });

      try {
        await new Promise<void>((r) => client.on('connect', () => r()));

        // Handshake with feedbackAck
        client.write(JSON.stringify({ type: 'handshake', harness: 'ack-test-agent', feedbackAck: true }) + '\n');
        const ack = await reader.nextMessage();
        expect(ack.ok).toBe(true);

        const clients = server.getClients();
        expect(clients.length).toBe(1);

        // Fill all 16 slots with deferred requests
        for (let i = 0; i < 16; i++) {
          client.write(JSON.stringify({ type: 'test:rpc', requestId: `req-${i}` }) + '\n');
        }

        // Wait to ensure all 16 requests are received and active
        await new Promise((r) => setTimeout(r, 30));

        // Server sends feedback while client is completely saturated
        const sendPromise = server.sendFeedback(clients[0], {
          draftId: 'draft-saturated-client',
          text: 'testing ack bypass',
        });

        // Client should receive the design:send-feedback event (reads not paused!)
        const eventMsg = await reader.nextMessage();
        expect(eventMsg.event).toBe('design:send-feedback');
        expect(eventMsg.draftId).toBe('draft-saturated-client');

        // Client sends ACK - must bypass concurrency cap and settle promise
        client.write(JSON.stringify({
          type: 'design:feedback-ack',
          draftId: 'draft-saturated-client',
          ok: true,
        }) + '\n');

        const deliveryResult = await sendPromise;
        expect(deliveryResult).toEqual({ ok: true });

        for (const r of resolvers) r({ ok: true });
      } finally {
        client.destroy();
        await server.stop();
      }
    });

    test('unknown/unregistered messages do not consume handler concurrency slots', async () => {
      const testSock = path.join(tmpdir(), `test-concurrency-unknown-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const client = connectClient(testSock);
      const reader = createLineReader(client);

      const resolvers: Array<(val: any) => void> = [];
      let executeCount = 0;

      server.onRequest('test:rpc', () => {
        executeCount++;
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      });

      try {
        await new Promise<void>((r) => client.on('connect', () => r()));

        // Send 20 unknown messages
        for (let i = 0; i < 20; i++) {
          client.write(JSON.stringify({ type: `unknown:type:${i}`, requestId: `unk-${i}` }) + '\n');
        }

        // Now send 16 registered requests - all 16 should execute despite earlier unknown messages
        for (let i = 0; i < 16; i++) {
          client.write(JSON.stringify({ type: 'test:rpc', requestId: `req-${i}` }) + '\n');
        }

        await new Promise((r) => setTimeout(r, 50));
        expect(executeCount).toBe(16);

        // 17th fails
        client.write(JSON.stringify({ type: 'test:rpc', requestId: 'req-16' }) + '\n');
        const overMsg = await reader.nextMessage();
        expect(overMsg.ok).toBe(false);
        expect(overMsg.error).toBe('Too many outstanding requests');

        for (const r of resolvers) r({ ok: true });
      } finally {
        client.destroy();
        await server.stop();
      }
    });

    test('enforces total connected client cap: excess connection is destroyed without disrupting existing clients', async () => {
      const testSock = path.join(tmpdir(), `test-max-clients-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const server = await startIpcServer({ socketPath: testSock });
      const clients: net.Socket[] = [];

      try {
        // Connect up to MAX_CONNECTED_CLIENTS (32)
        for (let i = 0; i < 32; i++) {
          const c = connectClient(testSock);
          await new Promise<void>((r) => c.on('connect', () => r()));
          clients.push(c);
        }

        expect(server.getClientCount()).toBe(32);

        // 33rd client connection should be refused / destroyed
        const extraClient = connectClient(testSock);
        let extraClosed = false;
        await new Promise<void>((resolve) => {
          extraClient.on('close', () => {
            extraClosed = true;
            resolve();
          });
          extraClient.on('error', () => {
            extraClosed = true;
            resolve();
          });
        });

        expect(extraClosed).toBe(true);
        expect(server.getClientCount()).toBe(32);

        // Disconnecting one client allows a new one to connect
        const freed = clients.pop();
        freed?.destroy();
        await new Promise((r) => setTimeout(r, 20));
        expect(server.getClientCount()).toBe(31);

        const newClient = connectClient(testSock);
        await new Promise<void>((r) => newClient.on('connect', () => r()));
        clients.push(newClient);
        expect(server.getClientCount()).toBe(32);
      } finally {
        for (const c of clients) c.destroy();
        await server.stop();
      }
    });

    test('delayed handshake coalesced with RPC does not run RPC before handshake release', async () => {
      const testSock = path.join(tmpdir(), `test-handshake-fifo-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
      const order: string[] = [];
      let releaseHandshake: (() => void) | undefined;

      const server = await startIpcServer({ socketPath: testSock });
      server.onHandshake = () => {
        order.push('handshake:start');
        return new Promise<Record<string, unknown>>((resolve) => {
          releaseHandshake = () => {
            order.push('handshake:done');
            resolve({ handshakeOk: true });
          };
        });
      };

      server.onRequest('test:rpc', () => {
        order.push('rpc:executed');
        return { done: true };
      });

      const client = connectClient(testSock);
      const reader = createLineReader(client);

      try {
        await new Promise<void>((r) => client.on('connect', () => r()));

        // Coalesce handshake and RPC in the same chunk
        const payload =
          JSON.stringify({ type: 'handshake', harness: 'test' }) +
          '\n' +
          JSON.stringify({ type: 'test:rpc', requestId: 'rpc-1' }) +
          '\n';
        client.write(payload);

        // Allow some time for socket processing
        await new Promise((r) => setTimeout(r, 50));

        // RPC must NOT have executed while handshake is awaiting
        expect(order).toEqual(['handshake:start']);

        // Now release handshake
        if (!releaseHandshake) throw new Error('Handshake resolver missing');
        (releaseHandshake as () => void)();

        const handshakeAck = await reader.nextMessage();
        expect(handshakeAck.type).toBe('handshake:ack');
        expect(handshakeAck.ok).toBe(true);

        const rpcResp = await reader.nextMessage();
        expect(rpcResp.requestId).toBe('rpc-1');
        expect(rpcResp.ok).toBe(true);

        expect(order).toEqual(['handshake:start', 'handshake:done', 'rpc:executed']);
      } finally {
        client.destroy();
        await server.stop();
      }
    });
  });
});
