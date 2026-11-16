import { emitKeypressEvents } from 'node:readline';

export interface PromptItem {
  id: string;
  label: string;
  hint?: string;
  description?: string;
}

export interface CheckboxPromptOptions {
  title: string;
  items: PromptItem[];
  preselectedIds?: string[];
  maxVisible?: number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface SelectPromptOptions {
  title: string;
  items: PromptItem[];
  defaultId?: string;
  maxVisible?: number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface ConfirmPromptOptions {
  title: string;
  defaultYes?: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface TextPromptOptions {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K\r',
  cursorUp: (n: number) => (n > 0 ? `\x1b[${n}A` : ''),
};

let activePromptTeardown: (() => void) | null = null;

function registerGlobalSafety(teardown: () => void) {
  activePromptTeardown = teardown;
}

function unregisterGlobalSafety() {
  activePromptTeardown = null;
}

const emergencyExit = () => {
  if (activePromptTeardown) {
    try {
      activePromptTeardown();
    } catch {}
    activePromptTeardown = null;
  }
};

process.once('exit', emergencyExit);
process.once('SIGINT', () => {
  emergencyExit();
  process.exit(130);
});
process.once('SIGTERM', () => {
  emergencyExit();
  process.exit(143);
});

/**
 * Clean Clack-style inline interactive checkbox prompt with zero dependencies.
 * - Arrow or j/k to navigate
 * - Spacebar to toggle
 * - 'a' to toggle all
 * - 'i' to invert selection
 * - Enter to confirm
 * - Escape / Ctrl+C to cancel
 * - Windowed scrolling if choices exceed viewport
 */
export async function checkboxPrompt(options: CheckboxPromptOptions): Promise<string[] | null> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    return options.preselectedIds ?? [];
  }

  const { items, title } = options;
  if (items.length === 0) return [];

  const selected = new Set<string>(options.preselectedIds ?? []);
  let cursor = 0;
  const maxRows = options.maxVisible ?? Math.min(Math.max((stdout.rows ?? 24) - 6, 4), 10);

  let renderedLineCount = 0;

  function render(isFirst = false) {
    const lines: string[] = [];
    const allCount = selected.size;

    // Header
    lines.push(
      `${ANSI.cyan}◆${ANSI.reset}  ${ANSI.bold}${title}${ANSI.reset} ${ANSI.dim}(Space toggle · 'a' all · Enter done)${ANSI.reset}`,
    );
    lines.push(`${ANSI.cyan}│${ANSI.reset}`);

    // Compute scroll window
    let startIdx = 0;
    if (items.length > maxRows) {
      const half = Math.floor(maxRows / 2);
      if (cursor <= half) {
        startIdx = 0;
      } else if (cursor >= items.length - half) {
        startIdx = items.length - maxRows;
      } else {
        startIdx = cursor - half;
      }
    }
    const endIdx = Math.min(startIdx + maxRows, items.length);

    // Scroll up indicator
    if (startIdx > 0) {
      lines.push(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}▲  (${startIdx} more above)${ANSI.reset}`);
    }

    // Visible items
    for (let index = startIdx; index < endIdx; index++) {
      const item = items[index];
      const isItemActive = cursor === index;
      const isChecked = selected.has(item.id);

      const checkGlyph = isChecked ? `${ANSI.green}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`;
      const pointer = isItemActive ? `${ANSI.cyan}❯${ANSI.reset}` : ' ';
      const labelText = isItemActive ? `${ANSI.bold}${item.label}${ANSI.reset}` : item.label;
      const hintColor = item.hint === 'configured' ? ANSI.green : ANSI.dim;
      const hintText = item.hint ? ` ${hintColor}(${item.hint})${ANSI.reset}` : '';

      lines.push(`${ANSI.cyan}│${ANSI.reset}  ${pointer} ${checkGlyph} ${labelText}${hintText}`);
    }

    // Scroll down indicator
    if (endIdx < items.length) {
      lines.push(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}▼  (${items.length - endIdx} more below)${ANSI.reset}`);
    }

    lines.push(`${ANSI.cyan}│${ANSI.reset}`);

    // Footer description & counter
    const activeItem = items[cursor];
    const desc = activeItem?.description ?? '';
    const counter = `${allCount}/${items.length} selected`;
    lines.push(
      `${ANSI.cyan}└${ANSI.reset}  ${ANSI.dim}${desc ? `${desc} · ` : ''}${counter}${ANSI.reset}`,
    );

    if (!isFirst && renderedLineCount > 0) {
      stdout.write(ANSI.cursorUp(renderedLineCount));
    }
    for (let i = 0; i < lines.length; i++) {
      stdout.write(`${ANSI.clearLine}${lines[i]}\n`);
    }
    renderedLineCount = lines.length;
  }

  function cleanup(confirmed: boolean) {
    if (renderedLineCount > 0) {
      stdout.write(ANSI.cursorUp(renderedLineCount));
      for (let i = 0; i < renderedLineCount; i++) {
        stdout.write(`${ANSI.clearLine}\n`);
      }
      stdout.write(ANSI.cursorUp(renderedLineCount));
    }
    stdout.write(ANSI.showCursor);

    if (confirmed) {
      const count = selected.size;
      stdout.write(
        `\r${ANSI.clearLine}${ANSI.green}✔${ANSI.reset}  ${ANSI.bold}${title}${ANSI.reset} ${ANSI.dim}· ${count} selected${ANSI.reset}\n`,
      );
    } else {
      stdout.write(`\r${ANSI.clearLine}${ANSI.dim}Cancelled.${ANSI.reset}\n`);
    }
  }

  return new Promise((resolve) => {
    stdout.write(ANSI.hideCursor);
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    const emergencyTeardown = () => {
      stdout.write(ANSI.showCursor);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
    };
    registerGlobalSafety(emergencyTeardown);

    render(true);

    const onKeypress = (str: string, key: { name: string; ctrl: boolean; meta: boolean }) => {
      if (!key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        done(false);
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % items.length;
        render();
        return;
      }

      if (key.name === 'space') {
        const item = items[cursor];
        if (selected.has(item.id)) {
          selected.delete(item.id);
        } else {
          selected.add(item.id);
        }
        render();
        return;
      }

      if (str === 'a' || str === 'A') {
        const all = items.every((i) => selected.has(i.id));
        if (all) {
          selected.clear();
        } else {
          for (const item of items) selected.add(item.id);
        }
        render();
        return;
      }

      if (str === 'i' || str === 'I') {
        for (const item of items) {
          if (selected.has(item.id)) selected.delete(item.id);
          else selected.add(item.id);
        }
        render();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        done(true);
      }
    };

    function done(confirmed: boolean) {
      unregisterGlobalSafety();
      stdin.removeListener('keypress', onKeypress);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      cleanup(confirmed);
      resolve(confirmed ? Array.from(selected) : null);
    }

    stdin.on('keypress', onKeypress);
  });
}

/**
 * Clean Clack-style inline single-select prompt with scrolling window.
 */
export async function selectPrompt(options: SelectPromptOptions): Promise<string | null> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    return options.defaultId ?? options.items[0]?.id ?? null;
  }

  const { items, title } = options;
  if (items.length === 0) return null;

  let cursor = options.defaultId ? items.findIndex((i) => i.id === options.defaultId) : 0;
  if (cursor < 0) cursor = 0;

  const maxRows = options.maxVisible ?? Math.min(Math.max((stdout.rows ?? 24) - 6, 4), 10);
  let renderedLineCount = 0;

  function render(isFirst = false) {
    const lines: string[] = [];
    lines.push(
      `${ANSI.cyan}◆${ANSI.reset}  ${ANSI.bold}${title}${ANSI.reset} ${ANSI.dim}(Enter to choose, Esc to cancel)${ANSI.reset}`,
    );
    lines.push(`${ANSI.cyan}│${ANSI.reset}`);

    let startIdx = 0;
    if (items.length > maxRows) {
      const half = Math.floor(maxRows / 2);
      if (cursor <= half) {
        startIdx = 0;
      } else if (cursor >= items.length - half) {
        startIdx = items.length - maxRows;
      } else {
        startIdx = cursor - half;
      }
    }
    const endIdx = Math.min(startIdx + maxRows, items.length);

    if (startIdx > 0) {
      lines.push(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}▲  (${startIdx} more above)${ANSI.reset}`);
    }

    for (let index = startIdx; index < endIdx; index++) {
      const item = items[index];
      const isActive = cursor === index;
      const pointer = isActive ? `${ANSI.cyan}❯${ANSI.reset}` : ' ';
      const labelText = isActive ? `${ANSI.bold}${item.label}${ANSI.reset}` : item.label;
      const hintText = item.hint ? ` ${ANSI.dim}${item.hint}${ANSI.reset}` : '';
      lines.push(`${ANSI.cyan}│${ANSI.reset}  ${pointer} ${labelText}${hintText}`);
    }

    if (endIdx < items.length) {
      lines.push(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}▼  (${items.length - endIdx} more below)${ANSI.reset}`);
    }

    lines.push(`${ANSI.cyan}│${ANSI.reset}`);
    const activeItem = items[cursor];
    const desc = activeItem?.description ?? '';
    lines.push(`${ANSI.cyan}└${ANSI.reset}  ${ANSI.dim}${desc}${ANSI.reset}`);

    if (!isFirst && renderedLineCount > 0) {
      stdout.write(ANSI.cursorUp(renderedLineCount));
    }
    for (let i = 0; i < lines.length; i++) {
      stdout.write(`${ANSI.clearLine}${lines[i]}\n`);
    }
    renderedLineCount = lines.length;
  }

  function cleanup(confirmed: boolean) {
    if (renderedLineCount > 0) {
      stdout.write(ANSI.cursorUp(renderedLineCount));
      for (let i = 0; i < renderedLineCount; i++) {
        stdout.write(`${ANSI.clearLine}\n`);
      }
      stdout.write(ANSI.cursorUp(renderedLineCount));
    }
    stdout.write(ANSI.showCursor);

    if (confirmed) {
      const item = items[cursor];
      stdout.write(
        `\r${ANSI.clearLine}${ANSI.green}✔${ANSI.reset}  ${ANSI.bold}${title}${ANSI.reset} ${ANSI.dim}· ${item.label}${ANSI.reset}\n`,
      );
    } else {
      stdout.write(`\r${ANSI.clearLine}${ANSI.dim}Cancelled.${ANSI.reset}\n`);
    }
  }

  return new Promise((resolve) => {
    stdout.write(ANSI.hideCursor);
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    const emergencyTeardown = () => {
      stdout.write(ANSI.showCursor);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
    };
    registerGlobalSafety(emergencyTeardown);

    render(true);

    const onKeypress = (_str: string, key: { name: string; ctrl: boolean; meta: boolean }) => {
      if (!key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        done(false);
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % items.length;
        render();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        done(true);
      }
    };

    function done(confirmed: boolean) {
      unregisterGlobalSafety();
      stdin.removeListener('keypress', onKeypress);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      cleanup(confirmed);
      resolve(confirmed ? items[cursor].id : null);
    }

    stdin.on('keypress', onKeypress);
  });
}

/**
 * Clean Clack-style inline confirmation prompt.
 */
export async function confirmPrompt(options: ConfirmPromptOptions): Promise<boolean> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    return options.defaultYes ?? false;
  }

  let value = options.defaultYes ?? false;
  const { title } = options;

  function render() {
    const yesText = value
      ? `${ANSI.bold}${ANSI.cyan}● Yes${ANSI.reset}`
      : `${ANSI.dim}○ Yes${ANSI.reset}`;
    const noText = !value
      ? `${ANSI.bold}${ANSI.cyan}● No${ANSI.reset}`
      : `${ANSI.dim}○ No${ANSI.reset}`;

    stdout.write(
      `${ANSI.clearLine}${ANSI.cyan}◆${ANSI.reset}  ${ANSI.bold}${title}${ANSI.reset}  ${yesText}   ${noText}\r`,
    );
  }

  function cleanup(confirmed: boolean) {
    stdout.write(ANSI.showCursor);
    const choiceLabel = value ? 'Yes' : 'No';
    if (confirmed) {
      stdout.write(
        `\r${ANSI.clearLine}${ANSI.green}✔${ANSI.reset}  ${ANSI.bold}${title}${ANSI.reset} ${ANSI.dim}· ${choiceLabel}${ANSI.reset}\n`,
      );
    } else {
      stdout.write(`\r${ANSI.clearLine}${ANSI.dim}Cancelled.${ANSI.reset}\n`);
    }
  }

  return new Promise((resolve) => {
    stdout.write(ANSI.hideCursor);
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    const emergencyTeardown = () => {
      stdout.write(ANSI.showCursor);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
    };
    registerGlobalSafety(emergencyTeardown);

    render();

    const onKeypress = (str: string, key: { name: string; ctrl: boolean; meta: boolean }) => {
      if (!key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        done(false, false);
        return;
      }

      if (key.name === 'left' || key.name === 'h' || key.name === 'right' || key.name === 'l') {
        value = !value;
        render();
        return;
      }

      if (str === 'y' || str === 'Y') {
        value = true;
        done(true, true);
        return;
      }

      if (str === 'n' || str === 'N') {
        value = false;
        done(true, false);
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        done(true, value);
      }
    };

    function done(confirmed: boolean, result: boolean) {
      unregisterGlobalSafety();
      stdin.removeListener('keypress', onKeypress);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      cleanup(confirmed);
      resolve(result);
    }

    stdin.on('keypress', onKeypress);
  });
}

/**
 * Clean Clack-style inline text input prompt with paste support.
 */
export async function textPrompt(options: TextPromptOptions): Promise<string | null> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    return options.defaultValue ?? null;
  }

  const { title, placeholder = '', defaultValue = '' } = options;
  let text = defaultValue;

  function render() {
    const displayText = text.length > 0 ? text : `${ANSI.dim}${placeholder}${ANSI.reset}`;
    stdout.write(
      `${ANSI.clearLine}${ANSI.cyan}◆${ANSI.reset}  ${ANSI.bold}${title}${ANSI.reset} ${ANSI.dim}❯${ANSI.reset} ${displayText}`,
    );
  }

  function cleanup(confirmed: boolean) {
    stdout.write(ANSI.showCursor);
    if (confirmed) {
      stdout.write(
        `\r${ANSI.clearLine}${ANSI.green}✔${ANSI.reset}  ${ANSI.bold}${title}${ANSI.reset} ${ANSI.dim}· ${text}${ANSI.reset}\n`,
      );
    } else {
      stdout.write(`\r${ANSI.clearLine}${ANSI.dim}Cancelled.${ANSI.reset}\n`);
    }
  }

  return new Promise((resolve) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    const emergencyTeardown = () => {
      stdout.write(ANSI.showCursor);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
    };
    registerGlobalSafety(emergencyTeardown);

    render();

    const onKeypress = (str: string, key: { name: string; ctrl: boolean; meta: boolean }) => {
      if (!key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        done(false);
        return;
      }

      if (key.ctrl && key.name === 'u') {
        text = '';
        render();
        return;
      }

      if (key.name === 'backspace') {
        if (text.length > 0) {
          text = text.slice(0, -1);
          render();
        }
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        done(true);
        return;
      }

      // Filter out raw escape sequences, control keys, and arrow keys
      if (
        str &&
        !key.ctrl &&
        !key.meta &&
        !str.startsWith('\x1b') &&
        !['up', 'down', 'left', 'right'].includes(key.name)
      ) {
        text += str;
        render();
      }
    };

    function done(confirmed: boolean) {
      unregisterGlobalSafety();
      stdin.removeListener('keypress', onKeypress);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      cleanup(confirmed);
      resolve(confirmed ? text : null);
    }

    stdin.on('keypress', onKeypress);
  });
}
