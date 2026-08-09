import { OSC } from './escapeCodes';
import { write } from './output';

const fallbackCursor = 'default';
let lastCursor = '';

const supportedCursors = new Set([
  'alias',
  'cell',
  'copy',
  'crosshair',
  'default',
  'e-resize',
  'ew-resize',
  'grab',
  'grabbing',
  'help',
  'move',
  'n-resize',
  'ne-resize',
  'nesw-resize',
  'no-drop',
  'not-allowed',
  'ns-resize',
  'nw-resize',
  'nwse-resize',
  'pointer',
  'progress',
  's-resize',
  'se-resize',
  'sw-resize',
  'text',
  'vertical-text',
  'w-resize',
  'wait',
  'zoom-in',
  'zoom-out',
]);

const electronSwap: Record<string, string> = {
  pointer: 'default',
  hand: 'pointer',
};

export function updateCursor(_event: any, cursor: string) {
  let cursor_ = electronSwap[cursor] ?? cursor;
  cursor_ = supportedCursors.has(cursor_) ? cursor_ : fallbackCursor;
  if (cursor_ === lastCursor) return;

  write(OSC`22;${cursor_}`);
  lastCursor = cursor_;
}
