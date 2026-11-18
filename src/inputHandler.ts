import type { TermEvent } from 'awrit-native-rs';
import { options } from './args';
import { readLeaderKey } from './designKey';
import { createKeyBindingHandler, startsBinding } from './keybindings';
import { focusedView, managedViews, type WindowView } from './windows';
import { debuggerManager } from './browserOwner/debugger.js';
import { createSyntheticInputGuard } from './syntheticInput';
import { noteUserInput } from './browserOwner/tools/userActivity';

const WHEEL_DELTA = 100;
// SGR wheel reports are discrete ticks, even when they originate from a touchpad.
const ADB_WHEEL_DELTA = 24;
const NAVIGATION_THRESHOLD = 3;
const NAVIGATION_COOLDOWN = 500;

export function createInputHandler(
  selectView: () => WindowView | null = () => focusedView.current,
  selectViews: () => WindowView[] = () => managedViews,
  overlay?: boolean,
  syntheticInput = createSyntheticInputGuard(),
) {
  const keyBindings = createKeyBindingHandler();
  const handleKeyBinding = keyBindings.handleEvent;
  // The phone page reads the leader from settings on each load; read it per key so a change in setup applies without a restart.
  const isAndroidLeaderKey = (keyEvent: NonNullable<TermEvent['keyEvent']>) => startsBinding(keyEvent, readLeaderKey());
  let horizontalScrollAccumulator = 0;
  let lastNavigationTime = 0;
  let lastScrollTime = 0;

  let lastSentX = -1;
  let lastSentY = -1;
  let lastSentView: any = null;
  let lastSentMods = '';

  // Multi-click tracking
  const DOUBLE_CLICK_TIMEOUT = 500;
  const DOUBLE_CLICK_DISTANCE = 5; // Pixels
  let lastClickTime = 0;
  let lastClickX = -1;
  let lastClickY = -1;
  let lastClickButton: string | undefined;
  let lastClickTarget: any = null;
  let currentClickCount = 0;
  let activeMouseButton: string | undefined;

  let dismissOverlayHandler = () => {};
  function setDismissOverlayHandler(fn: () => void) {
    dismissOverlayHandler = fn;
  }
  let escapeDownActive = false;

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

  let lastUnlockTime = 0;
  function runDragCommand(
    webContents: Electron.WebContents,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const lease = debuggerManager.acquire(webContents);
      return lease
        .sendCommand('Input.dispatchDragEvent', params)
        .then(() => {})
        .catch(() => {})
        .finally(() => lease.release());
    } catch {
      return Promise.resolve();
    }
  }

  function ensureInputUnlocked(webContents: any) {
    const now = Date.now();
    if (now - lastUnlockTime < 2000) return;
    lastUnlockTime = now;

    try {
      const lease = debuggerManager.acquire(webContents);
      void Promise.all([
        lease.sendCommand('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {}),
        lease
          .sendCommand('Emulation.setEmitTouchEventsForMouse', {
            enabled: false,
            configuration: 'mobile',
          })
          .catch(() => {}),
        lease.sendCommand('Debugger.resume').catch(() => {}),
      ]).finally(() => lease.release());
    } catch {
      // Input recovery is best effort; the next input event can retry.
    }
  }

  function handleInput(evt: TermEvent): boolean {
    const kind = evt.mouseEvent?.kind;
    if (
      (evt.eventType === 'key' && evt.keyEvent?.down) ||
      kind === 'mouseDown' ||
      kind === 'scrollUp' ||
      kind === 'scrollDown'
    ) {
      noteUserInput();
    }
    let view = selectView();
    if (!view || view.destroyed) {
      view = selectViews().find((candidate) => !candidate.destroyed) ?? null;
    }
    if (!view) {
      return handleKeyBinding(evt);
    }

    switch (evt.eventType) {
      case 'key': {
        const isToolbarActive =
          view.omniboxVisible ||
          view.keyHelpVisible ||
          view.findVisible ||
          view.designMode ||
          view.permissionPending;
        const adbInput = !!view.adbMode && !isToolbarActive;
        const keyCode = evt.keyEvent?.code.toLowerCase();
        const mods = normalizeModifiers(evt.keyEvent?.modifiers || []).filter((m) =>
          ['control', 'alt', 'shift', 'meta'].includes(m),
        );

        // Overlay dismissal & nested UI Escape handling
        if (
          (overlay ?? Boolean(options.overlay)) &&
          keyCode === 'escape' &&
          !view.permissionPending
        ) {
          if (!evt.keyEvent?.down) {
            escapeDownActive = false;
            return true;
          }

          if (mods.length === 0) {
            if (escapeDownActive) {
              // Auto-repeat in the same physical press: suppress
              return true;
            }
            escapeDownActive = true;

            // 1. Host toolbar UI takes priority (Omnibox, KeyHelp, Find, Design)
            if (view.designMode) {
              view.toggleDesignMode();
              return true;
            }
            if (view.omniboxVisible && view.siteInfoOpen) {
              view.toolbar.webContents.send('toolbar:close-site-info');
              return true;
            }
            if (view.omniboxVisible) {
              view.toggleOmnibox();
              return true;
            }
            if (view.findVisible) {
              view.toggleFind();
              view.content.webContents.stopFindInPage('clearSelection');
              return true;
            }
            if (view.keyHelpVisible) {
              view.toggleKeyHelp();
              return true;
            }

            // 2. In browser mode, if DOM input is focused, blur it first
            if (!view.adbMode && view.inputFocused) {
              view.content.webContents
                .executeJavaScript(`
              if (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement) {
                document.activeElement.blur();
              }
            `)
                .catch(() => {});
              view.inputFocused = false;
              return true;
            }

            // 3. In ADB mode, if Android controls are visible, close controls first
            if (view.adbMode && view.adbControlsVisible) {
              view.adbControlsVisible = false;
              view.content.webContents.sendInputEvent({
                type: 'keyDown',
                keyCode: 'Escape',
                modifiers: [],
              });
              return true;
            }

            // 4. Idle overlay: dismiss overlay cleanly without leaking to Android or page
            dismissOverlayHandler();
            return true;
          }
        }
        // Unhandled Ctrl+C falls through to the quit handler in index.ts; the phone stream has nothing to copy.
        if (adbInput && keyCode === 'c' && mods.length === 1 && mods[0] === 'control') {
          return false;
        }
        // Phone typing has no DOM input for Vim bindings to detect; modifier shortcuts still reach Awrit first.
        // Terminal-style Ctrl+Shift+C copies on the phone; Awrit's page copy has no text to copy here.
        const phoneCopy =
          keyCode === 'c' &&
          mods.length === 2 &&
          mods.includes('control') &&
          mods.includes('shift');
        const phoneTyping = adbInput && (phoneCopy || mods.every((m) => m === 'shift'));
        // In designMode, allow Alt+D (or design toggle key) to toggle design mode off
        const isDesignToggle =
          mods.length === 1 &&
          mods[0] === 'alt' &&
          (keyCode === 'd' || evt.keyEvent?.code.toLowerCase() === 'd');
        if (view?.designMode && isDesignToggle && evt.keyEvent?.down) {
          view.toggleDesignMode();
          return true;
        }
        // Keep explicit quit bindings available while the review owns typing.
        if (view.designMode && mods.length === 1 &&
          ((mods[0] === 'control' && (keyCode === 'd' || keyCode === 'q')) ||
            (mods[0] === 'meta' && keyCode === 'q')) && handleKeyBinding(evt, view)) {
          return true;
        }
        // In designMode, other key events belong to the design overlay unless handled by design shortcuts (e.g. Escape)
        const androidLeaderPressed =
          adbInput && evt.keyEvent !== undefined && isAndroidLeaderKey(evt.keyEvent);
        if (
          !view?.designMode &&
          !(view.keyHelpVisible && mods.length === 0) &&
          !view.permissionPending &&
          !phoneTyping &&
          !androidLeaderPressed &&
          handleKeyBinding(evt, view)
        ) {
          return true;
        }

        const webContents = isToolbarActive ? view.toolbar.webContents : view.focusedContent;

        ensureInputUnlocked(webContents);

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
          syntheticInput.run(webContents, () => webContents.sendInputEvent({
            type: 'keyDown',
            keyCode: code,
            modifiers: electronMods,
          }));

          // char event for printable characters
          if (isCharEvent) {
            syntheticInput.run(webContents, () => webContents.sendInputEvent({
              type: 'char',
              keyCode: code,
              modifiers: electronMods,
            }));
          }
        } else {
          // keyUp event
          syntheticInput.run(webContents, () => webContents.sendInputEvent({
            type: 'keyUp',
            keyCode: code,
            modifiers: electronMods,
          }));
        }
        return adbInput;
      }

      case 'resize': {
        for (const v of selectViews()) {
          v.relayout();
        }
        return true;
      }

      case 'paste': {
        if (evt.paste) {
          const isToolbarActive = view.omniboxVisible || view.keyHelpVisible || view.findVisible;
          const webContents = isToolbarActive ? view.toolbar.webContents : view.content.webContents;
          const { clipboard } = require('electron');
          clipboard.writeText(evt.paste);
          webContents.paste();
        }
        return true;
      }

      case 'focus':
        if (evt.focusGained) {
          view.focusedContent.focus();
        }
        return true;

      case 'mouse': {
        ensureInputUnlocked(view.focusedContent);
        const mouseEvent = evt.mouseEvent;
        if (!mouseEvent) return false;
        const { kind, button, x, y, modifiers } = mouseEvent;
        const electronMods = normalizeModifiers(modifiers);

        if (kind === 'mouseDown') {
          activeMouseButton = button ?? undefined;
        } else if (kind === 'mouseUp') {
          if (button === activeMouseButton || !button) {
            activeMouseButton = undefined;
          }
        }

        const currentDragButton = button ?? activeMouseButton;
        if (kind === 'mouseMove' || kind === 'mouseDown') {
          if (currentDragButton === 'left') electronMods.push('leftButtonDown');
          else if (currentDragButton === 'middle') electronMods.push('middleButtonDown');
          else if (currentDragButton === 'right') electronMods.push('rightButtonDown');
        }

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

        const isOverlayActive =
          view.omniboxVisible || view.keyHelpVisible || view.findVisible || view.designMode || view.permissionPending;
        const isInToolbar = isOverlayActive;

        const targetWindow = isInToolbar ? view.toolbar : view.content;
        const targetContents = targetWindow.webContents;

        // OPTIMIZED FOCUS: Only focus if not already focused
        if (view.focusedContent !== targetContents) {
          targetContents.focus();
          view.focusedContent = targetContents;
        }

        const targetNode = isInToolbar ? toolbarNode : contentNode;
        const adjustedX = Math.floor((rawX - targetNode.deviceLayout.x) / dpr);
        const adjustedY = Math.floor((rawY - targetNode.deviceLayout.y) / dpr);

        if (kind === 'mouseDown') {
          const now = Date.now();
          const dist = Math.sqrt((adjustedX - lastClickX) ** 2 + (adjustedY - lastClickY) ** 2);

          if (
            now - lastClickTime < DOUBLE_CLICK_TIMEOUT &&
            dist < DOUBLE_CLICK_DISTANCE &&
            button === lastClickButton &&
            targetContents === lastClickTarget
          ) {
            currentClickCount++;
          } else {
            currentClickCount = 1;
          }

          lastClickTime = now;
          lastClickX = adjustedX;
          lastClickY = adjustedY;
          lastClickButton = button ?? undefined;
          lastClickTarget = targetContents;
        }

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

        // When an overlay (omnibox/find/help) is open, scroll the toolbar's
        // dropdown via IPC. A synthetic mouseWheel sendInputEvent does not
        // reliably scroll an offscreen webview, so we scroll the container
        // programmatically in the toolbar. (Vertical wheel only; horizontal
        // wheel still drives page navigation below.)
        if (view.omniboxVisible && !view.permissionPending && (kind === 'scrollUp' || kind === 'scrollDown')) {
          const direction = kind === 'scrollDown' ? 1 : -1;
          view.toolbar.webContents.send('toolbar:scroll-suggestions', direction * WHEEL_DELTA);
          return true;
        }

        if (kind === 'scrollUp' || kind === 'scrollDown') {
          targetContents.sendInputEvent({
            type: 'mouseWheel',
            wheelTicksY: kind === 'scrollUp' ? 1 : -1,
            wheelTicksX: 0,
            deltaX: 0,
            deltaY: (kind === 'scrollUp' ? 1 : -1) * (view.adbMode ? ADB_WHEEL_DELTA : WHEEL_DELTA),
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
          // Electron's wheel deltaX is the opposite sign of the terminal's left/right,
          // as with deltaY above: a wheel-left must scroll content right.
          const wheelDirection = -direction;

          if (
            !view.adbMode &&
            (Math.sign(horizontalScrollAccumulator) !== direction || now - lastScrollTime > 1000)
          ) {
            horizontalScrollAccumulator = 0;
          }

          if (!view.adbMode) horizontalScrollAccumulator += direction;
          lastScrollTime = now;

          if (
            !view.adbMode &&
            !isOverlayActive &&
            Math.abs(horizontalScrollAccumulator) >= NAVIGATION_THRESHOLD &&
            now - lastNavigationTime > NAVIGATION_COOLDOWN
          ) {
            if (direction === -1) {
              view.back();
            } else {
              view.forward();
            }
            lastNavigationTime = now;
            horizontalScrollAccumulator = 0;
          }

          targetContents.sendInputEvent({
            type: 'mouseWheel',
            wheelTicksY: 0,
            wheelTicksX: wheelDirection,
            deltaX: wheelDirection * (view.adbMode ? ADB_WHEEL_DELTA : WHEEL_DELTA),
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
          currentDragButton === 'fourth' ||
          currentDragButton === 'fifth' ||
          currentDragButton == null
            ? undefined
            : (currentDragButton as 'left' | 'right' | 'middle');

        // @ts-expect-error
        targetContents.lastMousePos = { x: adjustedX, y: adjustedY };

        // @ts-expect-error
        const currentDragData = targetContents.currentDragData;
        if (currentDragData) {
          if (kind === 'mouseMove' && !activeMouseButton) {
            // Ghost drag caused by dragIntercepted firing after mouseUp
            // @ts-expect-error
            targetContents.currentDragData = null;
          } else if (kind === 'mouseMove') {
            const zoom = targetContents.getZoomFactor();
            void runDragCommand(targetContents, {
              type: 'dragOver',
              x: adjustedX / zoom,
              y: adjustedY / zoom,
              data: currentDragData,
            });
            return true;
          } else if (kind === 'mouseUp') {
            const zoom = targetContents.getZoomFactor();
            void runDragCommand(targetContents, {
              type: 'drop',
              x: adjustedX / zoom,
              y: adjustedY / zoom,
              data: currentDragData,
            });
            // @ts-expect-error
            targetContents.currentDragData = null;
            return true;
          }
        }

        targetContents.sendInputEvent({
          type: kind,
          x: adjustedX,
          y: adjustedY,
          button: electronButton,
          modifiers: electronMods,
          clickCount: kind === 'mouseMove' ? 0 : currentClickCount,
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

  return {
    handleInput,
    setDismissOverlayHandler,
    dispose: keyBindings.dispose,
  };
}
const defaultInputHandler = createInputHandler();
export const setDismissOverlayHandler = defaultInputHandler.setDismissOverlayHandler;
export function handleInput(event: TermEvent): boolean {
  if (!focusedView.current || focusedView.current.destroyed) {
    focusedView.current = managedViews.find((view) => !view.destroyed) ?? null;
  }
  return defaultInputHandler.handleInput(event);
}
