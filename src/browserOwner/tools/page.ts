import type { WebContents } from 'electron';
import { clipField } from './text';
import { pageStatus } from './pageLog';

/** Layout viewport in CSS pixels, read from the page itself. */
interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface PageState {
  url: string;
  title: string;
  loading: boolean;
  httpStatus?: number;
  viewport?: { width: number; height: number };
  zoom: number;
  devicePixelRatio?: number;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  crashReason?: string;
}

/** Reads the page's visible state without running page code beyond the size probe. */
export async function readPageState(wc: WebContents): Promise<PageState> {
  const status = pageStatus(wc.id);
  const state: PageState = {
    url: clipField(wc.getURL()),
    title: clipField(wc.getTitle()),
    loading: wc.isLoading(),
    ...(status.httpStatus === undefined ? {} : { httpStatus: status.httpStatus }),
    zoom: wc.getZoomFactor(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    crashed: Boolean(status.crashReason) || wc.isCrashed(),
    ...(status.crashReason ? { crashReason: status.crashReason } : {}),
  };
  // A crashed or closing page cannot answer; the rest of the state is still useful.
  try {
    const raw: unknown = await wc.executeJavaScript(
      '({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })',
      false,
    );
    const viewport = raw as Partial<Viewport> | null;
    if (viewport && typeof viewport.width === 'number' && typeof viewport.height === 'number') {
      state.viewport = { width: viewport.width, height: viewport.height };
      if (typeof viewport.devicePixelRatio === 'number') state.devicePixelRatio = viewport.devicePixelRatio;
    }
  } catch {
    // No page to measure.
  }
  return state;
}
