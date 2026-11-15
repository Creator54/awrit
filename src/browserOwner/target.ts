export interface PaneIdentity {
  id: string;
  sourceWindowId?: string;
  kittyWindowId?: string;
}

export interface PaneTarget {
  paneId?: string;
  sourceWindowId?: string;
  kittyWindowId?: string;
}

export type PaneMatchResult<T> = { ok: true; pane: T } | { ok: false; reason: 'no-match' };

export function matchPane<T extends PaneIdentity>(
  panes: T[],
  target: PaneTarget,
): PaneMatchResult<T> {
  const matches = panes.filter(
    (pane) =>
      (target.paneId === undefined || pane.id === target.paneId) &&
      (target.sourceWindowId === undefined || pane.sourceWindowId === target.sourceWindowId) &&
      (target.kittyWindowId === undefined || pane.kittyWindowId === target.kittyWindowId),
  );
  if (matches.length === 0) return { ok: false, reason: 'no-match' };
  if (matches.length !== 1)
    throw new Error('Ambiguous viewer target; specify paneId, sourceWindowId or kittyWindowId');
  return { ok: true, pane: matches[0] };
}

export function selectPane<T extends PaneIdentity>(panes: T[], target: PaneTarget): T {
  const result = matchPane(panes, target);
  if (!result.ok) throw new Error('No matching active viewer pane');
  return result.pane;
}
