import type net from 'node:net';
import type { ConnectedClient } from './socketServer';

/**
 * Selects an unambiguous feedback destination client matching an explicit sourceWindowId.
 * Fails closed (returns undefined) if sourceWindowId is missing/empty, if no client matches,
 * or if multiple clients match without an active matching bound socket.
 */
export function selectFeedbackClient<T extends { socket: net.Socket; windowId?: string } = ConnectedClient>(
  clients: readonly T[],
  sourceWindowId?: string,
  boundSocket?: net.Socket,
): T | undefined {
  const explicitSource = sourceWindowId?.trim();
  if (!explicitSource) {
    return undefined;
  }

  const isSocketValid = (s: net.Socket | undefined): boolean => {
    return Boolean(s && !s.destroyed);
  };

  const matchingClients = clients.filter(
    (c) => Boolean(c.windowId && c.windowId === explicitSource && isSocketValid(c.socket)),
  );

  if (matchingClients.length === 0) {
    return undefined;
  }

  if (boundSocket && isSocketValid(boundSocket)) {
    const boundMatch = matchingClients.find((c) => c.socket === boundSocket);
    if (boundMatch) {
      return boundMatch;
    }
  }

  if (matchingClients.length === 1) {
    return matchingClients[0];
  }

  // Ambiguous multiple clients for the same source window without a matching active binding
  return undefined;
}
