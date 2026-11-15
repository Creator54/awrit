import { expect, test } from 'bun:test';
import type { ConnectedClient } from '../ipc/socketServer';
import { type AgentPane, adoptPaneForHandshake, describeWindowViewers } from './agentIpc';

function pane(id: string, sourceWindowId: string): AgentPane {
  return {
    id,
    sourceWindowId,
    kittyWindowId: `${id}-kitty`,
    view: { destroyed: false },
  } as unknown as AgentPane;
}

test('an agent started later binds to the one viewer opened from its own window', () => {
  const own = pane('own', '429');
  const other = pane('other', '100');
  const client = {
    windowId: '429',
    socket: {},
    harness: 'pi',
    pid: 123,
    cwd: '/work',
  } as unknown as ConnectedClient;

  expect(adoptPaneForHandshake([own, other], client)).toEqual({
    adopted: true,
    paneId: 'own',
    kittyWindowId: 'own-kitty',
  });
  expect(own.view.binding).toMatchObject({
    state: 'bound',
    clientSocket: client.socket,
    sourceWindowId: '429',
  });
  expect(other.view.binding).toBeUndefined();
});

test('an agent does not bind to another window or guess between viewers', () => {
  const client = { windowId: '429', socket: {} } as unknown as ConnectedClient;
  expect(adoptPaneForHandshake([pane('other', '100')], client)).toEqual({ adopted: false });
  expect(adoptPaneForHandshake([pane('a', '429'), pane('b', '429')], client)).toEqual({
    adopted: false,
  });

  const closed = pane('closed', '429');
  closed.view.destroyed = true;
  expect(adoptPaneForHandshake([pane('live', '429'), closed], client)).toMatchObject({
    adopted: true,
    paneId: 'live',
  });
});

test('status lists only live viewers opened from the asking window', () => {
  const page = (url: string) => ({
    destroyed: false,
    content: {
      webContents: { getURL: () => url, isLoading: () => false, isDestroyed: () => false },
    },
  });
  const own = {
    id: 'own',
    sourceWindowId: '429',
    view: page('https://own/'),
  } as unknown as AgentPane;
  const other = {
    id: 'other',
    sourceWindowId: '100',
    view: page('https://other/'),
  } as unknown as AgentPane;
  const closed = {
    id: 'closed',
    sourceWindowId: '429',
    view: { ...page('x'), destroyed: true },
  } as unknown as AgentPane;
  expect(describeWindowViewers([own, other, closed], '429')).toEqual([
    { paneId: 'own', url: 'https://own/', loading: false, designMode: false },
  ]);
});
