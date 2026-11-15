import { getSocketPath } from '../ipc/socketServer';
import { loadOverlayState } from './overlayToggle';
import { request } from './toolClient';
import { validateVideoPageText } from './videoPage';

const OVERLAY_TIMEOUT_MS = 5000;
const VIDEO_PAGE_TARGET = /\/video-pages\/page-[a-zA-Z0-9]+\/index\.html$/;

export interface OverlayTextRequest {
  target: string;
  /** Absent removes the text column beside the video. */
  text?: string;
}

export interface OverlayTextPage {
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
}

export interface UpdateOverlayTextOptions {
  sourceWindowId: number | string;
  text: string;
}

/** Owner trust boundary: this comes off the socket, so check shapes before use. */
export function decodeOverlayTextRequest(value: unknown): OverlayTextRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid overlay text request');
  const target = Reflect.get(value, 'target');
  if (
    typeof target !== 'string' ||
    target.length > 4096 ||
    !VIDEO_PAGE_TARGET.test(target)
  )
    throw new Error('Invalid overlay text target');
  const text = validateVideoPageText(Reflect.get(value, 'text'));
  return { target, ...(text !== undefined ? { text } : {}) };
}

/** Page script: set the text column, creating or removing it as needed. JSON keeps the text inert. */
function buildOverlayTextExpression(text: string | undefined): string {
  return `(t=>{let e=document.querySelector('.card-text');
if(t===undefined){if(e)e.remove();return 'removed'}
if(!e){e=document.createElement('div');e.className='card-text';document.querySelector('.card-video').before(e)}
e.textContent=t;return 'set'})(${JSON.stringify(text)})`;
}

/** Update the text column in whichever page is showing this overlay. */
export async function applyOverlayText(
  pages: readonly OverlayTextPage[],
  overlay: OverlayTextRequest,
): Promise<'set' | 'removed'> {
  const page = pages.find((candidate) => candidate.getURL() === overlay.target);
  if (!page) throw new Error('The overlay viewer is not showing that video');
  let action: unknown;
  try {
    action = await page.executeJavaScript(buildOverlayTextExpression(overlay.text));
  } catch {
    throw new Error('The overlay page rejected the text update');
  }
  if (action !== 'set' && action !== 'removed') throw new Error('The overlay page rejected the text update');
  return action;
}

/** Replace the text beside the video in the overlay opened from this window. */
export async function updateOverlayText(options: UpdateOverlayTextOptions): Promise<void> {
  const sourceId = Number(options.sourceWindowId);
  const text = validateVideoPageText(options.text);
  const state = loadOverlayState(sourceId);
  if (!state?.overlayWindowId || !state.target) throw new Error('No overlay is open to update');
  if (!VIDEO_PAGE_TARGET.test(state.target))
    throw new Error('Text updates are supported only for video overlays');

  const overlay = decodeOverlayTextRequest({ target: state.target, text });
  try {
    await request(getSocketPath(), 'overlay:text', { ...overlay }, OVERLAY_TIMEOUT_MS);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('No running Awrit viewer') || error.message.includes('timed out'))
    )
      throw new Error('Could not reach the overlay viewer');
    throw error;
  }
}
