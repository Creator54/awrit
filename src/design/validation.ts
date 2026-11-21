import { parseCaptureProvenance } from '../remote/captureProvenance';
import { normalizePixelRegion } from './coordinates';
import { TERMINAL_ID } from './terminalReview';
import type {
  Annotation,
  DesignDraft,
  DesignDraftState,
  Dimensions,
  ElementSelection,
  FrozenSource,
  Point,
  RegionSelection,
  Selection,
  StrokeSelection,
} from './types';

export const MAX_ANNOTATIONS_PER_DRAFT = 20;
export const MAX_COMMENT_CODEPOINTS = 2000;
export const MAX_TOTAL_COMMENT_CODEPOINTS = 8000;
export const MAX_STROKE_POINTS = 256;
export const MAX_PNG_BYTES = 16 * 1024 * 1024; // 16 MiB

const CAPTURE_ID_REGEX = /^cap-[a-f0-9]{12}$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/;

function countCodePoints(str: string): number {
  return Array.from(str).length;
}

function assertNoUnknownFields(
  obj: Record<string, unknown>,
  allowedFields: readonly string[],
  context: string,
): void {
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown field "${key}" encountered in ${context}`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_PNG_DIMENSION = 32768;
const MAX_PNG_PIXELS = 100_000_000;
const MAX_ID_LENGTH = 128;
const MAX_URL_OR_PATH_LENGTH = 8192;
const MAX_METADATA_STRING_LENGTH = 2048;
const MAX_SERIAL_LENGTH = 256;

function validatePngDims(pngDims: unknown): asserts pngDims is Dimensions {
  if (!isPlainObject(pngDims)) {
    throw new Error('pngDims must be an object');
  }
  const { width, height } = pngDims;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error('pngDims width and height must be positive finite integers');
  }
  if (width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
    throw new Error(`pngDims dimensions exceed maximum allowed (${MAX_PNG_DIMENSION})`);
  }
  if (width * height > MAX_PNG_PIXELS) {
    throw new Error(`pngDims total pixels exceed maximum allowed (${MAX_PNG_PIXELS})`);
  }
}

function parseBounds(rawBounds: unknown): { x: number; y: number; width: number; height: number } {
  if (!isPlainObject(rawBounds)) {
    throw new Error('Selection bounds must be an object');
  }
  assertNoUnknownFields(rawBounds, ['x', 'y', 'width', 'height'], 'Selection.bounds');

  const { x, y, width, height } = rawBounds;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    throw new Error('Bounds fields (x, y, width, height) must be finite numbers');
  }

  return { x, y, width, height };
}

/**
 * Validates a RegionSelection in canonical screenshot pixel coordinates.
 */
export function validateRegionSelection(
  raw: unknown,
  pngDims: Dimensions,
): RegionSelection {
  validatePngDims(pngDims);
  if (!isPlainObject(raw)) {
    throw new Error('RegionSelection must be an object');
  }
  assertNoUnknownFields(raw, ['kind', 'bounds'], 'RegionSelection');

  if (raw.kind !== 'region') {
    throw new Error(`Expected kind "region", got "${String(raw.kind)}"`);
  }

  const rawBounds = parseBounds(raw.bounds);
  const bounds = normalizePixelRegion(
    rawBounds,
    pngDims.width,
    pngDims.height,
  );

  return { kind: 'region', bounds };
}

/**
 * Validates an ElementSelection in canonical screenshot pixel coordinates.
 */
export function validateElementSelection(
  raw: unknown,
  pngDims: Dimensions,
): ElementSelection {
  validatePngDims(pngDims);
  if (!isPlainObject(raw)) {
    throw new Error('ElementSelection must be an object');
  }
  assertNoUnknownFields(raw, ['kind', 'bounds', 'elementId', 'selector', 'text', 'role', 'styles', 'component', 'also'], 'ElementSelection');

  if (raw.kind !== 'element') {
    throw new Error(`Expected kind "element", got "${String(raw.kind)}"`);
  }

  if (typeof raw.elementId !== 'string' || raw.elementId.trim().length === 0) {
    throw new Error('ElementSelection requires a non-empty string elementId');
  }
  if (raw.elementId.length > MAX_ID_LENGTH) {
    throw new Error(`ElementSelection elementId exceeds maximum length of ${MAX_ID_LENGTH}`);
  }

  const rawBounds = parseBounds(raw.bounds);
  const bounds = normalizePixelRegion(
    rawBounds,
    pngDims.width,
    pngDims.height,
  );

  const detail = (key: string, max: number): string | undefined => {
    const value = raw[key];
    return typeof value === 'string' && value ? value.slice(0, max) : undefined;
  };
  return {
    kind: 'element',
    bounds,
    elementId: raw.elementId,
    selector: detail('selector', 200),
    text: detail('text', 100),
    styles: detail('styles', 300),
    component: detail('component', 60),
    also: Array.isArray(raw.also)
      ? raw.also.slice(0, 5).flatMap((item: unknown) => {
          if (!isPlainObject(item)) return [];
          const part = (key: string, max: number): string | undefined => {
            const value = item[key];
            return typeof value === 'string' && value ? value.slice(0, max) : undefined;
          };
          return [{ selector: part('selector', 200), text: part('text', 100), component: part('component', 60) }];
        })
      : undefined,
    role: /^[a-z][a-z-]{0,39}$/.test(String(raw.role)) ? (raw.role as string) : undefined,
  };
}

/**
 * Validates a Point in pixel space.
 */
export function validatePoint(raw: unknown, pngDims: Dimensions): Point {
  validatePngDims(pngDims);
  if (!isPlainObject(raw)) {
    throw new Error('Point must be an object');
  }
  assertNoUnknownFields(raw, ['x', 'y'], 'Point');

  if (typeof raw.x !== 'number' || typeof raw.y !== 'number') {
    throw new Error('Point coordinates must be numbers');
  }

  const x = raw.x;
  const y = raw.y;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('Point coordinates must be finite numbers');
  }

  const roundedX = Math.round(x);
  const roundedY = Math.round(y);

  if (roundedX < 0 || roundedX > pngDims.width || roundedY < 0 || roundedY > pngDims.height) {
    throw new Error(
      `Point (${roundedX}, ${roundedY}) is outside PNG bounds (${pngDims.width}x${pngDims.height})`,
    );
  }

  return { x: roundedX, y: roundedY };
}

/**
 * Validates a StrokeSelection in canonical screenshot pixel coordinates.
 */
export function validateStrokeSelection(
  raw: unknown,
  pngDims: Dimensions,
): StrokeSelection {
  validatePngDims(pngDims);
  if (!isPlainObject(raw)) {
    throw new Error('StrokeSelection must be an object');
  }
  assertNoUnknownFields(raw, ['kind', 'bounds', 'points'], 'StrokeSelection');

  if (raw.kind !== 'stroke') {
    throw new Error(`Expected kind "stroke", got "${String(raw.kind)}"`);
  }

  if (!Array.isArray(raw.points)) {
    throw new Error('StrokeSelection points must be an array');
  }

  if (raw.points.length === 0) {
    throw new Error('StrokeSelection must contain at least one point');
  }

  if (raw.points.length > MAX_STROKE_POINTS) {
    throw new Error(
      `Stroke points exceeds maximum of ${MAX_STROKE_POINTS} (received ${raw.points.length})`,
    );
  }

  const points = raw.points.map((p) => validatePoint(p, pngDims));

  const rawBounds = parseBounds(raw.bounds);
  const bounds = normalizePixelRegion(
    rawBounds,
    pngDims.width,
    pngDims.height,
  );

  const minX = bounds.x;
  const maxX = bounds.x + bounds.width;
  const minY = bounds.y;
  const maxY = bounds.y + bounds.height;

  for (const pt of points) {
    if (pt.x < minX || pt.x > maxX || pt.y < minY || pt.y > maxY) {
      throw new Error(
        `Stroke point (${pt.x}, ${pt.y}) falls outside stroke bounds (${bounds.x}, ${bounds.y}, ${bounds.width}, ${bounds.height})`,
      );
    }
  }

  return {
    kind: 'stroke',
    bounds,
    points,
  };
}

/**
 * Validates a general Selection contract.
 */
export function validateSelection(raw: unknown, pngDims: Dimensions): Selection {
  validatePngDims(pngDims);
  if (!isPlainObject(raw)) {
    throw new Error('Selection must be an object');
  }

  switch (raw.kind) {
    case 'region':
      return validateRegionSelection(raw, pngDims);
    case 'element':
      return validateElementSelection(raw, pngDims);
    case 'stroke':
      return validateStrokeSelection(raw, pngDims);
    default:
      throw new Error(`Unsupported selection kind: ${String(raw.kind)}`);
  }
}

/**
 * Validates a single Annotation.
 */
export function validateAnnotation(
  raw: unknown,
  pngDims: Dimensions,
): Annotation {
  validatePngDims(pngDims);
  if (!isPlainObject(raw)) {
    throw new Error('Annotation must be an object');
  }
  assertNoUnknownFields(raw, ['id', 'selection', 'comment', 'sourceRange'], 'Annotation');

  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    throw new Error('Annotation id must be a non-empty string');
  }
  if (raw.id.length > MAX_ID_LENGTH) {
    throw new Error(`Annotation id exceeds maximum length of ${MAX_ID_LENGTH}`);
  }

  if (typeof raw.comment !== 'string') {
    throw new Error('Annotation comment must be a string');
  }

  const codepointCount = countCodePoints(raw.comment);
  if (codepointCount > MAX_COMMENT_CODEPOINTS) {
    throw new Error(
      `Annotation comment exceeds ${MAX_COMMENT_CODEPOINTS} codepoints (has ${codepointCount})`,
    );
  }

  const selection = validateSelection(raw.selection, pngDims);
  let sourceRange: Annotation['sourceRange'];
  if (raw.sourceRange !== undefined) {
    const range = raw.sourceRange;
    if (!isPlainObject(range)) throw new Error('Source range must be an object');
    assertNoUnknownFields(range, ['startLine', 'endLine', 'text'], 'Source range');
    if (typeof range.startLine !== 'number' || !Number.isInteger(range.startLine) || range.startLine < 1 || typeof range.endLine !== 'number' || !Number.isInteger(range.endLine) || range.endLine < range.startLine || range.endLine > 20000 || range.endLine - range.startLine >= 100 || typeof range.text !== 'string' || range.text.length > 8192) throw new Error('Invalid source range');
    sourceRange = { startLine: range.startLine, endLine: range.endLine, text: range.text };
  }

  return {
    id: raw.id,
    selection,
    comment: raw.comment,
    ...(sourceRange ? { sourceRange } : {}),
  };
}

/**
 * Validates a FrozenSource object.
 */
export function validateFrozenSource(raw: unknown): FrozenSource {
  if (!isPlainObject(raw)) {
    throw new Error('FrozenSource must be an object');
  }

  switch (raw.kind) {
    case 'web':
      assertNoUnknownFields(raw, ['kind', 'url', 'title'], 'FrozenSource(web)');
      if (typeof raw.url !== 'string' || raw.url.length === 0) {
        throw new Error('Web source requires a valid non-empty url');
      }
      if (raw.url.length > MAX_URL_OR_PATH_LENGTH) {
        throw new Error(`Web source url exceeds maximum length of ${MAX_URL_OR_PATH_LENGTH}`);
      }
      if (raw.title !== undefined) {
        if (typeof raw.title !== 'string') {
          throw new Error('Web source title must be a string if provided');
        }
        if (raw.title.length > MAX_METADATA_STRING_LENGTH) {
          throw new Error(`Web source title exceeds maximum length of ${MAX_METADATA_STRING_LENGTH}`);
        }
      }
      return {
        kind: 'web',
        url: raw.url,
        title: raw.title as string | undefined,
      };

    case 'adb':
      assertNoUnknownFields(
        raw,
        ['kind', 'serial', 'packageName', 'activity'],
        'FrozenSource(adb)',
      );
      if (typeof raw.serial !== 'string' || raw.serial.length === 0) {
        throw new Error('ADB source requires a valid non-empty serial');
      }
      if (raw.serial.length > MAX_SERIAL_LENGTH) {
        throw new Error(`ADB source serial exceeds maximum length of ${MAX_SERIAL_LENGTH}`);
      }
      if (raw.packageName !== undefined) {
        if (typeof raw.packageName !== 'string') {
          throw new Error('ADB source packageName must be a string if provided');
        }
        if (raw.packageName.length > MAX_METADATA_STRING_LENGTH) {
          throw new Error(`ADB source packageName exceeds maximum length of ${MAX_METADATA_STRING_LENGTH}`);
        }
      }
      if (raw.activity !== undefined) {
        if (typeof raw.activity !== 'string') {
          throw new Error('ADB source activity must be a string if provided');
        }
        if (raw.activity.length > MAX_METADATA_STRING_LENGTH) {
          throw new Error(`ADB source activity exceeds maximum length of ${MAX_METADATA_STRING_LENGTH}`);
        }
      }
      return {
        kind: 'adb',
        serial: raw.serial,
        packageName: raw.packageName as string | undefined,
        activity: raw.activity as string | undefined,
      };

    case 'document':
      assertNoUnknownFields(raw, ['kind', 'path', 'page', 'sha256'], 'FrozenSource(document)');
      if (typeof raw.path !== 'string' || raw.path.length === 0) {
        throw new Error('Document source requires a non-empty path');
      }
      if (raw.path.length > MAX_URL_OR_PATH_LENGTH) {
        throw new Error(`Document source path exceeds maximum length of ${MAX_URL_OR_PATH_LENGTH}`);
      }
      if (raw.page !== undefined && (!Number.isInteger(raw.page) || Number(raw.page) <= 0)) {
        throw new Error('Document source page must be a positive integer if provided');
      }
      if (raw.sha256 !== undefined && (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256))) {
        throw new Error('Document source sha256 must be a lowercase SHA-256 hash');
      }
      return {
        kind: 'document',
        path: raw.path,
        page: raw.page as number | undefined,
        ...(raw.sha256 !== undefined ? { sha256: raw.sha256 as string } : {}),
      };

    case 'terminal':
      assertNoUnknownFields(raw, ['kind', 'windowId', 'title'], 'FrozenSource(terminal)');
      if (
        typeof raw.windowId !== 'string' ||
        !TERMINAL_ID.test(raw.windowId)
      ) {
        throw new Error('Terminal source windowId must be a Kitty window id or a TUIOS pane id');
      }
      if (raw.title !== undefined) {
        if (typeof raw.title !== 'string') {
          throw new Error('Terminal source title must be a string if provided');
        }
        if (raw.title.length > MAX_METADATA_STRING_LENGTH) {
          throw new Error(`Terminal source title exceeds maximum length of ${MAX_METADATA_STRING_LENGTH}`);
        }
      }
      return {
        kind: 'terminal',
        windowId: raw.windowId,
        title: raw.title as string | undefined,
      };

    case 'image':
    case 'video':
      assertNoUnknownFields(raw, ['kind', 'path'], `FrozenSource(${raw.kind})`);
      if (typeof raw.path !== 'string' || raw.path.length === 0) {
        throw new Error(`${raw.kind} source requires a non-empty path`);
      }
      if (raw.path.length > MAX_URL_OR_PATH_LENGTH) {
        throw new Error(`${raw.kind} source path exceeds maximum length of ${MAX_URL_OR_PATH_LENGTH}`);
      }
      return {
        kind: raw.kind,
        path: raw.path,
      };

    default:
      throw new Error(`Unsupported source kind: ${String(raw.kind)}`);
  }
}

const VALID_DRAFT_STATES: ReadonlySet<string> = new Set<DesignDraftState>([
  'editing',
  'sending',
  'failed',
  'unknown',
  'accepted',
]);

/**
 * Validates a DesignDraft structure against all strict boundary limits.
 */
export function validateDesignDraft(
  raw: unknown,
  pngDims: Dimensions,
): DesignDraft {
  validatePngDims(pngDims);
  if (!isPlainObject(raw)) {
    throw new Error('DesignDraft must be an object');
  }
  assertNoUnknownFields(
    raw,
    ['version', 'id', 'captureId', 'captureSha256', 'captureProvenance', 'source', 'annotations', 'state'],
    'DesignDraft',
  );

  if (raw.version !== 1) {
    throw new Error(`Unsupported draft version: ${String(raw.version)} (expected 1)`);
  }

  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    throw new Error('Draft id must be a non-empty string');
  }
  if (raw.id.length > MAX_ID_LENGTH) {
    throw new Error(`Draft id exceeds maximum length of ${MAX_ID_LENGTH}`);
  }

  if (typeof raw.captureId !== 'string' || !CAPTURE_ID_REGEX.test(raw.captureId)) {
    throw new Error(
      `Invalid captureId "${String(raw.captureId)}"; must match cap-[a-f0-9]{12}`,
    );
  }

  if (typeof raw.captureSha256 !== 'string' || !SHA256_REGEX.test(raw.captureSha256)) {
    throw new Error('Invalid captureSha256; must be 64-character lowercase hex string');
  }

  const captureProvenance = parseCaptureProvenance(raw.captureProvenance);
  const source = validateFrozenSource(raw.source);

  if (!Array.isArray(raw.annotations)) {
    throw new Error('Draft annotations must be an array');
  }

  if (raw.annotations.length > MAX_ANNOTATIONS_PER_DRAFT) {
    throw new Error(
      `Draft exceeds maximum of ${MAX_ANNOTATIONS_PER_DRAFT} annotations (has ${raw.annotations.length})`,
    );
  }

  let totalCommentCodepoints = 0;
  const seenAnnotationIds = new Set<string>();
  const annotations: Annotation[] = raw.annotations.map((ann) => {
    const validated = validateAnnotation(ann, pngDims);
    if (seenAnnotationIds.has(validated.id)) {
      throw new Error(`Duplicate annotation id: "${validated.id}"`);
    }
    seenAnnotationIds.add(validated.id);
    totalCommentCodepoints += countCodePoints(validated.comment);
    return validated;
  });

  if (totalCommentCodepoints > MAX_TOTAL_COMMENT_CODEPOINTS) {
    throw new Error(
      `Total comment codepoints (${totalCommentCodepoints}) exceeds ${MAX_TOTAL_COMMENT_CODEPOINTS}`,
    );
  }

  if (typeof raw.state !== 'string' || !VALID_DRAFT_STATES.has(raw.state)) {
    throw new Error(`Invalid state "${String(raw.state)}" in DesignDraft`);
  }

  return {
    version: 1,
    id: raw.id,
    captureId: raw.captureId,
    captureSha256: raw.captureSha256,
    ...(captureProvenance ? { captureProvenance } : {}),
    source,
    annotations,
    state: raw.state as DesignDraftState,
  };
}
