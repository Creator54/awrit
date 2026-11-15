import { expect, test } from 'bun:test';
import type { AgentPane } from './agentIpc';
import { associateViewer } from './viewerAssociation';

function pane(id: string, sourceWindowId?: string): AgentPane {
  return {
    id,
    kittyWindowId: id,
    sourceWindowId,
    view: { destroyed: false },
  } as unknown as AgentPane;
}

test('a viewer opened before the agent split is associated on demand', () => {
  const viewer = pane('10');
  associateViewer([viewer], '11', [['10', '11']]);
  expect(viewer.sourceWindowId).toBe('11');
});

test('a viewer whose original terminal closed can be reclaimed in its current tab', () => {
  const viewer = pane('10', 'closed');
  associateViewer([viewer], '11', [['10', '11']]);
  expect(viewer.sourceWindowId).toBe('11');
});

test('never claims across tabs, a live source, a connected agent, or ambiguous viewers', () => {
  const elsewhere = pane('20');
  const owned = pane('10', '12');
  associateViewer([elsewhere, owned], '11', [['10', '11', '12'], ['20']]);
  expect(elsewhere.sourceWindowId).toBeUndefined();
  expect(owned.sourceWindowId).toBe('12');
  const bound = pane('10');
  bound.view.binding = { clientSocket: {} } as NonNullable<AgentPane['view']['binding']>;
  associateViewer([bound], '11', [['10', '11']]);
  expect(bound.sourceWindowId).toBeUndefined();
  const a = pane('10');
  const b = pane('12');
  associateViewer([a, b], '11', [['10', '11', '12']]);
  expect(a.sourceWindowId).toBeUndefined();
  expect(b.sourceWindowId).toBeUndefined();
});

test('preserves existing matches and ignores destroyed viewers', () => {
  const own = pane('10', '11');
  const unowned = pane('12');
  associateViewer([own, unowned], '11', [['10', '11', '12']]);
  expect(unowned.sourceWindowId).toBeUndefined();
  const dead = pane('13');
  dead.view.destroyed = true;
  associateViewer([dead], '11', [['11', '13']]);
  expect(dead.sourceWindowId).toBeUndefined();
});
