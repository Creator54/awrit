import type { KeyEvent as KeyEventOriginal, TermEvent } from 'awrit-native-rs';
import { handleEvent as handleKeyBinding } from './keybindings';
import { focusedView } from './windows';

const WHEEL_DELTA = 100;

export function setCellSize(_width: number, _height: number) {}

export function setCellPadding(_x: number, _y: number) {}

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

      const webContents = view.focusedContent;
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
      // Mouse coords from Kitty (SGR-pixel mode) are in terminal pixels = device pixels
      const isInToolbar = rawY < contentNode.deviceLayout.y;

      // Pick target webContents and compute coordinates relative to it
      const targetNode = isInToolbar ? toolbarNode : contentNode;
      const targetContents = isInToolbar ? view.toolbar.webContents : view.content.webContents;

      // Convert from terminal pixels to CSS pixels relative to the target area
      const adjustedX = Math.floor((rawX - targetNode.deviceLayout.x) / dpr);
      const adjustedY = Math.floor((rawY - targetNode.deviceLayout.y) / dpr);

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
