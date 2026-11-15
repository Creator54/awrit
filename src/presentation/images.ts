import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { parsePositiveInt, resolveKittenBinary } from './capabilities';
import { getStringWidth, graphemeSegmenter, wrapText } from './textMetrics';

export const MAX_IMAGE_FILE_SIZE = 16 * 1024 * 1024; // 16 MiB
export const DEFAULT_ICAT_TIMEOUT_MS = 5000;
export const DEFAULT_ICAT_MAX_BUFFER = 32 * 1024 * 1024; // 32 MiB
export const MAX_STDERR_CAPTURE_BYTES = 64 * 1024; // 64 KiB

export const MULTIPLEXER_ENV_VARS = ['TMUX', 'STY', 'ZELLIJ'] as const;
export const AGENT_ENV_VARS = [
  'CLAUDE_CODE',
  'CLAUDE_SESSION_ID',
  'CLAUDE_AGENT_ID',
  'CODEX',
  'OPENCODE',
] as const;

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ValidatedImageFile {
  filePath: string;
  canonicalPath: string;
  byteLength: number;
  format: ImageFormat;
}

export interface TerminalDimensions {
  columns: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface ImageDimensions {
  width?: number;
  height?: number;
}

export interface TerminalEligibilityOptions {
  ownedTerminal?: boolean;
  stdout?: { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
}

export interface BuildIcatArgsOptions {
  dimensions: TerminalDimensions;
  imagePath: string;
  width?: number;
  height?: number;
  unicodePlaceholder?: boolean;
  align?: 'left' | 'center' | 'right';
  scaleUp?: boolean;
}

export interface CaptureIcatOptions {
  kittenBinary: string;
  args: string[];
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface PresentInlineImageOptions {
  imagePath: string;
  dimensions: TerminalDimensions;
  ownedTerminal?: boolean;
  width?: number;
  height?: number;
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  kittenBinary?: string;
  fallbackDirs?: string[];
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface PresentInlineImageResult {
  displayed: true;
  format: ImageFormat;
  byteLength: number;
  fitWidth: number;
  fitHeight: number;
  graphicsByteLength: number;
}

export interface PresentSideBySideOptions {
  imagePath: string;
  text: string;
  dimensions: TerminalDimensions;
  ownedTerminal?: boolean;
  columns?: { text: number; media: number };
  layout?: 'text-left' | 'media-left';
  height?: number;
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  kittenBinary?: string;
  fallbackDirs?: string[];
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface PresentSideBySideResult {
  displayed: true;
  format: ImageFormat;
  byteLength: number;
  textColumns: number;
  mediaColumns: number;
  totalRows: number;
  layout: 'text-left' | 'media-left';
  graphicsByteLength: number;
}

export interface SideBySidePartition {
  textColumns: number;
  mediaColumns: number;
  gutterColumns: number;
  imageLeft: number;
  textLeft: number;
  mediaRows: number;
  totalRows: number;
  wrappedText: string[];
  layout: 'text-left' | 'media-left';
}

export class ImagePresentationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ImagePresentationError';
    this.code = code;
  }
}

export function detectImageSignature(header: Buffer | Uint8Array): ImageFormat | null {
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return 'png';
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'jpeg';
  }
  if (
    header.length >= 6 &&
    header[0] === 0x47 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x38 &&
    (header[4] === 0x37 || header[4] === 0x39) &&
    header[5] === 0x61
  ) {
    return 'gif';
  }
  if (
    header.length >= 12 &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

export function validateImageFile(filePath: string): ValidatedImageFile {
  let stat: fs.Stats;
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(filePath);
    stat = fs.statSync(canonicalPath);
  } catch (error) {
    const errCode = (error as NodeJS.ErrnoException).code;
    if (errCode === 'ENOENT') {
      throw new ImagePresentationError(`Image file does not exist: ${filePath}`, 'FILE_NOT_FOUND');
    }
    throw new ImagePresentationError(
      `Cannot access image file: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
      'FILE_ACCESS_ERROR',
    );
  }

  if (!stat.isFile()) {
    throw new ImagePresentationError(
      `Image target is not a regular file: ${filePath}`,
      'NOT_REGULAR_FILE',
    );
  }

  if (stat.size === 0) {
    throw new ImagePresentationError(`Image file is empty: ${filePath}`, 'EMPTY_FILE');
  }

  if (stat.size > MAX_IMAGE_FILE_SIZE) {
    throw new ImagePresentationError(
      `Image file size (${stat.size} bytes) exceeds 16 MiB limit (${MAX_IMAGE_FILE_SIZE} bytes)`,
      'FILE_TOO_LARGE',
    );
  }

  const fd = fs.openSync(canonicalPath, 'r');
  const buffer = Buffer.alloc(16);
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
    const format = detectImageSignature(buffer.subarray(0, bytesRead));
    if (!format) {
      throw new ImagePresentationError(
        `Invalid image file signature for ${filePath}. Must be PNG, JPEG, GIF, or WebP.`,
        'INVALID_IMAGE_SIGNATURE',
      );
    }
    return {
      filePath,
      canonicalPath,
      byteLength: stat.size,
      format,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function assertTerminalEligibility(options: TerminalEligibilityOptions): number {
  if (options.ownedTerminal !== true) {
    throw new ImagePresentationError(
      'Inline image presentation requires explicit caller terminal ownership (ownedTerminal: true)',
      'NOT_OWNED_TERMINAL',
    );
  }

  const isTTY = options.stdout ? Boolean(options.stdout.isTTY) : Boolean(process.stdout.isTTY);
  if (!isTTY) {
    throw new ImagePresentationError(
      'Stdout is captured or redirected (non-TTY); inline graphics require an interactive terminal',
      'NON_TTY',
    );
  }

  const env = options.env ?? process.env;

  for (const multiplexer of MULTIPLEXER_ENV_VARS) {
    if (env[multiplexer]) {
      throw new ImagePresentationError(
        `Terminal multiplexer detected (${multiplexer}); inline graphics not permitted behind multiplexer`,
        'MULTIPLEXER_DETECTED',
      );
    }
  }

  for (const agent of AGENT_ENV_VARS) {
    if (env[agent]) {
      throw new ImagePresentationError(
        `Agent harness detected (${agent}); inline graphics cannot safely place images without redrawing corruption`,
        'AGENT_DETECTED',
      );
    }
  }

  const kittyWindowId = parsePositiveInt(env.KITTY_WINDOW_ID);
  if (kittyWindowId === null) {
    throw new ImagePresentationError(
      'Not running inside a valid Kitty terminal window (KITTY_WINDOW_ID missing or invalid)',
      'NOT_KITTY',
    );
  }

  return kittyWindowId;
}

export function validateTerminalDimensions(dims: TerminalDimensions): void {
  if (
    !dims ||
    typeof dims.columns !== 'number' ||
    typeof dims.rows !== 'number' ||
    typeof dims.pixelWidth !== 'number' ||
    typeof dims.pixelHeight !== 'number' ||
    !Number.isSafeInteger(dims.columns) ||
    !Number.isSafeInteger(dims.rows) ||
    !Number.isSafeInteger(dims.pixelWidth) ||
    !Number.isSafeInteger(dims.pixelHeight) ||
    dims.columns <= 0 ||
    dims.rows <= 0 ||
    dims.pixelWidth <= 0 ||
    dims.pixelHeight <= 0
  ) {
    throw new ImagePresentationError(
      'Terminal dimensions must contain positive integer columns, rows, pixelWidth, and pixelHeight',
      'INVALID_TERMINAL_DIMENSIONS',
    );
  }
}

export function calculateImageFit(
  dimensions: TerminalDimensions,
  requested?: ImageDimensions,
): { fitWidth: number; fitHeight: number } {
  validateTerminalDimensions(dimensions);

  let fitWidth = dimensions.columns;
  if (requested?.width !== undefined) {
    if (!Number.isSafeInteger(requested.width) || requested.width <= 0) {
      throw new ImagePresentationError(
        `Requested width must be a positive integer: ${requested.width}`,
        'INVALID_DIMENSIONS',
      );
    }
    fitWidth = Math.min(requested.width, dimensions.columns);
  }

  let fitHeight = dimensions.rows;
  if (requested?.height !== undefined) {
    if (!Number.isSafeInteger(requested.height) || requested.height <= 0) {
      throw new ImagePresentationError(
        `Requested height must be a positive integer: ${requested.height}`,
        'INVALID_DIMENSIONS',
      );
    }
    fitHeight = Math.min(requested.height, dimensions.rows);
  }

  return { fitWidth, fitHeight };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: necessary for terminal control sequences
const COLOR_MATCH_REGEX = /\x1b\[38:2:[0-9;: ]+m/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: necessary for terminal control sequences
const COLOR_STRIP_REGEX = /\x1b\[38:2:[0-9;: ]+m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: necessary for terminal control sequences
const COLOR_RESET_REGEX = /\x1b\[39m/g;

export function calculateSideBySidePartition(options: {
  dimensions: TerminalDimensions;
  text: string;
  columns?: { text: number; media: number };
  layout?: 'text-left' | 'media-left';
  requestedHeight?: number;
}): SideBySidePartition {
  const { dimensions, text, columns, layout = 'text-left', requestedHeight } = options;
  validateTerminalDimensions(dimensions);

  if (typeof text !== 'string') {
    throw new ImagePresentationError('text must be a string', 'INVALID_TEXT');
  }

  if (layout !== 'text-left' && layout !== 'media-left') {
    throw new ImagePresentationError(
      "layout must be 'text-left' or 'media-left'",
      'INVALID_LAYOUT',
    );
  }

  if (requestedHeight !== undefined) {
    if (!Number.isSafeInteger(requestedHeight) || requestedHeight <= 0) {
      throw new ImagePresentationError(
        `Requested height must be a positive integer: ${requestedHeight}`,
        'INVALID_HEIGHT',
      );
    }
  }

  if (columns !== undefined) {
    if (
      typeof columns !== 'object' ||
      columns === null ||
      !Number.isSafeInteger(columns.text) ||
      !Number.isSafeInteger(columns.media) ||
      columns.text <= 0 ||
      columns.media <= 0
    ) {
      throw new ImagePresentationError(
        'columns must contain positive integer text and media values',
        'INVALID_COLUMNS',
      );
    }
  }

  const GUTTER = 2;
  const availableColumns = dimensions.columns - GUTTER;
  if (dimensions.columns < 10 || availableColumns < 8) {
    throw new ImagePresentationError(
      `Terminal columns (${dimensions.columns}) too narrow for side-by-side presentation (minimum 10 columns required)`,
      'TERMINAL_TOO_NARROW',
    );
  }

  let textCols: number;
  let mediaCols: number;

  if (columns) {
    if (columns.text + columns.media + GUTTER <= dimensions.columns) {
      textCols = columns.text;
      mediaCols = columns.media;
    } else {
      const ratio = columns.text / (columns.text + columns.media);
      textCols = Math.max(2, Math.floor(availableColumns * ratio));
      mediaCols = Math.max(2, availableColumns - textCols);
      if (textCols + mediaCols > availableColumns) {
        textCols = Math.max(1, availableColumns - mediaCols);
      }
      if (textCols < 2 || mediaCols < 2) {
        throw new ImagePresentationError(
          'Rescaled columns are too narrow for side-by-side presentation',
          'TERMINAL_TOO_NARROW',
        );
      }
    }
  } else {
    textCols = Math.floor(availableColumns / 2);
    mediaCols = availableColumns - textCols;
  }

  let mediaRows = Math.min(dimensions.rows, Math.max(4, Math.floor(mediaCols / 2)));
  if (requestedHeight !== undefined && requestedHeight > 0) {
    mediaRows = Math.min(dimensions.rows, requestedHeight);
  }

  let wrappedText = wrapText(text, textCols);

  let totalRows: number;
  if (requestedHeight !== undefined && requestedHeight > 0) {
    totalRows = Math.min(dimensions.rows, requestedHeight);
  } else {
    totalRows = Math.min(dimensions.rows, Math.max(wrappedText.length, mediaRows));
  }

  // Bound height with text overflow handled safely
  if (wrappedText.length > totalRows) {
    if (totalRows <= 0) {
      wrappedText = [];
    } else {
      const truncated = wrappedText.slice(0, totalRows);
      let lastLine = truncated[totalRows - 1];
      if (getStringWidth(lastLine) + 1 <= textCols) {
        lastLine += '…';
      } else {
        const graphemes = Array.from(graphemeSegmenter.segment(lastLine));
        while (graphemes.length > 0) {
          const testStr = `${graphemes.map((g) => g.segment).join('')}…`;
          if (getStringWidth(testStr) <= textCols) {
            lastLine = testStr;
            break;
          }
          graphemes.pop();
        }
        if (graphemes.length === 0) {
          lastLine = '…';
        }
      }
      truncated[totalRows - 1] = lastLine;
      wrappedText = truncated;
    }
  }

  let imageLeft: number;
  let textLeft: number;

  if (layout === 'text-left') {
    textLeft = 0;
    imageLeft = textCols + GUTTER;
  } else {
    imageLeft = 0;
    textLeft = mediaCols + GUTTER;
  }

  return {
    textColumns: textCols,
    mediaColumns: mediaCols,
    gutterColumns: GUTTER,
    imageLeft,
    textLeft,
    mediaRows,
    totalRows,
    wrappedText,
    layout,
  };
}

export function buildIcatArgs(options: BuildIcatArgsOptions): string[] {
  const { fitWidth, fitHeight } = calculateImageFit(options.dimensions, options);
  const pixelWidth = Math.max(
    1,
    Math.floor((options.dimensions.pixelWidth * fitWidth) / options.dimensions.columns),
  );
  const pixelHeight = Math.max(
    1,
    Math.floor((options.dimensions.pixelHeight * fitHeight) / options.dimensions.rows),
  );
  const args = [
    'icat',
    '--stdin=no',
    `--use-window-size=${fitWidth},${fitHeight},${pixelWidth},${pixelHeight}`,
    '--fit=both',
  ];

  if (options.scaleUp) {
    args.push('--scale-up=yes');
  }

  if (options.unicodePlaceholder) {
    args.push('--unicode-placeholder=yes');
    args.push(`--align=${options.align ?? 'left'}`);
  }

  args.push('--transfer-mode=stream', '--loop=0', options.imagePath);
  return args;
}

export function captureIcatGraphics(options: CaptureIcatOptions): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ICAT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    Number.isNaN(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return Promise.reject(
      new ImagePresentationError(
        `timeoutMs must be a positive finite number, received: ${timeoutMs}`,
        'INVALID_TIMEOUT',
      ),
    );
  }

  const maxBuffer = options.maxBuffer ?? DEFAULT_ICAT_MAX_BUFFER;
  if (
    typeof maxBuffer !== 'number' ||
    !Number.isFinite(maxBuffer) ||
    Number.isNaN(maxBuffer) ||
    maxBuffer <= 0
  ) {
    return Promise.reject(
      new ImagePresentationError(
        `maxBuffer must be a positive finite number, received: ${maxBuffer}`,
        'INVALID_MAX_BUFFER',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ImagePresentationError('Image presentation aborted by signal', 'ABORTED'));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(options.kittenBinary, options.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ?? process.env,
        windowsHide: true,
      });
    } catch (err) {
      reject(
        new ImagePresentationError(
          `Failed to spawn kitten process: ${err instanceof Error ? err.message : String(err)}`,
          'SPAWN_ERROR',
        ),
      );
      return;
    }

    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      reject(new ImagePresentationError(`Kitten icat timed out after ${timeoutMs}ms`, 'TIMEOUT'));
    }, timeoutMs);

    const onAbort = () => {
      child.kill('SIGKILL');
      reject(new ImagePresentationError('Image presentation aborted by signal', 'ABORTED'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        child.kill('SIGKILL');
        reject(
          new ImagePresentationError(
            `Kitten icat output exceeded maxBuffer limit (${maxBuffer} bytes)`,
            'MAX_BUFFER_EXCEEDED',
          ),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_CAPTURE_BYTES) {
        const take = Math.min(chunk.length, MAX_STDERR_CAPTURE_BYTES - stderrBytes);
        stderrChunks.push(chunk.subarray(0, take));
        stderrBytes += take;
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new ImagePresentationError(`Kitten process error: ${err.message}`, 'SPAWN_ERROR'));
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);

      if (timedOut || options.signal?.aborted) return;

      if (code !== 0) {
        const stderrStr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(
          new ImagePresentationError(
            `Kitten icat failed (exit code ${code ?? signal}): ${stderrStr || 'unknown error'}`,
            'ICAT_FAILED',
          ),
        );
        return;
      }

      const output = Buffer.concat(stdoutChunks);
      if (output.length === 0) {
        reject(
          new ImagePresentationError('Kitten icat produced no graphics output', 'EMPTY_OUTPUT'),
        );
        return;
      }

      resolve(output);
    });
  });
}

export function writeToStreamWithBackpressure(
  stream: NodeJS.WritableStream,
  chunk: Buffer | Uint8Array | string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new ImagePresentationError('Image presentation aborted by signal', 'ABORTED'),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let writeFinished = false;
    let drained = true;

    const onError = (err: Error) => {
      if (settled) {
        stream.removeListener('error', onError);
        return;
      }
      settled = true;
      cleanup();
      reject(
        new ImagePresentationError(
          `Error writing graphics to stdout: ${err.message}`,
          'WRITE_ERROR',
        ),
      );
    };

    const onDrain = () => {
      drained = true;
      checkCompletion();
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ImagePresentationError('Image presentation aborted by signal', 'ABORTED'));
    };

    const checkCompletion = () => {
      if (settled) return;
      if (writeFinished && drained) {
        settled = true;
        cleanup();
        resolve();
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('error', onError);

    const ok = stream.write(chunk, (writeErr) => {
      if (settled) return;
      if (writeErr) {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        stream.removeListener('drain', onDrain);
        setImmediate(() => stream.removeListener('error', onError));
        reject(
          new ImagePresentationError(
            `Error writing graphics to stdout: ${writeErr.message}`,
            'WRITE_ERROR',
          ),
        );
        return;
      }
      writeFinished = true;
      checkCompletion();
    });

    if (!ok) {
      drained = false;
      stream.once('drain', onDrain);
    }
  });
}

export async function presentInlineImage(
  options: PresentInlineImageOptions,
): Promise<PresentInlineImageResult> {
  assertTerminalEligibility({
    ownedTerminal: options.ownedTerminal,
    stdout: options.stdout,
    env: options.env,
  });

  validateTerminalDimensions(options.dimensions);

  const validatedFile = validateImageFile(options.imagePath);

  const { fitWidth, fitHeight } = calculateImageFit(options.dimensions, {
    width: options.width,
    height: options.height,
  });

  let binary = options.kittenBinary;
  if (!binary) {
    const resolved = resolveKittenBinary(options.env ?? process.env, options.fallbackDirs);
    binary = resolved.binaryPath ?? undefined;
  }
  if (!binary) {
    throw new ImagePresentationError(
      'Kitten executable not found in PATH or standard profiles',
      'KITTEN_NOT_FOUND',
    );
  }

  const args = buildIcatArgs({
    dimensions: options.dimensions,
    imagePath: validatedFile.canonicalPath,
    width: fitWidth,
    height: fitHeight,
  });

  const graphics = await captureIcatGraphics({
    kittenBinary: binary,
    args,
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    signal: options.signal,
    env: options.env,
  });

  const stdout = options.stdout ?? process.stdout;
  await writeToStreamWithBackpressure(stdout, graphics, options.signal);

  return {
    displayed: true,
    format: validatedFile.format,
    byteLength: validatedFile.byteLength,
    fitWidth,
    fitHeight,
    graphicsByteLength: graphics.length,
  };
}

export async function presentSideBySideImage(
  options: PresentSideBySideOptions,
): Promise<PresentSideBySideResult> {
  assertTerminalEligibility({
    ownedTerminal: options.ownedTerminal,
    stdout: options.stdout,
    env: options.env,
  });

  validateTerminalDimensions(options.dimensions);

  if (typeof options.text !== 'string') {
    throw new ImagePresentationError('text must be a string', 'INVALID_TEXT');
  }

  const validatedFile = validateImageFile(options.imagePath);

  const partition = calculateSideBySidePartition({
    dimensions: options.dimensions,
    text: options.text,
    columns: options.columns,
    layout: options.layout,
    requestedHeight: options.height,
  });

  let binary = options.kittenBinary;
  if (!binary) {
    const resolved = resolveKittenBinary(options.env ?? process.env, options.fallbackDirs);
    binary = resolved.binaryPath ?? undefined;
  }
  if (!binary) {
    throw new ImagePresentationError(
      'Kitten executable not found in PATH or standard profiles',
      'KITTEN_NOT_FOUND',
    );
  }

  const args = buildIcatArgs({
    dimensions: options.dimensions,
    imagePath: validatedFile.canonicalPath,
    width: partition.mediaColumns,
    height: partition.mediaRows,
    unicodePlaceholder: true,
    align: 'left',
    scaleUp: true,
  });

  const rawOutput = await captureIcatGraphics({
    kittenBinary: binary,
    args,
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    signal: options.signal,
    env: options.env,
  });

  // Separate graphics upload command from placeholder rows
  const escIdx = rawOutput.lastIndexOf(Buffer.from('\x1b\\'));
  const belIdx = rawOutput.lastIndexOf(Buffer.from('\x07'));
  const lastSt = Math.max(escIdx !== -1 ? escIdx + 2 : -1, belIdx !== -1 ? belIdx + 1 : -1);

  const graphicsCommand = lastSt !== -1 ? rawOutput.subarray(0, lastSt) : rawOutput;
  const placeholderText = lastSt !== -1 ? rawOutput.subarray(lastSt).toString('utf8') : '';

  // Extract foreground color sequence (which encodes image id in Kitty placeholder protocol)
  const colorMatch = placeholderText.match(COLOR_MATCH_REGEX);
  const colorSeq = colorMatch ? colorMatch[0] : '';

  // Clean placeholder rows
  const rawPlaceholderLines = placeholderText.split(/\r?\n/).filter((l) => l.length > 0);
  const cleanPlaceholderRows = rawPlaceholderLines.map((line) =>
    line.replace(COLOR_STRIP_REGEX, '').replace(COLOR_RESET_REGEX, '').replace(/\r/g, ''),
  );

  const stdout = options.stdout ?? process.stdout;

  // 1. Emit graphics upload command (uploads image to Kitty memory with U=1, no cursor movement)
  if (graphicsCommand.length > 0) {
    await writeToStreamWithBackpressure(stdout, graphicsCommand, options.signal);
  }

  // 2. Emit combined text + placeholder lines naturally without absolute placement
  let textBuffer = '';
  const layout = partition.layout;

  for (let r = 0; r < partition.totalRows; r++) {
    const textLine = r < partition.wrappedText.length ? partition.wrappedText[r] : '';
    const textLineWidth = getStringWidth(textLine);
    const textPad = ' '.repeat(Math.max(0, partition.textColumns - textLineWidth));
    const textPart = `${textLine}${textPad}`;
    const gutter = ' '.repeat(partition.gutterColumns);

    const placeholderRow = r < cleanPlaceholderRows.length ? cleanPlaceholderRows[r] : '';
    let mediaPart: string;
    if (placeholderRow) {
      const placeholderWidth = placeholderRow.includes('\u{10EEEE}')
        ? (placeholderRow.match(/\u{10EEEE}/gu)?.length ?? 0)
        : getStringWidth(placeholderRow);
      const mediaPad = ' '.repeat(Math.max(0, partition.mediaColumns - placeholderWidth));
      mediaPart = `${colorSeq}${placeholderRow}\x1b[39m${mediaPad}`;
    } else {
      mediaPart = ' '.repeat(partition.mediaColumns);
    }

    if (layout === 'text-left') {
      textBuffer += `${textPart}${gutter}${mediaPart}\r\n`;
    } else {
      textBuffer += `${mediaPart}${gutter}${textPart}\r\n`;
    }
  }

  await writeToStreamWithBackpressure(stdout, Buffer.from(textBuffer, 'utf8'), options.signal);

  return {
    displayed: true,
    format: validatedFile.format,
    byteLength: validatedFile.byteLength,
    textColumns: partition.textColumns,
    mediaColumns: partition.mediaColumns,
    totalRows: partition.totalRows,
    layout,
    graphicsByteLength: graphicsCommand.length,
  };
}
