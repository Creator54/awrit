import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TermEvent } from '../awrit-native-rs';

const focusedView = { current: null as any };
const managedViews: any[] = [];

mock.module('./tty/overlay', () => ({
  showNavigationOverlay: () => {},
}));

mock.module('./windows', () => ({
  focusedView,
  managedViews,
  getWindowSize: () => ({ width: 1200, height: 800, cols: 120, rows: 40 }),
  setTerminalIsFocused: () => {},
  updateFrameRates: () => {},
}));

const { handleInput } = await import('./inputHandler');
const { loadKeyBindings } = await import('./keybindings');

function createWebContents() {
  const events: any[] = [];
  return {
    events,
    focus: mock(() => {}),
    insertText: mock(() => {}),
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
    toolbarNode: { deviceLayout: { x: 0, y: 0 } },
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
});
