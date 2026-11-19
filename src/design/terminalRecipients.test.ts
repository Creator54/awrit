import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectedClient, IpcServer } from '../ipc/socketServer';
import { createDesignIpcHarness, fakeWindowView } from './windowDesignIpcHarness';

test('shared review asks for a chat only during send, without a dropdown or polling', () => {
  const source = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  expect(source).not.toContain('<select');
  expect(source).not.toContain('Refresh connected agents');
  expect(source).not.toContain('setInterval');
  expect(source).toContain('Choose a chat');
  expect(source).toContain('recipientNotes = notes');
});

/** Only the members the design IPC asks of the socket server during a review send. */
function fakeServer(clients: () => ConnectedClient[], sent: unknown[]): IpcServer {
  return {
    socketPath: '/tmp/unused.sock',
    broadcast: () => {},
    sendTo: () => 0,
    sendFeedback: async (_client, payload) => {
      sent.push(payload);
      return { ok: true, id: 'delivery-1' };
    },
    onRequest: () => {},
    stop: async () => {},
    getClientCount: () => clients().length,
    getClients: () => clients(),
  };
}

function fakeClient(overrides: Partial<ConnectedClient> & { windowId: string }): ConnectedClient {
  return {
    harness: 'pi',
    socket: { destroyed: false } as net.Socket,
    registeredAt: Date.now(),
    feedbackAck: true,
    ...overrides,
  };
}

test('native source selection binds a real socket that delivers and acknowledges feedback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'awrit-review-routing-'));
  const dataHome = process.env.XDG_DATA_HOME;
  const runtimeDir = process.env.AWRIT_RUNTIME_DIR;
  process.env.XDG_DATA_HOME = dir;
  process.env.AWRIT_RUNTIME_DIR = dir;
  const { startIpcServer } = await import('../ipc/socketServer');
  const server = await startIpcServer({ socketPath: join(dir, 'ipc.sock') });
  const socket = net.connect(join(dir, 'ipc.sock'));
  const lines = createInterface({ input: socket });
  try {
    await once(socket, 'connect');
    const handshake = once(lines, 'line');
    socket.write(`${JSON.stringify({ type: 'handshake', harness: 'pi', windowId: 'source-7', feedbackAck: true })}\n`);
    expect(JSON.parse((await handshake)[0]).ok).toBe(true);

    // The real server, not a fake, is what `getIpcServer()` returns here.
    const harness = await createDesignIpcHarness({
      terminalReview: { windowId: '7', imagePath: join(dir, 'capture.png') },
      view: fakeWindowView({ binding: { sourceWindowId: 'source-7' } }),
      ipcServer: server,
    });
    const recipients = (await harness.invoke('awrit:list-review-recipients')) as {
      id: string;
      preferred: boolean;
    }[];
    expect(recipients).toHaveLength(1);
    expect(recipients[0]?.preferred).toBe(true);
    expect(await harness.invoke('awrit:select-review-recipient', recipients[0]?.id)).toBe(true);

    // A send after selection routes to the bound agent and quotes the review summary.
    const captureId = 'cap-0123456789ab';
    harness.setCaptureMeta({
      captureId,
      captureSha256: 'a'.repeat(64),
      pngDims: { width: 800, height: 600 },
      source: { kind: 'terminal', windowId: '7' },
    });
    const feedback = once(lines, 'line');
    const result = await harness.invoke('awrit:save-design-draft', {
      id: captureId,
      captureId,
      captureSha256: 'a'.repeat(64),
      version: 1,
      state: 'editing',
      annotations: [
        { id: 'note-1', comment: 'Native review feedback', selection: { kind: 'region', bounds: { x: 1, y: 2, width: 3, height: 4 } } },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    const sending = harness.invoke('awrit:send-design-feedback', {
      id: captureId,
      captureId,
      captureSha256: 'a'.repeat(64),
      version: 1,
      state: 'editing',
      annotations: [
        { id: 'note-1', comment: 'Native review feedback', selection: { kind: 'region', bounds: { x: 1, y: 2, width: 3, height: 4 } } },
      ],
    });
    const message = JSON.parse((await feedback)[0]);
    expect(message.event).toBe('design:send-feedback');
    expect(message.sourceWindowId).toBe('source-7');
    expect(message.summary).toContain('Native review feedback');
    socket.write(`${JSON.stringify({ type: 'design:feedback-ack', draftId: message.draftId, ok: true })}\n`);
    expect(await sending).toMatchObject({ ok: true });
  } finally {
    lines.close();
    socket.destroy();
    await server.stop();
    if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = dataHome;
    if (runtimeDir === undefined) delete process.env.AWRIT_RUNTIME_DIR;
    else process.env.AWRIT_RUNTIME_DIR = runtimeDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal review selection binds only a live explicitly listed agent', async () => {
  const client = fakeClient({ windowId: 'agent-7', harness: 'test' });
  let clients = [client];
  const harness = await createDesignIpcHarness({
    terminalReview: { windowId: '3', imagePath: '/tmp/review.png' },
    view: fakeWindowView({ binding: { sourceWindowId: 'tui-3' } }),
    ipcServer: fakeServer(() => clients, []),
  });

  const list = async () => (await harness.invoke('awrit:list-review-recipients')) as { id: string; label: string; preferred: boolean }[];
  const first = await list();
  expect(first).toEqual([{ id: first[0]?.id, label: 'test — split agent-7', preferred: false }]);
  expect(first[0]?.id).toMatch(/^[a-f0-9]{24}$/);
  // The opaque recipient id is stable across listings.
  expect(await list()).toEqual(first);

  // Only the toolbar can select, and only a listed live agent can be bound.
  expect(await harness.ipc.invoke('awrit:select-review-recipient', { sender: {} }, first[0]?.id)).toBe(false);
  expect(await harness.invoke('awrit:select-review-recipient', 'unknown')).toBe(false);
  expect(await harness.invoke('awrit:select-review-recipient', first[0]?.id)).toBe(true);
  expect(harness.view.binding?.sourceWindowId).toBe('agent-7');
  expect(await harness.invoke('awrit:select-review-recipient', first[0]?.id)).toBe(true);

  // A destroyed bound socket removes the preference, and ambiguity prefers nothing.
  const bound = harness.view.binding;
  if (!bound) throw new Error('binding missing');
  bound.clientSocket = { destroyed: true };
  expect((await list())[0]?.preferred).toBe(false);
  bound.clientSocket = undefined;
  clients = [client, fakeClient({ windowId: 'agent-7', harness: 'test' })];
  expect((await list()).some((entry) => entry.preferred)).toBe(false);

  // With one match again, the source window binds without a socket.
  clients = [client];
  expect((await list())[0]?.preferred).toBe(true);

  // Once the agent disconnects, a previously listed recipient cannot be selected.
  clients = [];
  expect(await harness.invoke('awrit:select-review-recipient', first[0]?.id)).toBe(false);
});
