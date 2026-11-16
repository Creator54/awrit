import type { WebContents } from 'electron';
import { fitEntries, consoleEntries, type ConsoleEntry, type ConsoleLevel } from './pageLog';

const LEVEL_RANK: Record<ConsoleLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const DEFAULT_LIMIT = 50;

export interface ConsoleInput {
  /** Lowest level to return; defaults to everything. */
  level?: ConsoleLevel;
  limit?: number;
}

export interface ConsoleResult {
  entries: ConsoleEntry[];
  /** Older entries were dropped to fit the output limit. */
  truncated?: true;
}

/** Recent console messages for the page, oldest first, including the page load. */
export function readConsoleLog(wc: Pick<WebContents, 'id'>, input: ConsoleInput = {}): ConsoleResult {
  const minimum = LEVEL_RANK[input.level ?? 'debug'] ?? LEVEL_RANK.debug;
  const limit =
    typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
      ? Math.min(Math.floor(input.limit), 200)
      : DEFAULT_LIMIT;
  const matching = consoleEntries(wc.id).filter((entry) => LEVEL_RANK[entry.level] >= minimum);
  return fitEntries(matching.slice(-limit));
}
