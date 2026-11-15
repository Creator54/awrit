import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { console_ } from '../console';
import {
  FeedbackDeliveryTracker,
  type FeedbackPayload,
  type DeliveryResult,
} from './feedbackDelivery';

export const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB
export const MAX_IN_FLIGHT_REQUESTS = 16;
export const MAX_CONNECTED_CLIENTS = 32;

export interface ConnectedClient {
  socket: net.Socket;
  harness?: string;
  windowId?: string;
  pid?: number;
  cwd?: string;
  registeredAt: number;
  feedbackAck?: boolean;
}

export interface IpcServer {
  socketPath: string;
  broadcast: (event: string, payload: Record<string, unknown>) => void;
  sendTo: (filter: (client: ConnectedClient) => boolean, event: string, payload: Record<string, unknown>) => number;
  sendFeedback: (client: ConnectedClient, payload: FeedbackPayload) => Promise<DeliveryResult>;
  onRequest: (type: string, handler: (payload: any, socket: net.Socket) => Promise<any> | any) => void;
  onDisconnect?: (client: ConnectedClient) => void;
  onHandshake?: (client: ConnectedClient, msg: any) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  stop: () => Promise<void>;
  getClientCount: () => number;
  getClients: () => ConnectedClient[];
}

export function getSocketPath(): string {
  if (process.env.AWRIT_IPC_SOCKET) {
    return process.env.AWRIT_IPC_SOCKET;
  }
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'awrit', 'ipc.sock');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return path.join('/tmp', `awrit-${uid}`, 'ipc.sock');
}

export async function isSocketAlive(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      return resolve(false);
    }
    const client = net.connect(socketPath);
    let resolved = false;

    const done = (alive: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      client.removeAllListeners();
      try {
        client.destroy();
      } catch {}
      resolve(alive);
    };

    const timer = setTimeout(() => done(false), timeoutMs);
    client.on('connect', () => done(true));
    client.on('error', () => done(false));
  });
}

export async function startIpcServer(options: { socketPath?: string } = {}): Promise<IpcServer> {
  if (activeServer) {
    return activeServer;
  }

  const socketPath = options.socketPath ?? getSocketPath();
  const socketDir = path.dirname(socketPath);

  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(socketDir, 0o700);
  } catch {}

  // Stale socket probe
  if (fs.existsSync(socketPath)) {
    const alive = await isSocketAlive(socketPath);
    if (alive) {
      console_.log(`[IPC] Another active Awrit instance is listening on ${socketPath}`);
    } else {
      try {
        fs.unlinkSync(socketPath);
      } catch (err) {
        console_.error(`[IPC] Failed to unlink stale socket at ${socketPath}:`, err);
      }
    }
  }

  const requestHandlers = new Map<string, (payload: any, socket: net.Socket) => Promise<any> | any>();
  const clients = new Map<net.Socket, ConnectedClient>();
  const tracker = new FeedbackDeliveryTracker();
  const server = net.createServer((socket) => {
    if (clients.size >= MAX_CONNECTED_CLIENTS) {
      socket.destroy();
      return;
    }

    const clientRecord: ConnectedClient = {
      socket,
      registeredAt: Date.now(),
    };
    clients.set(socket, clientRecord);

    let isCleanedUp = false;
    let currentLineBuffers: Buffer[] = [];
    let currentLineBytes = 0;
    let inFlightRequests = 0;

    const cleanupSocket = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      currentLineBuffers = [];
      currentLineBytes = 0;
      inFlightRequests = 0;
      tracker.disconnect(socket);
      const rec = clients.get(socket);
      clients.delete(socket);
      if (rec && ipcInstance.onDisconnect) {
        try {
          ipcInstance.onDisconnect(rec);
        } catch (err) {
          console_.error('[IPC] onDisconnect handler error:', err);
        }
      }
    };

    const rejectOffendingSocket = () => {
      cleanupSocket();
      socket.destroy();
    };

    socket.on('data', async (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const linesToProcess: string[] = [];
      let start = 0;

      while (start < buf.length) {
        const newlineIdx = buf.indexOf(0x0a, start);
        if (newlineIdx !== -1) {
          const slice = buf.subarray(start, newlineIdx);
          if (currentLineBytes + slice.length > MAX_LINE_BYTES) {
            rejectOffendingSocket();
            return;
          }

          let lineBuf: Buffer;
          if (currentLineBuffers.length === 0) {
            lineBuf = slice;
          } else {
            currentLineBuffers.push(slice);
            lineBuf = Buffer.concat(currentLineBuffers);
            currentLineBuffers = [];
          }
          currentLineBytes = 0;
          start = newlineIdx + 1;
          linesToProcess.push(lineBuf.toString('utf8'));
        } else {
          const slice = buf.subarray(start);
          currentLineBytes += slice.length;
          if (currentLineBytes > MAX_LINE_BYTES) {
            rejectOffendingSocket();
            return;
          }
          currentLineBuffers.push(slice);
          start = buf.length;
        }
      }

      for (const line of linesToProcess) {
        if (socket.destroyed) break;
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'design:feedback-ack') {
            if (typeof msg.draftId === 'string' && typeof msg.ok === 'boolean') {
              tracker.ack(socket, msg.draftId, msg.ok, typeof msg.error === 'string' ? msg.error : undefined);
            }
            continue;
          }

          // Handshake registration from client
          if (msg.type === 'handshake') {
            clientRecord.feedbackAck = msg.feedbackAck === true;
            if (msg.harness) clientRecord.harness = String(msg.harness);
            if (msg.windowId) clientRecord.windowId = String(msg.windowId);
            if (typeof msg.pid === 'number') clientRecord.pid = msg.pid;
            if (msg.cwd) clientRecord.cwd = String(msg.cwd);

            // Reconnecting the same agent process must not create another
            // feedback destination. Distinct processes in one split stay distinct.
            if (typeof clientRecord.pid === 'number' && Number.isSafeInteger(clientRecord.pid) && clientRecord.pid > 0 && clientRecord.windowId && clientRecord.harness) {
              for (const [previousSocket, previous] of clients) {
                if (previousSocket !== socket && previous.pid === clientRecord.pid && previous.windowId === clientRecord.windowId && previous.harness === clientRecord.harness) {
                  previousSocket.destroy();
                }
              }
            }

            const handshakeFn = ipcInstance.onHandshake;
            if (handshakeFn) {
              if (inFlightRequests >= MAX_IN_FLIGHT_REQUESTS) {
                const ack =
                  JSON.stringify({
                    type: 'handshake:ack',
                    ok: false,
                    error: 'Too many outstanding requests',
                  }) + '\n';
                if (!socket.destroyed && socket.writable) {
                  socket.write(ack);
                }
                continue;
              }

              inFlightRequests++;
              let extraAckData: Record<string, unknown> | undefined;
              try {
                const res = await handshakeFn(clientRecord, msg);
                if (res && typeof res === 'object') {
                  extraAckData = res;
                }
              } catch (err) {
                console_.error('[IPC] onHandshake handler error:', err);
              } finally {
                inFlightRequests = Math.max(0, inFlightRequests - 1);
              }

              // Send handshake ACK back to the client
              const ack =
                JSON.stringify({
                  type: 'handshake:ack',
                  ok: true,
                  ...(extraAckData ?? {}),
                }) + '\n';
              if (!socket.destroyed && socket.writable) {
                socket.write(ack);
              }
              continue;
            }

            // Send handshake ACK back to the client
            const ack =
              JSON.stringify({
                type: 'handshake:ack',
                ok: true,
              }) + '\n';
            if (!socket.destroyed && socket.writable) {
              socket.write(ack);
            }
            continue;
          }

          // Generic RPC request/response handling over IPC
          if (msg.type && requestHandlers.has(msg.type)) {
            const handler = requestHandlers.get(msg.type);
            if (!handler) continue;
            const requestId = msg.requestId;

            if (inFlightRequests >= MAX_IN_FLIGHT_REQUESTS) {
              if (requestId && !socket.destroyed && socket.writable) {
                socket.write(
                  JSON.stringify({
                    type: `${msg.type}:response`,
                    requestId,
                    ok: false,
                    error: 'Too many outstanding requests',
                  }) + '\n',
                );
              }
              continue;
            }

            inFlightRequests++;
            (async () => {
              try {
                const res = await handler(msg, socket);
                if (requestId && !socket.destroyed && socket.writable) {
                  socket.write(
                    JSON.stringify({
                      type: `${msg.type}:response`,
                      requestId,
                      ok: true,
                      data: res,
                    }) + '\n',
                  );
                }
              } catch (err: any) {
                if (requestId && !socket.destroyed && socket.writable) {
                  socket.write(
                    JSON.stringify({
                      type: `${msg.type}:response`,
                      requestId,
                      ok: false,
                      error: String(err?.message || err),
                    }) + '\n',
                  );
                }
              } finally {
                inFlightRequests = Math.max(0, inFlightRequests - 1);
              }
            })().catch((err) => {
              console_.error('[IPC] request handler error:', err);
            });
          }
        } catch {}
      }
    });

    socket.on('error', cleanupSocket);
    socket.on('close', cleanupSocket);
    socket.on('end', cleanupSocket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      try {
        fs.chmodSync(socketPath, 0o700);
      } catch {}
      resolve();
    });
  });

  const broadcast = (event: string, payload: Record<string, unknown>) => {
    const line = JSON.stringify({ event, ...payload }) + '\n';
    for (const socket of Array.from(clients.keys())) {
      try {
        if (!socket.destroyed && socket.writable) {
          socket.write(line);
        } else {
          clients.delete(socket);
        }
      } catch {
        clients.delete(socket);
      }
    }
  };

  const sendTo = (
    filter: (client: ConnectedClient) => boolean,
    event: string,
    payload: Record<string, unknown>,
  ): number => {
    const line = JSON.stringify({ event, ...payload }) + '\n';
    let sentCount = 0;
    for (const [socket, client] of Array.from(clients.entries())) {
      if (filter(client)) {
        try {
          if (!socket.destroyed && socket.writable) {
            socket.write(line);
            sentCount++;
          } else {
            clients.delete(socket);
          }
        } catch {
          clients.delete(socket);
        }
      }
    }
    return sentCount;
  };

  const stop = async (): Promise<void> => {
    tracker.dispose();
    for (const socket of Array.from(clients.keys())) {
      try {
        socket.destroy();
      } catch {}
    }
    clients.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    } catch {}

    if (activeServer?.socketPath === socketPath) {
      activeServer = null;
    }
  };

  const sendFeedback = (client: ConnectedClient, payload: FeedbackPayload): Promise<DeliveryResult> => {
    if (clients.get(client.socket) !== client || !client.feedbackAck) {
      return Promise.resolve({
        ok: false,
        error: 'Agent does not support feedback acceptance acknowledgement',
      });
    }
    return tracker.send(client.socket, payload);
  };

  const ipcInstance: IpcServer = {
    socketPath,
    broadcast,
    sendTo,
    sendFeedback,
    onRequest: (type, handler) => {
      requestHandlers.set(type, handler);
    },
    stop,
    getClientCount: () => clients.size,
    getClients: () => Array.from(clients.values()),
  };

  activeServer = ipcInstance;
  return ipcInstance;
}

let activeServer: IpcServer | null = null;

export function getIpcServer(): IpcServer | null {
  return activeServer;
}

export async function stopIpcServer(): Promise<void> {
  if (activeServer) {
    const s = activeServer;
    activeServer = null;
    await s.stop();
  }
}
