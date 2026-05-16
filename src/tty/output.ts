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
const { stdout } = process;

let batchBuf = '';
let inBatch = false;

export const startBatch = () => {
  inBatch = true;
};

export const endBatch = () => {
  inBatch = false;
  if (batchBuf.length > 0) {
    stdout.write(batchBuf);
    batchBuf = '';
  }
};

export const write = (data: string) => {
  if (inBatch) {
    batchBuf += data;
  } else {
    stdout.write(data);
  }
};

export const clearScreen = () => {
  write(CLEAR_SCREEN);
};

export function setTitle(title: string) {
  // Sanitize title to remove control characters and escape sequences
  // This prevents malicious websites from injecting terminal control codes via document.title
  const sanitized = title.replace(/[\x00-\x1f\x7f]/g, '');
  write(ESC`]2;${sanitized}\a`);
}

export function requestWindowSize() {
  write(CSI`14t`);
}

export function placeCursor(point: Point = { x: 0, y: 0 }) {
  write(CSI`${point.y};${point.x}H`);
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

export const setModes = (modes: Mode[], enabled: boolean) => {
  let buf = '';
  for (const mode of modes) {
    buf += CSI`${MODE}${enabled ? mode + 'h' : mode + 'l'}`;
  }
  write(buf);
};

export const setup = () => {
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

export const cleanup = () => {
  clearScreen();
  setModes([Mode.alternateScreen, Mode.mouseMoveTracking, Mode.mouseSgrPixelMode], false);
  setModes([Mode.textCursor], true);
  write(RESTORE_PRIVATE_MODE_VALUES + RESTORE_CURSOR + RESTORE_COLORS);
};
