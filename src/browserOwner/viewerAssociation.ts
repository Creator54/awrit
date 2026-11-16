import type { AgentPane } from './agentIpc';

/** Claim only an unowned viewer in the asking window's current tab. */
export function associateViewer(
  panes: AgentPane[],
  sourceWindowId: string,
  tabs: readonly (readonly string[])[],
): void {
  if (panes.some((pane) => !pane.view.destroyed && pane.sourceWindowId === sourceWindowId)) return;
  const tab = tabs.find((windows) => windows.includes(sourceWindowId));
  if (!tab) return;
  const liveWindows = new Set(tabs.flat());
  const candidates = panes.filter(
    (pane) =>
      !pane.view.destroyed &&
      pane.kittyWindowId !== undefined &&
      tab.includes(pane.kittyWindowId) &&
      !pane.view.binding?.clientSocket &&
      (!pane.sourceWindowId || !liveWindows.has(pane.sourceWindowId)),
  );
  if (candidates.length !== 1) return;
  const pane = candidates[0];
  pane.sourceWindowId = sourceWindowId;
  if (pane.view.binding) pane.view.binding.sourceWindowId = sourceWindowId;
}
