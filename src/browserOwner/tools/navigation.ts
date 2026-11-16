import type { WebContents } from 'electron';
import type { DocumentId } from './dispatch';

interface Tracker {
  navId: number;
  last?: DocumentId;
}

/**
 * Gives each page a navigation counter that changes on every main-frame navigation
 * (the process id does not), and reports the document that just went away so queued
 * tool calls for it can be dropped.
 */
export function createNavigationTracker(onLeave: (doc: DocumentId) => void) {
  const trackers = new WeakMap<WebContents, Tracker>();

  return function currentDocument(wc: WebContents): DocumentId {
    let tracker = trackers.get(wc);
    if (!tracker) {
      const created: Tracker = { navId: 1 };
      trackers.set(wc, created);
      wc.on('did-navigate', () => {
        if (created.last) onLeave(created.last);
        created.navId += 1;
        created.last = undefined;
      });
      tracker = created;
    }
    const doc: DocumentId = { frameUrl: wc.getURL(), navId: tracker.navId };
    tracker.last = doc;
    return doc;
  };
}
