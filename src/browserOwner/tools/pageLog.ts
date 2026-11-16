import type { Session, WebContents } from 'electron';
import { encodeToolResult } from './encode';
import { clipField } from './text';

/** Entries kept per page. Every field is clipped, so each buffer stays small. */
export const MAX_LOG_ENTRIES = 200;

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug';

export interface ConsoleEntry {
  time: string;
  level: ConsoleLevel;
  text: string;
  /** Source of the message as url:line, when the page provided one. */
  source?: string;
}

export interface NetworkEntry {
  time: string;
  method: string;
  url: string;
  /** HTTP status once the request completed; absent while pending or after a network error. */
  status?: number;
  error?: string;
  resourceType: string;
  fromCache: boolean;
  durationMs?: number;
}

interface PageLog {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /** Status code of the last HTTP main-document load, as Chromium reported it. */
  httpStatus?: number;
  crashReason?: string;
}

const pages = new Map<number, PageLog>();
const recordingSessions = new WeakSet<Session>();

/** Keeps the newest entries that fit the tool output limit, with room for the reply wrapper. */
export function fitEntries<T>(entries: T[]): { entries: T[]; truncated?: true } {
  let kept = entries;
  for (;;) {
    try {
      encodeToolResult(kept, 60_000);
      return kept.length === entries.length ? { entries: kept } : { entries: kept, truncated: true };
    } catch (error) {
      if (!(error instanceof Error) || !['Output byte limit exceeded', 'Input limit exceeded'].includes(error.message) || kept.length === 0) throw error;
      kept = kept.slice(Math.ceil(kept.length / 4));
    }
  }
}

const now = () => new Date().toISOString();

function push<T>(buffer: T[], entry: T): void {
  buffer.push(entry);
  if (buffer.length > MAX_LOG_ENTRIES) buffer.splice(0, buffer.length - MAX_LOG_ENTRIES);
}

/**
 * Starts recording console messages, load failures and crashes for one page, plus network
 * activity for its session. Call once, right after the page is created, so the first
 * read already shows the page load.
 */
export function startPageRecording(wc: WebContents): void {
  const id = wc.id;
  if (pages.has(id)) return;
  const log: PageLog = { console: [], network: [] };
  pages.set(id, log);
  startSessionRecording(wc.session);

  wc.on('console-message', (details) => {
    push(log.console, {
      time: now(),
      level: details.level,
      text: clipField(details.message),
      ...(details.sourceId ? { source: `${clipField(details.sourceId)}:${details.lineNumber}` } : {}),
    });
  });

  wc.on('did-navigate', (_event, url, httpResponseCode) => {
    log.httpStatus = httpResponseCode >= 0 ? httpResponseCode : undefined;
    log.crashReason = undefined;
    // Navigation marker: older entries above it belong to a previous page.
    push(log.console, {
      time: now(),
      level: 'info',
      text: `— navigated to ${clipField(url)}`,
    });
  });

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED: a superseded navigation, not a page error.
    if (!isMainFrame || errorCode === -3) return;
    push(log.console, {
      time: now(),
      level: 'error',
      text: `load failed: ${errorDescription} (${errorCode})`,
      ...(validatedURL ? { source: clipField(validatedURL) } : {}),
    });
  });

  wc.on('render-process-gone', (_event, details) => {
    log.crashReason = details.reason;
    push(log.console, {
      time: now(),
      level: 'error',
      text: `renderer gone: ${details.reason} (exit ${details.exitCode})`,
    });
  });

  wc.on('preload-error', (_event, preloadPath, error) => {
    push(log.console, {
      time: now(),
      level: 'error',
      text: `preload failed: ${clipField(error.message)}`,
      source: clipField(preloadPath),
    });
  });

  wc.on('destroyed', () => {
    pages.delete(id);
  });
}

/**
 * Electron allows one listener per webRequest event per session, so this installs once per
 * session and fans out by webContentsId. Recording never blocks or cancels a request.
 */
function startSessionRecording(session: Session): void {
  if (recordingSessions.has(session)) return;
  recordingSessions.add(session);
  // Request id -> the entry still open for it, so completion fills the same record.
  const pending = new Map<number, { entry: NetworkEntry; startedAt: number }>();

  session.webRequest.onBeforeRequest((details, callback) => {
    callback({});
    const log = details.webContentsId === undefined ? undefined : pages.get(details.webContentsId);
    if (!log) return;
    const entry: NetworkEntry = {
      time: now(),
      method: details.method,
      url: clipField(details.url),
      resourceType: details.resourceType,
      fromCache: false,
    };
    pending.set(details.id, { entry, startedAt: Date.now() });
    // Requests that never complete must not grow the map without bound.
    if (pending.size > MAX_LOG_ENTRIES) {
      const oldest = pending.keys().next();
      if (!oldest.done) pending.delete(oldest.value);
    }
    push(log.network, entry);
  });

  session.webRequest.onCompleted((details) => {
    const open = pending.get(details.id);
    if (!open) return;
    pending.delete(details.id);
    open.entry.status = details.statusCode;
    open.entry.fromCache = details.fromCache;
    open.entry.durationMs = Math.max(0, Date.now() - open.startedAt);
  });

  session.webRequest.onErrorOccurred((details) => {
    const open = pending.get(details.id);
    if (!open) return;
    pending.delete(details.id);
    open.entry.error = details.error;
  });
}

/** Console entries for a page, oldest first. */
export function consoleEntries(id: number): ConsoleEntry[] {
  return [...(pages.get(id)?.console ?? [])];
}

/** Network entries for a page, oldest first. */
export function networkEntries(id: number): NetworkEntry[] {
  return [...(pages.get(id)?.network ?? [])];
}

export function pageStatus(id: number): { httpStatus?: number; crashReason?: string } {
  const log = pages.get(id);
  return {
    ...(log?.httpStatus === undefined ? {} : { httpStatus: log.httpStatus }),
    ...(log?.crashReason ? { crashReason: log.crashReason } : {}),
  };
}
