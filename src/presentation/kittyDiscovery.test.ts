import { describe, expect, it } from 'bun:test';
import {
  correlateWindowIdFromLs,
  findCandidateKittySockets,
  getProcessAncestors,
  pickTabNeighbor,
  probeSocket,
} from './kittyDiscovery';

describe('kittyDiscovery', () => {
  it('probeSocket rejects non-existent or invalid endpoints', async () => {
    expect(await probeSocket('')).toBe(false);
    expect(await probeSocket('unix:/tmp/non-existent-kitty-9999999.sock', 20)).toBe(false);
    expect(await probeSocket('tcp:127.0.0.1:1', 20)).toBe(false);
  });

  it('getProcessAncestors returns an array including current process PID', () => {
    const ancestors = getProcessAncestors();
    expect(Array.isArray(ancestors)).toBe(true);
    expect(ancestors.length).toBeGreaterThan(0);
    expect(ancestors[0]).toBe(process.pid);
  });

  it('findCandidateKittySockets returns an array of candidate socket objects', () => {
    const candidates = findCandidateKittySockets();
    expect(Array.isArray(candidates)).toBe(true);
  });

  it('correlateWindowIdFromLs finds window by ancestor PID match', () => {
    const fakeLs = [
      {
        id: 1,
        is_focused: true,
        tabs: [
          {
            id: 10,
            is_focused: true,
            windows: [
              {
                id: 101,
                pid: 12345,
                foreground_processes: [{ pid: 67890 }],
              },
              {
                id: 102,
                pid: 99999,
              },
            ],
          },
        ],
      },
    ];

    expect(correlateWindowIdFromLs(fakeLs, [67890])).toBe(101);
    expect(correlateWindowIdFromLs(fakeLs, [99999])).toBe(102);
    expect(correlateWindowIdFromLs(fakeLs, [11111])).toBe(101); // Falls back to first/focused
  });

  it('correlateWindowIdFromLs preserves preferredWindowId if it exists in session', () => {
    const fakeLs = [
      {
        id: 1,
        tabs: [
          {
            id: 10,
            windows: [
              { id: 54, pid: 100 },
              { id: 134, pid: 200 },
            ],
          },
        ],
      },
    ];

    expect(correlateWindowIdFromLs(fakeLs, [100], 134)).toBe(134);
    // If preferred is stale, it falls back to PID match
    expect(correlateWindowIdFromLs(fakeLs, [200], 999)).toBe(134);
  });

  it('pickTabNeighbor ignores closed windows that Kitty still lists as neighbors', () => {
    const tab = [
      { id: 436, neighbors: { right: [429] } },
      { id: 437, neighbors: { left: [428] } },
    ];
    expect(pickTabNeighbor(tab, 437)).toBe(436);
    expect(pickTabNeighbor(tab, 436)).toBe(437);
  });

  it('pickTabNeighbor prefers a live listed neighbor and finds none when alone', () => {
    const tab = [{ id: 1, neighbors: { top: [3] } }, { id: 2 }, { id: 3 }];
    expect(pickTabNeighbor(tab, 1)).toBe(3);
    expect(pickTabNeighbor([{ id: 1, neighbors: { left: [9] } }], 1)).toBeUndefined();
  });
});
