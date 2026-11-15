import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearOverlayState,
  loadOverlayState,
  saveOverlayState,
  toggleOverlay,
} from './overlayToggle';

const originalAppData = process.env.XDG_DATA_HOME;
let tempDir: string;

describe('overlayToggle', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-test-appdata-'));
    process.env.XDG_DATA_HOME = tempDir;
  });

  afterEach(() => {
    if (originalAppData !== undefined) {
      process.env.XDG_DATA_HOME = originalAppData;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('loadOverlayState returns null when no state file exists', () => {
    expect(loadOverlayState(123)).toBeNull();
  });

  test('saveOverlayState and loadOverlayState persist data correctly', () => {
    saveOverlayState({
      sourceWindowId: 42,
      overlayWindowId: 99,
      target: 'https://example.com',
      updatedAt: 1000,
    });

    const state = loadOverlayState(42);
    expect(state).not.toBeNull();
    expect(state?.sourceWindowId).toBe(42);
    expect(state?.overlayWindowId).toBe(99);
    expect(state?.target).toBe('https://example.com');
  });

  test('clearOverlayState removes the state file', () => {
    saveOverlayState({
      sourceWindowId: 42,
      overlayWindowId: 99,
      updatedAt: 1000,
    });
    clearOverlayState(42);
    expect(loadOverlayState(42)).toBeNull();
  });

  test('toggleOverlay throws on conflicting options', async () => {
    expect(
      toggleOverlay({
        sourceWindowId: 1,
        close: true,
        status: true,
      }),
    ).rejects.toThrow('Cannot specify both close and status');
  });

  test('toggleOverlay status reports closed when no overlay recorded', async () => {
    const res = await toggleOverlay({
      sourceWindowId: 1,
      status: true,
      endpoint: 'unix:@test-endpoint',
    });
    expect(res).toEqual({
      action: 'status',
      open: false,
      source: 1,
      target: undefined,
    });
  });

  test('toggleOverlay status reports open when overlay is alive in Kitty', async () => {
    saveOverlayState({
      sourceWindowId: 1,
      overlayWindowId: 2,
      target: '127.0.0.1:5558',
      updatedAt: 1000,
    });

    const mockExec = mock((_bin: string, args: string[], _opts: any, cb: any) => {
      if (args.includes('ls')) {
        cb(
          null,
          JSON.stringify([
            {
              tabs: [
                {
                  windows: [{ id: 1 }, { id: 2 }],
                },
              ],
            },
          ]),
          '',
        );
      }
    });

    const res = await toggleOverlay({
      sourceWindowId: 1,
      status: true,
      endpoint: 'unix:@test-endpoint',
      execFileFn: mockExec as any,
      kittenBinary: 'kitten',
    });

    expect(res).toEqual({
      action: 'status',
      open: true,
      id: 2,
      source: 1,
      target: '127.0.0.1:5558',
    });
  });

  test('toggleOverlay status reports closed when overlay is in a different tab', async () => {
    saveOverlayState({
      sourceWindowId: 1,
      overlayWindowId: 2,
      target: '127.0.0.1:5558',
      updatedAt: 1000,
    });

    const mockExec = mock((_bin: string, args: string[], _opts: any, cb: any) => {
      if (args.includes('ls')) {
        cb(
          null,
          JSON.stringify([
            {
              tabs: [
                {
                  windows: [{ id: 1 }],
                },
                {
                  windows: [{ id: 2 }],
                },
              ],
            },
          ]),
          '',
        );
      }
    });

    const res = await toggleOverlay({
      sourceWindowId: 1,
      status: true,
      endpoint: 'unix:@test-endpoint',
      execFileFn: mockExec as any,
      kittenBinary: 'kitten',
    });

    expect(res).toEqual({
      action: 'status',
      open: false,
      source: 1,
      target: '127.0.0.1:5558',
    });
  });

  test('toggleOverlay status clears stale ID when overlay closed externally', async () => {
    saveOverlayState({
      sourceWindowId: 1,
      overlayWindowId: 2,
      target: '127.0.0.1:5558',
      updatedAt: 1000,
    });

    // Window 2 is missing from Kitty ls
    const mockExec = mock((_bin: string, args: string[], _opts: any, cb: any) => {
      if (args.includes('ls')) {
        cb(
          null,
          JSON.stringify([
            {
              tabs: [
                {
                  windows: [{ id: 1 }],
                },
              ],
            },
          ]),
          '',
        );
      }
    });

    const res = await toggleOverlay({
      sourceWindowId: 1,
      status: true,
      endpoint: 'unix:@test-endpoint',
      execFileFn: mockExec as any,
      kittenBinary: 'kitten',
    });

    expect(res).toEqual({
      action: 'status',
      open: false,
      source: 1,
      target: '127.0.0.1:5558',
    });

    // State on disk retained target but cleared overlayWindowId
    const state = loadOverlayState(1);
    expect(state?.overlayWindowId).toBeUndefined();
    expect(state?.target).toBe('127.0.0.1:5558');
  });

  test('toggleOverlay close closes alive overlay and retains target', async () => {
    saveOverlayState({
      sourceWindowId: 1,
      overlayWindowId: 2,
      target: '127.0.0.1:5558',
      updatedAt: 1000,
    });

    let closedWindowId: string | null = null;
    const mockExec = mock((_bin: string, args: string[], _opts: any, cb: any) => {
      if (args.includes('ls')) {
        cb(
          null,
          JSON.stringify([
            {
              tabs: [
                {
                  windows: [{ id: 1 }, { id: 2 }],
                },
              ],
            },
          ]),
          '',
        );
      } else if (args.includes('close-window')) {
        closedWindowId = args.find((a) => a.startsWith('--match=id:')) || null;
        cb(null, '', '');
      }
    });

    const res = await toggleOverlay({
      sourceWindowId: 1,
      close: true,
      endpoint: 'unix:@test-endpoint',
      execFileFn: mockExec as any,
      kittenBinary: 'kitten',
    });

    expect(res).toEqual({
      action: 'closed',
      previousId: 2,
      source: 1,
    });
    expect(closedWindowId).toBe('--match=id:2');

    const state = loadOverlayState(1);
    expect(state?.overlayWindowId).toBeUndefined();
    expect(state?.target).toBe('127.0.0.1:5558');
  });

  test('toggleOverlay opens new overlay and records state', async () => {
    const issued: string[][] = [];
    const mockExec = mock((_bin: string, args: string[], _opts: any, cb: any) => {
      issued.push(args);
      if (args.includes('ls')) {
        cb(
          null,
          JSON.stringify([
            {
              tabs: [
                {
                  windows: [
                    { id: 1, columns: 120 },
                    { id: 7, foreground_processes: [{ cmdline: ['/bin/awrit', 'show'] }] },
                  ],
                },
              ],
            },
          ]),
          '',
        );
      } else if (args.includes('launch')) {
        cb(null, '7\n', '');
      }
    });

    const res = await toggleOverlay({
      sourceWindowId: 1,
      target: '127.0.0.1:5558',
      endpoint: 'unix:@test-endpoint',
      execFileFn: mockExec as any,
      kittenBinary: 'kitten',
      env: { AWRIT_LAUNCHER: '/bin/awrit' },
    });

    expect(res).toEqual({
      action: 'opened',
      id: 7,
      source: 1,
      target: '127.0.0.1:5558',
      resumed: false,
      viewerRunning: true,
    });

    const state = loadOverlayState(1);
    expect(state?.overlayWindowId).toBe(7);
    expect(state?.target).toBe('127.0.0.1:5558');
    // Overlays inherit the source window's geometry; opening one must not touch spacing.
    expect(issued.flat().some((a) => a.includes('spacing') || a.includes('recent:'))).toBe(false);
  });

  test('toggleOverlay resumes remembered target when none provided', async () => {
    saveOverlayState({
      sourceWindowId: 1,
      target: '127.0.0.1:5558',
      updatedAt: 1000,
    });

    const mockExec = mock((_bin: string, args: string[], _opts: any, cb: any) => {
      if (args.includes('ls')) {
        cb(
          null,
          JSON.stringify([
            {
              tabs: [
                {
                  windows: [
                    { id: 1, columns: 120 },
                    { id: 8, foreground_processes: [{ cmdline: ['/bin/awrit', 'show'] }] },
                  ],
                },
              ],
            },
          ]),
          '',
        );
      } else if (args.includes('launch')) {
        cb(null, '8\n', '');
      }
    });

    const res = await toggleOverlay({
      sourceWindowId: 1,
      endpoint: 'unix:@test-endpoint',
      execFileFn: mockExec as any,
      kittenBinary: 'kitten',
      env: { AWRIT_LAUNCHER: '/bin/awrit' },
    });

    expect(res).toEqual({
      action: 'opened',
      id: 8,
      source: 1,
      target: '127.0.0.1:5558',
      resumed: true,
      viewerRunning: true,
    });
  });

  test('toggleOverlay closes old target when switching targets', async () => {
    saveOverlayState({
      sourceWindowId: 1,
      overlayWindowId: 5,
      target: 'https://site-a.com',
      updatedAt: 1000,
    });

    let closedOld = false;
    const mockExec = mock((_bin: string, args: string[], _opts: any, cb: any) => {
      if (args.includes('ls')) {
        cb(
          null,
          JSON.stringify([
            {
              tabs: [
                {
                  windows: [
                    { id: 1, columns: 120 },
                    { id: 5 },
                    { id: 9, foreground_processes: [{ cmdline: ['/bin/awrit', 'show'] }] },
                  ],
                },
              ],
            },
          ]),
          '',
        );
      } else if (args.includes('close-window')) {
        closedOld = true;
        cb(null, '', '');
      } else if (args.includes('launch')) {
        cb(null, '9\n', '');
      }
    });

    const res = await toggleOverlay({
      sourceWindowId: 1,
      target: 'https://site-b.com',
      endpoint: 'unix:@test-endpoint',
      execFileFn: mockExec as any,
      kittenBinary: 'kitten',
      env: { AWRIT_LAUNCHER: '/bin/awrit' },
    });

    expect(closedOld).toBe(true);
    expect(res).toEqual({
      action: 'opened',
      id: 9,
      source: 1,
      target: 'https://site-b.com',
      viewerRunning: true,
      resumed: false,
    });
  });
  describe('readiness', () => {
    const lsMock = (windowsFn: () => any[], launchId = '7\n') =>
      mock((_bin: string, args: string[], _opts: any, cb: any) => {
        if (args.includes('ls'))
          cb(null, JSON.stringify([{ tabs: [{ windows: windowsFn() }] }]), '');
        else if (args.includes('launch')) cb(null, launchId, '');
        else cb(null, '', '');
      });
    const base = {
      sourceWindowId: 1,
      target: 'https://example.com',
      endpoint: 'unix:@test-endpoint',
      env: { AWRIT_LAUNCHER: '/bin/awrit' },
    };

    test('window vanishes -> error and overlayWindowId cleared', async () => {
      const exec = lsMock(() => [{ id: 1, columns: 120 }]);
      await expect(
        toggleOverlay({ ...base, execFileFn: exec as any, kittenBinary: 'kitten' }),
      ).rejects.toThrow('closed before the viewer started');
      expect(loadOverlayState(1)?.overlayWindowId).toBeUndefined();
    });

    test('viewer never appears -> viewerRunning false after timeout', async () => {
      let t = 0;
      const exec = lsMock(() => [
        { id: 1, columns: 120 },
        { id: 7, foreground_processes: [{ cmdline: ['fish'] }] },
      ]);
      const res = await toggleOverlay({
        ...base,
        execFileFn: exec as any,
        kittenBinary: 'kitten',
        readyTimeoutMs: 1000,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      });
      expect(res).toMatchObject({ action: 'opened', id: 7, viewerRunning: false });
      expect(loadOverlayState(1)?.overlayWindowId).toBe(7);
    });

    test('viewer appears on later poll -> viewerRunning true', async () => {
      let polls = 0;
      const exec = lsMock(() => {
        polls++;
        const fg = polls > 3 ? ['/bin/electron', 'x'] : ['fish'];
        return [
          { id: 1, columns: 120 },
          { id: 7, foreground_processes: [{ cmdline: fg }] },
        ];
      });
      const res = await toggleOverlay({
        ...base,
        execFileFn: exec as any,
        kittenBinary: 'kitten',
        sleep: async () => {},
      });
      expect(res).toMatchObject({ action: 'opened', viewerRunning: true });
    });
  });
});
