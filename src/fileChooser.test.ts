import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { setupFileChooser } from './fileChooser';

class FakeDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params: unknown }> = [];
  failAttach = false;
  attributes: string[] = [];
  failCommand?: string;
  isAttached() {
    return this.attached;
  }
  attach() {
    if (this.failAttach) throw new Error('attachment refused');
    this.attached = true;
  }
  detach() {
    this.attached = false;
  }
  async sendCommand(method: string, params: unknown) {
    this.commands.push({ method, params });
    if (method === this.failCommand) throw new Error('command refused');
    return method === 'DOM.describeNode' ? { node: { attributes: this.attributes } } : {};
  }
}

test('file inputs are answered from a parentless dialog; cancel leaves the input alone', async () => {
  const debuggerApi = new FakeDebugger();
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
  const answers = [
    { canceled: false, filePaths: ['/a.txt', '/b.txt'] },
    { canceled: true, filePaths: [] },
  ];
  const asked: Electron.OpenDialogOptions[] = [];
  const stop = setupFileChooser(webContents, async (options) => {
    asked.push(options);
    return answers.shift() ?? { canceled: true, filePaths: [] };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(debuggerApi.commands.map((c) => c.method)).toEqual([
    'Page.enable',
    'Page.setInterceptFileChooserDialog',
  ]);

  debuggerApi.emit('message', {}, 'Page.fileChooserOpened', {
    backendNodeId: 7,
    mode: 'selectMultiple',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  debuggerApi.emit('message', {}, 'Page.fileChooserOpened', {
    backendNodeId: 8,
    mode: 'selectSingle',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(asked.map((o) => o.properties)).toEqual([['openFile', 'multiSelections'], ['openFile']]);
  expect(debuggerApi.commands.slice(2).filter(command => command.method !== 'DOM.describeNode')).toEqual([
    { method: 'DOM.setFileInputFiles', params: { files: ['/a.txt', '/b.txt'], backendNodeId: 7 } },
  ]);
  stop();
  expect(debuggerApi.commands.at(-1)).toEqual({
    method: 'Page.setInterceptFileChooserDialog',
    params: { enabled: false },
  });
});

for (const failure of ['attach', 'Page.enable', 'Page.setInterceptFileChooserDialog']) {
  test(`reports unavailable if ${failure} fails, without showing a dialog`, async () => {
    const debuggerApi = new FakeDebugger();
    debuggerApi.failAttach = failure === 'attach';
    if (failure !== 'attach') debuggerApi.failCommand = failure;
    const webContents = Object.assign(new EventEmitter(), {
      debugger: debuggerApi,
      isDestroyed: () => false,
    }) as unknown as Electron.WebContents;
    let unavailable = 0;
    let dialogs = 0;
    const log = spyOn(console, 'error').mockImplementation(() => {});
    let stop = () => {};
    try {
      stop = setupFileChooser(
        webContents,
        async () => {
          dialogs++;
          return { canceled: true, filePaths: [] };
        },
        () => {
          unavailable++;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unavailable).toBe(1);
      expect(dialogs).toBe(0);
      expect(
        debuggerApi.commands.some((command) => command.method === 'DOM.setFileInputFiles'),
      ).toBe(false);
      if (failure === 'Page.enable') {
        expect(debuggerApi.commands.map((command) => command.method)).toEqual(['Page.enable']);
      }
    } finally {
      stop();
      log.mockRestore();
    }
  });
}

for (const end of ['did-start-navigation', 'destroyed', 'teardown']) {
  test(`a pending chooser cannot install files after ${end}`, async () => {
    const debuggerApi = new FakeDebugger();
    let destroyed = false;
    const webContents = Object.assign(new EventEmitter(), {
      debugger: debuggerApi,
      isDestroyed: () => destroyed,
    }) as unknown as Electron.WebContents;
    let finish: (value: Electron.OpenDialogReturnValue) => void = () => {};
    let signal: AbortSignal | undefined;
    const stop = setupFileChooser(webContents, (_options, pendingSignal) => {
      signal = pendingSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    debuggerApi.emit('message', {}, 'Page.fileChooserOpened', {
      backendNodeId: 1,
      mode: 'selectSingle',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(signal?.aborted).toBe(false);
    if (end === 'teardown') stop();
    else {
      destroyed = end === 'destroyed';
      webContents.emit(end);
    }
    expect(signal?.aborted).toBe(true);
    finish({ canceled: false, filePaths: ['/private/chosen.txt'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(debuggerApi.commands.some((command) => command.method === 'DOM.setFileInputFiles')).toBe(
      false,
    );
    stop();
    expect(webContents.listenerCount('did-start-navigation')).toBe(0);
  });
}

test('a second chooser is ignored while a dialog is open', async () => {
  const debuggerApi = new FakeDebugger();
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
  let finish: (value: Electron.OpenDialogReturnValue) => void = () => {};
  let asked = 0;
  const stop = setupFileChooser(webContents, () => {
    asked++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  debuggerApi.emit('message', {}, 'Page.fileChooserOpened', {
    backendNodeId: 1,
    mode: 'selectSingle',
  });
  debuggerApi.emit('message', {}, 'Page.fileChooserOpened', {
    backendNodeId: 2,
    mode: 'selectSingle',
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(asked).toBe(1);
  finish({ canceled: true, filePaths: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  debuggerApi.emit('message', {}, 'Page.fileChooserOpened', {
    backendNodeId: 3,
    mode: 'selectSingle',
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(asked).toBe(2);
  stop();
});

test('remote installation is awaited once and its signal lasts until document teardown', async () => {
  const debuggerApi = new FakeDebugger();
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
  let signal: AbortSignal | undefined;
  const stop = setupFileChooser(
    webContents,
    async (_options, document, install) => {
      signal = document;
      await install('/verified.txt');
      return { canceled: true, filePaths: [] };
    },
    undefined,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  debuggerApi.emit('message', {}, 'Page.fileChooserOpened', {
    backendNodeId: 4,
    mode: 'selectSingle',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    debuggerApi.commands.filter((command) => command.method === 'DOM.setFileInputFiles'),
  ).toEqual([
    { method: 'DOM.setFileInputFiles', params: { files: ['/verified.txt'], backendNodeId: 4 } },
  ]);
  expect(signal?.aborted).toBe(false);
  stop();
  expect(signal?.aborted).toBe(true);
});

test('installed selections keep their document signal until navigation or teardown', async () => {
  const debuggerApi = new FakeDebugger();
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
  const signals: AbortSignal[] = [];
  const stop = setupFileChooser(
    webContents,
    async (_options, signal) => {
      signals.push(signal);
      return { canceled: false, filePaths: ['/chosen.txt'] };
    },
    undefined,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const backendNodeId of [1, 2]) {
    debuggerApi.emit('message', {}, 'Page.fileChooserOpened', {
      backendNodeId,
      mode: 'selectSingle',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
  webContents.emit('did-start-navigation', {}, '#fragment', true, true);
  webContents.emit('did-start-navigation', {}, 'https://subframe.test', false, false);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
  webContents.emit('did-start-navigation', {}, 'https://next.test', false, true);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  debuggerApi.emit('message', {}, 'Page.fileChooserOpened', {
    backendNodeId: 3,
    mode: 'selectSingle',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(signals[2]?.aborted).toBe(false);
  stop();
  expect(signals[2]?.aborted).toBe(true);
});


test('directory upload inputs open a folder chooser using the real CDP mode', async () => {
  const debuggerApi = new FakeDebugger();
  debuggerApi.attributes = ['type', 'file', 'webkitdirectory', '', 'multiple', ''];
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi, isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
  let properties: unknown;
  const stop = setupFileChooser(webContents, async options => {
    properties = options.properties;
    return { canceled: false, filePaths: ['/folder'] };
  });
  debuggerApi.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 9, mode: 'selectMultiple' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(properties).toEqual(['openDirectory']);
  expect(debuggerApi.commands).toContainEqual({ method: 'DOM.setFileInputFiles', params: { files: ['/folder'], backendNodeId: 9 } });
  stop();
});


for (const [accept, directory, expected] of [
  ['.PNG, .jpg,.png', false, ['png', 'jpg']],
  ['.blend', false, ['blend']],
  ['image/*,.png', false, undefined],
  ['.png', true, undefined],
] as const) {
  test(`file chooser filters ${accept}, directory=${directory}`, async () => {
    const debuggerApi = new FakeDebugger();
    debuggerApi.attributes = ['type', 'file', 'accept', accept, ...(directory ? ['webkitdirectory', ''] : [])];
    const webContents = Object.assign(new EventEmitter(), {
      debugger: debuggerApi, isDestroyed: () => false,
    }) as unknown as Electron.WebContents;
    let options: Electron.OpenDialogOptions | undefined;
    const stop = setupFileChooser(webContents, async value => {
      options = value;
      return { canceled: true, filePaths: [] };
    });
    debuggerApi.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 9, mode: 'selectSingle' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(options?.filters?.[0].extensions).toEqual(expected);
    if (expected) expect(options?.filters?.[1].extensions).toEqual(['*']);
    stop();
  });
}


test('stopping a chooser during startup never re-enables interception', async () => {
  const debuggerApi = new FakeDebugger();
  let release!: () => void;
  const enable = new Promise<void>(resolve => { release = resolve; });
  const original = debuggerApi.sendCommand.bind(debuggerApi);
  debuggerApi.sendCommand = async (method, params) => {
    if (method === 'Page.enable') await enable;
    return original(method, params);
  };
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi, isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
  const stop = setupFileChooser(webContents, async () => ({ canceled: true, filePaths: [] }));
  stop();
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(debuggerApi.commands.filter(command =>
    command.method === 'Page.setInterceptFileChooserDialog' &&
    (command.params as { enabled: boolean }).enabled,
  )).toEqual([]);
});
