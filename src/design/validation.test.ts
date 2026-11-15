import { describe, expect, test } from 'bun:test';
import type { RegionBox } from '../presentation/collaborativeCapture';
import type {
  Annotation,
  DesignDraft,
  ElementSelection,
  FrozenSource,
  RegionSelection,
  StrokeSelection,
} from './types';
import {
  MAX_ANNOTATIONS_PER_DRAFT,
  MAX_COMMENT_CODEPOINTS,
  MAX_STROKE_POINTS,
  validateAnnotation,
  validateDesignDraft,
  validateElementSelection,
  validateFrozenSource,
  validateRegionSelection,
  validateSelection,
  validateStrokeSelection,
} from './validation';

describe('Design mode validation foundation', () => {
  const validBounds: RegionBox = { x: 10, y: 20, width: 100, height: 150 };
  const pngDims = { width: 1920, height: 1080 };

  const validRegionSelection: RegionSelection = {
    kind: 'region',
    bounds: validBounds,
  };

  const validElementSelection: ElementSelection = {
    kind: 'element',
    bounds: validBounds,
    elementId: 'elem-1234',
  };

  const validStrokeSelection: StrokeSelection = {
    kind: 'stroke',
    bounds: validBounds,
    points: [
      { x: 10, y: 20 },
      { x: 50, y: 80 },
      { x: 110, y: 170 },
    ],
  };

  const validWebSource: FrozenSource = {
    kind: 'web',
    url: 'https://example.com/app',
    title: 'Example App',
  };

  const validDraft: DesignDraft = {
    version: 1,
    id: 'draft-0123456789ab',
    captureId: 'cap-0123456789ab',
    captureSha256: 'a'.repeat(64),
    source: validWebSource,
    annotations: [
      {
        id: 'ann-1',
        selection: validRegionSelection,
        comment: 'Fix alignment here',
      },
    ],
    state: 'editing',
  };

  test('validateRegionSelection validates pixel bounds within PNG dimensions', () => {
    expect(validateRegionSelection(validRegionSelection, pngDims)).toEqual(validRegionSelection);

    // Rejects non-number / non-object bounds fields
    expect(() =>
      validateRegionSelection(
        { kind: 'region', bounds: { x: '10' as any, y: 20, width: 100, height: 150 } },
        pngDims,
      ),
    ).toThrow(/must be finite numbers/i);
    expect(() =>
      validateRegionSelection(
        { kind: 'region', bounds: { x: null as any, y: 20, width: 100, height: 150 } },
        pngDims,
      ),
    ).toThrow(/must be finite numbers/i);

    // Reversed drag normalization
    expect(
      validateRegionSelection(
        { kind: 'region', bounds: { x: 110, y: 170, width: -100, height: -150 } },
        pngDims,
      ),
    ).toEqual({
      kind: 'region',
      bounds: { x: 10, y: 20, width: 100, height: 150 },
    });

    // Rejects unknown fields
    expect(() =>
      validateRegionSelection({ ...validRegionSelection, extraField: 'bad' }, pngDims),
    ).toThrow(/unknown field/i);

    // Rejects out of bounds
    expect(() =>
      validateRegionSelection(
        { kind: 'region', bounds: { x: 1900, y: 1000, width: 50, height: 100 } },
        pngDims,
      ),
    ).toThrow(/exceeds/i);

    // Rejects non-finite
    expect(() =>
      validateRegionSelection(
        { kind: 'region', bounds: { x: NaN, y: 0, width: 10, height: 10 } },
        pngDims,
      ),
    ).toThrow(/finite/i);
  });

  test('validateElementSelection validates elementId and bounds', () => {
    expect(validateElementSelection(validElementSelection, pngDims)).toEqual(validElementSelection);

    // Rejects missing/empty elementId
    expect(() =>
      validateElementSelection({ ...validElementSelection, elementId: '' }, pngDims),
    ).toThrow();

    // Rejects unknown fields
    expect(() =>
      validateElementSelection({ ...validElementSelection, extra: true }, pngDims),
    ).toThrow(/unknown field/i);

    // Rejects oversized elementId
    expect(() =>
      validateElementSelection({ ...validElementSelection, elementId: 'a'.repeat(129) }, pngDims),
    ).toThrow(/elementId exceeds maximum length/i);
  });

  test('validateStrokeSelection checks stroke point count (max 256) and point bounds', () => {
    expect(validateStrokeSelection(validStrokeSelection, pngDims)).toEqual(validStrokeSelection);

    // Rejects 0 points
    expect(() =>
      validateStrokeSelection({ ...validStrokeSelection, points: [] }, pngDims),
    ).toThrow(/at least one point/i);

    // Rejects > 256 points
    const tooManyPoints = Array.from({ length: MAX_STROKE_POINTS + 1 }, (_, i) => ({
      x: i % pngDims.width,
      y: i % pngDims.height,
    }));
    expect(() =>
      validateStrokeSelection(
        { ...validStrokeSelection, points: tooManyPoints },
        pngDims,
      ),
    ).toThrow(/points exceeds maximum/i);

    // Rejects points outside PNG dimensions
    expect(() =>
      validateStrokeSelection(
        {
          ...validStrokeSelection,
          points: [{ x: 2000, y: 50 }],
        },
        pngDims,
      ),
    ).toThrow(/outside PNG bounds/i);

    // Rejects unknown fields on points or selection
    expect(() =>
      validateStrokeSelection(
        {
          ...validStrokeSelection,
          points: [{ x: 10, y: 20, z: 0 } as any],
        },
        pngDims,
      ),
    ).toThrow(/unknown field/i);

    // Rejects non-number point coordinates ('1', null, true)
    expect(() =>
      validateStrokeSelection(
        {
          ...validStrokeSelection,
          points: [{ x: '1' as any, y: 20 }],
        },
        pngDims,
      ),
    ).toThrow(/must be numbers/i);
    expect(() =>
      validateStrokeSelection(
        {
          ...validStrokeSelection,
          points: [{ x: null as any, y: 20 }],
        },
        pngDims,
      ),
    ).toThrow(/must be numbers/i);
    expect(() =>
      validateStrokeSelection(
        {
          ...validStrokeSelection,
          points: [{ x: 10, y: true as any }],
        },
        pngDims,
      ),
    ).toThrow(/must be numbers/i);

    // Rejects points outside stroke bounds
    expect(() =>
      validateStrokeSelection(
        {
          kind: 'stroke',
          bounds: { x: 10, y: 20, width: 50, height: 50 },
          points: [
            { x: 10, y: 20 },
            { x: 70, y: 20 }, // out of bounds: x max is 60
          ],
        },
        pngDims,
      ),
    ).toThrow(/outside stroke bounds/i);
  });

  test('validateSelection delegates to the proper kind and rejects unknown kinds', () => {
    expect(validateSelection(validRegionSelection, pngDims).kind).toBe('region');
    expect(validateSelection(validElementSelection, pngDims).kind).toBe('element');
    expect(validateSelection(validStrokeSelection, pngDims).kind).toBe('stroke');

    expect(() => validateSelection({ kind: 'circle', bounds: validBounds }, pngDims)).toThrow(
      /unsupported selection kind/i,
    );
  });

  test('annotation source ranges are typed and bounded', () => {
    const ann = { id: 'range', comment: '', selection: { kind: 'region', bounds: { x: 0, y: 0, width: 1, height: 1 } }, sourceRange: { startLine: 2, endLine: 3, text: 'two\nthree' } };
    expect(validateAnnotation(ann, { width: 10, height: 10 }).sourceRange).toEqual(ann.sourceRange);
    expect(() => validateAnnotation({ ...ann, sourceRange: { ...ann.sourceRange, endLine: 1 } }, { width: 10, height: 10 })).toThrow();
    expect(() => validateAnnotation({ ...ann, sourceRange: { ...ann.sourceRange, text: 'x'.repeat(8193) } }, { width: 10, height: 10 })).toThrow();
  });

  test('validateAnnotation validates ID, comment codepoint limits, and selection', () => {
    const ann: Annotation = {
      id: 'ann-1',
      selection: validRegionSelection,
      comment: 'Hello world',
    };
    expect(validateAnnotation(ann, pngDims)).toEqual(ann);

    // 2000 codepoints limit per comment
    const validLongComment = '🚀'.repeat(2000); // 2000 emoji codepoints (UTF-16 length is 4000)
    expect(
      validateAnnotation({ ...ann, comment: validLongComment }, pngDims).comment,
    ).toBe(validLongComment);

    const tooLongComment = '🚀'.repeat(MAX_COMMENT_CODEPOINTS + 1);
    expect(() =>
      validateAnnotation({ ...ann, comment: tooLongComment }, pngDims),
    ).toThrow(/comment exceeds 2000 codepoints/i);

    // Rejects oversized annotation id (>128 chars)
    expect(() =>
      validateAnnotation({ ...ann, id: 'a'.repeat(129) }, pngDims),
    ).toThrow(/id exceeds maximum length of 128/i);

    // Rejects unknown fields
    expect(() => validateAnnotation({ ...ann, strayProp: 1 }, pngDims)).toThrow(/unknown field/i);
  });

  test('validateFrozenSource validates tagged sources and bounded metadata', () => {
    expect(validateFrozenSource(validWebSource)).toEqual(validWebSource);

    const androidSource: FrozenSource = {
      kind: 'adb',
      serial: 'emulator-5554',
      packageName: 'com.example.app',
      activity: '.MainActivity',
    };
    expect(validateFrozenSource(androidSource)).toEqual(androidSource);

    const docSource: FrozenSource = {
      kind: 'document',
      path: '/path/to/doc.pdf',
    };
    expect(validateFrozenSource(docSource)).toEqual(docSource);

    // Rejects unknown source kind
    expect(() => validateFrozenSource({ kind: 'alien' })).toThrow(/unsupported source kind/i);

    // Rejects unknown fields
    expect(() =>
      validateFrozenSource({ ...validWebSource, hackerSecret: 'bad' }),
    ).toThrow(/unknown field/i);

    // Rejects non-string adb metadata objects
    expect(() =>
      validateFrozenSource({
        kind: 'adb',
        serial: 'emulator-5554',
        packageName: { bad: 'object' } as any,
      }),
    ).toThrow(/packageName must be a string/i);
    expect(() =>
      validateFrozenSource({
        kind: 'adb',
        serial: 'emulator-5554',
        activity: 123 as any,
      }),
    ).toThrow(/activity must be a string/i);
    expect(() =>
      validateFrozenSource({
        kind: 'web',
        url: 'https://example.com',
        title: ['not', 'a', 'string'] as any,
      }),
    ).toThrow(/title must be a string/i);

    // Rejects oversized metadata
    expect(() =>
      validateFrozenSource({
        kind: 'adb',
        serial: 'a'.repeat(257),
      }),
    ).toThrow(/serial exceeds maximum length/i);
    expect(() =>
      validateFrozenSource({
        kind: 'adb',
        serial: 'emulator-5554',
        packageName: 'a'.repeat(2049),
      }),
    ).toThrow(/packageName exceeds maximum length/i);
    expect(() =>
      validateFrozenSource({
        kind: 'adb',
        serial: 'emulator-5554',
        activity: 'a'.repeat(2049),
      }),
    ).toThrow(/activity exceeds maximum length/i);
    expect(() =>
      validateFrozenSource({
        kind: 'web',
        url: 'https://example.com/' + 'a'.repeat(8192),
      }),
    ).toThrow(/url exceeds maximum length/i);
    expect(() =>
      validateFrozenSource({
        kind: 'web',
        url: 'https://example.com',
        title: 'a'.repeat(2049),
      }),
    ).toThrow(/title exceeds maximum length/i);
    expect(() =>
      validateFrozenSource({
        kind: 'document',
        path: '/' + 'a'.repeat(8192),
      }),
    ).toThrow(/path exceeds maximum length/i);
  });

  test('validateDesignDraft checks overall draft invariants and limits', () => {
    expect(validateDesignDraft(validDraft, pngDims)).toEqual(validDraft);

    // Rejects unsupported version
    expect(() => validateDesignDraft({ ...validDraft, version: 2 }, pngDims)).toThrow(
      /unsupported draft version/i,
    );

    // Rejects bad captureId (must match cap-[a-f0-9]{12})
    expect(() =>
      validateDesignDraft({ ...validDraft, captureId: 'bad-id' }, pngDims),
    ).toThrow(/invalid captureId/i);

    // Rejects bad sha256 (must be 64 hex chars)
    expect(() =>
      validateDesignDraft({ ...validDraft, captureSha256: 'not-a-hash' }, pngDims),
    ).toThrow(/invalid captureSha256/i);

    // Rejects invalid draft state
    expect(() =>
      validateDesignDraft({ ...validDraft, state: 'in-flight' as any }, pngDims),
    ).toThrow(/invalid state/i);

    // Limit: max 20 annotations
    const annotations21: Annotation[] = Array.from({ length: MAX_ANNOTATIONS_PER_DRAFT + 1 }, (_, i) => ({
      id: `ann-${i}`,
      selection: validRegionSelection,
      comment: `Comment ${i}`,
    }));
    expect(() =>
      validateDesignDraft({ ...validDraft, annotations: annotations21 }, pngDims),
    ).toThrow(/exceeds maximum of 20 annotations/i);

    // Limit: max 8000 total comment codepoints
    const annotationsWithHugeTotal: Annotation[] = [
      { id: '1', selection: validRegionSelection, comment: 'a'.repeat(2000) },
      { id: '2', selection: validRegionSelection, comment: 'b'.repeat(2000) },
      { id: '3', selection: validRegionSelection, comment: 'c'.repeat(2000) },
      { id: '4', selection: validRegionSelection, comment: 'd'.repeat(2000) },
      { id: '5', selection: validRegionSelection, comment: 'e'.repeat(1) },
    ]; // total 8001 codepoints
    expect(() =>
      validateDesignDraft({ ...validDraft, annotations: annotationsWithHugeTotal }, pngDims),
    ).toThrow(/total comment codepoints.*exceeds 8000/i);

    // Rejects unknown top-level fields
    expect(() =>
      validateDesignDraft({ ...validDraft, extraProperty: 42 }, pngDims),
    ).toThrow(/unknown field/i);

    // Rejects duplicate annotation IDs
    expect(() =>
      validateDesignDraft(
        {
          ...validDraft,
          annotations: [
            { id: 'dup-1', selection: validRegionSelection, comment: 'One' },
            { id: 'dup-1', selection: validRegionSelection, comment: 'Two' },
          ],
        },
        pngDims,
      ),
    ).toThrow(/duplicate annotation id/i);

    // Rejects oversized draft id
    expect(() =>
      validateDesignDraft({ ...validDraft, id: 'a'.repeat(129) }, pngDims),
    ).toThrow(/id exceeds maximum length/i);
  });

  test('public validators reject invalid pngDims (non-finite, non-positive, non-integer, >32768, >100M pixels)', () => {
    const badDimsList = [
      { width: 0, height: 1080 },
      { width: 1920, height: -1 },
      { width: NaN, height: 1080 },
      { width: Infinity, height: 1080 },
      { width: 1920.5, height: 1080 },
      { width: '1920' as any, height: 1080 },
      { width: 32769, height: 1000 },
      { width: 1000, height: 32769 },
      { width: 20000, height: 20000 }, // 400M pixels > 100M
    ];

    for (const bad of badDimsList) {
      expect(() => validateRegionSelection(validRegionSelection, bad)).toThrow();
      expect(() => validateElementSelection(validElementSelection, bad)).toThrow();
      expect(() => validateStrokeSelection(validStrokeSelection, bad)).toThrow();
      expect(() => validateSelection(validRegionSelection, bad)).toThrow();
      expect(() => validateAnnotation(validDraft.annotations[0], bad)).toThrow();
      expect(() => validateDesignDraft(validDraft, bad)).toThrow();
    }
  });
});

describe('ElementSelection also', () => {
  test('keeps at most five extra elements and trims their fields', () => {
    const also = Array.from({ length: 8 }, (_, i) => ({ selector: `li.${i}`, text: 'x'.repeat(500) }));
    const result = validateElementSelection({ kind: 'element', elementId: 'li-0-0', bounds: { x: 0, y: 0, width: 5, height: 5 }, also }, { width: 100, height: 100 });
    expect(result.also).toHaveLength(5);
    expect(result.also?.[0]?.text).toHaveLength(100);
  });
});
