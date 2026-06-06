import type { KeyEvent as KeyEventOriginal, TermEvent } from 'awrit-native-rs';
import { handleEvent as handleKeyBinding } from './keybindings';
import { focusedView, getWindowSize, managedViews } from './windows';
import { showNavigationOverlay } from './tty/overlay';

const WHEEL_DELTA = 100;
const NAVIGATION_THRESHOLD = 3;
const NAVIGATION_COOLDOWN = 500;

let horizontalScrollAccumulator = 0;
let lastNavigationTime = 0;
let lastScrollTime = 0;

let lastSentX = -1;
let lastSentY = -1;
let lastSentView: any = null;
let lastSentMods = '';

const mouseEventTypes = ['mouseDown', 'mouseUp', 'mouseMove'] as const;

/**
 * Maps terminal modifier names to Electron-compatible names
 */
function normalizeModifiers(modifiers: string[]): any[] {
  return (modifiers || []).map((m) => {
    const lower = m.toLowerCase();
    if (lower === 'ctrl') return 'control';
    if (lower === 'meta') return 'meta'; // 'command' or 'cmd' also works
    return lower;
  });
}

function isSimpleMouseEvent(kind: unknown): kind is (typeof mouseEventTypes)[number] {
  return mouseEventTypes.includes(kind as (typeof mouseEventTypes)[number]);
}

export function handleInput(evt: TermEvent): boolean {
  const view = focusedView.current;
  if (!view) {
    return handleKeyBinding(evt);
  }

  switch (evt.eventType) {
    case 'key': {
      if (handleKeyBinding(evt, view)) {
        return true;
      }

      const isToolbarActive = view.omniboxVisible || view.keyHelpVisible || view.findVisible;
      const webContents = isToolbarActive ? view.toolbar.webContents : view.focusedContent;
      
      // OPTIMIZED FOCUS: Only focus if not already focused
      if (view.focusedContent !== webContents) {
        webContents.focus();
        view.focusedContent = webContents;
      }
      
      const keyEvent = evt.keyEvent;
      if (!keyEvent) return false;
      const { code, modifiers, down, isCharEvent } = keyEvent;
      const electronMods = normalizeModifiers(modifiers);

      if (down) {
        // keyDown event
        webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: code,
          modifiers: electronMods,
        });

        // char event for printable characters
        if (isCharEvent) {
          webContents.sendInputEvent({
            type: 'char',
            keyCode: code,
            modifiers: electronMods,
          });
        }
      } else {
        // keyUp event
        webContents.sendInputEvent({
          type: 'keyUp',
          keyCode: code,
          modifiers: electronMods,
        });
      }
      return false;
    }

    case 'resize': {
      for (const v of managedViews) {
        v.relayout();
      }
      return true;
    }

    case 'paste': {
      if (evt.paste) {
        const isToolbarActive = view.omniboxVisible || view.keyHelpVisible || view.findVisible;
        const webContents = isToolbarActive ? view.toolbar.webContents : view.content.webContents;
        webContents.insertText(evt.paste);
      }
      return true;
    }

    case 'focus':
      if (evt.focusGained) {
        view.focusedContent.focus();
      }
      return true;

    case 'mouse': {
      const mouseEvent = evt.mouseEvent;
      if (!mouseEvent) return false;
      const { kind, button, x, y, modifiers } = mouseEvent;
      const electronMods = normalizeModifiers(modifiers);
      
      if (
        (kind === 'mouseUp' || kind === 'mouseDown') &&
        button &&
        ['fourth', 'fifth'].includes(button ?? '')
      ) {
        return handleKeyBinding(evt, view);
      }

      const rawX = x ?? 0;
      const rawY = y ?? 0;

      const { toolbarNode, contentNode, layoutContainer } = view;
      const dpr = layoutContainer.devicePixelRatio;

      const isOverlayActive = view.omniboxVisible || view.keyHelpVisible || view.findVisible;
      const isInToolbar = isOverlayActive;

      const targetWindow = isInToolbar ? view.toolbar : view.content;
      const targetContents = isInToolbar ? targetWindow.webContents : view.focusedContent;

      // OPTIMIZED FOCUS: Only focus if not already focused
      if (view.focusedContent !== targetContents) {
        targetContents.focus();
        view.focusedContent = targetContents;
      }

      const targetNode = isInToolbar ? toolbarNode : contentNode;
      const adjustedX = Math.floor((rawX - targetNode.deviceLayout.x) / dpr);
      const adjustedY = Math.floor((rawY - targetNode.deviceLayout.y) / dpr);

      if (kind === 'mouseMove') {
        const mods = electronMods.join(',');
        if (
          view === lastSentView &&
          adjustedX === lastSentX &&
          adjustedY === lastSentY &&
          mods === lastSentMods
        ) {
          return true;
        }
        lastSentX = adjustedX;
        lastSentY = adjustedY;
        lastSentView = view;
        lastSentMods = mods;
      }

      if (kind === 'scrollUp' || kind === 'scrollDown') {
        view.content.webContents.sendInputEvent({
          type: 'mouseWheel',
          wheelTicksY: kind === 'scrollUp' ? 1 : -1,
          wheelTicksX: 0,
          deltaX: 0,
          deltaY: kind === 'scrollUp' ? WHEEL_DELTA : -WHEEL_DELTA,
          modifiers: electronMods,
          x: adjustedX,
          y: adjustedY,
          accelerationRatioY: 0.5,
          hasPreciseScrollingDeltas: false,
          canScroll: true,
        });
        return true;
      }

      if (kind === 'scrollLeft' || kind === 'scrollRight') {
        const now = Date.now();
        const direction = kind === 'scrollLeft' ? -1 : 1;

        if (Math.sign(horizontalScrollAccumulator) !== direction || now - lastScrollTime > 1000) {
          horizontalScrollAccumulator = 0;
        }

        horizontalScrollAccumulator += direction;
        lastScrollTime = now;

        if (
          Math.abs(horizontalScrollAccumulator) >= NAVIGATION_THRESHOLD &&
          now - lastNavigationTime > NAVIGATION_COOLDOWN
        ) {
          const winSize = getWindowSize();
          if (direction === -1) {
            view.back();
            showNavigationOverlay('left', winSize);
          } else {
            view.forward();
            showNavigationOverlay('right', winSize);
          }
          lastNavigationTime = now;
          horizontalScrollAccumulator = 0;
        }

        view.content.webContents.sendInputEvent({
          type: 'mouseWheel',
          wheelTicksY: 0,
          wheelTicksX: direction,
          deltaX: direction * WHEEL_DELTA,
          deltaY: 0,
          modifiers: electronMods,
          x: adjustedX,
          y: adjustedY,
          accelerationRatioX: 0.5,
          hasPreciseScrollingDeltas: false,
          canScroll: true,
        });
        return true;
      }

      if (!isSimpleMouseEvent(kind)) {
        return false;
      }
      if (!button && kind !== 'mouseMove') {
        return false;
      }

      const electronButton =
        button === 'fourth' || button === 'fifth' || button == null ? undefined : button;

      targetContents.sendInputEvent({
        type: kind,
        x: adjustedX,
        y: adjustedY,
        button: electronButton,
        modifiers: electronMods,
        clickCount: kind === 'mouseDown' ? 1 : 0,
      });

      if (kind === 'mouseDown' && button === 'left') {
        if (targetContents === view.content.webContents) {
          view.toolbar.blurWebView();
          view.content.focusOnWebView();
        } else {
          view.content.blurWebView();
          view.toolbar.focusOnWebView();
        }
      }
      return true;
    }
  }
  return false;
}
