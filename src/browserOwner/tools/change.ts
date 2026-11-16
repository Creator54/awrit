import type { WebContents } from 'electron';

export interface PageState {
  url: string;
  title: string;
}

export interface PageChange {
  url?: string;
  title?: string;
}

// Time for a click's effect (navigation, title update) to show up.
const SETTLE_MS = 250;

export function readPageState(wc: WebContents): PageState {
  return {
    url: typeof wc.getURL === 'function' ? wc.getURL() : '',
    title: typeof wc.getTitle === 'function' ? wc.getTitle() : '',
  };
}

/** Reports the URL and title only when they differ from `before`, so agents can skip a follow-up snapshot. */
export async function changeSince(wc: WebContents, before: PageState, settleMs = SETTLE_MS): Promise<PageChange> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const after = readPageState(wc);
  const change: PageChange = {};
  if (after.url !== before.url) change.url = after.url;
  if (after.title !== before.title) change.title = after.title;
  return change;
}
