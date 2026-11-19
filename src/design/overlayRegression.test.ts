import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { annotationRevision } from './sentRevisions';
import { createRequire } from 'node:module';
import { loadDraft } from './draftStore';
import { createDesignIpcHarness } from './windowDesignIpcHarness';

// Node's default Solid export is the non-reactive SSR runtime; exercise the browser runtime.
const solid: typeof import('solid-js') = createRequire(import.meta.url)('solid-js/dist/solid.cjs');
import {
  computeContainedImageBounds,
  createImageTransform,
  imageBoundsToView,
  viewBoundsToImage,
} from './coordinates';

const CAPTURE_ID = 'cap-0123456789ab';
const DRAFT_ID = 'draft-aaaaaaaa';
const DIMS = { width: 40, height: 40 };
const SOURCE = { kind: 'document', path: 'src/app.ts', sha256: 'b'.repeat(64) } as const;

/** A draft whose note quotes source context, so the save must validate a snapshot. */
function sourceDraft(annotationId: string) {
  return {
    version: 1,
    id: DRAFT_ID,
    captureId: CAPTURE_ID,
    captureSha256: 'a'.repeat(64),
    state: 'editing',
    annotations: [
      {
        id: annotationId,
        comment: 'Check this line',
        selection: { kind: 'region', bounds: { x: 0, y: 0, width: 10, height: 10 } },
        sourceRange: { startLine: 1, endLine: 1, text: 'line one' },
      },
    ],
  };
}

describe('DesignModeOverlay regressions', () => {
  const overlaySource = readFileSync(
    new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url),
    'utf8',
  );

  test('note card takes over wheel scrolling only at the editor edge', () => {
    const start = overlaySource.indexOf('onWheel={(e) => {');
    const end = overlaySource.indexOf('\n                    }}', start);
    class Editor {
      scrollTop = 20;
      scrollHeight = 100;
      readonly clientHeight = 50;
    }
    const editor = new Editor();
    const card = { scrollTop: 40, scrollHeight: 140, clientHeight: 60 };
    const onWheel = new Function('HTMLTextAreaElement', 'WheelEvent',
      `return (${overlaySource.slice(start + 'onWheel={'.length, end)} })`)(
      Editor, { DOM_DELTA_PAGE: 2, DOM_DELTA_LINE: 1 },
    );
    let prevented = 0;
    const wheel = (deltaY: number, ctrlKey = false) => onWheel({
      target: editor, currentTarget: card, deltaY, ctrlKey, deltaMode: 0,
      preventDefault: () => { prevented++; },
    });
    wheel(10);
    editor.scrollTop = 50;
    wheel(10, true);
    wheel(-10);
    expect(card.scrollTop).toBe(40);
    expect(prevented).toBe(0);
    wheel(10);
    expect(card.scrollTop).toBe(50);
    editor.scrollTop = 0;
    wheel(-10);
    expect(card.scrollTop).toBe(40);
    expect(prevented).toBe(2);
    editor.scrollHeight = editor.clientHeight;
    wheel(10);
    expect(card.scrollTop).toBe(50);
    expect(prevented).toBe(3);
  });

  test('native review backing pages do not receive the website white background', () => {
    const source = readFileSync(new URL('../windows.ts', import.meta.url), 'utf8');
    const start = source.indexOf('      if (!transparent && !terminalReview) {\n        // The native review');
    const end = source.indexOf('\n\n      // Load and apply saved zoom', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const css: string[] = [];
    const context = vm.createContext({ transparent: false, terminalReview: {}, content: { webContents: { insertCSS: (text: string) => css.push(text) } } });
    const code = source.slice(start, end);
    vm.runInContext(code, context);
    expect(css).toEqual([]);
    vm.runInContext('terminalReview = undefined', context);
    vm.runInContext(code, context);
    expect(css).toEqual(['html { background-color: white; }']);
  });

  test('frame readiness waits for rendering and rejects a replaced capture', () => {
    const start = overlaySource.indexOf('                  requestAnimationFrame(() => requestAnimationFrame');
    const end = overlaySource.indexOf('\n                }}', start);
    const callbacks: Array<() => void> = [];
    const ready: string[] = [];
    let current = 'capture-1';
    const context = vm.createContext({
      requestAnimationFrame: (fn: () => void) => callbacks.push(fn),
      props: { active: true }, captureId: 'capture-1', frameMeta: () => ({ captureId: current }),
      window: { ipc: { designFrameReady: (id: string) => ready.push(id) } },
    });
    const code = overlaySource.slice(start, end);
    vm.runInContext(code, context);
    expect(ready).toEqual([]);
    callbacks.shift()?.();
    expect(ready).toEqual([]);
    callbacks.shift()?.();
    expect(ready).toEqual(['capture-1']);
    vm.runInContext(code, context);
    current = 'capture-2';
    callbacks.shift()?.(); callbacks.shift()?.();
    expect(ready).toEqual(['capture-1']);
  });

  test('replacement decoding retains the current frame and rejects stale captures', async () => {
    const start = overlaySource.indexOf('  const unsubscribeFrame =');
    const end = overlaySource.indexOf('\n\n\n  onCleanup', start);
    let receive!: (frame: unknown) => Promise<void>;
    const decodes: Array<() => void> = [];
    const failures: Array<(error: Error) => void> = [];
    let status = '';
    const revoked: string[] = [];
    let shown = 'original';
    let selected: string | null = 'old-note';
    let dragging = true;
    let hovered: unknown = { elementId: 'old-element' };
    let next = 0;
    const context = vm.createContext({
      props: { active: true }, frameRequest: 0, Blob, Uint8Array,
      URL: { createObjectURL: () => `frame-${++next}`, revokeObjectURL: (url: string) => revoked.push(url) },
      Image: class { src = ''; decode() { return new Promise<void>((resolve, reject) => { decodes.push(resolve); failures.push(reject); }); } },
      window: { ipc: { onDesignFrozenFrame: (fn: typeof receive) => { receive = fn; } } },
      frameDataUrl: () => shown, setFrameDataUrl: (url: string) => { shown = url; },
      batch: (fn: () => void) => fn(),
      setSaveStatus: (value: string) => { status = value; }, setSaveOutcome() {}, setRestoredReview() {}, setAnnotations() {}, setSentNotes() {}, setDeletedNote() {},
      setSelectedAnnotationId: (id: string | null) => { selected = id; }, setActiveComment() {},
      setIsDragging: (value: boolean) => { dragging = value; }, setDragStart() {}, setCurrentDragRect() {},
      inspectReqId: 0, inspectTimer: null, clearTimeout() {}, lastPointer: { x: 10, y: 10 },
      setHoveredElement: (value: unknown) => { hovered = value; },
      setFrameDims() {}, setFrameMeta() {}, viewportRef: undefined, console,
    });
    vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(overlaySource.slice(start, end)), context);
    const first = receive({ png: [], captureId: 'first' });
    const second = receive({ png: [], captureId: 'second' });
    expect(shown).toBe('original');
    expect(revoked).toEqual([]);
    decodes[0](); await first;
    expect(shown).toBe('original');
    expect(revoked).toEqual(['frame-1']);
    decodes[1](); await second;
    expect(shown).toBe('frame-2');
    expect(selected).toBe(null);
    expect(dragging).toBe(false);
    expect(hovered).toBe(null);
    expect(context.lastPointer).toBe(null);
    expect(context.inspectReqId).toBe(1);
    expect(revoked).toEqual(['frame-1', 'original']);
    const failed = receive({ png: [], captureId: 'broken' });
    failures[2](new Error('Decode failed'));
    await failed;
    expect(shown).toBe('frame-2');
    expect(status).toContain('Could not open capture');
    expect(revoked).toContain('frame-3');
    const staleFailure = receive({ png: [], captureId: 'stale-broken' });
    const fresh = receive({ png: [], captureId: 'fresh' });
    decodes[4](); await fresh;
    failures[3](new Error('Stale decode failed')); await staleFailure;
    expect(shown).toBe('frame-5');
    expect(status).toBe(null);
    const beforeClose = receive({ png: [], captureId: 'before-close' });
    context.props.active = false;
    context.frameRequest++;
    context.props.active = true;
    decodes[5](); await beforeClose;
    expect(shown).toBe('frame-5');
    expect(revoked).toContain('frame-6');
    expect(overlaySource).toContain('if (!props.active) {\n      frameRequest++;');


  });

  test('resize synchronizes both viewport dimensions before the next observer callback', () => {
    const start = overlaySource.indexOf('  const syncViewport =');
    const end = overlaySource.indexOf('  const saveForResize', start);
    let listener: (() => void) | undefined;
    let size = { width: 900, height: 600 };
    let measured: unknown;
    const context = vm.createContext({
      props: { active: true }, viewportRef: { getBoundingClientRect: () => size },
      setViewportDims: (value: unknown) => { measured = value; },
      window: { addEventListener: (_: string, fn: () => void) => { listener = fn; } },
      onCleanup: () => {},
    });
    vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(overlaySource.slice(start, end)), context);
    size = { width: 420, height: 180 };
    expect(listener).toBeDefined();
    listener?.();
    expect(measured).toEqual(size);
  });

  test('deleting a note can restore its position and text only in the same capture', () => {
    const start = overlaySource.indexOf('  const removeAnnotation =');
    const end = overlaySource.indexOf('  // Keep the complete review', start);
    let notes = [{ id: 'a', comment: 'first' }, { id: 'b', comment: 'keep my text' }, { id: 'c', comment: 'last' }];
    let deleted: unknown;
    let captureId = 'capture-1';
    let selected: string | null = 'b';
    let comment = '';
    const context = vm.createContext({
      annotations: () => notes, setAnnotations: (update: (notes: unknown[]) => typeof notes) => { notes = update(notes); },
      frameMeta: () => ({ captureId }), deletedNote: () => deleted, setDeletedNote: (value: unknown) => { deleted = value; },
      selectedAnnotationId: () => selected, setSelectedAnnotationId: (value: string | null) => { selected = value; },
      setActiveComment: (value: string) => { comment = value; }, rootRef: { focus() {} },
    });
    const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(overlaySource.slice(start, end));
    vm.runInContext(`${code}; removeAnnotation('b'); undoDelete();`, context);
    expect(notes.map(note => note.id)).toEqual(['a', 'b', 'c']);
    expect(comment).toBe('keep my text');
    expect(selected).toBe('b');
    vm.runInContext("removeAnnotation('b')", context);
    captureId = 'capture-2';
    vm.runInContext('undoDelete()', context);
    expect(notes.map(note => note.id)).toEqual(['a', 'c']);
  });

  test('note navigation keeps text and stops at the ends', () => {
    const start = overlaySource.indexOf('  const selectAdjacentNote =');
    const end = overlaySource.indexOf('  const removeAnnotation =', start);
    expect(start).toBeGreaterThan(-1);
    let selected = 'b';
    let comment = '';
    const context = vm.createContext({
      annotations: () => [{ id: 'a', comment: 'first' }, { id: 'b', comment: 'second' }],
      selectedAnnotationId: () => selected,
      selectAnnotation: (id: string, text: string) => { selected = id; comment = text; },
    });
    const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(overlaySource.slice(start, end));
    vm.runInContext(`${code}; selectAdjacentNote(-1); selectAdjacentNote(-1);`, context);
    expect(selected).toBe('a');
    expect(comment).toBe('first');
    vm.runInContext('selectAdjacentNote(1); selectAdjacentNote(1);', context);
    expect(selected).toBe('b');
    expect(comment).toBe('second');
  });

  test('only unsent notes with written feedback count toward Send all', () => {
    const start = overlaySource.indexOf('  const pendingNotes =');
    const end = overlaySource.indexOf('\n\n', start);
    const context = vm.createContext({
      annotations: () => [{ id: 'empty', comment: '  ' }, { id: 'sent', comment: 'done' }, { id: 'ready', comment: 'Fix contrast' }],
      wasSent: (note: { id: string }) => note.id === 'sent',
    });
    vm.runInContext(`${overlaySource.slice(start, end)}; globalThis.pending = pendingNotes().map(note => note.id);`, context);
    expect(context.pending).toEqual(['ready']);
  });

  test('Tab stays within the visible review controls', () => {
    const start = overlaySource.indexOf('  const handleKeyDown =');
    const end = overlaySource.indexOf('  const scheduleInspect =', start);
    let focused = '';
    const first = { focus: () => { focused = 'first'; } };
    const last = { focus: () => { focused = 'last'; } };
    const root = { querySelectorAll: () => [first, last] };
    const document = { activeElement: last };
    const context = vm.createContext({ rootRef: root, document });
    const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(overlaySource.slice(start, end));
    let prevented = false;
    context.event = { key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } };
    vm.runInContext(`${code}; handleKeyDown(event);`, context);
    expect(focused).toBe('first');
    expect(prevented).toBe(true);
    document.activeElement = first;
    context.event.shiftKey = true;
    vm.runInContext('handleKeyDown(event)', context);
    expect(focused).toBe('last');
  });

  test('bar drag coalesces captured events and uses the current pane width', () => {
    const start = overlaySource.indexOf('const startBarDrag =');
    const end = overlaySource.indexOf('let viewportRef', start);
    const listeners = new Map<string, { callback: (event: unknown) => void; capture: unknown }>();
    let scheduled: (() => void) | undefined;
    const updates: unknown[] = [];
    let width = 800;
    const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${overlaySource.slice(start, end)}; startBarDrag(event);`);
    vm.runInNewContext(script, {
      stopBarDrag: undefined,
      barRef: { getBoundingClientRect: () => ({ left: 300, top: 12 }) },
      barSize: () => ({ width: 200 }), viewportDims: () => ({ width }),
      setBarOffset: (value: unknown) => updates.push(value),
      event: { clientX: 150, clientY: 30, preventDefault() {}, stopPropagation() {} },
      requestAnimationFrame: (callback: () => void) => { scheduled = callback; return 1; },
      cancelAnimationFrame() {},
      window: { innerWidth: 800, innerHeight: 600,
        addEventListener: (type: string, callback: (event: unknown) => void, capture: unknown) => listeners.set(type, { callback, capture }),
        removeEventListener: (type: string) => listeners.delete(type),
      },
    });
    expect(listeners.get('mousemove')?.capture).toBe(true);
    listeners.get('mousemove')?.callback({ clientX: 160, clientY: 40 });
    listeners.get('mousemove')?.callback({ clientX: 180, clientY: 50 });
    expect(updates).toHaveLength(0);
    scheduled?.();
    expect(updates).toEqual([{ x: 30, y: 20 }]);
    width = 640;
    listeners.get('mousemove')?.callback({ clientX: 190, clientY: 60 });
    listeners.get('mouseup')?.callback({});
    expect(updates).toEqual([{ x: 30, y: 20 }, { x: 120, y: 30 }]);
    expect(listeners.size).toBe(0);
  });

  test('unchanged retries reuse the draft and edited submissions get new IDs', () => {
    const start = overlaySource.indexOf('const buildDraft =');
    const end = overlaySource.indexOf('const send =', start);
    const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
      let draftId;
      let draftKey;
      let comment = 'Original';
      const annotations = () => [{ id: 'note', selection: { kind: 'region' }, comment }];
      ${overlaySource.slice(start, end)}
      const first = buildDraft(meta);
      const retry = buildDraft(meta);
      comment = 'Updated';
      const fresh = buildDraft(meta);
      globalThis.results = { first, retry, fresh };
    `);
    let nextRandom = 0;
    const context = {
      Math: { random: () => { nextRandom += 0.1; return nextRandom; } },
      meta: { captureId: 'cap-test', captureSha256: 'hash' },
      frameSource: () => ({ kind: 'web', url: 'https://example.com', title: 'Test' }),
      results: undefined as { first: { id: string }; retry: { id: string }; fresh: { id: string; annotations: { comment: string }[] } } | undefined,
    };
    vm.runInNewContext(script, context);
    if (!context.results) throw new Error('Draft test did not produce results');
    const { first, retry, fresh } = context.results;
    expect(first.id).toBe(retry.id);
    expect(fresh.annotations[0].comment).toBe('Updated');
    expect(fresh.id).not.toBe(first.id);
  });

  test('comment edits do not place pins again, but selected geometry changes do', () => {
    solid.createRoot(dispose => {
      try {
        const [annotations, setAnnotations] = solid.createSignal([{ id: 'one', comment: 'old', x: 1 }]);
        const start = overlaySource.indexOf('  const pinBoxes =');
        const end = overlaySource.indexOf('  const kindLabel =', start);
        let calls = 0;
        const box = (a: { x: number }) => ({ x: a.x, y: 2, width: 3, height: 4 });
        const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${overlaySource.slice(start, end)}\npins();`);
        vm.runInNewContext(script, {
          createMemo: solid.createMemo, annotations, getViewBox: box,
          selectedAnnotation: () => annotations()[0], selectedAnnotationId: () => 'one',
          bubblePosition: box, viewportDims: () => ({ width: 800, height: 600 }),
          bubbleSize: () => ({ width: 260, height: 124 }),
          placePins: () => { calls++; return []; },
        });
        const initial = calls;
        solid.batch(() => setAnnotations(previous => previous.map(a => ({ ...a, comment: 'new' }))));
        expect(calls).toBe(initial);
        solid.batch(() => setAnnotations(previous => previous.map(a => ({ ...a, x: 20 }))));
        expect(calls).toBeGreaterThan(initial);
      } finally { dispose(); }
    });
  });

  test('send outcome distinguishes clipboard fallback and failure without parsing messages', async () => {
    const start = overlaySource.indexOf('const send = async (notes = pendingNotes()) => {');
    const end = overlaySource.indexOf('\n  return (', start);
    const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${overlaySource.slice(start, end)}\nsend();`);
    for (const [result, expected, expectedStatus] of [
      [{ ok: true }, 'normal', 'Accepted'],
      [{ ok: false, noConnectedAgent: true }, 'warning', 'No agent found. Notes copied to the clipboard.'],
      [{ ok: false, error: 'Offline' }, 'error', 'Could not send: Offline'],
    ] as const) {
      let outcome = '';
      const statuses: string[] = [];
      await vm.runInNewContext(script, {
        props: { active: true }, frameRequest: 0,
        frameSource: () => ({ kind: 'web' }),
        frameMeta: () => ({}), pendingNotes: () => [{id: 'n', comment: 'Written feedback'}], isSaving: () => false, draftId: 'draft-test', setSentNotes() {},
        setIsSaving() {}, setSendingNoteIds() {}, setSaveStatus: (value: string) => { statuses.push(value); }, setSaveOutcome: (value: string) => { outcome = value; },
        annotations: () => [],
        annotationRevision,
        buildDraft: () => ({id: 'draft-test'}), window: { ipc: { saveDesignDraft: async () => ({ ok: true }), sendDesignFeedback: async () => result } },
      });
      expect(outcome).toBe(expected);
      expect(statuses).toEqual(['Sending…', expectedStatus]);
    }
  });

  test('sending one note marks only its submitted revision and preserves failures', async () => {
    const start = overlaySource.indexOf('const send = async (notes = pendingNotes()) => {');
    const end = overlaySource.indexOf('\n  return (', start);
    const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${overlaySource.slice(start, end)}\nsend([note]);`);
    for (const ok of [true, false]) {
      const note = { id: 'one', comment: 'Original' };
      let marked: Record<string, string> = {};
      let payload: { annotations: typeof note[] } | undefined;
      let fullReview: { annotations: typeof note[] } | undefined;
      const other = { id: 'two', comment: 'Not submitted' };
      await vm.runInNewContext(script, {
        annotationRevision,
        props: { active: true }, frameRequest: 0,
        frameSource: () => ({ kind: 'web' }),
        note, draftId: 'draft-test', frameMeta: () => ({ captureId: 'cap-test' }), isSaving: () => false,
        annotations: () => [note, other],
        setIsSaving() {}, setSendingNoteIds() {}, setSaveStatus() {}, setSaveOutcome() {},
        setSentNotes: (update: (previous: Record<string, string>) => Record<string, string>) => { marked = update({}); },
        buildDraft: (_meta: unknown, notes: typeof note[]) => ({ id: 'draft-test', annotations: notes }),
        window: { ipc: { saveDesignDraft: async (draft: { annotations: typeof note[] }) => { fullReview = draft; return { ok: true }; }, sendDesignFeedback: async (draft: { annotations: typeof note[] }) => {
          payload = draft;
          note.comment = 'Edited while sending';
          return { ok };
        } } },
      });
      expect(fullReview?.annotations).toHaveLength(2);
      expect(payload?.annotations).toHaveLength(1);
      expect(Object.keys(marked)).toEqual(ok ? ['one'] : []);
      if (ok) expect(marked.one).not.toBe(JSON.stringify(note));
    }
  });

  test('sending an edited note keeps its earlier acknowledged revision', async () => {
    const start = overlaySource.indexOf('const send = async (notes = pendingNotes()) => {');
    const end = overlaySource.indexOf('\n  return (', start);
    const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${overlaySource.slice(start, end)}\nsend();`);
    const note = { id: 'one', comment: 'Edited again' };
    const earlier = annotationRevision({ ...note, comment: 'Original' });
    let marked: Record<string, string[]> = { one: [earlier] };
    await vm.runInNewContext(script, {
      annotationRevision,
      props: { active: true }, frameRequest: 0,
      frameSource: () => ({ kind: 'web' }),
      pendingNotes: () => [note], draftId: 'draft-test',
      frameMeta: () => ({ captureId: 'cap-test' }), isSaving: () => false,
      annotations: () => [note],
      setIsSaving() {}, setSendingNoteIds() {}, setSaveStatus() {}, setSaveOutcome() {},
      setSentNotes: (update: (previous: Record<string, string[]>) => Record<string, string[]>) => { marked = update(marked); },
      buildDraft: () => ({ id: 'draft-test' }),
      window: { ipc: { saveDesignDraft: async () => ({ ok: true }), sendDesignFeedback: async () => ({ ok: true }) } },
    });
    expect(marked.one).toEqual([earlier, annotationRevision(note)]);
  });

  test('Enter sends the current unsent note but preserves composition and newlines', () => {
    const start = overlaySource.lastIndexOf('onKeyDown={(e) => {');
    const end = overlaySource.indexOf('\n                      }}', start);
    const handler = overlaySource.slice(start + 'onKeyDown={'.length, end) + '\n}';
    const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(`(${handler})(event);`);
    const note = { id: 'one', comment: 'Make this clearer' };
    const sent: unknown[] = [];
    let alreadySent = false;
    const run = (isComposing: boolean, shiftKey = false) => vm.runInNewContext(script, {
      event: { key: 'Enter', isComposing, shiftKey, preventDefault() {}, stopPropagation() {} },
      ann: () => note,
      wasSent: () => alreadySent,
      send: (notes: unknown[]) => sent.push(...notes),
    });
    run(true);
    run(false, true);
    expect(sent).toHaveLength(0);
    run(false);
    expect(sent).toEqual([note]);
    alreadySent = true;
    run(false);
    expect(sent).toHaveLength(1);
  });

  test('bubble header preserves custom element names', () => {
    const start = overlaySource.indexOf('const kindLabel =');
    const end = overlaySource.indexOf('// An empty note', start);
    const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(
      `${overlaySource.slice(start, end)}\nkindLabel(annotation);`,
    );
    expect(vm.runInNewContext(script, {
      annotation: { selection: { kind: 'element', elementId: 'user-card-12-34' } },
    })).toBe('user-card');
  });

  test('frozen frame image markup uses object-contain matching coordinate math', () => {
    // Verifies the image rendering uses object-contain rather than object-fill
    expect(overlaySource).toContain('class="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"');
    expect(overlaySource).not.toContain('class="absolute inset-0 w-full h-full object-fill pointer-events-none select-none"');

    // Selection math assumes CSS object-contain letterboxing/pillarboxing
    const viewport = { width: 1000, height: 500 };
    const screenshot = { width: 500, height: 500 }; // 1:1 image inside 2:1 container
    const transform = createImageTransform(viewport, screenshot);

    const contained = computeContainedImageBounds(viewport, screenshot);
    expect(contained).toEqual({
      x: 250,
      y: 0,
      width: 500,
      height: 500,
    });
    expect(transform.scale).toBe(1);

    // Coordinate mapping round-trips correctly within the contained image box
    const viewDrag = { x: 300, y: 50, width: 100, height: 100 };
    const imageBounds = viewBoundsToImage(viewDrag, transform);
    expect(imageBounds).toEqual({
      x: 50,
      y: 50,
      width: 100,
      height: 100,
    });
    if (!imageBounds) throw new Error('Expected selection inside image');
    const backToView = imageBoundsToView(imageBounds, transform);
    expect(backToView).toEqual(viewDrag);
  });

  test('element selection saves screenshot pixels rather than viewport CSS pixels', () => {
    const start = overlaySource.indexOf('const addElementNote =');
    const end = overlaySource.indexOf('const cancelSelection =', start);
    const handler = overlaySource.slice(start, end).replace('const addElementNote = () => {', '').replace(/\};\s*$/, '') + '}';
    let saved: { selection: { bounds: object } }[] = [];
    const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(`(() => { ${handler})()`);
    vm.runInNewContext(executable, {
      setIsDragging: () => {}, setDragStart: () => {},
      setCurrentDragRect: () => {}, hoveredElement: () => ({ elementId: 'button', bounds: { x: 50, y: 30, width: 100, height: 40 } }),
      viewportRef: { getBoundingClientRect: () => ({ width: 500, height: 300 }) },
      frameDims: () => ({ width: 1000, height: 600 }),
      createImageTransform, viewBoundsToImage,
      setAnnotations: (update: (previous: object[]) => typeof saved) => { saved = update([]); },
      selectAnnotation: () => {}, setSelectedAnnotationId: () => {}, setActiveComment: () => {}, setSaveStatus: () => {},
      setHoveredElement: () => {},
    });
    expect(saved[0]?.selection.bounds).toEqual({ x: 100, y: 60, width: 200, height: 80 });

    const viewBoxStart = overlaySource.indexOf('const getViewBox =');
    const viewBoxEnd = overlaySource.indexOf('\n  const bubbleSize =', viewBoxStart);
    const viewBoxScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
      `${overlaySource.slice(viewBoxStart, viewBoxEnd)}\ngetViewBox(annotation);`,
    );
    const highlighted = vm.runInNewContext(viewBoxScript, {
      annotation: { selection: { kind: 'element', bounds: saved[0]?.selection.bounds } },
      viewportDims: () => ({ width: 500, height: 300 }),
      frameDims: () => ({ width: 1000, height: 600 }),
      createImageTransform, imageBoundsToView,
    });
    expect(highlighted).toEqual({ x: 50, y: 30, width: 100, height: 40 });
  });
});

describe('DesignModeOverlay click versus drag', () => {
  test('a click picks the hovered element; without one it drops a small area pin', () => {
    const source = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
    expect(source).toContain('if (isClick && hoveredElement()) {');
    expect(source).toContain('const PIN = 32;');
  });
});

describe('DesignModeOverlay parent and child picking', () => {
  test('arrow keys move the inspected element up the tree and stop below body', () => {
    const overlay = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
    const windows = readFileSync(new URL('../windows.ts', import.meta.url), 'utf8');
    expect(overlay).toContain("e.key === 'ArrowUp' || e.key === 'ArrowDown'");
    expect(windows).toContain('parent === document.body');
  });
});

describe('DesignModeOverlay undo', () => {
  test('Ctrl/Cmd+Z outside text fields restores a deleted note or removes the last mark', () => {
    const overlay = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
    expect(overlay).toContain("e.key.toLowerCase() === 'z'");
    expect(overlay).toContain('if (deletedNote()) undoDelete();');
    expect(overlay).toContain('setAnnotations((prev) => prev.filter((a) => a.id !== last.id))');
  });
});

describe('DesignModeOverlay batch removal', () => {
  test('batch setting and toggle are absent and default collects notes for Send all', () => {
    const overlay = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
    expect(overlay).not.toContain('BATCH_STORAGE_KEY');
    expect(overlay).not.toContain('loadBatchMode');
    expect(overlay).not.toContain('saveBatchMode');
    expect(overlay).not.toContain('batchMode');
    expect(overlay).not.toContain('toggleBatchMode');
    expect(overlay).not.toContain('>Batch<');
    expect(overlay).toContain('Enter sends · Shift+Enter adds a new line');
    expect(overlay).toContain('if (!wasSent(ann())) void send([ann()]);');
    expect(overlay).toContain('Send all (${' + 'pendingNotes().length})');
  });
});


test('region selection captures the pointer and ignores secondary buttons', () => {
  const overlaySource = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  const start = overlaySource.indexOf('  const handleMouseDown =');
  const end = overlaySource.indexOf('  const handleMouseMove =', start);
  const code = new Bun.Transpiler({ loader: 'tsx' }).transformSync(overlaySource.slice(start, end));
  let captures = 0;
  let dragging = false;
  const bindings = {
    viewportRef: { setPointerCapture: () => { captures++; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
    frameDims: () => ({ width: 100, height: 100 }), setViewportDims: () => {},
    setIsDragging: (value: boolean) => { dragging = value; }, setDragStart: () => {}, setCurrentDragRect: () => {},
  };
  const down = new Function(...Object.keys(bindings), `let inspectReqId = 0; const inspectTimer = null; ${code}; return handleMouseDown;`)(...Object.values(bindings));
  down({ button: 2, isPrimary: true });
  expect(captures).toBe(0);
  down({ button: 0, isPrimary: true, pointerId: 1, clientX: 40, clientY: 50 });
  expect(captures).toBe(1);
  expect(dragging).toBe(true);
  expect(overlaySource).toContain('onLostPointerCapture={cancelSelection}');
});


test('leaving Design waits for the latest draft and stays open on save failure', async () => {
  const source = readFileSync(new URL('../toolbar/src/Toolbar.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('        onExit={async () => {');
  const end = source.indexOf('\n        }}', start);
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start + '        onExit={async () => {'.length, end);
  let active = true;
  let exits = 0;
  let release!: () => void;
  let fail = false;
  const saved = new Promise<void>(resolve => { release = resolve; });
  const exit = new Function('reviewContext', 'setDesignModeActive', 'window', 'console',
    `let leavingReview = false; const openingReview = false; return async () => { ${body} };`
  )(() => ({ saveBeforeLeave: async () => { if (fail) throw new Error('Disk full'); await saved; } }),
    (value: boolean) => { active = value; }, { ipc: { exitDesignMode: () => { exits++; } } }, { error() {} });
  const pending = exit();
  await exit();
  expect(active).toBe(true);
  expect(exits).toBe(0);
  release();
  await pending;
  expect(active).toBe(false);
  expect(exits).toBe(1);
  active = true;
  fail = true;
  await exit();
  expect(active).toBe(true);
  expect(exits).toBe(1);
});


test('draft saves finish in request order even when older source validation waits', async () => {
  const dataHome = mkdtempSync(path.join(tmpdir(), 'awrit-design-drafts-'));
  const originalDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  let harness: Awaited<ReturnType<typeof createDesignIpcHarness>> | undefined;
  try {
    let release!: () => void;
    const validation = new Promise<void>((resolve) => {
      release = resolve;
    });
    let validations = 0;
    harness = await createDesignIpcHarness({
      sourceReader: async () => {
        validations++;
        await validation;
        return { path: 'src/app.ts', sha256: 'b'.repeat(64), text: 'line one' };
      },
    });
    harness.setCaptureMeta({
      captureId: CAPTURE_ID,
      captureSha256: 'a'.repeat(64),
      pngDims: DIMS,
      source: SOURCE,
    });
    const save = (draft: object) =>
      harness.invoke('awrit:save-design-draft', draft) as Promise<{ ok: boolean; error?: string }>;
    const draftPath = path.join(dataHome, 'awrit', 'design-drafts', `${DRAFT_ID}.json`);
    const first = save(sourceDraft('note-old'));
    const latest = save(sourceDraft('note-latest'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The newer request waits: the older one is still validating and nothing is written.
    expect(validations).toBe(1);
    expect(existsSync(draftPath)).toBe(false);
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await latest).toMatchObject({ ok: true });
    expect(validations).toBe(2);
    expect(loadDraft(DRAFT_ID, DIMS)?.annotations[0]?.id).toBe('note-latest');

    // A rejected request does not block later deliberate saves.
    const rejected = await save({ ...sourceDraft('note-bad'), captureSha256: 'c'.repeat(64) });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('Capture identity does not match active review');
    expect(await save(sourceDraft('note-recovered'))).toMatchObject({ ok: true });
    expect(loadDraft(DRAFT_ID, DIMS)?.annotations[0]?.id).toBe('note-recovered');
  } finally {
    harness?.dispose();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    rmSync(dataHome, { recursive: true, force: true });
  }
});


test('IME candidate keys cannot trigger Design shortcuts or send a note', () => {
  const source = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const handleKeyDown =');
  const end = source.indexOf('\n  };', start) + 5;
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  const handler = new Function(`${code}; return handleKeyDown;`)();
  handler({ key: 'Escape', isComposing: true });
  handler({ key: 'Enter', keyCode: 229 });
  const noteStart = source.indexOf('                      onKeyDown={(e) => {');
  const noteEnd = source.indexOf('\n                      }}', noteStart);
  const body = source.slice(noteStart + '                      onKeyDown={(e) => {'.length, noteEnd);
  const noteKey = new Function('e', body);
  noteKey({ key: 'Enter', keyCode: 229 });
  noteKey({ key: 'Enter', isComposing: true });
  expect(noteStart).toBeGreaterThan(-1);
});


test('starting selection invalidates an in-flight element inspection', async () => {
  const source = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const scheduleInspect =');
  const end = source.indexOf('  const handleMouseMove =', start);
  const code = new Bun.Transpiler({ loader: 'tsx' }).transformSync(source.slice(start, end));
  let callback!: () => Promise<void>;
  let answer!: (value: unknown) => void;
  const lookup = new Promise(resolve => { answer = resolve; });
  const shown: unknown[] = [];
  const bindings = {
    isDragging: () => false, isAdb: () => false,
    setTimeout: (fn: () => Promise<void>) => { callback = fn; return 1; }, clearTimeout: () => {},
    window: { ipc: { inspectElementAtPoint: () => lookup } }, setHoveredElement: (value: unknown) => shown.push(value),
    viewportRef: { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
    frameDims: () => ({ width: 100, height: 100 }), setViewportDims() {}, setIsDragging() {}, setDragStart() {}, setCurrentDragRect() {},
  };
  const api = new Function(...Object.keys(bindings),
    `let inspectReqId = 0, inspectTimer = null, inspectUp = 0, lastPointer = null; ${code}; return { scheduleInspect, handleMouseDown };`
  )(...Object.values(bindings));
  api.scheduleInspect(30, 40);
  const pending = callback();
  api.handleMouseDown({ button: 0, isPrimary: true, pointerId: 1, clientX: 30, clientY: 40 });
  answer({ elementId: 'late-element' });
  await pending;
  expect(shown).toEqual([]);
});


test('closing Design before delayed setup cannot steal focus or observe a hidden viewport', () => {
  const source = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('      const setupTimer =');
  const end = source.indexOf('\n    }\n  });', start);
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  const props = { active: true };
  let scheduled!: () => void;
  let cleanup!: () => void;
  let focused = 0;
  let cleared = false;
  const bindings = {
    props, setTimeout: (fn: () => void) => { scheduled = fn; return 7; },
    clearTimeout: (id: number) => { expect(id).toBe(7); cleared = true; },
    onCleanup: (fn: () => void) => { cleanup = fn; },
    rootRef: { focus() { focused++; } }, viewportRef: null,
  };
  new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  props.active = false;
  cleanup();
  expect(cleared).toBe(true);
  scheduled();
  expect(focused).toBe(0);
  props.active = true;
  scheduled();
  expect(focused).toBe(1);
});


test('superseded autosave results cannot change the current review status', async () => {
  const source = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('    let current = true;');
  const end = source.indexOf('\n  });', start);
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  let run!: () => void;
  let cleanup!: () => void;
  let answer!: (result: { ok: boolean }) => void;
  let status: string | null = null;
  const bindings = {
    meta: { captureId: 'old' }, source: {}, notes: [],
    setTimeout: (fn: () => void) => { run = fn; return 1; }, clearTimeout() {},
    onCleanup: (fn: () => void) => { cleanup = fn; },
    window: { ipc: { saveDesignDraft: () => new Promise(resolve => { answer = resolve; }) } },
    saveStatus: () => status, setSaveStatus: (value: string | null) => { status = value; }, setSaveOutcome() {},
  };
  const setup = () => new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  setup(); run(); cleanup(); answer({ ok: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(status).toBe(null);
  setup(); run(); answer({ ok: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(status).toBe('Could not save review');
});


test('element ancestor keyboard navigation stays within the host depth limit', () => {
  const overlaySource = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  const start = overlaySource.indexOf('  const handleKeyDown =');
  const end = overlaySource.indexOf('  const scheduleInspect =', start);
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(overlaySource.slice(start, end));
  const depths: number[] = [];
  const context = vm.createContext({
    lastPointer: { x: 10, y: 20 }, hoveredElement: () => ({}), isAdb: () => false,
    selectedAnnotationId: () => null, isDragging: () => false, inspectUp: 30,
    scheduleInspect: (_x: number, _y: number, depth: number) => depths.push(depth),
    event: { key: 'ArrowUp', preventDefault() {}, stopPropagation() {} },
  });
  vm.runInContext(`${code}; handleKeyDown(event);`, context);
  context.event.key = 'ArrowDown';
  vm.runInContext('handleKeyDown(event)', context);
  expect(depths).toEqual([30, 29]);
  context.inspectUp = 0;
  vm.runInContext('handleKeyDown(event)', context);
  expect(depths.at(-1)).toBe(0);
});


test('switching notes drops only the abandoned blank note', () => {
  const source = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const selectAnnotation =');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('  const closeBubble =', start);
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  let notes = [{ id: 'empty', comment: '  ' }, { id: 'kept', comment: 'Keep this' }];
  let selected: string | null = 'empty';
  let comment = '';
  const bindings = {
    selectedAnnotationId: () => selected, annotations: () => notes,
    setAnnotations: (fn: (previous: typeof notes) => typeof notes) => { notes = fn(notes); },
    setSelectedAnnotationId: (id: string | null) => { selected = id; },
    setActiveComment: (value: string) => { comment = value; },
  };
  const select = new Function(...Object.keys(bindings), `${code}; return selectAnnotation;`)(...Object.values(bindings));
  select('empty', '');
  expect(notes).toHaveLength(2);
  select('kept', 'Keep this');
  expect(notes.map(note => note.id)).toEqual(['kept']);
  expect(comment).toBe('Keep this');
  select(null, '');
  expect(notes.map(note => note.id)).toEqual(['kept']);
  expect(selected).toBe(null);
  expect(comment).toBe('');
});
