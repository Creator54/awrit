import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TermEvent } from '../awrit-native-rs';
import { getAppDataPath } from './paths';
import { installDesignIpcElectronStubs } from './design/windowDesignIpcHarness';

// Point settings at a temp dir so the Android leader key is deterministic on every platform.
const savedEnv = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA };
const dataHome = mkdtempSync(path.join(os.tmpdir(), 'awrit-input-'));
process.env.HOME = process.env.XDG_DATA_HOME = process.env.LOCALAPPDATA = dataHome;
writeFileSync(path.join(getAppDataPath(), 'settings.json'), '{"leaderKey":"Alt+D"}');
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataHome, { recursive: true, force: true });
});

const focusedView = { current: null as any };
const managedViews: any[] = [];

mock.module('./windows', () => ({
  focusedView,
  managedViews,
}));

const { handleInput, createInputHandler } = await import('./inputHandler');
const { setDismissOverlayHandler } = await import('./inputHandler');
const { options } = await import('./args');
const { loadKeyBindings } = await import('./keybindings');

function createWebContents() {
  const events: any[] = [];
  return {
    events,
    focus: mock(() => {}),
    insertText: mock(() => {}),
    paste: mock(() => {}),
    send: mock(() => {}),
    sendInputEvent: mock((event: any) => {
      events.push(event);
    }),
  };
}

function createView() {
  const contentWebContents = createWebContents();
  const toolbarWebContents = createWebContents();
  const view: any = {
    content: {
      webContents: contentWebContents,
      focus: mock(() => {}),
      focusOnWebView: mock(() => {}),
      blurWebView: mock(() => {}),
      isDestroyed: mock(() => false),
    },
    toolbar: {
      webContents: toolbarWebContents,
      focus: mock(() => {}),
      focusOnWebView: mock(() => {}),
      blurWebView: mock(() => {}),
      isDestroyed: mock(() => false),
    },
    focusedContent: contentWebContents,
    layoutContainer: { devicePixelRatio: 1 },
    contentNode: { deviceLayout: { x: 0, y: 0 } },
    toolbarNode: { deviceLayout: { x: 0, y: 0 }, computedLayout: { width: 800, height: 600 } },
    omniboxVisible: false,
    keyHelpVisible: false,
    findVisible: false,
  };
  return { view, contentWebContents, toolbarWebContents };
}

describe('handleInput', () => {
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    focusedView.current = null;
    managedViews.length = 0;
    loadKeyBindings({ keybindings: {} });
    originalStderrWrite = process.stderr.write;
  });

  afterEach(() => {
    focusedView.current = null;
    process.stderr.write = originalStderrWrite;
  });

  test('shortcut overlays receive plain keys instead of page bindings', () => {
    const { view, toolbarWebContents } = createView();
    focusedView.current = view;
    view.keyHelpVisible = true;
    const binding = mock(() => true);
    loadKeyBindings({ keybindings: { '1': binding } });
    handleInput({
      eventType: 'key',
      keyEvent: { code: '1', modifiers: [], down: true, isCharEvent: true },
    });
    expect(binding).not.toHaveBeenCalled();
    expect(toolbarWebContents.events.some((event) => event.keyCode === '1')).toBe(true);
  });

  test.each(['designMode', 'permissionPending'] as const)('routes remote paste to the toolbar while %s owns input', (overlay) => {
    installDesignIpcElectronStubs();
    const { view, contentWebContents, toolbarWebContents } = createView();
    focusedView.current = view;
    view[overlay] = true;
    expect(handleInput({ eventType: 'paste', paste: 'test text' })).toBe(true);
    expect(toolbarWebContents.paste).toHaveBeenCalledTimes(1);
    expect(contentWebContents.paste).not.toHaveBeenCalled();

    view[overlay] = false;
    expect(handleInput({ eventType: 'paste', paste: 'page text' })).toBe(true);
    expect(toolbarWebContents.paste).toHaveBeenCalledTimes(1);
    expect(contentWebContents.paste).toHaveBeenCalledTimes(1);
  });

  test('terminal key delivery marks synthetic input only during the send', () => {
    const { view, contentWebContents } = createView();
    const { createSyntheticInputGuard } = require('./syntheticInput');
    const guard = createSyntheticInputGuard();
    const observed: boolean[] = [];
    contentWebContents.sendInputEvent = () => { observed.push(guard.active(contentWebContents)); };
    const handler = createInputHandler(() => view, () => [view], false, guard);
    handler.handleInput({ eventType: 'key', keyEvent: { code: 'q', modifiers: [], down: true, isCharEvent: true } });
    expect(observed).toEqual([true, true]);
    expect(guard.active(contentWebContents)).toBe(false);
    handler.dispose();
  });

  test('forwards SGR pixel mouse coordinates unchanged', () => {
    const { view, contentWebContents } = createView();
    focusedView.current = view;

    const event: TermEvent = {
      eventType: 'mouse',
      mouseEvent: {
        kind: 'mouseDown',
        button: 'left',
        x: 40,
        y: 20,
        modifiers: [],
      },
    };

    expect(handleInput(event)).toBe(true);
    expect(contentWebContents.events[0]).toMatchObject({
      type: 'mouseDown',
      x: 40,
      y: 20,
      button: 'left',
    });
  });

  test('does not write terminal logs for input events', () => {
    const { view } = createView();
    focusedView.current = view;
    const stderrWrite = mock(() => true);
    process.stderr.write = stderrWrite as any;

    const event: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'a',
        modifiers: [],
        down: true,
        isCharEvent: true,
      },
    };

    handleInput(event);

    expect(stderrWrite).not.toHaveBeenCalled();
  });

  test('recovers routing when the focused view pointer is lost', () => {
    const { view, contentWebContents } = createView();
    managedViews.push(view);

    const event: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'a',
        modifiers: [],
        down: true,
        isCharEvent: true,
      },
    };

    expect(handleInput(event)).toBe(false);
    expect(focusedView.current).toBe(view);
    expect(contentWebContents.events).toContainEqual({
      type: 'char',
      keyCode: 'a',
      modifiers: [],
    });
  });

  test('recovers routing when the focused view pointer is stale', () => {
    const { view: staleView } = createView();
    const { view, contentWebContents } = createView();
    staleView.destroyed = true;
    focusedView.current = staleView;
    managedViews.push(view);

    const event: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'a',
        modifiers: [],
        down: true,
        isCharEvent: true,
      },
    };

    expect(handleInput(event)).toBe(false);
    expect(focusedView.current).toBe(view);
    expect(contentWebContents.events).toContainEqual({
      type: 'char',
      keyCode: 'a',
      modifiers: [],
    });
  });

  test('runs keybindings after recovering a lost focused view', () => {
    const { view } = createView();
    managedViews.push(view);
    view.toggleOmnibox = mock(() => {});
    loadKeyBindings({ keybindings: { '<C-l>': ({ view }) => view?.toggleOmnibox() } });

    const event: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'l',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: true,
      },
    };

    expect(handleInput(event)).toBe(true);
    expect(focusedView.current).toBe(view);
    expect(view.toggleOmnibox).toHaveBeenCalled();
  });

  test('does not intercept an unregistered omnibox hotkey', () => {
    const { view } = createView();
    focusedView.current = view;
    view.toggleOmnibox = mock(() => {});
    loadKeyBindings({ keybindings: {} });

    const event: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'l',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: true,
      },
    };

    expect(handleInput(event)).toBe(false);
    expect(view.toggleOmnibox).not.toHaveBeenCalled();
  });

  test('horizontal mouse navigation still goes back without an overlay', () => {
    const { view } = createView();
    view.back = mock(() => {});
    focusedView.current = view;
    const event: TermEvent = {
      eventType: 'mouse',
      mouseEvent: { kind: 'scrollLeft', x: 40, y: 20, modifiers: [] },
    };

    handleInput(event);
    handleInput(event);
    handleInput(event);
    expect(view.back).toHaveBeenCalledTimes(1);
  });

  test('sideways wheel scrolls content like the vertical wheel', () => {
    const { view, contentWebContents } = createView();
    focusedView.current = view;
    for (const kind of ['scrollLeft', 'scrollRight'] as const) {
      handleInput({ eventType: 'mouse', mouseEvent: { kind, x: 40, y: 20, modifiers: [] } });
    }
    // Wheel-left reveals content on the left: DOM deltaX must be negative.
    expect(contentWebContents.events.map((event: any) => Math.sign(event.deltaX))).toEqual([1, -1]);
  });

  test('ADB wheel input reaches the phone without browser navigation', () => {
    const { view, contentWebContents } = createView();
    view.adbMode = true;
    view.back = mock(() => {});
    focusedView.current = view;
    for (const kind of ['scrollDown', 'scrollRight', 'scrollRight', 'scrollRight'] as const) {
      handleInput({ eventType: 'mouse', mouseEvent: { kind, x: 40, y: 20, modifiers: [] } });
    }
    expect(view.back).not.toHaveBeenCalled();
    expect(contentWebContents.events.map((event: any) => [event.deltaX, event.deltaY])).toEqual([
      [0, -24],
      [-24, 0],
      [-24, 0],
      [-24, 0],
    ]);
  });

  test('Design mode preserves quit shortcuts for browser and device viewers', () => {
    for (const adbMode of [false, true]) {
      const { view } = createView();
      view.adbMode = adbMode;
      view.designMode = true;
      focusedView.current = view;
      const quit = mock(() => true);
      loadKeyBindings({ keybindings: { '<C-d>': quit, '<C-q>': quit, '<M-q>': quit } });
      for (const code of ['d', 'q']) {
        handleInput({ eventType: 'key', keyEvent: { code, modifiers: ['ctrl'], down: true, isCharEvent: false } });
      }
      handleInput({ eventType: 'key', keyEvent: { code: 'q', modifiers: ['meta'], down: true, isCharEvent: false } });
      expect(quit).toHaveBeenCalledTimes(3);
      for (const code of ['d', 'q']) {
        handleInput({ eventType: 'key', keyEvent: { code, modifiers: [], down: true, isCharEvent: false } });
      }
      expect(quit).toHaveBeenCalledTimes(3);
    }
  });

  test('ADB mode: plain keys bypass Awrit vim bindings and go to page', () => {
    const { view, contentWebContents } = createView();
    view.adbMode = true;
    view.inputFocused = false;
    focusedView.current = view;
    loadKeyBindings({ keybindings: { l: () => true } }); // vim scroll-right
    const event: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'l', modifiers: [], down: true, isCharEvent: true },
    };
    const result = handleInput(event);
    expect(result).toBe(true);
    expect(contentWebContents.events).toContainEqual({ type: 'char', keyCode: 'l', modifiers: [] });
    for (const code of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()-_=+[]{};:"\'\\|,<.>/?`~') {
      expect(
        handleInput({
          eventType: 'key',
          keyEvent: { code, modifiers: [], down: true, isCharEvent: true },
        }),
      ).toBe(true);
      expect(contentWebContents.events.at(-1)).toMatchObject({ type: 'char', keyCode: code });
    }
    // Unbound Ctrl shortcuts still reach the phone.
    for (const code of ['a', 'x', 'z', 'y', 'f']) {
      expect(
        handleInput({
          eventType: 'key',
          keyEvent: { code, modifiers: ['ctrl'], down: true, isCharEvent: false },
        }),
      ).toBe(true);
      expect(contentWebContents.events.at(-1)).toMatchObject({
        type: 'keyDown',
        keyCode: code,
        modifiers: ['control'],
      });
    }
    // Every bound modifier shortcut (Ctrl+D quit, Alt+H help, ...) stays with Awrit.
    const quit = mock(() => true);
    const help = mock(() => true);
    const copy = mock(() => true);
    loadKeyBindings({
      keybindings: { '<C-q>': quit, '<C-d>': quit, '<A-h>': help, '<C-c>': copy },
    });
    const sent = contentWebContents.events.length;
    for (const [code, modifiers] of [
      ['q', ['ctrl']],
      ['d', ['ctrl']],
      ['h', ['alt']],
    ] as const) {
      expect(
        handleInput({
          eventType: 'key',
          keyEvent: { code, modifiers: [...modifiers], down: true, isCharEvent: false },
        }),
      ).toBe(true);
    }
    expect(quit).toHaveBeenCalledTimes(2);
    expect(help).toHaveBeenCalledTimes(1);
    // Ctrl+C is left unhandled so index.ts quits, even though a copy binding exists.
    expect(
      handleInput({
        eventType: 'key',
        keyEvent: { code: 'c', modifiers: ['ctrl'], down: true, isCharEvent: false },
      }),
    ).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    expect(contentWebContents.events.length).toBe(sent);
    // Ctrl+Shift+C goes to the phone instead of Awrit's page copy binding.
    loadKeyBindings({ keybindings: { '<C-S-c>': copy } });
    expect(
      handleInput({
        eventType: 'key',
        keyEvent: { code: 'c', modifiers: ['ctrl', 'shift'], down: true, isCharEvent: false },
      }),
    ).toBe(true);
    expect(copy).not.toHaveBeenCalled();
    expect(contentWebContents.events.at(-1)).toMatchObject({
      type: 'keyDown',
      keyCode: 'c',
      modifiers: ['control', 'shift'],
    });
    // Caps Lock doesn't turn typing into a shortcut.
    expect(
      handleInput({
        eventType: 'key',
        keyEvent: { code: 'l', modifiers: ['capsLock'], down: true, isCharEvent: true },
      }),
    ).toBe(true);
    expect(contentWebContents.events.at(-1)).toMatchObject({ type: 'char', keyCode: 'l' });
    view.omniboxVisible = true;
    const binding = mock(() => true);
    loadKeyBindings({ keybindings: { l: binding } });
    handleInput(event);
    expect(binding).toHaveBeenCalledTimes(1);
  });

  test('ADB mode: the Android leader key reaches the phone instead of running Awrit bindings', () => {
    const { view, contentWebContents } = createView();
    view.adbMode = true;
    focusedView.current = view;
    const designToggle = mock(() => true);
    loadKeyBindings({ keybindings: { '<A-d>': designToggle } });
    const altD: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'd', modifiers: ['alt'], down: true, isCharEvent: false },
    };
    expect(handleInput(altD)).toBe(true);
    expect(designToggle).not.toHaveBeenCalled();
    expect(contentWebContents.events.at(-1)).toMatchObject({
      type: 'keyDown',
      keyCode: 'd',
      modifiers: ['alt'],
    });
    // Outside ADB mode the same key still runs the Awrit binding.
    view.adbMode = false;
    expect(handleInput(altD)).toBe(true);
    expect(designToggle).toHaveBeenCalledTimes(1);
  });

  test('routes keyboard and mouse exclusively to toolbar when designMode is active', () => {
    const { view, contentWebContents, toolbarWebContents } = createView();
    focusedView.current = view;
    view.designMode = true;

    // Register vim binding like 'r' (refresh) and verify it doesn't intercept typing in design mode
    const refreshBinding = mock(() => true);
    loadKeyBindings({ keybindings: { r: refreshBinding } });

    // Key event 'r' (like typing "r" in a comment)
    const keyEvtR: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'r', modifiers: [], down: true, isCharEvent: true },
    };
    expect(handleInput(keyEvtR)).toBe(false);
    expect(refreshBinding).not.toHaveBeenCalled();
    expect(contentWebContents.events.length).toBe(0);
    expect(toolbarWebContents.events).toContainEqual(
      expect.objectContaining({ type: 'keyDown', keyCode: 'r' }),
    );

    // Key event
    const keyEvt: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'x', modifiers: [], down: true, isCharEvent: true },
    };
    handleInput(keyEvt);

    expect(contentWebContents.events.length).toBe(0);
    expect(toolbarWebContents.events).toContainEqual(
      expect.objectContaining({ type: 'keyDown', keyCode: 'x' }),
    );

    // Mouse event
    const mouseEvt: TermEvent = {
      eventType: 'mouse',
      mouseEvent: { kind: 'mouseDown', button: 'left', x: 20, y: 30, modifiers: [] },
    };
    handleInput(mouseEvt);

    expect(contentWebContents.events.length).toBe(0);
    expect(toolbarWebContents.events).toContainEqual(
      expect.objectContaining({ type: 'mouseDown', button: 'left' }),
    );
  });

  test('standalone permission prompts receive clicks instead of the page', () => {
    const { view, contentWebContents, toolbarWebContents } = createView();
    focusedView.current = view;
    view.permissionPending = true;
    const click = () => {
      for (const kind of ['mouseDown', 'mouseUp'] as const) {
        handleInput({ eventType: 'mouse', mouseEvent: { kind, button: 'left', x: 20, y: 30, modifiers: [] } });
      }
    };
    click();
    expect(toolbarWebContents.events.map(({ type }) => type)).toEqual(['mouseDown', 'mouseUp']);
    expect(contentWebContents.events).toEqual([]);

    view.permissionPending = false;
    click();
    expect(contentWebContents.events.map(({ type }) => type)).toEqual(['mouseDown', 'mouseUp']);
  });

  test('permission prompt scrolling takes priority over omnibox suggestions', () => {
    const { view, toolbarWebContents } = createView();
    focusedView.current = view;
    view.omniboxVisible = true;
    view.permissionPending = true;
    handleInput({ eventType: 'mouse', mouseEvent: { kind: 'scrollDown', x: 20, y: 30, modifiers: [] } });
    expect(toolbarWebContents.send).not.toHaveBeenCalled();
    expect(toolbarWebContents.events).toContainEqual(expect.objectContaining({ type: 'mouseWheel', deltaY: -100 }));
  });

  test('a pending permission prompt receives Escape instead of dismissing the overlay', () => {
    const { view, toolbarWebContents } = createView();
    focusedView.current = view;
    options.overlay = true;
    let dismissed = 0;
    setDismissOverlayHandler(() => {
      dismissed++;
    });
    view.permissionPending = true;
    handleInput({
      eventType: 'key',
      keyEvent: { code: 'escape', modifiers: [], down: true, isCharEvent: false },
    });
    expect(dismissed).toBe(0);
    expect(toolbarWebContents.events.at(0)).toMatchObject({ type: 'keyDown', keyCode: 'escape' });
  });

  test('overlay mode dismisses idle overlay on unmodified Escape and respects nested UI', async () => {
    const { view, contentWebContents } = createView();
    focusedView.current = view;
    options.overlay = true;

    let dismissed = 0;
    setDismissOverlayHandler(() => {
      dismissed++;
    });

    // 0. Design mode takes priority over closing the overlay
    view.designMode = true;
    let designToggled = false;
    view.toggleDesignMode = () => {
      view.designMode = false;
      designToggled = true;
    };
    const escDesign: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'escape', modifiers: [], down: true, isCharEvent: false },
    };
    expect(handleInput(escDesign)).toBe(true);
    expect(designToggled).toBe(true);
    expect(dismissed).toBe(0);
    view.designMode = false;

    // Reset escape state
    const escUp0: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'escape', modifiers: [], down: false, isCharEvent: false },
    };
    handleInput(escUp0);

    // 1. Idle overlay dismisses on first unmodified Escape down
    const escDown: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'escape', modifiers: [], down: true, isCharEvent: false },
    };
    expect(handleInput(escDown)).toBe(true);
    expect(dismissed).toBe(1);
    expect(contentWebContents.events.length).toBe(0);

    // 2. Auto-repeat while down is active is suppressed
    expect(handleInput(escDown)).toBe(true);
    expect(dismissed).toBe(1);

    // 3. KeyUp resets suppression and does not dismiss
    const escUp: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'escape', modifiers: [], down: false, isCharEvent: false },
    };
    expect(handleInput(escUp)).toBe(true);
    expect(dismissed).toBe(1);

    // 4. Modified Escape (ctrl+escape) does not dismiss
    const ctrlEsc: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'escape', modifiers: ['ctrl'], down: true, isCharEvent: false },
    };
    handleInput(ctrlEsc);
    expect(dismissed).toBe(1);

    // 4b. An open site-info panel closes first; the omnibox stays
    view.omniboxVisible = true;
    view.siteInfoOpen = true;
    view.toggleOmnibox = mock(() => {});
    expect(handleInput(escDown)).toBe(true);
    expect(view.toggleOmnibox).not.toHaveBeenCalled();
    expect(view.toolbar.webContents.send).toHaveBeenCalledWith('toolbar:close-site-info');
    view.siteInfoOpen = false;
    handleInput(escUp);

    // 5. Host toolbar active consumes Escape first
    view.omniboxVisible = true;
    view.toggleOmnibox = mock(() => {
      view.omniboxVisible = false;
    });
    expect(handleInput(escDown)).toBe(true);
    expect(view.toggleOmnibox).toHaveBeenCalledTimes(1);
    expect(dismissed).toBe(1);
    handleInput(escUp);

    // 6. Browser mode with inputFocused blurs input first
    view.adbMode = false;
    view.inputFocused = true;
    contentWebContents.executeJavaScript = mock(() => Promise.resolve());
    expect(handleInput(escDown)).toBe(true);
    expect(contentWebContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(view.inputFocused).toBe(false);
    expect(dismissed).toBe(1);
    handleInput(escUp);

    // 7. ADB mode with adbControlsVisible hides controls first
    view.adbMode = true;
    view.adbControlsVisible = true;
    expect(handleInput(escDown)).toBe(true);
    expect(view.adbControlsVisible).toBe(false);
    expect(contentWebContents.events.at(-1)).toMatchObject({
      type: 'keyDown',
      keyCode: 'Escape',
      modifiers: [],
    });
    expect(dismissed).toBe(1);
    handleInput(escUp);

    // 8. Next Escape after controls hidden dismisses overlay
    expect(handleInput(escDown)).toBe(true);
    expect(dismissed).toBe(2);
    handleInput(escUp);

    // 9. Non-overlay mode forwards Escape in ADB mode without dismissing
    options.overlay = false;
    view.adbControlsVisible = false;
    const prevEvents = contentWebContents.events.length;
    expect(handleInput(escDown)).toBe(true);
    expect(dismissed).toBe(2);
    expect(contentWebContents.events.length).toBe(prevEvents + 1);
  });
});
