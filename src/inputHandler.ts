import type { KeyEvent as KeyEventOriginal, TermEvent } from 'awrit-native-rs';
import { handleEvent as handleKeyBinding } from './keybindings';
import { focusedView, getWindowSize } from './windows';
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
type KeyEventModifiers = Lowercase<KeyEventOriginal['modifiers'][number]>[];
type KeyEvent = Omit<KeyEventOriginal, 'modifiers'> & {
  modifiers: KeyEventModifiers;
};

function isSimpleMouseEvent(kind: unknown): kind is (typeof mouseEventTypes)[number] {
  return mouseEventTypes.includes(kind as (typeof mouseEventTypes)[number]);
}

export function handleInput(evt: TermEvent) {
  const view = focusedView.current;
  if (!view) {
    handleKeyBinding(evt);
    return;
  }

  switch (evt.eventType) {
    case 'key': {
      if (handleKeyBinding(evt, view)) {
        return;
      }

      const webContents = view.omniboxVisible ? view.toolbar.webContents : view.focusedContent;
      const { code: keyCode, modifiers, down, isCharEvent } = evt.keyEvent as KeyEvent;

      if (isCharEvent && down) {
        webContents.sendInputEvent({
          type: 'rawKeyDown',
          keyCode,
          modifiers,
        });
        webContents.sendInputEvent({
          type: 'char',
          keyCode,
          modifiers,
        });
      } else {
        webContents.sendInputEvent({
          type: down ? 'keyDown' : 'keyUp',
          keyCode,
          modifiers,
        });
      }
      break;
    }

    case 'resize': {
      const resizeView = focusedView.current;
      if (resizeView) {
        resizeView.relayout();
      }
      break;
    }

    case 'paste': {
      if (evt.paste) {
        const webContents = view.omniboxVisible ? view.toolbar.webContents : view.focusedContent;
        webContents.insertText(evt.paste);
      }
      break;
    }

    case 'focus':
      break;

    case 'mouse': {
      const { kind, button, x, y, modifiers } = evt.mouseEvent;
      if (
        (kind === 'mouseUp' || kind === 'mouseDown') &&
        button &&
        ['fourth', 'fifth'].includes(button ?? '')
      ) {
        handleKeyBinding(evt, view);
        return;
      }

      const rawX = x ?? 0;
      const rawY = y ?? 0;

      const { toolbarNode, contentNode, layoutContainer } = view;
      const dpr = layoutContainer.devicePixelRatio;

      // Determine if click is in toolbar or content area
      // If omnibox is visible, it takes precedence as an overlay
      const isInToolbar = view.omniboxVisible || rawY < contentNode.deviceLayout.y;

      // Pick target webContents and compute coordinates relative to it
      const targetNode = isInToolbar ? toolbarNode : contentNode;
      const targetContents = isInToolbar ? view.toolbar.webContents : view.content.webContents;

      // Convert from terminal pixels to CSS pixels relative to the target area
      const adjustedX = Math.floor((rawX - targetNode.deviceLayout.x) / dpr);
      const adjustedY = Math.floor((rawY - targetNode.deviceLayout.y) / dpr);

      if (kind === 'mouseMove') {
        const mods = (modifiers || []).join(',');
        if (
          view === lastSentView &&
          adjustedX === lastSentX &&
          adjustedY === lastSentY &&
          mods === lastSentMods
        ) {
          return;
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
          modifiers,
          x: adjustedX,
          y: adjustedY,
          accelerationRatioY: 0.5,
          hasPreciseScrollingDeltas: false,
          canScroll: true,
        });
        break;
      }

      if (kind === 'scrollLeft' || kind === 'scrollRight') {
        const now = Date.now();
        const direction = kind === 'scrollLeft' ? -1 : 1;

        // Reset accumulator if direction changed or after 1s of inactivity
        if (Math.sign(horizontalScrollAccumulator) !== direction || now - lastScrollTime > 1000) {
          horizontalScrollAccumulator = 0;
        }

        horizontalScrollAccumulator += direction;
        lastScrollTime = now;

        // Trigger navigation if threshold met and cooldown passed
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
          modifiers,
          x: adjustedX,
          y: adjustedY,
          accelerationRatioX: 0.5,
          hasPreciseScrollingDeltas: false,
          canScroll: true,
        });
        break;
      }

      if (!isSimpleMouseEvent(kind)) {
        break;
      }
      if (!button && kind !== 'mouseMove') {
        break;
      }

      const electronButton =
        button === 'fourth' || button === 'fifth' || button == null ? undefined : button;

      targetContents.sendInputEvent({
        type: kind,
        x: adjustedX,
        y: adjustedY,
        button: electronButton,
        modifiers,
        clickCount: kind === 'mouseDown' ? 1 : 0,
      });

      if (kind === 'mouseDown' && button === 'left') {
        if (targetContents !== view.focusedContent) {
          if (targetContents === view.content.webContents) {
            view.toolbar.blurWebView();
            view.content.focusOnWebView();
          } else {
            view.content.blurWebView();
            view.toolbar.focusOnWebView();
          }
          view.focusedContent = targetContents;
        }
      }
      break;
    }
  }
}
