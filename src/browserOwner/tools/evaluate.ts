import type { WebContents } from 'electron';
import { MAX_TEXT_CHARS } from './text';

/** An agent probe, not a program to paste into the page. */
export const MAX_EXPRESSION_CHARS = 4_000;

export interface EvaluateOutcome {
  result?: string;
  error?: string;
}

/** Runs one expression in the page and returns its JSON-serialized, clipped value. */
export async function evaluateInPage(
  wc: Pick<WebContents, 'executeJavaScript'>,
  expression: unknown,
): Promise<EvaluateOutcome> {
  if (typeof expression !== 'string' || !expression.trim()) {
    return { error: 'expression must be a non-empty string' };
  }
  if (expression.length > MAX_EXPRESSION_CHARS) {
    return { error: `expression must be ${MAX_EXPRESSION_CHARS} characters or fewer` };
  }
  let value: unknown;
  try {
    // userGesture false: a script must not be able to grant itself activation.
    value = await wc.executeJavaScript(expression, false);
  } catch (error) {
    return { error: clip(error instanceof Error ? error.message : String(error)) };
  }
  return { result: clip(serialize(value)) };
}

function serialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Circular structure.
  }
  try {
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

const clip = (value: string) =>
  value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}…` : value;
