import {
  CLEAR_SCREEN,
  CSI,
  DECSACE_DEFAULT_REGION_SELECT,
  ESC,
  MODE,
  RESET_IRM,
  RESTORE_COLORS,
  RESTORE_CURSOR,
  RESTORE_PRIVATE_MODE_VALUES,
  S7C1T,
  SAVE_COLORS,
  SAVE_CURSOR,
  SAVE_PRIVATE_MODE_VALUES,
} from './escapeCodes';
import type { Point } from './graphics';
export function createTerminalOutput(sink: (data: string) => unknown) {
  let batchBuf = '';
  let batchDepth = 0;

  const startBatch = () => {
    batchDepth++;
  };

  const endBatch = () => {
    if (batchDepth > 0) batchDepth--;
    if (batchDepth === 0 && batchBuf.length > 0) {
      const data = batchBuf;
      batchBuf = '';
      sink(data);
    }
  };

  const write = (data: string) => {
    if (batchDepth > 0) {
      batchBuf += data;
    } else {
      sink(data);
    }
  };

  const clearScreen = () => {
    write(CLEAR_SCREEN);
  };

  function setTitle(title: string) {
    // Sanitize title to remove control characters and escape sequences
    // This prevents malicious websites from injecting terminal control codes via document.title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: necessary for terminal security
    const sanitized = title.replace(/[\u0000-\u001f\u007f]/g, '');
    write(ESC`]2;${sanitized}\x07`);
  }

  function requestWindowSize() {
    write(CSI`14t`);
  }

  function placeCursor(point: Point = { x: 0, y: 0 }) {
    write(CSI`${point.y};${point.x}H`);
  }

  /**
   * Write text to the terminal emulator's clipboard using OSC 52.
   */
  function writeToTerminalClipboard(text: string) {
    const base64 = Buffer.from(text).toString('base64');
    write(ESC`]52;c;${base64}\x07`);
  }

  const modeCache = new Map<string, string>();
  let pendingUpdateDepth = 0;

  const setModes = (modes: Mode[], enabled: boolean) => {
    modes = modes.filter(mode => {
      if (mode !== Mode.pendingUpdate) return true;
      if (enabled) return pendingUpdateDepth++ === 0;
      if (pendingUpdateDepth === 0) return false;
      return --pendingUpdateDepth === 0;
    });
    if (modes.length === 0) return;
    const key = `${modes.join(',')}-${enabled}`;
    let buf = modeCache.get(key);
    if (!buf) {
      buf = '';
      for (const mode of modes) {
        buf += CSI`${MODE}${enabled ? mode + 'h' : mode + 'l'}`;
      }
      modeCache.set(key, buf);
    }
    write(buf);
  };

  const setup = () => {
    write(
      S7C1T +
        SAVE_CURSOR +
        SAVE_PRIVATE_MODE_VALUES +
        SAVE_COLORS +
        DECSACE_DEFAULT_REGION_SELECT +
        RESET_IRM,
    );

    setModes(
      [
        Mode.textCursor,
        Mode.cursorKeyToApp,
        Mode.reverseVideo,
        Mode.bracketedPaste,
        Mode.focusTracking,
        Mode.mouseButtonTracking,
        Mode.mouseMotionTracking,
        Mode.mouseMoveTracking,
        Mode.mouseUtf8Mode,
        Mode.mouseSgrMode,
      ],
      false,
    );

    setModes(
      [
        Mode.autoRepeat,
        Mode.autoWrap,
        Mode.alternateScreen,
        Mode.mouseSgrPixelMode,
        Mode.mouseMoveTracking,
      ],
      true,
    );

    clearScreen();
  };

  const cleanup = () => {
    clearScreen();
    setModes([Mode.alternateScreen, Mode.mouseMoveTracking, Mode.mouseSgrPixelMode], false);
    setModes([Mode.textCursor], true);
    write(RESTORE_PRIVATE_MODE_VALUES + RESTORE_CURSOR + RESTORE_COLORS);
  };
  return {
    startBatch,
    endBatch,
    write,
    clearScreen,
    setTitle,
    requestWindowSize,
    placeCursor,
    writeToTerminalClipboard,
    setModes,
    setup,
    cleanup,
  };
}

export enum Mode {
  cursorKeyToApp = 1,
  reverseVideo = 5,
  autoWrap = 7,
  autoRepeat = 8,
  textCursor = 25,
  mouseButtonTracking = 1000,
  mouseMotionTracking = 1002,
  mouseMoveTracking = 1003,
  focusTracking = 1004,
  mouseUtf8Mode = 1005,
  mouseSgrMode = 1006,
  mouseSgrPixelMode = 1016,
  alternateScreen = 1049,
  bracketedPaste = 2004,
  pendingUpdate = 2026,
}
export type TerminalOutput = ReturnType<typeof createTerminalOutput>;
export const defaultOutput = createTerminalOutput((data) => process.stdout.write(data));
export const {
  startBatch,
  endBatch,
  write,
  clearScreen,
  setTitle,
  requestWindowSize,
  placeCursor,
  writeToTerminalClipboard,
  setModes,
  setup,
  cleanup,
} = defaultOutput;
