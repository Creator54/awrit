import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import FakeTimers from '@sinonjs/fake-timers';
import { DEFAULT_ANDROID_KEYS } from '../designKey';
import {
  computeStreamDimensions,
  createRawFrameReader,
  detectAdbDevice,
  findBinary,
  getDeviceResolution,
  startAdbControl,
  textInputCommand,
} from './adbControl';
import { getAdbHtml } from './template';

// One viewer page session: a new gesture epoch per press and a monotonic event sequence.
const viewerPage = { id: 'testsession', epoch: 0, seq: 0 };
function gestureEvent(phase: 'down' | 'move' | 'up', x: unknown = 0, y: unknown = 0) {
  if (phase === 'down') viewerPage.epoch++;
  return { phase, id: viewerPage.id, epoch: viewerPage.epoch, seq: ++viewerPage.seq, x, y };
}

describe('ADB Control', () => {
  test('JPEG stream packets preserve frames across whole, coalesced and split chunks', () => {
    const source = readFileSync(new URL('./adbControl.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    let buffer');
    const end = source.indexOf('    let finished = false;', start);
    const parser = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
    const first = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(1024, 1),
      Buffer.from([0xff, 0xd9]),
    ]);
    const second = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(1024, 2),
      Buffer.from([0xff, 0xd9]),
    ]);
    const frameTail = Buffer.from('\r\n--frame\r\nContent-Type: image/jpeg\r\n\r\n');
    for (const [chunks, frames] of [
      [
        [first, second],
        [first, second],
      ],
      [[Buffer.concat([first, second])], [second]],
      [
        [
          first.subarray(0, 1),
          first.subarray(1, first.length - 1),
          first.subarray(first.length - 1),
        ],
        [first],
      ],
      [
        [
          first.subarray(0, 100),
          Buffer.concat([first.subarray(100), second.subarray(0, 1)]),
          second.subarray(1),
        ],
        [first, second],
      ],
    ]) {
      const handlers = new Map<string, (chunk: Buffer) => void>();
      const packets: Buffer[] = [];
      let now = 0;
      const context = vm.createContext({
        Buffer,
        Date: {
          now: () => {
            now += 20;
            return now;
          },
        },
        encoder: {
          stdout: {
            on: (event: string, handler: (chunk: Buffer) => void) => handlers.set(event, handler),
          },
        },
        connected: true,
        latestFrame: null,
        lastFrameSent: 0,
        fpsCount: 0,
        frameTail,
        activeClients: [
          { writableNeedDrain: false, write: (packet: Buffer) => packets.push(packet) },
        ],
      });
      vm.runInContext(parser, context);
      const consume = handlers.get('data');
      if (!consume) throw new Error('Stream listener was not registered');
      for (const chunk of chunks) consume(chunk);
      expect(packets).toEqual(frames.map((frame) => Buffer.concat([frame, frameTail])));
    }
  });

  test('stream packets are copied once only when a viewer can receive them', () => {
    const source = readFileSync(new URL('./adbControl.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    let buffer');
    const parser = new Bun.Transpiler({ loader: 'ts' }).transformSync(
      source.slice(start, source.indexOf('    let finished = false;', start)),
    );
    const frame = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(1024, 1),
      Buffer.from([0xff, 0xd9]),
    ]);
    const frameTail = Buffer.from('\r\n--frame\r\nContent-Type: image/jpeg\r\n\r\n');
    for (const blocked of [[], [true, true], [false], [true, false, false]]) {
      let copies = 0;
      let consume: ((chunk: Buffer) => void) | undefined;
      const packets: Buffer[] = [];
      const context = vm.createContext({
        Buffer: {
          alloc: Buffer.alloc,
          from: Buffer.from,
          concat: (parts: readonly Uint8Array[]) => {
            copies++;
            return Buffer.concat(parts);
          },
        },
        Date: { now: () => 20 },
        encoder: {
          stdout: {
            on: (_event: string, handler: (chunk: Buffer) => void) => {
              consume = handler;
            },
          },
        },
        connected: true,
        latestFrame: null,
        lastFrameSent: 0,
        fpsCount: 0,
        frameTail,
        activeClients: blocked.map((writableNeedDrain) => ({
          writableNeedDrain,
          write: (packet: Buffer) => packets.push(packet),
        })),
      });
      vm.runInContext(parser, context);
      if (!consume) throw new Error('Stream listener was not registered');
      consume(frame);
      const writable = blocked.filter((value) => !value).length;
      expect(copies).toBe(writable ? 1 : 0);
      expect(packets).toHaveLength(writable);
      for (const packet of packets) {
        expect(packet).toBe(packets[0]);
        expect(packet).toEqual(Buffer.concat([frame, frameTail]));
      }
      expect(context.latestFrame).toEqual(frame);
      expect(context.fpsCount).toBe(1);
      expect(context.lastFrameSent).toBe(20);
    }
  });

  test('encoder workers scale with stream pixels and available CPUs', () => {
    const source = readFileSync(new URL('./adbControl.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    const encoderThreads =');
    const initializer = source.slice(start, source.indexOf(';', start) + 1);
    for (const [streamWidth, streamHeight, cpus, expected] of [
      [584, 1032, 16, 1],
      [904, 1600, 16, 1],
      [1920, 1080, 16, 1],
      [2560, 1440, 16, 2],
      [2160, 3840, 16, 4],
      [2160, 3840, 2, 2],
      [2160, 3840, 1, 1],
    ]) {
      const context = vm.createContext({
        streamWidth,
        streamHeight,
        availableParallelism: () => cpus,
      });
      expect(vm.runInContext(`${initializer}\nencoderThreads;`, context)).toBe(expected);
    }
  });

  test('pane-owned streams keep device, resize and stop lifetimes independent', async () => {
    const source = readFileSync(new URL('./adbControl.ts', import.meta.url), 'utf8');
    const functions = source.slice(source.indexOf('let activeInstance')).replaceAll('export ', '');
    const servers: Array<{ closed: boolean }> = [];
    const timers = new Set<() => void>();
    const children: Array<{ args: string[]; killed: boolean }> = [];
    const context = vm.createContext({
      Buffer,
      AbortController,
      ADB_FALLBACKS: [],
      findBinary: (name: string) => name,
      existsSync: () => true,
      detectAdbDevice: async (device: string) => device,
      getDeviceResolution: async () => ({ width: 1080, height: 1920 }),
      readDeviceResolution: async () => ({ width: 1080, height: 1920 }),
      setInterval: () => 1,
      clearInterval: () => {},
      computeStreamDimensions,
      getAdbHtml: () => '',
      readAndroidKeyConfig: () => ({ leader: '<Space>', keys: {} }),
      availableParallelism: () => 2,
      http: {
        createServer: () => {
          const server = Object.assign(new EventEmitter(), {
            closed: false,
            listen(_port: number, _host: string, ready: () => void) {
              queueMicrotask(ready);
            },
            address: () => ({ port: 10000 + servers.length }),
            close() {
              this.closed = true;
            },
          });
          servers.push(server);
          return server;
        },
      },
      spawn(_binary: string, args: string[]) {
        const child = Object.assign(new EventEmitter(), {
          args,
          killed: false,
          stdout: Object.assign(new EventEmitter(), { pipe() {} }),
          stdin: new EventEmitter(),
          kill() {
            this.killed = true;
            return true;
          },
        });
        children.push(child);
        return child;
      },
      setTimeout(handler: () => void) {
        timers.add(handler);
        return handler;
      },
      clearTimeout: (handler: () => void) => timers.delete(handler),
    });
    vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(functions), context);
    expect(vm.runInContext('typeof createAdbControl', context)).toBe('function');
    const first = await vm.runInContext('createAdbControl("first")', context);
    const second = await vm.runInContext('createAdbControl("second")', context);
    await Promise.resolve();
    expect(first.device).toBe('first');
    expect(second.device).toBe('second');
    expect(first.port).not.toBe(second.port);
    first.resize({ width: 400, height: 500 });
    first.stop();
    expect(servers.map((server) => server.closed)).toEqual([true, false]);
    expect(
      children.filter((child) => child.args.includes('second')).every((child) => !child.killed),
    ).toBe(true);
    second.resize({ width: 600, height: 700 });
    expect(timers.size).toBe(1);
    second.stop();
    expect(servers.every((server) => server.closed)).toBe(true);
    expect(children.every((child) => child.killed)).toBe(true);
    expect(timers.size).toBe(0);
    const legacy = await vm.runInContext('startAdbControl("legacy")', context);
    expect(await vm.runInContext('startAdbControl("ignored")', context)).toBe(legacy);
    const independent = await vm.runInContext('createAdbControl("independent")', context);
    independent.stop();
    expect(await vm.runInContext('startAdbControl()', context)).toBe(legacy);
    vm.runInContext('stopAdbControl()', context);
    const restarted = await vm.runInContext('startAdbControl("restarted")', context);
    expect(restarted.device).toBe('restarted');
    expect(restarted).not.toBe(legacy);
    vm.runInContext('stopAdbControl()', context);
  });

  test('failed listener startup never launches or restarts the stream pipeline', async () => {
    const source = readFileSync(new URL('./adbControl.ts', import.meta.url), 'utf8');
    const functions = source.slice(source.indexOf('let activeInstance')).replaceAll('export ', '');
    const children: EventEmitter[] = [];
    const timers = new Set<() => void>();
    const server = Object.assign(new EventEmitter(), {
      listen() {
        queueMicrotask(() => server.emit('error', new Error('listen denied')));
      },
    });
    const context = vm.createContext({
      Buffer,
      AbortController,
      ADB_FALLBACKS: [],
      findBinary: (name: string) => name,
      existsSync: () => true,
      detectAdbDevice: async () => 'device',
      getDeviceResolution: async () => ({ width: 1080, height: 1920 }),
      readDeviceResolution: async () => ({ width: 1080, height: 1920 }),
      setInterval: () => 1,
      clearInterval: () => {},
      computeStreamDimensions,
      getAdbHtml: () => '',
      readAndroidKeyConfig: () => ({ leader: '<Space>', keys: {} }),
      http: { createServer: () => server },
      spawn() {
        const child = Object.assign(new EventEmitter(), {
          stdout: Object.assign(new EventEmitter(), { pipe() {} }),
          stdin: new EventEmitter(),
          kill: () => true,
        });
        children.push(child);
        return child;
      },
      setTimeout(handler: () => void) {
        timers.add(handler);
        return handler;
      },
      clearTimeout: (handler: () => void) => timers.delete(handler),
    });
    vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(functions), context);
    await expect(vm.runInContext('startAdbControl()', context)).rejects.toThrow('listen denied');
    vm.runInContext('stopAdbControl()', context);
    for (const child of children) child.emit('close');
    expect(children).toHaveLength(0);
    expect(timers.size).toBe(0);
  });

  test('contextual controls preserve local keyboard focus and return keys to Android', async () => {
    const requests: string[] = [];
    const handlers: Record<string, (event: any) => void> = {};
    let focused = '';
    let expanded = 'false';
    const button = {
      focus: () => {
        focused = 'button';
      },
    };
    const controls = { hidden: true, querySelector: () => button };
    const element = {
      addEventListener() {},
      focus: () => {
        focused = 'screen';
      },
    };
    const toggle = {
      setAttribute: (_: string, value: string) => {
        expanded = value;
      },
    };
    const context = vm.createContext({
      document: {
        getElementById: (id: string) =>
          id === 'android-controls' ? controls : id === 'controls-toggle' ? toggle : element,
        querySelectorAll: () => [],
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
      },
      window: {
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
      },
      fetch: async (_route: string, options?: { body: string }) => {
        if (options) requests.push(JSON.parse(options.body).keycode);
        return { ok: true, json: async () => ({ fps: 0 }) };
      },
      AbortSignal,
      setTimeout: () => 0,
      setInterval: () => 0,
    });
    const html = getAdbHtml(1080, 1920);
    expect(html).toContain('id="android-controls" hidden');
    expect(html).toContain('[hidden] { display: none !important; }');
    vm.runInContext(html.split('<script>')[1].split('</script>')[0], context);
    const key = (value: string, local = false, altKey = false, repeat = false) => {
      let prevented = false;
      handlers.keydown({
        key: value,
        altKey,
        repeat,
        target: { closest: () => (local ? button : null) },
        preventDefault: () => {
          prevented = true;
        },
      });
      return prevented;
    };
    expect(key('c', false, true)).toBe(true);
    expect(controls.hidden).toBe(false);
    expect(expanded).toBe('true');
    expect(focused).toBe('button');
    expect(key('c', true, true, true)).toBe(true);
    expect(controls.hidden).toBe(false);
    let wheelPrevented = false;
    handlers.wheel({
      target: { closest: () => button },
      preventDefault: () => {
        wheelPrevented = true;
      },
    });
    expect(wheelPrevented).toBe(false);
    for (const value of ['Tab', 'Enter', ' ']) expect(key(value, true)).toBe(false);
    expect(key('Escape', true)).toBe(true);
    expect(controls.hidden).toBe(true);
    expect(expanded).toBe('false');
    expect(focused).toBe('screen');
    expect(key('ArrowLeft')).toBe(true);
    expect(key('Home', false, true)).toBe(true);
    await vm.runInContext('controlQueue', context);
    expect(requests).toEqual(['KEYCODE_DPAD_LEFT', 'KEYCODE_HOME']);

    const defaultHtml = getAdbHtml(1080, 1920);
    expect(defaultHtml).toContain("'Escape': 'KEYCODE_BACK'");
    const overlayHtml = getAdbHtml(1080, 1920, 'device', undefined, true);
    expect(overlayHtml).not.toContain("'Escape': 'KEYCODE_BACK'");
  });
  test('leader key drives Android actions and the controls toggle stays out of the way', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    const requests: Array<{ route: string; body: any }> = [];
    const clicks: string[] = [];
    const windowHandlers: Record<string, () => void> = {};
    const revoked: string[] = [];
    const timers = new Set<() => void>();
    let focused = '';
    let expanded = 'false';
    const button = {
      focus: () => {
        focused = 'button';
      },
    };
    const controls = { hidden: true, querySelector: () => button };
    const element = {
      addEventListener() {},
      focus: () => {
        focused = 'screen';
      },
    };
    const toggle = {
      setAttribute: (_: string, value: string) => {
        expanded = value;
      },
    };
    const context = vm.createContext({
      document: {
        getElementById: (id: string) =>
          id === 'android-controls' ? controls : id === 'controls-toggle' ? toggle : element,
        querySelectorAll: () => [],
        createElement: () => ({ click: () => clicks.push('screenshot') }),
        body: { appendChild() {}, removeChild() {} },
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
      },
      window: { addEventListener: (name: string, handler: () => void) => { windowHandlers[name] = handler; } },
      fetch: async (route: string, options?: { body: string }) => {
        if (options) requests.push({ route, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ fps: 0 }), blob: async () => 'jpeg' };
      },
      URL: { createObjectURL: () => 'blob:shot', revokeObjectURL: (url: string) => revoked.push(url) },
      AbortSignal,
      setTimeout(handler: () => void) {
        timers.add(handler);
        return handler;
      },
      clearTimeout: (handler: () => void) => timers.delete(handler),
      setInterval: () => 0,
    });
    const html = getAdbHtml(1080, 1920, 'phone', undefined, false, {
      leader: '<A-d>',
      keys: DEFAULT_ANDROID_KEYS,
    });
    expect(html).toContain('#controls-toggle { opacity: 0');
    expect(html).toContain('pointer-events: none');
    expect(html).toContain('#controls-toggle:hover');
    expect(html).toContain('#controls-hotzone {');
    expect(html).toContain('\\u003cA-d>');
    expect(html).toContain('"screenshot":"s"');
    // The shipped leader has no modifier, so it stays inert instead of eating typed spaces.
    expect(getAdbHtml(1080, 1920)).toContain('\\u003cSpace>');
    vm.runInContext(html.split('<script>')[1].split('</script>')[0], context);
    const press = (value: string, modifiers: Record<string, boolean> = {}) => {
      let prevented = false;
      handlers.keydown({
        key: value,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        target: { tagName: 'IMG', closest: () => null },
        preventDefault: () => {
          prevented = true;
        },
        ...modifiers,
      });
      return prevented;
    };
    const settle = () => vm.runInContext('controlQueue', context);

    // Leader, then Back; neither key reaches the phone as text.
    expect(press('d', { altKey: true })).toBe(true);
    expect(press('b')).toBe(true);
    await settle();
    expect(requests.map((request) => request.route)).toEqual(['/key']);
    expect(requests.at(-1)?.body.keycode).toBe('KEYCODE_BACK');

    // c toggles the controls, Escape closes them, unknown letters are swallowed.
    press('d', { altKey: true });
    press('c');
    expect(controls.hidden).toBe(false);
    expect(expanded).toBe('true');
    expect(focused).toBe('button');
    expect(press('Escape')).toBe(true);
    expect(controls.hidden).toBe(true);
    expect(focused).toBe('screen');
    expect(press('d', { altKey: true })).toBe(true);
    expect(press('q')).toBe(true);
    await settle();
    expect(requests).toHaveLength(1);
    expect(vm.runInContext('hud.textContent', context)).toBe('Leader cancelled');

    // Repeats and bare modifier presses leave a pending leader alone.
    press('d', { altKey: true });
    expect(press('Shift')).toBe(false);
    press('x', { repeat: true });
    expect(press('o')).toBe(true);
    await settle();
    expect(requests.at(-1)?.body.keycode).toBe('KEYCODE_HOME');

    // o is Home, r rotates, s saves a screenshot.
    press('d', { altKey: true });
    press('o');
    await settle();
    expect(requests.at(-1)?.body.keycode).toBe('KEYCODE_HOME');
    press('d', { altKey: true });
    press('r');
    await settle();
    expect(requests.at(-1)?.route).toBe('/rotate');
    press('d', { altKey: true });
    press('s');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clicks).toEqual(['screenshot']);
    expect(element.textContent).toBe('Screenshot download started');
    expect(revoked).toEqual([]);
    for (const timer of [...timers]) timer();
    expect(revoked).toEqual(['blob:shot']);

    // AltGr produces text, not Alt shortcuts, even with a pending leader.
    press('d', { altKey: true });
    const beforeAltGr = requests.length;
    expect(press('@', { ctrlKey: true, altKey: true, getModifierState: (key: string) => key === 'AltGraph' })).toBe(true);
    await settle();
    expect(requests.slice(beforeAltGr)).toEqual([{ route: '/text', body: { text: '@' } }]);
    expect(press('b', { ctrlKey: true, altKey: true, getModifierState: (key: string) => key === 'AltGraph' })).toBe(true);
    await settle();
    expect(requests.at(-1)).toEqual({ route: '/text', body: { text: 'b' } });
    const beforeUnsupported = requests.length;
    press('€', { ctrlKey: true, altKey: true, getModifierState: (key: string) => key === 'AltGraph' });
    await settle();
    expect(requests).toHaveLength(beforeUnsupported);
    expect(element.textContent).toBe('Only printable ASCII text is supported');

    // A pending leader times out and the following key types normally again.
    press('d', { altKey: true });
    for (const timer of [...timers]) timer();
    expect(vm.runInContext('hud.textContent', context)).toBe('Leader timed out');
    expect(press('b')).toBe(true);
    await settle();
    expect(requests.at(-1)?.body.text).toBe('b');

    // Losing focus cancels a pending leader rather than consuming typing on return.
    for (const leave of [
      () => windowHandlers.blur(),
      () => windowHandlers.pagehide(),
      () => {
        vm.runInContext("document.visibilityState = 'hidden'", context);
        handlers.visibilitychange({});
      },
    ]) {
      press('d', { altKey: true });
      leave();
      expect(press('b')).toBe(true);
      await settle();
      expect(requests.at(-1)?.body.text).toBe('b');
    }

    // Spaces and Alt+C keep their old behaviour.
    expect(press(' ')).toBe(true);
    await settle();
    expect(requests.at(-1)?.body.text).toBe(' ');
    press('c', { altKey: true });
    expect(controls.hidden).toBe(false);
    press('c', { altKey: true });
    expect(controls.hidden).toBe(true);
  });

  test('stream sizing fits the viewport and preserves explicit maximums', () => {
    expect(computeStreamDimensions(1080, 2400, undefined, { width: 1800, height: 600 })).toEqual({
      streamWidth: 272,
      streamHeight: 600,
    });
    expect(computeStreamDimensions(1920, 1080, undefined, { width: 600, height: 1800 })).toEqual({
      streamWidth: 600,
      streamHeight: 336,
    });
    expect(computeStreamDimensions(320, 640, undefined, { width: 1920, height: 2400 })).toEqual({
      streamWidth: 320,
      streamHeight: 640,
    });
    expect(computeStreamDimensions(2160, 3840, undefined, { width: 4000, height: 4000 })).toEqual({
      streamWidth: 904,
      streamHeight: 1600,
    });
    expect(computeStreamDimensions(1080, 2400, 1280, { width: 200, height: 400 })).toEqual({
      streamWidth: 576,
      streamHeight: 1280,
    });
    for (const viewport of [
      { width: 0, height: 600 },
      { width: 600, height: -1 },
      { width: NaN, height: 600 },
      { width: 600, height: Infinity },
    ]) {
      expect(computeStreamDimensions(1080, 2400, undefined, viewport)).toEqual(
        computeStreamDimensions(1080, 2400),
      );
    }
    expect(computeStreamDimensions(1080, 2400, 0, { width: 1800, height: 600 })).toEqual({
      streamWidth: 272,
      streamHeight: 600,
    });
    expect(computeStreamDimensions(1080, 2400, undefined, { width: 1, height: 1 })).toEqual({
      streamWidth: 128,
      streamHeight: 128,
    });
  });
  test('controls use the shared chrome and clear the toggle', () => {
    const html = getAdbHtml(1080, 1920);
    expect(html).toContain('--control-size: 44px;');
    expect(html).toContain(
      'right: calc(var(--space-2) + var(--control-size) + var(--space-1));',
    );
    expect(html).toContain('button:focus-visible { outline: 2px solid var(--ui-accent)');
    expect(html).not.toContain('#4ade80');
  });
  test('idle status skips unchanged HUD writes and restores control feedback', async () => {
    let text = '';
    let writes = 0;
    let online = true;
    let responseOk = true;
    let now = 100;
    let status = { fps: 0, hasFrame: true, w: 1080, h: 2400 };
    const element = {
      get textContent() {
        return text;
      },
      set textContent(value: string) {
        text = value;
        writes++;
      },
      addEventListener() {},
    };
    const context = vm.createContext({
      document: {
        getElementById: () => element,
        querySelectorAll: () => [],
        addEventListener() {},
      },
      window: { addEventListener() {} },
      fetch: async () => {
        if (!online) throw new Error('offline');
        return { ok: responseOk, json: async () => status };
      },
      setTimeout: () => 0,
      setInterval: () => 0,
    });
    vm.runInContext(getAdbHtml(1080, 2400).split('<script>')[1].split('</script>')[0], context);
    context.now = () => now;
    vm.runInContext('Date.now = now', context);
    const update = () => vm.runInContext('updateStatus()', context);
    await update();
    await update();
    expect(writes).toBe(1);
    expect(text).toContain('Live · idle');
    status = { ...status, fps: 30 };
    await update();
    expect(writes).toBe(2);
    expect(text).toContain('30 FPS');
    responseOk = false;
    await update();
    expect(text).toBe('Offline');
    responseOk = true;
    await update();
    expect(text).toContain('30 FPS');
    vm.runInContext(`sendText(${JSON.stringify("unsupported\ntext")})`, context);
    const warning = text;
    await update();
    expect(text).toBe(warning);
    expect(text).toBe('Only printable ASCII text is supported');
    responseOk = false;
    await update();
    expect(text).toBe('Offline');
    const offlineWrites = writes;
    await update();
    expect(writes).toBe(offlineWrites);
    responseOk = true;
    now += 5001;
    await update();
    expect(text).toContain('30 FPS');
    const writesBeforeResize = writes;
    status = { ...status, w: 2400, h: 1080 };
    await update();
    expect(writes).toBe(writesBeforeResize + 1);
    expect(text).toContain('(2400x1080)');
    element.textContent = 'Wake';
    await update();
    expect(writes).toBe(writesBeforeResize + 3);
    expect(text).toContain('30 FPS');
    online = false;
    await update();
    await update();
    expect(writes).toBe(writesBeforeResize + 4);
    expect(text).toBe('Offline');
    online = true;
    await update();
    expect(writes).toBe(writesBeforeResize + 5);
  });
  test('text preserves printable characters through the remote shell and rejects unsupported text', () => {
    const text =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()_+[]{};:"\'\\|,<.>/?`~ %s 100%';
    const script = `input() { printf '%s\\0' "$2"; }; ${textInputCommand(text)}`;
    const result = spawnSync('/bin/sh', ['-c', script]);
    expect(result.status).toBe(0);
    expect(
      result.stdout
        .toString()
        .split('\0')
        .filter(Boolean)
        .map((part) => part.replace(/%s/g, ' '))
        .join(''),
    ).toBe(text);
    for (const value of ['', 'x\ny', '\t', '\0', 'é', '😀', 'a'.repeat(257), null]) {
      expect(() => textInputCommand(value)).toThrow();
    }
    const html = getAdbHtml(1080, 2400);
    const scriptSource = html.split('<script>')[1].split('</script>')[0];
    expect(() => new vm.Script(scriptSource)).not.toThrow();
    expect(html).not.toContain('focus-proxy');

    const namedHtml = getAdbHtml(1080, 2400, 'device-test-123');
    expect(namedHtml).toContain('Awrit ADB: device-test-123');
    expect(namedHtml).toContain('btn-screenshot');

    // Dynamic stream dimensions preservation across portrait & landscape
    const portrait = computeStreamDimensions(1080, 2400);
    expect(portrait.streamWidth).toBe(720);
    expect(portrait.streamHeight).toBe(1600);

    const landscape = computeStreamDimensions(1920, 1080);
    expect(landscape.streamWidth).toBe(1600);
    expect(landscape.streamHeight).toBe(904);

    const customMax = computeStreamDimensions(1080, 2400, 1280);
    expect(customMax.streamWidth).toBe(576);
    expect(customMax.streamHeight).toBe(1280);
  });
  test('viewer forwards printable/editing keys and queues controls in event order', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    const element = {
      clientWidth: 360,
      clientHeight: 800,
      naturalWidth: 720,
      naturalHeight: 1600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 800 }),
      addEventListener: (name: string, handler: (event: any) => void) => {
        handlers[name] = handler;
      },
    };
    const requests: Array<{ route: string; body: any }> = [];
    let failNextText = false;
    const context = vm.createContext({
      document: {
        getElementById: () => element,
        querySelectorAll: () => [],
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
      },
      window: {
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
      },
      fetch: async (route: string, options?: { body: string }) => {
        if (options) requests.push({ route, body: JSON.parse(options.body) });
        const fail = !!options && route === '/text' && failNextText;
        if (fail) failNextText = false;
        return { ok: !fail, json: async () => ({ fps: 0 }) };
      },
      AbortSignal,
      setTimeout: () => 0,
      setInterval: () => 0,
      clearTimeout() {},
    });
    const html = getAdbHtml(1080, 2400);
    vm.runInContext(html.split('<script>')[1].split('</script>')[0], context);
    const key = (value: string, modifiers = {}) =>
      handlers.keydown({
        key: value,
        target: { tagName: 'BODY' },
        preventDefault() {},
        ...modifiers,
      });
    for (const event of [
      { key: 'a', isComposing: true }, { key: 'Escape', keyCode: 229 },
    ]) handlers.keydown({ ...event, preventDefault() { throw new Error('Composition must stay native'); } });
    await vm.runInContext('controlQueue', context);
    expect(requests).toEqual([]);

    const printable = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32));
    for (const value of printable) key(value);
    for (const value of [
      'Backspace',
      'Delete',
      'Enter',
      'Tab',
      'Home',
      'End',
      'ArrowLeft',
      'ArrowRight',
    ])
      key(value);
    key('a', { ctrlKey: true });
    key('c', { ctrlKey: true });
    key('ArrowLeft', { shiftKey: true });
    key('C', { ctrlKey: true, shiftKey: true });
    handlers.paste({ clipboardData: { getData: () => 'p'.repeat(300) }, preventDefault() {} });
    await vm.runInContext('controlQueue', context);
    expect(requests[0].body.text).toBe(printable.join(''));
    expect(requests.filter(request => request.route === '/text').length).toBe(3);
    expect(requests[1].body.keycode).toBe('KEYCODE_DEL');
    expect(requests[9].body.keycodes).toEqual([113, 29]);
    expect(requests[10].body.keycodes).toEqual([59, 21]);
    // Plain Ctrl+C sent nothing (Awrit's quit key); Ctrl+Shift+C copies on the phone.
    expect(requests[11].body.keycodes).toEqual([113, 31]);
    expect(requests.slice(12).map((request) => request.body.text.length)).toEqual([256, 44]);
    key('x');
    key('Backspace');
    key('y');
    await vm.runInContext('controlQueue', context);
    expect(requests.slice(-3).map(request => request.body)).toEqual([
      { text: 'x' }, { keycode: 'KEYCODE_DEL' }, { text: 'y' },
    ]);
    handlers.touchstart({ touches: [{ clientX: 180, clientY: 300 }], preventDefault() {} });
    handlers.touchend({ touches: [], changedTouches: [{ clientX: 182, clientY: 302 }] });
    await vm.runInContext('controlQueue', context);
    expect(requests.at(-1)?.route).toBe('/tap');
    const beforePaste = requests.length;
    failNextText = true;
    handlers.paste({ clipboardData: { getData: () => 'q'.repeat(800) }, preventDefault() {} });
    await vm.runInContext('controlQueue', context);
    expect(requests.slice(beforePaste).map(request => request.body.text.length)).toEqual([256]);
    expect((element as any).textContent).toBe('Typing stopped: some text may already be entered');
    key('z');
    await vm.runInContext('controlQueue', context);
    expect(requests.at(-1)?.body.text).toBe('z');
  });

  test('wheel ticks drive one continuous gesture and lift it when the pointer goes quiet', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    const element = {
      clientWidth: 736,
      clientHeight: 1079,
      naturalWidth: 720,
      naturalHeight: 1600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 736, height: 1079 }),
      addEventListener: (name: string, handler: (event: any) => void) => {
        handlers[name] = handler;
      },
    };
    const gestures: any[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let fail = false;
    const releases: Array<() => void> = [];
    const context: any = vm.createContext({
      document: {
        getElementById: () => element,
        querySelectorAll: () => [],
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
      },
      window: {
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
      },
      fetch: async (route: string, options?: { body: string }) => {
        if (!options) return { ok: true, json: async () => ({ fps: 0 }) };
        gestures.push({ route, at: clock.now, ...JSON.parse(options.body), keepalive: options.keepalive });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight--;
        return { ok: !fail };
      },
      AbortSignal,
      Date,
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
    });
    const clock = FakeTimers.withGlobal(context).install({
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
    });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const release = async () => {
      releases.shift()?.();
      await settle();
    };
    const drain = async () => {
      while (releases.length) await release();
      await settle();
    };
    try {
      vm.runInContext(getAdbHtml(1080, 2400).split('<script>')[1].split('</script>')[0], context);
      const wheel = (deltaY: number, deltaX = 0) =>
        handlers.wheel({
          target: element,
          deltaY,
          deltaX,
          deltaMode: 0,
          clientX: 368,
          clientY: 540,
          preventDefault() {},
        });
      const phases = () => gestures.map((gesture) => gesture.phase);

      let outsidePrevented = false;
      handlers.wheel({ target: element, deltaY: 24, deltaX: 0, deltaMode: 0,
        clientX: -100, clientY: -100, preventDefault() { outsidePrevented = true; } });
      await settle();
      expect(outsidePrevented).toBe(false);
      expect(gestures).toEqual([]);

      // 13 ticks in one 8ms-per-tick burst: one finger down, coalesced moves, one lift.
      for (let i = 0; i < 13; i++) {
        wheel(24);
        clock.tick(8);
        await settle();
        await drain();
      }
      clock.tick(200);
      await settle();
      await drain();
      expect(maxInFlight).toBe(1);
      expect(gestures.every((gesture) => gesture.route === '/gesture')).toBe(true);
      expect(phases()[0]).toBe('down');
      expect(phases().at(-1)).toBe('up');
      expect(phases().filter((phase) => phase === 'down')).toHaveLength(1);
      expect(phases().filter((phase) => phase === 'up')).toHaveLength(1);
      const moves = gestures.filter((gesture) => gesture.phase === 'move');
      expect(moves.length).toBeLessThan(13);
      for (let i = 1; i < moves.length; i++)
        expect(moves[i].at - moves[i - 1].at).toBeGreaterThanOrEqual(16);
      const scale = Math.max(1080 / 736, 2400 / 1079);
      const travel = gestures[0].y - moves.at(-1).y;
      expect(travel).toBeCloseTo(13 * 24 * scale * 0.55, -1);
      // Moves stay inside the same margins the old swipe segments used.
      expect(gestures.every((gesture) => gesture.y >= 240 && gesture.y <= 2159)).toBe(true);
      expect(gestures[0].x).toBe(540);
      expect(vm.runInContext('scrollActive', context)).toBe(false);

      // A long scroll flick-restarts at the margin instead of stalling there.
      gestures.length = 0;
      for (let i = 0; i < 60; i++) {
        wheel(24);
        clock.tick(8);
        await settle();
        await drain();
      }
      const restart = phases().indexOf('down', 1);
      expect(restart).toBeGreaterThan(0);
      expect(phases()[restart - 1]).toBe('up');
      expect(gestures[restart].y).toBeGreaterThan(2100);
      expect(gestures.slice(restart).some((gesture) => gesture.phase === 'move')).toBe(true);
      clock.tick(200);
      await settle();
      await drain();

      // Pointer leaving the image lifts the finger immediately.
      gestures.length = 0;
      wheel(24);
      clock.tick(16);
      await settle();
      await drain();
      const lastMove = gestures.at(-1);
      handlers.pointerleave({});
      await settle();
      await drain();
      expect(phases().at(-1)).toBe('up');
      expect(gestures.at(-1).x).toBe(lastMove.x);
      expect(gestures.at(-1).y).toBe(lastMove.y);
      expect(vm.runInContext('scrollActive', context)).toBe(false);

      // Window blur lifts it too, and the next wheel starts a fresh down.
      gestures.length = 0;
      wheel(-24);
      clock.tick(16);
      await settle();
      await drain();
      handlers.blur({});
      await settle();
      await drain();
      expect(phases()).toEqual(['down', 'move', 'up']);
      gestures.length = 0;
      wheel(24, 24);
      clock.tick(16);
      await settle();
      await drain();
      expect(gestures[0].phase).toBe('down');
      expect(gestures[0].y).toBeGreaterThanOrEqual(240);
      handlers.blur({});
      await settle();
      await drain();

      // Page unload lifts the finger with a keepalive request that outlives the page.
      gestures.length = 0;
      wheel(24);
      clock.tick(16);
      await settle();
      await drain();
      handlers.pagehide({});
      await settle();
      await drain();
      expect(phases().at(-1)).toBe('up');
      expect(gestures.at(-1).keepalive).toBe(true);

      // Horizontal wheel moves only x, clamped to the horizontal margins.
      gestures.length = 0;
      wheel(0, 150);
      clock.tick(16);
      await settle();
      await drain();
      const horizontal = gestures.filter((gesture) => gesture.phase === 'move');
      expect(horizontal.length).toBeGreaterThan(0);
      expect(horizontal.every((gesture) => gesture.y === gestures[0].y)).toBe(true);
      expect(horizontal.at(-1).x).toBeLessThan(gestures[0].x);
      expect(horizontal.at(-1).x).toBeGreaterThanOrEqual(87);
      clock.tick(200);
      await settle();
      await drain();

      // A failed `down` posts no moves and clears the backlog instead of replaying it later.
      gestures.length = 0;
      fail = true;
      for (let i = 0; i < 20; i++) wheel(24);
      clock.tick(16);
      await settle();
      await drain();
      expect(phases()).toEqual(['down']);
      expect(vm.runInContext('scrollPending', context)).toBe(0);
      expect(vm.runInContext('scrollActive', context)).toBe(false);
      fail = false;
      clock.tick(200);
      await settle();
      await drain();
    } finally {
      clock.uninstall();
    }
  });

  test('a press that travels becomes a live drag and a still press stays a tap', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    const element = {
      clientWidth: 736,
      clientHeight: 1079,
      naturalWidth: 720,
      naturalHeight: 1600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 736, height: 1079 }),
      addEventListener: (name: string, handler: (event: any) => void) => {
        handlers[name] = handler;
      },
    };
    const requests: any[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const context: any = vm.createContext({
      document: {
        getElementById: () => element,
        querySelectorAll: () => [],
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
        visibilityState: 'visible',
      },
      window: {
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
      },
      fetch: async (route: string, options?: { body: string }) => {
        if (!options) return { ok: true, json: async () => ({ fps: 0 }) };
        requests.push({ route, ...JSON.parse(options.body) });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight--;
        return { ok: true };
      },
      AbortSignal,
      Date,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    const clock = FakeTimers.withGlobal(context).install({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const drain = async () => {
      while (releases.length) {
        releases.shift()?.();
        await settle();
      }
      await settle();
    };
    const pointer = (name: string, clientX: number, clientY: number) =>
      handlers[name]({ clientX, clientY, target: element, preventDefault() {} });
    // The image is letterboxed horizontally, so client x/y map onto 1080x2400 device pixels.
    const deviceY = (clientY: number) => Math.round((clientY / 1079) * 2400);
    const deviceX = (clientX: number) => Math.round(((clientX - 125.225) / 485.55) * 1080);
    try {
      vm.runInContext(getAdbHtml(1080, 2400).split('<script>')[1].split('</script>')[0], context);

      // A press that stays inside the tap threshold sends nothing until release.
      pointer('mousedown', 368, 900);
      pointer('mousemove', 368, 890);
      clock.tick(20);
      await settle();
      await drain();
      expect(requests).toHaveLength(0);
      pointer('mouseup', 368, 901);
      await settle();
      await drain();
      expect(requests.map((request) => request.route)).toEqual(['/tap']);

      // Past the threshold the press becomes a live gesture from the press point.
      requests.length = 0;
      pointer('mousedown', 368, 900);
      pointer('mousemove', 368, 850);
      await settle();
      await drain();
      expect(requests.map((request) => request.phase)).toEqual(['down']);
      expect(requests[0]).toMatchObject({ x: deviceX(368), y: deviceY(900) });

      // Moves follow the pointer, coalesced to one request in flight.
      clock.tick(16);
      await settle();
      await drain();
      pointer('mousemove', 368, 800);
      pointer('mousemove', 368, 750);
      clock.tick(16);
      await settle();
      await drain();
      expect(maxInFlight).toBe(1);
      expect(requests.at(-1).phase).toBe('move');
      expect(requests.at(-1)).toMatchObject({ x: deviceX(368), y: deviceY(750) });

      // A finger held still keeps re-sending its point, so the server's idle lift spares it.
      const beforeHold = requests.length;
      clock.tick(400 + 16);
      await settle();
      await drain();
      expect(requests.length).toBeGreaterThan(beforeHold);
      expect(requests.at(-1)).toMatchObject({ phase: 'move', x: deviceX(368), y: deviceY(750) });

      // Releasing lifts the finger where the pointer stopped; no synthetic swipe is used.
      pointer('mouseup', 368, 750);
      await settle();
      await drain();
      expect(requests.at(-1).phase).toBe('up');
      expect(requests.at(-1)).toMatchObject({ x: deviceX(368), y: deviceY(750) });
      expect(requests.every((request) => request.route === '/gesture')).toBe(true);
      expect(vm.runInContext('dragHeld', context)).toBe(false);

      // Pressing during a wheel scroll lifts that scroll before the press takes over.
      requests.length = 0;
      handlers.wheel({
        target: element,
        deltaY: 24,
        deltaX: 0,
        deltaMode: 0,
        clientX: 368,
        clientY: 540,
        preventDefault() {},
      });
      clock.tick(16);
      await settle();
      await drain();
      expect(vm.runInContext('scrollActive', context)).toBe(true);
      requests.length = 0;
      pointer('mousedown', 368, 900);
      await settle();
      await drain();
      expect(requests.map((request) => request.phase)).toEqual(['up']);
      expect(vm.runInContext('scrollActive', context)).toBe(false);
      pointer('mouseup', 368, 900);
      await settle();
      await drain();
    } finally {
      clock.uninstall();
    }
  });

  /** The real template in a vm, with an endpoint that answers each request after a delay. */
  function delayedGestureHarness(ackMs = 100) {
    const handlers: Record<string, (event: any) => void> = {};
    const element = {
      clientWidth: 736,
      clientHeight: 1079,
      naturalWidth: 720,
      naturalHeight: 1600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 736, height: 1079 }),
      addEventListener: (name: string, handler: (event: any) => void) => {
        handlers[name] = handler;
      },
    };
    const requests: any[] = [];
    const stats = { inFlight: 0, maxInFlight: 0 };
    const due: Array<{ at: number; release: () => void }> = [];
    // Requests a test keeps unanswered until it releases them itself.
    const held: Array<{ body: any; release: (ok: boolean) => void }> = [];
    let holdWhen: (body: any) => boolean = () => false;
    let failMoves = false;
    let clock: any;
    const context: any = vm.createContext({
      document: {
        getElementById: () => element,
        querySelectorAll: () => [],
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
        visibilityState: 'visible',
      },
      window: {
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
      },
      fetch: (route: string, options?: { body: string; keepalive?: boolean }) => {
        if (!options) return Promise.resolve({ ok: true, json: async () => ({ fps: 0 }) });
        const body = JSON.parse(options.body);
        const entry = { route, at: clock.now, ...body, keepalive: options.keepalive };
        requests.push(entry);
        stats.inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        const ok = !(failMoves && body.phase === 'move');
        return new Promise((resolve) => {
          const settleRequest = (answer: boolean) => {
            stats.inFlight--;
            entry.ackAt = clock.now;
            resolve({ ok: answer });
          };
          if (holdWhen(body)) {
            held.push({ body, release: settleRequest });
            return;
          }
          due.push({
            at: clock.now + ackMs,
            release: () => settleRequest(ok),
          });
        });
      },
      AbortSignal,
      Date,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    clock = FakeTimers.withGlobal(context).install({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const releaseDue = async () => {
      const dueNow = due.filter((entry) => entry.at <= clock.now);
      for (const entry of dueNow) due.splice(due.indexOf(entry), 1);
      for (const entry of dueNow) entry.release();
      await settle();
    };
    // Advances the viewer's clock in frames, answering requests once their delay has passed.
    const run = async (ms: number) => {
      const end = clock.now + ms;
      while (clock.now < end) {
        clock.tick(Math.min(16, end - clock.now));
        await settle();
        await releaseDue();
      }
    };
    const deviceX = (clientX: number) => Math.round(((clientX - 125.225) / 485.55) * 1080);
    const deviceY = (clientY: number) => Math.round((clientY / 1079) * 2400);
    const pointer = (name: string, clientX: number, clientY: number) =>
      handlers[name]({ clientX, clientY, target: element, preventDefault() {} });
    vm.runInContext(getAdbHtml(1080, 2400).split('<script>')[1].split('</script>')[0], context);
    return {
      clock,
      context,
      handlers,
      requests,
      stats,
      run,
      pointer,
      deviceX,
      deviceY,
      setFailMoves: (value: boolean) => {
        failMoves = value;
      },
      /** Keeps matching requests unanswered until releaseHeld() answers them in order. */
      setHold: (when: (body: any) => boolean) => {
        holdWhen = when;
      },
      held,
      releaseHeld: async (ok: boolean) => {
        held.shift()?.release(ok);
        await settle();
      },
    };
  }

  test('touch pointer leave before touchend does not cancel a tap', async () => {
    const { handlers, clock, requests, run } = delayedGestureHarness(100);
    try {
      const finger = { clientX: 368, clientY: 900 };
      handlers.touchstart({ touches: [finger], preventDefault() {} });
      handlers.pointerleave({ pointerType: 'touch' });
      handlers.touchend({ touches: [], changedTouches: [finger], preventDefault() {} });
      await run(10);
      expect(requests.filter(request => request.route === '/tap')).toHaveLength(1);
    } finally { clock.uninstall(); }
  });

  test('touch presses suppress compatibility mouse events', () => {
    const { handlers, clock } = delayedGestureHarness(100);
    let prevented = 0;
    try {
      handlers.touchstart({
        touches: [{ clientX: 368, clientY: 900 }],
        preventDefault() { prevented++; },
      });
      expect(prevented).toBe(1);
    } finally { clock.uninstall(); }
  });

  test('two-finger scroll measures centroid movement, not the last lifted finger', async () => {
    const { handlers, run, requests, clock } = delayedGestureHarness(100);
    const touches = (y: number) => [260, 460].map(clientX => ({ clientX, clientY: y }));
    const end = (y: number) => {
      handlers.touchend({ touches: touches(y).slice(0, 1), changedTouches: touches(y).slice(1), preventDefault() {} });
      handlers.touchend({ touches: [], changedTouches: touches(y).slice(0, 1), preventDefault() {} });
    };
    try {
      handlers.touchstart({ touches: touches(800), preventDefault() {} });
      end(800);
      await run(500);
      expect(requests).toEqual([]);
      handlers.touchstart({ touches: touches(800), preventDefault() {} });
      handlers.touchmove({ touches: touches(600), preventDefault() {} });
      end(600);
      await run(1500);
      expect(requests.some(request => request.phase === 'down')).toBe(true);
      expect(requests.some(request => request.phase === 'up')).toBe(true);
    } finally { clock.uninstall(); }
  });

  test('unsupported three-finger gestures cancel without creating a phone press', async () => {
    const { handlers, run, context, requests, clock } = delayedGestureHarness(100);
    const touches = [300, 368, 430].map(clientX => ({ clientX, clientY: 700 }));
    try {
      handlers.touchstart({ touches: touches.slice(0, 2), preventDefault() {} });
      expect(vm.runInContext('twoTouchStart !== null', context)).toBe(true);
      handlers.touchstart({ touches, preventDefault() {} });
      expect(vm.runInContext('twoTouchStart', context)).toBe(null);
      expect(vm.runInContext('isDown', context)).toBe(false);
      handlers.touchmove({ touches: touches.slice(0, 1), preventDefault() {} });
      handlers.touchend({ touches: [], changedTouches: touches, preventDefault() {} });
      await run(500);
      expect(requests).toEqual([]);
    } finally { clock.uninstall(); }
  });

  test('adding a second finger invalidates a pending single-finger drag', async () => {
    const { handlers, pointer, run, context, requests, held, setHold, clock } = delayedGestureHarness(100);
    try {
      setHold(body => body.phase === 'down');
      handlers.touchstart({ touches: [{ clientX: 368, clientY: 900 }], preventDefault() {} });
      pointer('mousemove', 368, 700);
      await run(50);
      expect(held).toHaveLength(1);
      handlers.touchstart({ touches: [
        { clientX: 300, clientY: 700 }, { clientX: 400, clientY: 700 },
      ], preventDefault() {} });
      held[0].release(true);
      await run(500);
      expect(vm.runInContext('isDown', context)).toBe(false);
      expect(vm.runInContext('dragHeld', context)).toBe(false);
      expect(vm.runInContext('dragKeepalive', context)).toBe(null);
      expect(vm.runInContext('twoTouchStart !== null', context)).toBe(true);
      expect(requests.filter(request => request.phase === 'move')).toHaveLength(0);
      expect(requests.filter(request => request.phase === 'up')).toHaveLength(1);
    } finally { clock.uninstall(); }
  });

  test('secondary mouse buttons neither start phone gestures nor release a left drag', async () => {
    const { handlers, pointer, run, requests, context, clock } = delayedGestureHarness(100);
    const mouse = (name: string, button: number) => handlers[name]({
      button, clientX: 368, clientY: 900, preventDefault() {},
    });
    try {
      mouse('mousedown', 2);
      pointer('mousemove', 368, 700);
      mouse('mouseup', 2);
      await run(300);
      expect(requests).toEqual([]);
      expect(vm.runInContext('isDown', context)).toBe(false);
      mouse('mousedown', 0);
      pointer('mousemove', 368, 700);
      await run(200);
      mouse('mousedown', 1);
      mouse('mouseup', 1);
      expect(vm.runInContext('isDown', context)).toBe(true);
      expect(vm.runInContext('dragHeld', context)).toBe(true);
      mouse('mouseup', 0);
      await run(400);
      expect(requests.filter(request => request.phase === 'down')).toHaveLength(1);
      expect(requests.filter(request => request.phase === 'up')).toHaveLength(1);
    } finally { clock.uninstall(); }
  });

  test('cancelled presses cannot reopen a drag or turn a late release into a tap', async () => {
    for (const event of ['pointerleave', 'pointercancel', 'blur', 'touchcancel']) {
      const harness = delayedGestureHarness(100);
      const { pointer, handlers, run, context, requests, clock } = harness;
      try {
        pointer('mousedown', 368, 1000);
        pointer('mousemove', 368, 900);
        handlers[event]({});
        pointer('mousemove', 368, 700);
        pointer('mouseup', 368, 700);
        await run(800);
        expect(requests.filter(request => request.phase === 'down')).toHaveLength(1);
        expect(requests.filter(request => request.phase === 'up')).toHaveLength(1);
        expect(vm.runInContext('isDown', context)).toBe(false);
        expect(vm.runInContext('startPos', context)).toBe(null);
        expect(vm.runInContext('dragKeepalive', context)).toBe(null);
        expect(vm.runInContext('twoTouchStart', context)).toBe(null);
        // A fresh deliberate press still works after cancellation.
        pointer('mousedown', 368, 1000);
        pointer('mousemove', 368, 900);
        pointer('mouseup', 368, 900);
        await run(800);
        expect(requests.filter(request => request.phase === 'down')).toHaveLength(2);
      } finally { clock.uninstall(); }
    }
  });

  test('a drag with 100ms acknowledgements pipelines moves and releases after them', async () => {
    const harness = delayedGestureHarness(100);
    const { requests, stats, run, pointer, deviceX, deviceY } = harness;

    pointer('mousedown', 368, 1000);
    pointer('mousemove', 368, 950);
    await run(150);
    const down = requests.find((request) => request.phase === 'down');
    expect(down).toBeDefined();
    // The press is acknowledged before the finger moves.
    expect(
      requests
        .filter((request) => request.phase === 'move')
        .every((move) => move.at >= down.ackAt),
    ).toBe(true);

    let clientY = 950;
    for (let step = 0; step < 30; step++) {
      clientY -= 10;
      pointer('mousemove', 368, clientY);
      await run(16);
    }
    const inWindow = requests.filter(
      (request) => request.phase === 'move' && request.at <= down.at + 500,
    );
    // Waiting for every acknowledgement would only manage four moves in half a second.
    expect(inWindow.length).toBeGreaterThanOrEqual(10);
    expect(stats.maxInFlight).toBe(3);

    // A free slot sends the newest point instead of replaying the ones it skipped.
    pointer('mousemove', 368, 400);
    await run(200);
    const moves = requests.filter((request) => request.phase === 'move');
    expect(moves.at(-1)).toMatchObject({ x: deviceX(368), y: deviceY(400) });

    pointer('mouseup', 368, 390);
    await run(300);
    const up = requests.find((request) => request.phase === 'up');
    expect(up).toMatchObject({ x: deviceX(368), y: deviceY(390) });
    // The lift is written only after every move already sent came back.
    expect(up.at).toBeGreaterThanOrEqual(Math.max(...moves.map((move) => move.ackAt)));
    // Nothing is replayed once the finger is up.
    const settled = requests.length;
    await run(500);
    expect(requests).toHaveLength(settled);
  });

  test('an old wheel margin restart cannot replace a newer gesture', async () => {
    const harness = delayedGestureHarness(100);
    const { context, run, setHold, releaseHeld, requests } = harness;
    vm.runInContext("openGesture({x: 100, y: 200}, 'scroll')", context);
    await run(120);
    setHold((body) => body.phase === 'up');
    vm.runInContext(`
      scrollActive = true;
      scrollVertical = true;
      scrollPoint = scrollClamp({x: 100, y: 0});
      scrollPending = 100;
      flushScrollMove();
    `, context);
    await run(20);
    vm.runInContext(`
      scrollActive = true;
      openGesture({x: 200, y: 300}, 'scroll');
    `, context);
    const epoch = vm.runInContext('gesture.epoch', context);
    await releaseHeld(true);
    await run(300);
    expect(vm.runInContext('gesture.epoch', context)).toBe(epoch);
    expect(requests.filter((request) => request.phase === 'down')).toHaveLength(2);
  });

  test('a refused move ends the drag with exactly one lift', async () => {
    const harness = delayedGestureHarness(100);
    const { context, requests, run, pointer, setFailMoves } = harness;

    pointer('mousedown', 368, 1000);
    pointer('mousemove', 368, 950);
    await run(400);
    setFailMoves(true);
    pointer('mousemove', 368, 900);
    await run(150);

    expect(vm.runInContext('dragHeld', context)).toBe(false);
    expect(vm.runInContext('dragKeepalive', context)).toBe(null);
    expect(requests.filter((request) => request.phase === 'up')).toHaveLength(1);
    const settled = requests.length;
    await run(400);
    expect(requests.filter((request) => request.phase === 'up')).toHaveLength(1);
    expect(requests).toHaveLength(settled);

    // The release after a failed drag is not read as a tap.
    pointer('mouseup', 368, 900);
    await run(50);
    expect(requests.some((request) => request.route === '/tap')).toBe(false);
  });

  test('a release waits for sent moves and pagehide lifts without waiting', async () => {
    const harness = delayedGestureHarness(100);
    const { context, handlers, requests, run, pointer } = harness;

    // A move is still on the wire when the first finger lifts.
    pointer('mousedown', 368, 1000);
    pointer('mousemove', 368, 950);
    await run(150);
    pointer('mousemove', 368, 900);
    await run(16);
    pointer('mouseup', 368, 890);
    // A new press must not be pressed before the previous lift has been sent.
    pointer('mousedown', 368, 500);
    pointer('mousemove', 368, 450);
    await run(16);
    expect(requests.some((request) => request.phase === 'up')).toBe(false);

    await run(400);
    const phases = requests.map((request) => request.phase);
    const upAt = phases.indexOf('up');
    expect(upAt).toBeGreaterThan(0);
    expect(phases.slice(upAt + 1)).toContain('down');
    expect(phases.filter((phase) => phase === 'down')).toHaveLength(2);
    expect(phases.filter((phase) => phase === 'up')).toHaveLength(1);

    // Pagehide with a move still unresolved sends its lift now, with keepalive.
    pointer('mousemove', 368, 400);
    await run(16);
    const before = requests.length;
    handlers.pagehide({});
    expect(requests).toHaveLength(before + 1);
    expect(requests.at(-1)).toMatchObject({ phase: 'up', keepalive: true });
    expect(vm.runInContext('dragKeepalive', context)).toBe(null);
    expect(vm.runInContext('dragTimer', context)).toBe(null);
  });

  test('a release still waiting on a move lifts at once when the page leaves', async () => {
    const harness = delayedGestureHarness(100);
    const { handlers, requests, run, pointer } = harness;

    pointer('mousedown', 368, 1000);
    pointer('mousemove', 368, 950);
    await run(150);
    // A move is still on the wire when the finger lifts, so its lift is queued behind it.
    pointer('mousemove', 368, 900);
    await run(16);
    pointer('mouseup', 368, 890);
    expect(requests.some((request) => request.phase === 'up')).toBe(false);

    // Leaving the page sends that lift now, so it is not lost with the cancelled queue.
    handlers.pagehide({});
    const immediate = requests.filter((request) => request.phase === 'up');
    expect(immediate).toHaveLength(1);
    expect(immediate[0]).toMatchObject({ keepalive: true });
    // A repeated pagehide does not lift the same finger twice.
    handlers.pagehide({});
    expect(requests.filter((request) => request.phase === 'up')).toHaveLength(1);

    // The queued lift still runs later, numbered older, so the server drops it as stale.
    await run(400);
    const ups = requests.filter((request) => request.phase === 'up');
    expect(ups).toHaveLength(2);
    expect(ups[1].seq).toBeLessThan(ups[0].seq);
  });

  test('a press answered after a newer press does not drive it', async () => {
    const harness = delayedGestureHarness(60);
    const { context, held, requests, run, pointer, releaseHeld, setHold } = harness;

    setHold((body) => body.phase === 'down');
    pointer('mousedown', 368, 1000);
    pointer('mousemove', 368, 950);
    await run(50);
    // Release and press again while the first press is still unanswered.
    pointer('mouseup', 368, 950);
    pointer('mousedown', 368, 500);
    pointer('mousemove', 368, 450);
    await run(50);
    expect(held).toHaveLength(1);

    // The old press answers now; the new press keeps its own drag state.
    await releaseHeld(true);
    expect(vm.runInContext('dragHeld', context)).toBe(true);
    // The stale reply started no move and no heartbeat of its own.
    expect(vm.runInContext('dragTimer', context)).toBe(null);
    // Once the old press's queued lift is answered, the new press goes out.
    await run(100);
    expect(held).toHaveLength(1);
    const newDown = held[0].body;
    await releaseHeld(true);
    pointer('mousemove', 368, 400);
    await run(100);
    const moves = requests.filter((request) => request.phase === 'move');
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((move) => move.epoch === newDown.epoch)).toBe(true);
  });

  test('a failed press answered late does not stop the newer press', async () => {
    const harness = delayedGestureHarness(60);
    const { context, held, requests, run, pointer, releaseHeld, setHold } = harness;

    setHold((body) => body.phase === 'down');
    pointer('mousedown', 368, 1000);
    pointer('mousemove', 368, 950);
    await run(50);
    pointer('mouseup', 368, 950);
    pointer('mousedown', 368, 500);
    pointer('mousemove', 368, 450);
    await run(50);
    expect(held).toHaveLength(1);

    // The vanished press fails late; the held press keeps the finger it owns.
    await releaseHeld(false);
    expect(vm.runInContext('dragFailed', context)).toBe(false);
    expect(vm.runInContext('dragHeld', context)).toBe(true);

    // The old press's queued lift is answered, then the new press goes out.
    await run(100);
    expect(held).toHaveLength(1);
    const newDown = held[0].body;
    await releaseHeld(true);
    pointer('mousemove', 368, 400);
    await run(100);
    const moves = requests.filter((request) => request.phase === 'move');
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((move) => move.epoch === newDown.epoch)).toBe(true);
  });

  /** Fake adb shell that can acknowledge, forge or refuse, shared by the control tests. */
  function controlHarness() {
    const source = readFileSync(new URL('./adbControl.ts', import.meta.url), 'utf8');
    const functions = source.slice(source.indexOf('let activeInstance')).replaceAll('export ', '');
    let now = 1_000_000;
    const shells: any[] = [];
    const fallback: string[][] = [];
    const servers: any[] = [];
    // Timers are recorded instead of scheduled so a test can fire the server's watchdogs.
    const timers = new Map<number, () => void>();
    let timerSeq = 0;
    let failShell = false;
    const makeChild = (args: string[]): any => {
      const stdin = Object.assign(new EventEmitter(), {
        writes: [] as string[],
        destroyed: false,
        failWrites: false,
        blocked: false,
        ended: false,
        autoAck: true,
        write(data: string) {
          if (stdin.failWrites) throw new Error('EPIPE');
          stdin.writes.push(data);
          const marker = /echo (\S+) \$\?/.exec(data)?.[1];
          if (marker && stdin.autoAck) {
            queueMicrotask(() => child.stdout.emit('data', `${marker} 0\n`));
          }
          // A full pipe reports false and only a `drain` event may release the barrier.
          return !stdin.blocked;
        },
        end() {
          stdin.ended = true;
        },
      });
      const child: any = Object.assign(new EventEmitter(), {
        args,
        killed: false,
        stdin,
        stdout: Object.assign(new EventEmitter(), { pipe() {}, setEncoding() {} }),
        kill() {
          child.killed = true;
          child.fallbackAtKill = fallback.length;
          return true;
        },
      });
      return child;
    };
    const context = vm.createContext({
      Buffer,
      URL,
      AbortController,
      Date: { now: () => now },
      ADB_FALLBACKS: [],
      findBinary: (name: string) => name,
      existsSync: () => true,
      detectAdbDevice: async (device: string) => device,
      getDeviceResolution: async () => ({ width: 1080, height: 1920 }),
      readDeviceResolution: async () => ({ width: 1080, height: 1920 }),
      setInterval: () => 1,
      clearInterval: () => {},
      computeStreamDimensions,
      textInputCommand,
      getAdbHtml: () => '',
      readAndroidKeyConfig: () => ({ leader: '<Space>', keys: {} }),
      availableParallelism: () => 2,
      executeFile: async (_binary: string, args: string[]) => {
        fallback.push(args);
        return { stdout: '', stderr: '' };
      },
      http: {
        createServer(handler: any) {
          const server = Object.assign(new EventEmitter(), {
            handler,
            listen(_port: number, _host: string, ready: () => void) {
              queueMicrotask(ready);
            },
            address: () => ({ port: 20000 + servers.length }),
            close() {},
          });
          servers.push(server);
          return server;
        },
      },
      spawn(_binary: string, args: string[]) {
        if (failShell && args.length === 3 && args[2] === 'shell') {
          throw new Error('spawn failed');
        }
        const child = makeChild(args);
        if (args.length === 3 && args[2] === 'shell') shells.push(child);
        return child;
      },
      setTimeout: (fn: () => void) => {
        timers.set(++timerSeq, fn);
        return timerSeq;
      },
      clearTimeout: (id: number) => {
        timers.delete(id);
      },
    });
    vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(functions), context);
    const request = (server: any, pathname: string, body: unknown) =>
      new Promise<any>((resolve) => {
        const res: any = Object.assign(new EventEmitter(), {
          status: 0,
          body: '',
          writeHead(code: number) {
            res.status = code;
            return res;
          },
          end(data?: string) {
            res.body = data ?? '';
            resolve(res);
          },
        });
        const req: any = Object.assign(new EventEmitter(), {
          method: 'POST',
          url: pathname,
          headers: {
            host: `127.0.0.1:${server.address().port}`,
            'content-type': 'application/json',
          },
        });
        server.handler(req, res);
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
      });
    const markerOf = (write: string) => /echo (\S+) \$\?/.exec(write)?.[1] ?? '';
    return {
      context,
      shells,
      fallback,
      servers,
      request,
      markerOf,
      start: (device: string) =>
        vm.runInContext(`createAdbControl("${device}")`, context) as Promise<any>,
      stop: () => vm.runInContext('stopAdbControl()', context),
      setFailShell: (value: boolean) => {
        failShell = value;
      },
      advance: (ms: number) => {
        now += ms;
      },
      pendingTimers: () => timers.size,
      fireTimers: () => {
        const due = [...timers.values()];
        timers.clear();
        for (const fire of due) fire();
      },
    };
  }

  test('controls reuse one persistent adb shell and fall back when it cannot start', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, fallback, servers, request, advance } = harness;

    expect((await request(servers[0], '/tap', { x: 5, y: 6 })).status).toBe(200);
    expect(shells).toHaveLength(1);
    expect(shells[0].args).toEqual(['-s', 'dev', 'shell']);
    expect(shells[0].stdin.writes).toHaveLength(1);
    expect(shells[0].stdin.writes[0].startsWith('input tap 5 6; echo __awrit_')).toBe(true);
    expect(fallback).toHaveLength(0);

    expect((await request(servers[0], '/gesture', gestureEvent('down', 5, 6))).status).toBe(200);
    expect((await request(servers[0], '/gesture', gestureEvent('move', 7, 8))).status).toBe(200);
    expect(shells).toHaveLength(1);
    expect(shells[0].stdin.writes.at(-1).startsWith('input motionevent MOVE 7 8; echo ')).toBe(
      true,
    );
    expect((await request(servers[0], '/gesture', gestureEvent('up', 7, 8))).status).toBe(200);
    expect(shells[0].stdin.writes.at(-1).startsWith('input motionevent UP 7 8; echo ')).toBe(true);

    expect((await request(servers[0], '/text', { text: 'a b' })).status).toBe(200);
    expect(shells[0].stdin.writes.at(-1).startsWith("input text 'a%sb'; echo ")).toBe(true);

    // A shell that exits is replaced once the retry cooldown passes.
    shells[0].emit('exit');
    advance(5000);
    expect((await request(servers[0], '/wake', {})).status).toBe(200);
    expect(shells).toHaveLength(2);
    expect(shells[1].stdin.writes[0].startsWith('input keyevent KEYCODE_WAKEUP; echo ')).toBe(
      true,
    );

    server.stop();
    expect(shells[1].killed).toBe(true);

    // Without a usable persistent shell each command uses the old executeFile path.
    const fallbackServer = await harness.start('dev2');
    harness.setFailShell(true);
    expect((await request(servers[1], '/tap', { x: 9, y: 10 })).status).toBe(200);
    expect(fallback).toEqual([['-s', 'dev2', 'shell', 'input', 'tap', '9', '10']]);
    expect(shells).toHaveLength(2);
    fallbackServer.stop();
    harness.stop();
    expect(servers.every((entry) => entry.handler)).toBe(true);
  });

  test('a dead or broken control shell fails the request instead of confirming it', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, fallback, servers, request, advance } = harness;
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);

    // The shell exits with the command written but never echoed back.
    shells[0].stdin.autoAck = false;
    const dead = request(servers[0], '/tap', { x: 1, y: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shells[0].stdin.writes).toHaveLength(2);
    shells[0].emit('exit');
    expect((await dead).status).toBe(502);
    expect(fallback).toHaveLength(0);

    // A write that throws (EPIPE) also fails instead of reporting success.
    advance(5000);
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    expect(shells).toHaveLength(2);
    shells[1].stdin.failWrites = true;
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(502);
    server.stop();
  });

  test('only the command\'s own marker acknowledges it and a non-zero status fails', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, servers, request, markerOf } = harness;
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    shells[0].stdin.autoAck = false;

    let status: number | null = null;
    const pending = request(servers[0], '/tap', { x: 1, y: 2 }).then((res: any) => {
      status = res.status;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Device output cannot guess the random per-instance token.
    shells[0].stdout.emit('data', '__awrit_forged_1 0\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(status).toBeNull();

    const marker = markerOf(shells[0].stdin.writes.at(-1));
    expect(marker.startsWith('__awrit_')).toBe(true);
    shells[0].stdout.emit('data', `${marker} 1\n`);
    expect((await pending).status).toBe(502);

    // The same command with status 0 is the acknowledgement.
    shells[0].stdin.autoAck = true;
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    server.stop();
  });

  test('unacknowledged controls cap at 64 and free up as the shell confirms them', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, servers, request, markerOf } = harness;
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    shells[0].stdin.autoAck = false;
    const before = shells[0].stdin.writes.length;

    const pending = Array.from({ length: 64 }, () => request(servers[0], '/tap', { x: 1, y: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shells[0].stdin.writes).toHaveLength(before + 64);
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(502);

    for (const write of shells[0].stdin.writes.slice(before)) {
      shells[0].stdout.emit('data', `${markerOf(write)} 0\n`);
    }
    expect((await Promise.all(pending)).every((res: any) => res.status === 200)).toBe(true);
    shells[0].stdin.autoAck = true;
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    server.stop();
  });

  test('stopping during a gesture lifts the finger before the shell dies', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, fallback, servers, request } = harness;

    expect((await request(servers[0], '/gesture', gestureEvent('down', 30, 40))).status).toBe(
      200,
    );
    server.stop();
    expect(shells[0].killed).toBe(true);
    expect(shells[0].fallbackAtKill).toBe(1);
    expect(fallback.at(-1)).toEqual([
      '-s',
      'dev',
      'shell',
      'input',
      'motionevent',
      'UP',
      '30',
      '40',
    ]);
  });

  test('a lift is never refused by the pending command cap', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, fallback, servers, request, markerOf } = harness;

    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    expect((await request(servers[0], '/gesture', gestureEvent('down', 10, 20))).status).toBe(200);
    shells[0].stdin.autoAck = false;
    // Fill the cap with moves that never acknowledge.
    const moves = Array.from({ length: 64 }, (_, index) =>
      request(servers[0], '/gesture', gestureEvent('move', 10 + index, 20)),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(502);

    const before = shells[0].stdin.writes.length;
    const lift = request(servers[0], '/gesture', gestureEvent('up', 1, 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The lift still reaches the shell, at the point the viewer released it.
    expect(shells[0].stdin.writes).toHaveLength(before + 1);
    const liftWrite: string = shells[0].stdin.writes.at(-1);
    expect(liftWrite.startsWith('input motionevent UP 1 1; echo ')).toBe(true);
    shells[0].stdout.emit('data', `${markerOf(liftWrite)} 0\n`);
    expect((await lift).status).toBe(200);

    // The moves settle once the shell acknowledges them.
    for (const write of shells[0].stdin.writes.slice(0, -1)) {
      shells[0].stdout.emit('data', `${markerOf(write)} 0\n`);
    }
    expect((await Promise.all(moves)).every((res: any) => res.status === 200)).toBe(true);
    expect(fallback).toHaveLength(0);
    server.stop();
  });

  test('a failed lift keeps the tracked finger so the next lift can retry it', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, fallback, servers, request, markerOf } = harness;

    expect((await request(servers[0], '/gesture', gestureEvent('down', 30, 40))).status).toBe(
      200,
    );
    shells[0].stdin.autoAck = false;
    const refused = request(servers[0], '/gesture', gestureEvent('up', 1, 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    shells[0].stdout.emit('data', `${markerOf(shells[0].stdin.writes.at(-1))} 1\n`);
    expect((await refused).status).toBe(502);

    // The device finger is still down, so a later lift with a newer sequence is written.
    shells[0].stdin.autoAck = true;
    expect((await request(servers[0], '/gesture', gestureEvent('up', 30, 40))).status).toBe(200);
    const retryWrite: string = shells[0].stdin.writes.at(-1);
    expect(retryWrite.startsWith('input motionevent UP 30 40; echo ')).toBe(true);
    expect(fallback).toHaveLength(0);
    server.stop();
  });

  test('a shell that stops acknowledging is killed and replaced', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, servers, request, advance, fireTimers } = harness;

    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    shells[0].stdin.autoAck = false;
    const stuck = request(servers[0], '/tap', { x: 3, y: 4 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shells[0].killed).toBe(false);

    // The acknowledgement never comes: the timeout drops the shell instead of keeping it.
    fireTimers();
    expect((await stuck).status).toBe(502);
    expect(shells[0].killed).toBe(true);
    expect(shells[0].stdin.ended).toBe(true);

    advance(5000);
    expect((await request(servers[0], '/tap', { x: 5, y: 6 })).status).toBe(200);
    expect(shells).toHaveLength(2);
    server.stop();
  });

  test('a write stuck on drain cannot block the commands after a dead shell', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, servers, request, advance } = harness;

    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    // A full pipe: this write waits for a `drain` that never arrives.
    shells[0].stdin.blocked = true;
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    const stuck = request(servers[0], '/tap', { x: 1, y: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    shells[0].emit('exit');
    expect((await stuck).status).toBe(502);

    advance(5000);
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    expect(shells).toHaveLength(2);
    server.stop();
  });

  test('a viewer that vanishes mid-gesture is lifted after an idle second', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { fallback, servers, request, pendingTimers, fireTimers } = harness;

    expect((await request(servers[0], '/gesture', gestureEvent('down', 30, 40))).status).toBe(
      200,
    );
    expect(pendingTimers()).toBe(1);
    // Every move restarts the idle window.
    expect((await request(servers[0], '/gesture', gestureEvent('move', 31, 41))).status).toBe(
      200,
    );
    expect(pendingTimers()).toBe(1);
    expect(fallback).toHaveLength(0);

    fireTimers();
    expect(fallback.at(-1)).toEqual([
      '-s',
      'dev',
      'shell',
      'input',
      'motionevent',
      'UP',
      '31',
      '41',
    ]);

    // A proper lift clears the window instead of leaving it armed.
    expect((await request(servers[0], '/gesture', gestureEvent('down', 5, 6))).status).toBe(
      200,
    );
    expect((await request(servers[0], '/gesture', gestureEvent('up', 5, 6))).status).toBe(200);
    expect(pendingTimers()).toBe(0);
    expect(fallback).toHaveLength(1);
    server.stop();
  });

  test('gesture events need a bounded identity, epoch and safe sequence', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { servers, request } = harness;
    const post = (body: unknown) => request(servers[0], '/gesture', body);
    const base = { phase: 'down', id: 'page', epoch: 1, seq: 1, x: 10, y: 10 };

    expect((await post({ ...base, id: 'bad id!' })).status).toBe(400);
    expect((await post({ ...base, id: '' })).status).toBe(400);
    expect((await post({ ...base, id: 'x'.repeat(33) })).status).toBe(400);
    expect((await post({ ...base, id: 7 })).status).toBe(400);
    expect((await post({ ...base, epoch: 1.5 })).status).toBe(400);
    expect((await post({ ...base, epoch: -1 })).status).toBe(400);
    expect((await post({ ...base, seq: '1' })).status).toBe(400);
    expect((await post({ ...base, seq: Number.MAX_SAFE_INTEGER + 1 })).status).toBe(400);
    expect((await post(base)).status).toBe(200);
    server.stop();
  });

  test('late, duplicate and out-of-order gesture events are skipped, not written', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, servers, request } = harness;
    const event = (phase: string, epoch: number, seq: number, x: number, y: number) =>
      request(servers[0], '/gesture', { phase, id: 'page', epoch, seq, x, y });
    const lastWrite = () => shells[0].stdin.writes.at(-1);
    const wrote = (command: string) => lastWrite().startsWith(`${command}; echo `);

    expect((await event('down', 1, 1, 10, 10)).status).toBe(200);
    // The newest sequence wins; the superseded move never reaches the device.
    expect((await event('move', 1, 3, 30, 30)).status).toBe(200);
    const backwards = await event('move', 1, 2, 20, 20);
    expect(backwards.status).toBe(200);
    expect(JSON.parse(backwards.body)).toEqual({ ok: true, skipped: true });
    expect(wrote('input motionevent MOVE 30 30')).toBe(true);

    // A lift uses the released point, then seals the identity against further moves.
    expect((await event('up', 1, 4, 30, 31)).status).toBe(200);
    expect(wrote('input motionevent UP 30 31')).toBe(true);
    const duplicate = await event('up', 1, 4, 30, 31);
    expect(JSON.parse(duplicate.body)).toEqual({ ok: true, skipped: true });
    const reseal = await event('move', 1, 5, 40, 40);
    expect(JSON.parse(reseal.body)).toEqual({ ok: true, skipped: true });
    expect(wrote('input motionevent UP 30 31')).toBe(true);

    // A delayed lift from the previous gesture cannot close the newer one.
    expect((await event('down', 2, 6, 50, 50)).status).toBe(200);
    expect((await event('move', 2, 7, 55, 55)).status).toBe(200);
    const oldLift = await event('up', 1, 8, 30, 31);
    expect(JSON.parse(oldLift.body)).toEqual({ ok: true, skipped: true });
    expect(wrote('input motionevent MOVE 55 55')).toBe(true);
    expect((await event('move', 2, 9, 60, 60)).status).toBe(200);
    expect(wrote('input motionevent MOVE 60 60')).toBe(true);

    // An older press for the same page cannot reopen a superseded epoch.
    const staleDown = await event('down', 1, 10, 5, 5);
    expect(JSON.parse(staleDown.body)).toEqual({ ok: true, skipped: true });
    expect(wrote('input motionevent MOVE 60 60')).toBe(true);
    server.stop();
  });

  test('a sealed gesture cannot be reopened and a competing press is refused', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, servers, request } = harness;
    const event = (phase: string, id: string, epoch: number, seq: number, x: number, y: number) =>
      request(servers[0], '/gesture', { phase, id, epoch, seq, x, y });
    const writes = () => shells[0].stdin.writes.length;

    expect((await event('down', 'page', 1, 1, 10, 10)).status).toBe(200);
    expect((await event('up', 'page', 1, 2, 10, 10)).status).toBe(200);
    const settled = writes();
    // The lifted epoch is sealed: a newer press for it is skipped, not written.
    const reopen = await event('down', 'page', 1, 3, 20, 20);
    expect(reopen.status).toBe(200);
    expect(JSON.parse(reopen.body)).toEqual({ ok: true, skipped: true });
    expect(writes()).toBe(settled);

    // Another owner starts a finger, then a competing press is refused outright.
    expect((await event('down', 'other', 1, 1, 30, 40)).status).toBe(200);
    const held = writes();
    expect((await event('down', 'page', 2, 4, 50, 50)).status).toBe(409);
    expect(writes()).toBe(held);
    // The tracked owner keeps its identity, so its lift is still written.
    expect((await event('up', 'other', 1, 2, 30, 40)).status).toBe(200);
    expect(shells[0].stdin.writes.at(-1).startsWith('input motionevent UP 30 40; echo ')).toBe(
      true,
    );
    // Once that lift is acknowledged the finger is free for a new owner.
    expect((await event('down', 'page', 2, 5, 50, 50)).status).toBe(200);
    expect(shells[0].stdin.writes.at(-1).startsWith('input motionevent DOWN 50 50; echo ')).toBe(
      true,
    );
    server.stop();
  });

  test('a live finger is not stolen by a newer epoch and frees after the idle lift', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { fallback, servers, request, fireTimers } = harness;
    const event = (phase: string, id: string, epoch: number, seq: number, x: number, y: number) =>
      request(servers[0], '/gesture', { phase, id, epoch, seq, x, y });

    expect((await event('down', 'page', 1, 1, 30, 40)).status).toBe(200);
    // The next press for the page normally waits for the lift; a newer epoch may not steal it.
    expect((await event('down', 'page', 2, 2, 50, 50)).status).toBe(409);
    expect((await event('down', 'other', 1, 3, 60, 60)).status).toBe(409);
    // The idle watchdog lifts the vanished viewer's finger on a fresh shell.
    fireTimers();
    expect(fallback.at(-1)).toEqual([
      '-s',
      'dev',
      'shell',
      'input',
      'motionevent',
      'UP',
      '30',
      '40',
    ]);
    // Recovery is not blocked forever: the new owner presses once the finger is free.
    expect((await event('down', 'other', 1, 4, 60, 60)).status).toBe(200);
    expect((await event('up', 'other', 1, 5, 60, 60)).status).toBe(200);
    server.stop();
  });

  test('a delayed failed press cannot clear a newer owner', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, servers, request, markerOf, fireTimers } = harness;
    const event = (phase: string, id: string, epoch: number, seq: number, x: number, y: number) =>
      request(servers[0], '/gesture', { phase, id, epoch, seq, x, y });

    expect((await event('down', 'page', 1, 1, 30, 40)).status).toBe(200);
    shells[0].stdin.autoAck = false;
    // A repeated press for the same live page stays pending.
    const delayed = event('down', 'page', 1, 2, 31, 41);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const delayedWrite: string = shells[0].stdin.writes.at(-1);
    // It vanishes before acknowledging, and the watchdog lifts its finger.
    fireTimers();
    const next = event('down', 'other', 1, 3, 60, 60);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const nextWrite: string = shells[0].stdin.writes.at(-1);

    // The old press fails late; the newer owner still holds the finger.
    shells[0].stdout.emit('data', `${markerOf(delayedWrite)} 1\n`);
    expect((await delayed).status).toBe(502);
    expect((await event('down', 'page', 2, 4, 50, 50)).status).toBe(409);
    shells[0].stdout.emit('data', `${markerOf(nextWrite)} 0\n`);
    expect((await next).status).toBe(200);
    shells[0].stdin.autoAck = true;
    expect((await event('up', 'other', 1, 5, 60, 60)).status).toBe(200);
    server.stop();
  });

  test('an untracked lift with a non-finite point is refused instead of writing NaN', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, fallback, servers, request } = harness;

    expect(
      (await request(servers[0], '/gesture', gestureEvent('up', 'left', 20))).status,
    ).toBe(400);
    expect(
      (await request(servers[0], '/gesture', gestureEvent('up', Number.NaN, 20))).status,
    ).toBe(400);
    expect((await request(servers[0], '/gesture', gestureEvent('up', 1, 2))).status).toBe(200);
    const write: string = shells[0].stdin.writes.at(-1);
    expect(write.startsWith('input motionevent UP 1 2; echo ')).toBe(true);
    expect(shells[0].stdin.writes.some((entry: string) => entry.includes('NaN'))).toBe(false);
    expect(fallback).toHaveLength(0);
    server.stop();
  });

  test('a marker is found anywhere on a line and survives split or trimmed reads', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, servers, request, markerOf } = harness;

    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    shells[0].stdin.autoAck = false;

    // Shell chatter before the marker, and the marker itself split across two reads.
    const prefixed = request(servers[0], '/tap', { x: 3, y: 4 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const first = markerOf(shells[0].stdin.writes.at(-1));
    shells[0].stdout.emit('data', `note: ${first.slice(0, 6)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    shells[0].stdout.emit('data', `${first.slice(6)} 0\n`);
    expect((await prefixed).status).toBe(200);

    // A long unterminated line is trimmed, but the marker start at its end is kept.
    const trimmed = request(servers[0], '/tap', { x: 5, y: 6 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = markerOf(shells[0].stdin.writes.at(-1));
    shells[0].stdout.emit('data', `${'x'.repeat(5000)}${second.slice(0, 6)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    shells[0].stdout.emit('data', `${second.slice(6)} 0\n`);
    expect((await trimmed).status).toBe(200);
    server.stop();
  });

  test('a failed shell spawn is retried after a cooldown, not latched forever', async () => {
    const harness = controlHarness();
    const server = await harness.start('dev');
    const { shells, fallback, servers, request, advance } = harness;

    harness.setFailShell(true);
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    expect(fallback).toHaveLength(1);

    // Inside the cooldown every command takes the one-shot path without respawning.
    harness.setFailShell(false);
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    expect(fallback).toHaveLength(2);
    expect(shells).toHaveLength(0);

    advance(5000);
    expect((await request(servers[0], '/tap', { x: 1, y: 2 })).status).toBe(200);
    expect(shells).toHaveLength(1);
    server.stop();
  });

  test('findBinary finds existing binary or fallback', () => {
    const sh = findBinary('sh', ['/bin/sh']);
    expect(sh.endsWith('sh')).toBe(true);

    const fallback = findBinary('non_existent_binary_xyz', ['/bin/sh']);
    expect(fallback).toBe('/bin/sh');
  });

  test('detectAdbDevice selects only connected devices', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'awrit-adb-'));
    const adb = path.join(dir, 'adb');
    try {
      writeFileSync(adb, '#!/bin/sh\nprintf "List of devices attached\\nserial-1\\tdevice\\n"\n', {
        mode: 0o700,
      });
      expect(await detectAdbDevice(undefined, adb)).toBe('serial-1');
      expect(await detectAdbDevice('serial-1', adb)).toBe('serial-1');
      await expect(detectAdbDevice('missing', adb)).rejects.toThrow('not connected');
      writeFileSync(adb, '#!/bin/sh\nprintf "List of devices attached\\n"\n', { mode: 0o700 });
      await expect(detectAdbDevice(undefined, adb)).rejects.toThrow('No connected ADB device');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getDeviceResolution follows rotation from the window dump', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'awrit-adb-rotation-'));
    const adb = path.join(dir, 'adb');
    writeFileSync(
      adb,
      `#!/bin/sh\nprintf 'Physical size: 1080x1920\\n  init=1080x1920 480dpi cur=1920x1080 app=1920x1008\\n'\n`,
      { mode: 0o700 },
    );
    try {
      expect(await getDeviceResolution(adb, 'serial-1')).toEqual({ width: 1920, height: 1080 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getDeviceResolution falls back gracefully on invalid command', async () => {
    const res = await getDeviceResolution('false', 'invalid_device');
    expect(res.width).toBe(1080);
    expect(res.height).toBe(2400);
  });

  test('control endpoint rejects cross-origin and invalid requests', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'awrit-adb-server-'));
    const originalPath = process.env.PATH;
    const adb = path.join(dir, 'adb');
    const ffmpeg = path.join(dir, 'ffmpeg');
    const commandLog = path.join(dir, 'commands');
    writeFileSync(
      adb,
      `#!/bin/sh
if [ "$1" = devices ]; then printf 'serial-1\\tdevice\\n'
elif [ "$4" = wm ]; then printf 'Physical size: 1080x2400\\n'
elif [ "$3" = shell ] && [ $# -gt 3 ]; then printf '%s\\n' "$*" >> '${commandLog}'; exit 0
elif [ "$3" = shell ]; then
  while IFS= read -r line; do
    cmd=\${line%%; echo *}
    printf '%s\\n' "-s serial-1 shell $cmd" >> '${commandLog}'
    mark=\${line##*; echo }
    mark=\${mark% *}
    printf '%s 0\\n' "$mark"
  done
  exit 0
else exec sleep 10; fi
`,
      { mode: 0o700 },
    );
    writeFileSync(ffmpeg, '#!/bin/sh\nexec sleep 10\n', { mode: 0o700 });
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    let server: Awaited<ReturnType<typeof startAdbControl>> | null = null;
    const logLines = () => {
      try {
        return readFileSync(commandLog, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    const waitForLine = async (expected: string) => {
      const deadline = Date.now() + 3000;
      while (!logLines().includes(expected) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return logLines();
    };
    try {
      server = await startAdbControl();
      const currentServer = server;
      const post = (headers: Record<string, string>, body: string) =>
        fetch(`${currentServer.url}tap`, { method: 'POST', headers, body });
      expect(
        (
          await post(
            { 'Content-Type': 'application/json', Origin: 'https://example.org' },
            '{"x":1,"y":1}',
          )
        ).status,
      ).toBe(403);
      expect((await post({ 'Content-Type': 'text/plain' }, '{"x":1,"y":1}')).status).toBe(415);
      expect((await post({ 'Content-Type': 'application/json' }, '{"x":-1,"y":1}')).status).toBe(
        400,
      );
      expect((await post({ 'Content-Type': 'application/json' }, '{"x":1,"y":1}')).status).toBe(
        200,
      );
      const postKey = (headers: Record<string, string>, body: string) =>
        fetch(`${currentServer.url}key`, { method: 'POST', headers, body });
      expect(
        (await postKey({ 'Content-Type': 'application/json' }, '{"keycodes":[113,29]}')).status,
      ).toBe(200);
      expect(
        (await postKey({ 'Content-Type': 'application/json' }, '{"keycodes":[]}')).status,
      ).toBe(400);
      const postText = (headers: Record<string, string>, body: string) =>
        fetch(`${currentServer.url}text`, { method: 'POST', headers, body });
      expect((await postText({ 'Content-Type': 'application/json' }, '{"text":""}')).status).toBe(
        400,
      );
      expect(
        (await postText({ 'Content-Type': 'application/json' }, '{"text":"hello world"}')).status,
      ).toBe(200);
      expect(
        (
          await postText(
            { 'Content-Type': 'application/json' },
            JSON.stringify({ text: 'hello\necho inject' }),
          )
        ).status,
      ).toBe(400);
      const postLaunch = (component: string) =>
        fetch(`${currentServer.url}launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ component }),
        });
      expect((await postLaunch('com.android.settings/.Settings')).status).toBe(200);
      expect((await postLaunch('com.x/.A; reboot')).status).toBe(400);
      expect((await postLaunch('$(reboot)/.A')).status).toBe(400);
      await waitForLine('-s serial-1 shell am start -n com.android.settings/.Settings');
      const postWake = (headers: Record<string, string>) =>
        fetch(`${currentServer.url}wake`, { method: 'POST', headers, body: '{}' });
      expect((await postWake({ 'Content-Type': 'application/json' })).status).toBe(200);
      // One cheap wake key: no dumpsys query (1.5 MB on real devices) and no MENU/unlock.
      expect(
        (await waitForLine('-s serial-1 shell input keyevent KEYCODE_WAKEUP')).filter((line) =>
          line.endsWith('input keyevent KEYCODE_WAKEUP'),
        ),
      ).toHaveLength(1);

      const postGesture = (headers: Record<string, string>, body: string) =>
        fetch(`${currentServer.url}gesture`, { method: 'POST', headers, body });
      const jsonHeaders = { 'Content-Type': 'application/json' };
      const event = (phase: string, seq: number, x: unknown, y: unknown, id = 'pagesession') =>
        JSON.stringify({ phase, id, epoch: 1, seq, x, y });
      expect((await postGesture(jsonHeaders, '{"phase":"push","x":1,"y":2}')).status).toBe(400);
      expect((await postGesture(jsonHeaders, '{"x":1,"y":2}')).status).toBe(400);
      expect((await postGesture(jsonHeaders, event('down', 1, 1, 2, 'bad id'))).status).toBe(400);
      expect((await postGesture(jsonHeaders, event('down', 1, 1, 2, 'x'.repeat(33)))).status).toBe(
        400,
      );
      expect((await postGesture(jsonHeaders, event('down', 1.5, 1, 2))).status).toBe(400);
      expect((await postGesture(jsonHeaders, event('down', 1, -1, 2))).status).toBe(400);
      expect((await postGesture(jsonHeaders, event('down', 1, 1.5, 2))).status).toBe(400);
      expect((await postGesture(jsonHeaders, event('down', 1, 1, 2400))).status).toBe(400);
      expect(
        (
          await postGesture(
            { ...jsonHeaders, Origin: 'https://example.org' },
            event('down', 2, 1, 2),
          )
        ).status,
      ).toBe(403);
      expect((await postGesture(jsonHeaders, event('down', 2, 1, 2))).status).toBe(200);
      expect(
        (await waitForLine('-s serial-1 shell input motionevent DOWN 1 2')).filter((line) =>
          line.endsWith('input motionevent DOWN 1 2'),
        ),
      ).toHaveLength(1);

      // A lift is clamped onto the screen instead of rejected, at the released point.
      expect((await postGesture(jsonHeaders, event('up', 3, 5000, 5000))).status).toBe(200);
      expect(
        (await waitForLine('-s serial-1 shell input motionevent UP 1079 2399')).filter((line) =>
          line.endsWith('input motionevent UP 1079 2399'),
        ),
      ).toHaveLength(1);
      // A duplicate lift of the sealed gesture is reported skipped and not written again.
      const duplicate = await postGesture(jsonHeaders, event('up', 3, 5000, 5000));
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual({ ok: true, skipped: true });
      expect(
        logLines().filter((line) => line.endsWith('input motionevent UP 1079 2399')),
      ).toHaveLength(1);

      const postRotate = (headers: Record<string, string>) =>
        fetch(`${currentServer.url}rotate`, { method: 'POST', headers, body: '{}' });
      expect((await postRotate({ 'Content-Type': 'application/json' })).status).toBe(200);

      const shotRes = await fetch(`${currentServer.url}screenshot`);
      expect([200, 503].includes(shotRes.status)).toBe(true);
    } finally {
      server?.stop();
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resizing, external rotation and offline recovery update the stream', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'awrit-adb-resize-'));
    const originalPath = process.env.PATH;
    const log = path.join(dir, 'recordings');
    const display = path.join(dir, 'display');
    writeFileSync(display, 'Physical size: 1080x1920\n');
    writeFileSync(
      path.join(dir, 'adb'),
      `#!/bin/sh
if [ "$1" = devices ]; then printf 'serial-1\\tdevice\\n'
elif [ "$4" = wm ]; then cat '${display}'
else
  printf '%s\\n' "$*" >> '${log}'
  printf 'video'
  case "$*" in *--time-limit=180*) exec sleep 60;; esac
fi
`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(dir, 'ffmpeg'),
      `#!/bin/sh
cat >/dev/null
printf '\\377\\330'
dd if=/dev/zero bs=1024 count=1 2>/dev/null
printf '\\377\\331'
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    let server: Awaited<ReturnType<typeof startAdbControl>> | null = null;
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!predicate() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(predicate()).toBe(true);
    };
    try {
      for (const maxSize of [undefined, 1280]) {
        writeFileSync(log, '');
        server = await startAdbControl(undefined, {
          maxSize,
          viewport: { width: 900, height: 1600 },
        });
        await waitFor(() => readFileSync(log, 'utf8').includes('--time-limit=180'));
        expect((await (await fetch(`${server.url}status`)).json()).hasFrame).toBe(true);
        server.resize({ width: 320, height: 600 });
        server.resize({ width: 600, height: 900 });
        server.resize({ width: 360, height: 640 });
        if (maxSize === undefined) {
          await waitFor(() =>
            readFileSync(log, 'utf8').includes('--size=360x640 --bit-rate=4M --time-limit=180'),
          );
          const recordings = readFileSync(log, 'utf8');
          expect(recordings.match(/--size=360x640/g)?.length).toBe(2);
          expect(recordings).toContain('--size=360x640 --bit-rate=4M --time-limit=1');
          expect(recordings).not.toContain('--size=320x');
          expect((await (await fetch(`${server.url}status`)).json()).hasFrame).toBe(true);
        }
        const before = readFileSync(log, 'utf8');
        server.resize({ width: 360, height: 640 });
        server.resize({ width: NaN, height: 640 });
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(readFileSync(log, 'utf8')).toBe(before);
        if (maxSize === 1280) {
          writeFileSync(display, 'Physical size: 1080x1920\ncur=1920x1080\n');
          const status = async () => (await (await fetch(`${server?.url}status`)).json());
          const deadline = Date.now() + 5000;
          while ((await status()).w !== 1920 && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
          expect(await status()).toMatchObject({ w: 1920, h: 1080, connected: true });
          writeFileSync(display, '');
          const offlineDeadline = Date.now() + 5000;
          while ((await status()).connected && Date.now() < offlineDeadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
          expect(await status()).toMatchObject({ w: 1920, h: 1080, connected: false, hasFrame: false });
          writeFileSync(display, 'Physical size: 1080x1920\n');
          const recoveryDeadline = Date.now() + 5000;
          while ((await status()).w !== 1080 && Date.now() < recoveryDeadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
          expect(await status()).toMatchObject({ w: 1080, h: 1920, connected: true });
          await waitFor(() => readFileSync(log, 'utf8').trim().endsWith('--time-limit=180 -'));
        }
        const beforeStop = readFileSync(log, 'utf8');
        server.resize({ width: 900, height: 1600 });
        server.stop();
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(readFileSync(log, 'utf8')).toBe(beforeStop);
      }
    } finally {
      server?.stop();
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test('startup recording flushes its final frame before restarting', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'awrit-adb-frame-'));
    const originalPath = process.env.PATH;
    const log = path.join(dir, 'recordings');
    const encoderLog = path.join(dir, 'encoder-options');
    writeFileSync(
      path.join(dir, 'adb'),
      `#!/bin/sh
if [ "$1" = devices ]; then printf 'serial-1\\tdevice\\n'
elif [ "$4" = wm ]; then printf 'Physical size: 1080x1920\\n'
else printf '%s\\n' "$*" >> '${log}'; printf 'video'; fi
`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(dir, 'ffmpeg'),
      `#!/bin/sh
printf '%s\\n' "$@" > '${encoderLog}'
cat >/dev/null
sleep 0.05
printf '\\377\\330'
dd if=/dev/zero bs=1024 count=1 2>/dev/null
printf '\\377\\331'
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    let server: Awaited<ReturnType<typeof startAdbControl>> | null = null;
    try {
      server = await startAdbControl();
      let response = await fetch(`${server.url}screenshot`);
      const deadline = Date.now() + 2000;
      while (response.status === 503 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        response = await fetch(`${server.url}screenshot`);
      }
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(1028);
      expect((await (await fetch(`${server.url}status`)).json()).hasFrame).toBe(true);
      const stream = await fetch(`${server.url}stream`);
      if (!stream.body) throw new Error('Missing stream body');
      const reader = stream.body.getReader();
      try {
        const chunk = await reader.read();
        if (!chunk.value) throw new Error('Stream ended without a frame');
        const body = Buffer.from(chunk.value);
        // The single cached frame is complete without waiting for another JPEG.
        const nextPart = Buffer.from('\r\n--frame\r\nContent-Type: image/jpeg\r\n\r\n');
        expect(body.subarray(-nextPart.length).equals(nextPart)).toBe(true);
      } finally {
        await reader.cancel();
      }
      expect(readFileSync(log, 'utf8')).toContain('--time-limit=1');
      expect(readFileSync(log, 'utf8')).not.toContain('--time-limit=0');
      const encoderArgs = readFileSync(encoderLog, 'utf8').trim().split('\n');
      const inputIndex = encoderArgs.indexOf('-i');
      const decoderThreads = encoderArgs.indexOf('-threads');
      const encoderThreads = encoderArgs.lastIndexOf('-threads');
      expect(decoderThreads).toBeLessThan(inputIndex);
      expect(encoderThreads).toBeGreaterThan(inputIndex);
      expect(encoderArgs[decoderThreads + 1]).toBe('1');
      expect(encoderArgs[encoderThreads + 1]).toBe('1');
    } finally {
      server?.stop();
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('createRawFrameReader handles split and coalesced frames with bounded buffer', () => {
    const frames: Array<{ data: Buffer; width: number; height: number }> = [];
    const push = createRawFrameReader(2, 1, (data, width, height) => {
      frames.push({ data, width, height });
    });
    const first = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    push(first.subarray(0, 5));
    expect(frames.length).toBe(0);
    push(first.subarray(5));
    expect(frames.length).toBe(1);
    expect([...frames[0].data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frames[0].width).toBe(2);
    expect(frames[0].height).toBe(1);

    const second = Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]);
    const third = Buffer.from([7, 7, 7, 7, 7, 7, 7, 7]);
    push(Buffer.concat([second, third]));
    expect(frames.length).toBe(2);
    expect([...frames[1].data]).toEqual([...third]);

    const chunk = Buffer.from([1, 2, 3, 4]);
    const single = createRawFrameReader(1, 1, (data) => frames.push({ data, width: 1, height: 1 }));
    single(chunk);
    chunk.fill(0);
    expect([...frames[2].data]).toEqual([1, 2, 3, 4]);

    expect(() => createRawFrameReader(0, 1, () => {})).toThrow();
    expect(() => createRawFrameReader(5000, 1, () => {})).toThrow();
  });
});
