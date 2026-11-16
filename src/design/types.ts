import type { RegionBox } from './regionBox';

export type { RegionBox };

/**
 * 2D point representation.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * Selection in canonical screenshot pixel coordinates.
 */
export interface RegionSelection {
  kind: 'region';
  bounds: RegionBox;
}

export interface ElementSelection {
  kind: 'element';
  bounds: RegionBox;
  elementId: string;
  /** What the page says about the element, so an agent can find it in code. */
  selector?: string;
  text?: string;
  role?: string;
  /** Computed color, background, font, display and position as the page renders them. */
  styles?: string;
  /** React, Vue or Svelte component that rendered the element, when the page exposes it. */
  component?: string;
  /** Further elements the user added to the same note with Shift+click. */
  also?: { selector?: string; text?: string; component?: string }[];
}

export interface StrokeSelection {
  kind: 'stroke';
  bounds: RegionBox;
  points: Point[];
}

export type Selection = RegionSelection | ElementSelection | StrokeSelection;

/**
 * Single numbered annotation with associated selection and user comment.
 */
export interface Annotation {
  id: string;
  selection: Selection;
  comment: string;
  /** Snapshot coordinates; owner verifies context against the captured source. */
  sourceRange?: import('./sourceRange').SourceRange;
}

/**
 * Tagged frozen source provenance with bounded observed metadata.
 */
export type FrozenSource =
  | {
      kind: 'web';
      url: string;
      title?: string;
    }
  | {
      kind: 'adb';
      serial: string;
      packageName?: string;
      activity?: string;
    }
  | {
      kind: 'document';
      path: string;
      page?: number;
      /** Hash of the original source bytes, distinct from the screenshot hash. */
      sha256?: string;
    }
  | {
      kind: 'image' | 'video';
      path: string;
    }
  | {
      kind: 'terminal';
      /** Numeric Kitty window id as a decimal string; no URL describes this source. */
      windowId: string;
      title?: string;
    };

/**
 * Draft lifecycle state.
 */
export type DesignDraftState =
  | 'editing'
  | 'sending'
  | 'failed'
  | 'unknown'
  | 'accepted';

/**
 * Versioned immutable/draft contract (version 1).
 */
export interface DesignDraft {
  captureProvenance?: import('../remote/captureProvenance').CaptureProvenance;
  version: 1;
  id: string;
  captureId: string;
  captureSha256: string;
  source: FrozenSource;
  annotations: Annotation[];
  state: DesignDraftState;
}

/**
 * Dimensions of a bitmap or viewport surface.
 */
export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Viewport geometry including optional device pixel ratio.
 */
export interface ViewportGeometry {
  width: number;
  height: number;
  dpr?: number;
}

/**
 * Precomputed letterbox/pillarbox transform for contained-image rendering.
 * All coordinates in `containedRect` are in view (client/CSS) space.
 */
export interface ImageTransform {
  viewport: ViewportGeometry;
  screenshot: Dimensions;
  containedRect: RegionBox;
  scale: number;
}
