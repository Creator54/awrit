import type { WebContents } from 'electron';
import { fitEntries, networkEntries, type NetworkEntry } from './pageLog';

const DEFAULT_LIMIT = 50;

export interface NetworkInput {
  /** Only requests that failed: a network error or an HTTP status of 400 or more. */
  failedOnly?: boolean;
  /** Case-insensitive substring the request URL must contain. */
  urlContains?: string;
  limit?: number;
}

export interface NetworkResult {
  entries: NetworkEntry[];
  /** Older entries were dropped to fit the output limit. */
  truncated?: true;
}

/** Recent requests for the page, oldest first. The page-load document request starts the list. */
export function readNetworkLog(wc: Pick<WebContents, 'id'>, input: NetworkInput = {}): NetworkResult {
  const needle = input.urlContains?.toLowerCase();
  const limit =
    typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
      ? Math.min(Math.floor(input.limit), 200)
      : DEFAULT_LIMIT;
  const matching = networkEntries(wc.id).filter((entry) => {
    if (needle && !entry.url.toLowerCase().includes(needle)) return false;
    if (input.failedOnly && entry.error === undefined && (entry.status ?? 0) < 400) return false;
    return true;
  });
  return fitEntries(matching.slice(-limit));
}
