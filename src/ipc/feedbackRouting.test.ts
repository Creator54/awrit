import { describe, expect, it } from 'bun:test';
import type net from 'node:net';
import { selectFeedbackClient } from './feedbackRouting';
import type { ConnectedClient } from './socketServer';

function createMockSocket(destroyed = false): net.Socket {
  return {
    destroyed,
    write: () => true,
  } as unknown as net.Socket;
}

function createClient(
  windowId?: string,
  socket: net.Socket = createMockSocket(),
): ConnectedClient {
  return {
    socket,
    windowId,
    registeredAt: Date.now(),
  };
}

describe('selectFeedbackClient', () => {
  it('returns undefined when sourceWindowId is missing, empty, or whitespace', () => {
    const client = createClient('win-1');
    const clients = [client];

    expect(selectFeedbackClient(clients, undefined)).toBeUndefined();
    expect(selectFeedbackClient(clients, '')).toBeUndefined();
    expect(selectFeedbackClient(clients, '   ')).toBeUndefined();
  });

  it('returns undefined when clients list is empty', () => {
    expect(selectFeedbackClient([], 'win-1')).toBeUndefined();
  });

  it('returns undefined for foreign sourceWindowId (no matching windowId)', () => {
    const clients = [createClient('win-2'), createClient('win-3')];
    expect(selectFeedbackClient(clients, 'win-1')).toBeUndefined();
  });

  it('returns matching client for unique matching sourceWindowId', () => {
    const client1 = createClient('win-1');
    const client2 = createClient('win-2');
    const clients = [client1, client2];

    expect(selectFeedbackClient(clients, 'win-1')).toBe(client1);
  });

  it('chooses unique target even if boundSocket is stale or destroyed', () => {
    const client = createClient('win-1');
    const staleSocket = createMockSocket();
    const destroyedBoundSocket = createMockSocket(true);

    expect(selectFeedbackClient([client], 'win-1', staleSocket)).toBe(client);
    expect(selectFeedbackClient([client], 'win-1', destroyedBoundSocket)).toBe(client);
  });

  it('does not honor boundSocket if boundSocket belongs to a client with a different windowId', () => {
    const foreignSocket = createMockSocket();
    const foreignClient = createClient('win-foreign', foreignSocket);
    const targetClient = createClient('win-target');

    // Bound socket is registered to foreign window; exact source target is win-target
    expect(selectFeedbackClient([foreignClient, targetClient], 'win-target', foreignSocket)).toBe(
      targetClient,
    );
  });

  it('prefers current bound client when multiple clients match the same sourceWindowId', () => {
    const socketA = createMockSocket();
    const socketB = createMockSocket();
    const clientA = createClient('win-1', socketA);
    const clientB = createClient('win-1', socketB);

    expect(selectFeedbackClient([clientA, clientB], 'win-1', socketB)).toBe(clientB);
    expect(selectFeedbackClient([clientA, clientB], 'win-1', socketA)).toBe(clientA);
  });

  it('fails closed (no reconnect adjacency / no guessing) when multiple clients match without matching boundSocket', () => {
    const clientA = createClient('win-1');
    const clientB = createClient('win-1');
    const staleSocket = createMockSocket();

    // No bound socket
    expect(selectFeedbackClient([clientA, clientB], 'win-1')).toBeUndefined();

    // Stale bound socket that does not match either client
    expect(selectFeedbackClient([clientA, clientB], 'win-1', staleSocket)).toBeUndefined();
  });

  it('guards against destroyed client sockets', () => {
    const destroyedSocket = createMockSocket(true);
    const destroyedClient = createClient('win-1', destroyedSocket);
    const activeClient = createClient('win-1');

    // Destroyed client ignored; only active client remains as unique target
    expect(selectFeedbackClient([destroyedClient, activeClient], 'win-1')).toBe(activeClient);

    // If only destroyed client exists, return undefined
    expect(selectFeedbackClient([destroyedClient], 'win-1')).toBeUndefined();
  });
});
