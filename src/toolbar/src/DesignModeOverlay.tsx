import { clearTerminalBackground } from './terminalCapture';
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { annotationRevision } from '../../design/sentRevisions';
import {
  createImageTransform,
  imageBoundsToView,
  viewBoundsToImage,
} from '../../design/coordinates';
import { PIN_HEIGHT, PIN_WIDTH, placePins, placeBubble } from '../../design/bubblePlacement';
import type { Annotation, DesignDraft, FrozenSource } from '../../design/types';
import type { SourceRange } from '../../design/sourceRange';
import { Icon } from './Icon';

export interface ReviewContext {
  image?: string;
  annotations?: Annotation[];
  onSelect?: (id: string) => void;
  onSourceRange?: (range: SourceRange) => void;
  saveBeforeLeave?: () => Promise<void>;
}

interface DesignModeOverlayProps {
  active: boolean;
  onExit: () => void;
  onReviewContextChange?: (ctx: ReviewContext | null) => void;
}


export function DesignModeOverlay(props: DesignModeOverlayProps) {
  let rootRef: HTMLDivElement | undefined;
  let barRef: HTMLDivElement | undefined;
  // The control bar can be moved so notes can be placed underneath it.
  const [recipients, setRecipients] = createSignal<{ id: string; label: string }[]>([]);
  const [recipient, setRecipient] = createSignal('');
  let recipientNotes: Annotation[] | undefined;
  const [barOffset, setBarOffset] = createSignal({ x: 0, y: 0 });
  const [barSize, setBarSize] = createSignal({ width: 0, height: 0 });
  const observeBar = (el: HTMLDivElement) => {
    barRef = el;
    const observer = new ResizeObserver(() => setBarSize({ width: el.offsetWidth, height: el.offsetHeight }));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };
  let stopBarDrag: (() => void) | undefined;
  const startBarDrag = (e: MouseEvent) => {
    stopBarDrag?.();
    e.preventDefault();
    e.stopPropagation();
    const r = barRef?.getBoundingClientRect();
    if (!r) return;
    const start = { mx: e.clientX, my: e.clientY, x: r.left, y: r.top };
    let frame: number | undefined;
    let pointer = { x: e.clientX, y: e.clientY };
    const paint = () => {
      frame = undefined;
      setBarOffset({
        x: start.x + pointer.x - start.mx - (viewportDims().width - barSize().width) / 2,
        y: start.y + pointer.y - start.my - 12,
      });
    };
    const move = (ev: MouseEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (frame === undefined) frame = requestAnimationFrame(paint);
    };
    const up = () => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        paint();
      }
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('blur', up);
      stopBarDrag = undefined;
    };
    stopBarDrag = up;
    window.addEventListener('blur', up);
    // The bar stops bubbling moves; capture keeps dragging continuous over its children.
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up);
  };
  let viewportRef: HTMLDivElement | undefined;
  const [frameDataUrl, setFrameDataUrl] = createSignal<string | null>(null);
  const [frameDims, setFrameDims] = createSignal<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [frameMeta, setFrameMeta] = createSignal<{
    captureId: string;
    captureSha256: string;
  } | null>(null);
  const [frameSource, setFrameSource] = createSignal<FrozenSource | null>(null);
  const [viewportDims, setViewportDims] = createSignal<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [annotations, setAnnotations] = createSignal<Annotation[]>([]);
  const [activeComment, setActiveComment] = createSignal('');
  const [selectedAnnotationId, setSelectedAnnotationId] = createSignal<string | null>(null);
  const [hoveredElement, setHoveredElement] = createSignal<{
    elementId: string;
    tag: string;
    selector: string;
    textSnippet?: string;
    role?: string;
    styles?: string;
    component?: string;
    bounds: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const [isSaving, setIsSaving] = createSignal(false);
  const [sendingNoteIds, setSendingNoteIds] = createSignal<string[]>([]);
  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);
  const [saveOutcome, setSaveOutcome] = createSignal<'normal' | 'warning' | 'error'>('normal');

  // Drag-to-select state
  const [isDragging, setIsDragging] = createSignal(false);
  const [dragStart, setDragStart] = createSignal<{ x: number; y: number } | null>(null);
  const [currentDragRect, setCurrentDragRect] = createSignal<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  let resizeObserver: ResizeObserver | undefined;
  let inspectReqId = 0;
  // ArrowUp/ArrowDown move the highlight to a parent/child of the hovered element; moving the mouse resets it.
  let inspectUp = 0;
  let lastPointer: { x: number; y: number } | null = null;
  let inspectTimer: ReturnType<typeof setTimeout> | null = null;

  const [restoredReview, setRestoredReview] = createSignal(false);
  const isAdb = () => restoredReview() || frameSource()?.kind === 'adb';
  let draftId: string | undefined;
  let draftKey: string | undefined;
  const [deletedNote, setDeletedNote] = createSignal<{ note: Annotation; index: number; captureId: string }>();
  const [sentNotes, setSentNotes] = createSignal<Record<string, string[]>>({});
  const wasSent = (note: Annotation) => sentNotes()[note.id]?.includes(annotationRevision(note)) ?? false;
  const pendingNotes = () => annotations().filter((note) => note.comment.trim() && !wasSent(note));

  createEffect(() => {
    if (!props.active) {
      props.onReviewContextChange?.(null);
      return;
    }
    const dataUrl = frameDataUrl();
    const dims = frameDims();
    props.onReviewContextChange?.({
      image: dataUrl ?? undefined,
      annotations: annotations(),
      onSelect: (id) => {
        selectAnnotation(id, annotations().find((note) => note.id === id)?.comment ?? '');
      },
      onSourceRange: (range: SourceRange) => {
        const id = `ann-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 6)}`;
        setAnnotations((prev) => [
          ...prev,
          {
            id,
            comment: '',
            sourceRange: range,
            selection: { kind: 'region', bounds: { x: 0, y: 0, width: dims.width, height: dims.height } },
          },
        ]);
        selectAnnotation(id, '');
        setSaveStatus(null);
      },
      saveBeforeLeave: async () => {
        if (isSaving()) {
          setSaveStatus('Wait for the current operation to finish, then close the review.');
          throw new Error('Review is busy');
        }
        const meta = frameMeta();
        const source = frameSource();
        if (meta && source) {
          const notes = annotations();
          setIsSaving(true);
          try {
            const saved = await window.ipc.saveDesignDraft({
              version: 1,
              id: meta.captureId,
              ...meta,
              source,
              annotations: notes,
              state: 'editing',
            });
            if (annotations() !== notes) {
              throw new Error('Review changed while saving. Close it again to save the latest edits.');
            }
            if (!saved.ok) {
              throw new Error(saved.error || 'Could not save current review');
            }
          } catch (error) {
            setSaveOutcome('error');
            setSaveStatus(error instanceof Error ? error.message : 'Could not save current review');
            throw error;
          } finally {
            setIsSaving(false);
          }
        }
      },
    });
  });

  onCleanup(() => {
    props.onReviewContextChange?.(null);
  });

  let frameRequest = 0;
  createEffect(() => {
    if (!props.active) {
      frameRequest++;
      setFrameDataUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setFrameSource(null);
      setRestoredReview(false);
      setAnnotations([]);
      setDeletedNote(undefined);
      draftId = undefined;
      setSentNotes({});
      setSaveStatus(null);
      setActiveComment('');
      setSelectedAnnotationId(null);
      setIsDragging(false);
      setDragStart(null);
      setCurrentDragRect(null);
      inspectReqId++;
      if (inspectTimer) clearTimeout(inspectTimer);
      setHoveredElement(null);
      resizeObserver?.disconnect();
      resizeObserver = undefined;
    } else {
      const setupTimer = setTimeout(() => {
        if (!props.active) return;
        rootRef?.focus();
        if (viewportRef) {
          const rect = viewportRef.getBoundingClientRect();
          setViewportDims({ width: rect.width, height: rect.height });
          resizeObserver?.disconnect();
          resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
              const { width, height } = entry.contentRect;
              if (width > 0 && height > 0) {
                setViewportDims({ width, height });
              }
            }
          });
          resizeObserver.observe(viewportRef);
        }
      }, 20);
      onCleanup(() => clearTimeout(setupTimer));
    }
  });

  const syncViewport = () => {
    if (!props.active || !viewportRef) return;
    const { width, height } = viewportRef.getBoundingClientRect();
    if (width > 0 && height > 0) setViewportDims({ width, height });
  };
  window.addEventListener('resize', syncViewport);
  onCleanup(() => window.removeEventListener('resize', syncViewport));

  const saveForResize = (event: Event) => {
    const { resolve, reject } = (event as CustomEvent<{ resolve: () => void; reject: (error: unknown) => void }>).detail;
    const meta = frameMeta(), source = frameSource();
    if (!meta || !source) { reject(new Error('Review is not ready')); return; }
    void window.ipc.saveDesignDraft({ version: 1, id: meta.captureId, ...meta, source, annotations: annotations(), state: 'editing' })
      .then(result => result.ok ? resolve() : reject(new Error('Could not save review')), reject);
  };
  window.addEventListener('awrit:save-review-for-resize', saveForResize);
  onCleanup(() => window.removeEventListener('awrit:save-review-for-resize', saveForResize));

  const unsubscribeFrame = window.ipc.onDesignFrozenFrame(async (frame) => {
    if (!props.active) return;
    const request = ++frameRequest;
    let pendingUrl: string | undefined;
    try {
      const png = new Blob([new Uint8Array(frame.png)], { type: 'image/png' });
      const blob = frame.source?.kind === 'terminal' ? await clearTerminalBackground(png, document.documentElement.dataset.terminalBackground ?? null) : png;
      const url = URL.createObjectURL(blob);
      pendingUrl = url;
      const image = new Image();
      image.src = url;
      await image.decode();
      if (request !== frameRequest || !props.active) return;
      const previousUrl = frameDataUrl();
      // Keep the old image and its geometry until the replacement is decoded.
      batch(() => {
      setSaveStatus(null);
      setSaveOutcome('normal');
      setFrameDataUrl(url);
      if (frame.restored) {
        if (frameMeta() && frameMeta()?.captureId !== frame.captureId && annotations().length > 0) {
          setSaveStatus('Previous notes saved with the original capture in Reviews.');
          setSaveOutcome('normal');
        }
        setRestoredReview(true);
        setAnnotations(frame.draft?.annotations ?? []);
        if (frame.sentRevisions) {
          setSentNotes(frame.sentRevisions);
        } else {
          setSentNotes({});
        }
      } else {
        setRestoredReview(false);
        setAnnotations([]);
        setSentNotes({});
      }
      setDeletedNote(undefined);
      setSelectedAnnotationId(null);
      setActiveComment('');
      setIsDragging(false);
      setDragStart(null);
      setCurrentDragRect(null);
      inspectReqId++;
      if (inspectTimer) clearTimeout(inspectTimer);
      setHoveredElement(null);
      lastPointer = null;
      setFrameDims({ width: frame.width, height: frame.height });
      setFrameMeta({
        captureId: frame.captureId,
        captureSha256: frame.captureSha256,
      });
      if (frame.source) {
        setRecipient('');
        setRecipients([]);
        recipientNotes = undefined;
        setFrameSource(frame.source);
      }
      if (viewportRef) {
        const rect = viewportRef.getBoundingClientRect();
        setViewportDims({ width: rect.width, height: rect.height });
      }
      });
      pendingUrl = undefined;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    } catch (err) {
      console.error('Failed to process frozen frame', err);
      if (request === frameRequest && props.active) {
        setSaveOutcome('error');
        setSaveStatus('Could not open capture. Try capturing again; existing notes are unchanged.');
      }
    } finally {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    }
  });



  onCleanup(() => {
    frameRequest++;
    stopBarDrag?.();
    inspectReqId++;
    if (inspectTimer) clearTimeout(inspectTimer);
    resizeObserver?.disconnect();
    unsubscribeFrame?.();
    const url = frameDataUrl();
    if (url) URL.revokeObjectURL(url);
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Tab') {
      const controls = Array.from(rootRef?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled)') ?? []);
      const first = controls[0];
      const last = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === rootRef)) {
        e.preventDefault(); last?.focus();
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === rootRef)) {
        e.preventDefault(); first?.focus();
      }
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && lastPointer && hoveredElement() && !isAdb() && !selectedAnnotationId() && !isDragging()) {
      e.preventDefault();
      e.stopPropagation();
      scheduleInspect(lastPointer.x, lastPointer.y, Math.min(30, Math.max(0, inspectUp + (e.key === 'ArrowUp' ? 1 : -1))));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && !selectedAnnotationId() && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) {
      // Like Cursor: undo the last mark. A just-deleted note comes back first.
      e.preventDefault();
      e.stopPropagation();
      // Popping a mark is not remembered as a delete, so repeated presses keep undoing earlier marks.
      const last = annotations().at(-1);
      if (deletedNote()) undoDelete();
      else if (last) setAnnotations((prev) => prev.filter((a) => a.id !== last.id));
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (selectedAnnotationId()) closeBubble();
      else props.onExit();
    } else if (e.altKey && (e.key === 'd' || e.key === 'D')) {
      e.stopPropagation();
      props.onExit();
    }
  };

  const scheduleInspect = (clientX: number, clientY: number, up = 0) => {
    if (isDragging() || isAdb()) return;
    inspectUp = up;
    lastPointer = { x: clientX, y: clientY };
    const reqId = ++inspectReqId;

    if (inspectTimer) clearTimeout(inspectTimer);
    inspectTimer = setTimeout(async () => {
      if (reqId !== inspectReqId) return;
      try {
        const el = await window.ipc.inspectElementAtPoint(clientX, clientY, up);
        if (reqId !== inspectReqId) return;
        setHoveredElement(el);
      } catch {
        if (reqId === inspectReqId) {
          setHoveredElement(null);
        }
      }
    }, 16);
  };

  const handleMouseDown = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || !viewportRef || frameDims().width <= 0) return;
    viewportRef.setPointerCapture(e.pointerId);
    inspectReqId++;
    if (inspectTimer) clearTimeout(inspectTimer);
    const rect = viewportRef.getBoundingClientRect();
    setViewportDims({ width: rect.width, height: rect.height });
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    setIsDragging(true);
    setDragStart({ x: clientX, y: clientY });
    setCurrentDragRect({ x: clientX, y: clientY, width: 0, height: 0 });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!viewportRef || frameDims().width <= 0) return;
    const rect = viewportRef.getBoundingClientRect();
    const currentX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const currentY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    const start = dragStart();
    if (!isDragging() || !start) {
      scheduleInspect(currentX, currentY);
      return;
    }

    const x = Math.min(start.x, currentX);
    const y = Math.min(start.y, currentY);
    const width = Math.abs(currentX - start.x);
    const height = Math.abs(currentY - start.y);

    setCurrentDragRect({ x, y, width, height });
  };

  const handleMouseLeave = () => {
    inspectReqId++;
    if (inspectTimer) clearTimeout(inspectTimer);
    setHoveredElement(null);
  };

  // Shift+click adds the hovered element to the open element note, like Cursor.
  const addToSelectedNote = () => {
    const el = hoveredElement();
    const id = selectedAnnotationId();
    const current = annotations().find((a) => a.id === id);
    if (!el || !current || current.selection.kind !== 'element' || !viewportRef) return false;
    const sel = current.selection;
    if (el.selector === sel.selector || sel.also?.some((o) => o.selector === el.selector) || (sel.also?.length ?? 0) >= 5) return true;
    const viewportRect = viewportRef.getBoundingClientRect();
    const added = viewBoundsToImage(el.bounds, createImageTransform(
      { width: viewportRect.width, height: viewportRect.height }, frameDims(),
    ));
    if (!added) return true;
    const x = Math.min(sel.bounds.x, added.x);
    const y = Math.min(sel.bounds.y, added.y);
    const bounds = {
      x,
      y,
      width: Math.max(sel.bounds.x + sel.bounds.width, added.x + added.width) - x,
      height: Math.max(sel.bounds.y + sel.bounds.height, added.y + added.height) - y,
    };
    const extra = { selector: el.selector, text: el.textSnippet, component: el.component };
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, selection: { ...sel, bounds, also: [...(sel.also ?? []), extra] } } : a)));
    setHoveredElement(null);
    // The press moved focus to the overlay; give it back to the note being edited.
    queueMicrotask(() => rootRef?.querySelector<HTMLTextAreaElement>('textarea.awrit-feedback-input')?.focus());
    return true;
  };

  /** Sends a note about the whole frame without selecting anything first. */
  const askAboutFrame = (text: string) => {
    const { width, height } = frameDims();
    if (!text.trim() || width <= 0 || height <= 0) return;
    const note: Annotation = {
      id: `ann-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 6)}`,
      selection: { kind: 'region', bounds: { x: 0, y: 0, width, height } },
      comment: text.trim(),
    };
    setAnnotations((prev) => [...prev, note]);
    void send([note]);
  };

  const addElementNote = () => {
    inspectUp = 0;
    const el = hoveredElement();
    if (!el || !viewportRef || frameDims().width <= 0) return;
    const viewportRect = viewportRef.getBoundingClientRect();
    const bounds = viewBoundsToImage(el.bounds, createImageTransform(
      { width: viewportRect.width, height: viewportRect.height }, frameDims(),
    ));
    if (!bounds) return;
    const newId = `ann-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 6)}`;
    const newAnn: Annotation = {
      id: newId,
      selection: {
        kind: 'element',
        elementId: el.elementId,
        selector: el.selector,
        text: el.textSnippet,
        role: el.role,
        styles: el.styles,
        component: el.component,
        bounds,
      },
      comment: '',
    };
    setAnnotations((prev) => [...prev, newAnn]);
    selectAnnotation(newId, '');
    setSaveStatus(null);
    setHoveredElement(null);
  };

  const cancelSelection = () => {
    setIsDragging(false);
    setDragStart(null);
    setCurrentDragRect(null);
  };

  const handleMouseUp = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (isDragging()) handleMouseMove(e);
    const drag = currentDragRect();
    if (!isDragging() || !drag || !viewportRef) {
      setIsDragging(false);
      setDragStart(null);
      return;
    }

    setIsDragging(false);
    setDragStart(null);
    setCurrentDragRect(null);

    // A click (no real drag) selects the hovered element; a drag marks an area.
    // With no element under the cursor (Android frames, or a very fast click), drop a small area pin instead.
    const isClick = drag.width < 5 && drag.height < 5;
    if (isClick && hoveredElement()) {
      if (e.shiftKey && addToSelectedNote()) return;
      addElementNote();
      return;
    }
    if (isClick) {
      const PIN = 32;
      drag.x = Math.max(0, drag.x - PIN / 2);
      drag.y = Math.max(0, drag.y - PIN / 2);
      drag.width = PIN;
      drag.height = PIN;
    }

    // Minimum drag threshold (5x5 px) to avoid accidental clicks
    if (drag.width < 5 || drag.height < 5) return;

    const viewportRect = viewportRef.getBoundingClientRect();
    const transform = createImageTransform(
      { width: viewportRect.width, height: viewportRect.height },
      frameDims(),
    );

    const normalized = viewBoundsToImage(drag, transform);
    if (!normalized) return;

    const newId = `ann-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 6)}`;
    const newAnn: Annotation = {
      id: newId,
      selection: {
        kind: 'region',
        bounds: normalized,
      },
      comment: '',
    };

    setAnnotations((prev) => [...prev, newAnn]);
    selectAnnotation(newId, '');
    setSaveStatus(null);
  };

  const getViewBox = (ann: Annotation) => {
    if (viewportDims().width <= 0) return null;
    if (ann.selection.kind === 'element' || ann.selection.kind === 'region') {
      if (frameDims().width <= 0) return null;
      const transform = createImageTransform(viewportDims(), frameDims());
      return imageBoundsToView(ann.selection.bounds, transform);
    }
    return null;
  };
  // In short panes, reserve the top row for Return and Send all.
  const compact = () => viewportDims().height < 200;
  const bubbleInset = () => viewportDims().height < 128 ? 38 : compact() ? 48 : 0;
  const bubbleViewport = () => ({ ...viewportDims(), height: Math.max(0, viewportDims().height - bubbleInset()) });
  const bubbleMargin = () => compact() ? 4 : 8;
  const bubbleSize = () => ({
    width: Math.max(0, Math.min(260, viewportDims().width - 2 * bubbleMargin())),
    height: Math.max(0, Math.min(150, bubbleViewport().height - 2 * bubbleMargin())),
  });
  const selectedAnnotation = () => annotations().find((a) => a.id === selectedAnnotationId());
  const bubblePosition = (ann: Annotation) => {
    const box = getViewBox(ann);
    if (!box || bubbleSize().height === 0) return null;
    const inset = bubbleInset();
    const position = placeBubble({ ...box, y: box.y - inset }, bubbleSize(), bubbleViewport(), 8, bubbleMargin());
    return { ...position, y: position.y + inset };
  };
  // Typing replaces the annotation object but not its geometry; skip re-placing pins then.
  const pinBoxes = createMemo(
    () => annotations().map((a) => getViewBox(a) ?? { x: 0, y: 0, width: 0, height: 0 }),
    undefined,
    { equals: (a, b) => a.length === b.length && a.every((box, i) => (['x', 'y', 'width', 'height'] as const).every((k) => box[k] === b[i][k])) },
  );
  const pinObstacle = createMemo(() => {
    const selected = selectedAnnotation();
    return selected ? bubblePosition(selected) : null;
  }, undefined, { equals: (a, b) => a === b || Boolean(a && b && a.x === b.x && a.y === b.y) });
  const pins = createMemo(() => {
    const position = pinObstacle();
    return placePins(
      pinBoxes(),
      viewportDims(),
      position ? [{ ...position, ...bubbleSize() }] : [],
    );
  });
  const kindLabel = (ann: Annotation) =>
    ann.sourceRange ? `Lines ${ann.sourceRange.startLine}–${ann.sourceRange.endLine}` : ann.selection.kind === 'element' ? ann.selection.elementId.replace(/(-\d+){2}$/, '') : 'Box';
  // An empty note is noise: leaving its bubble without a comment drops it.
  const selectAnnotation = (id: string | null, comment: string) => {
    const previous = selectedAnnotationId();
    if (previous && previous !== id && !annotations().find((a) => a.id === previous)?.comment.trim()) {
      setAnnotations((prev) => prev.filter((a) => a.id !== previous));
    }
    setSelectedAnnotationId(id);
    setActiveComment(comment);
  };
  const closeBubble = () => {
    selectAnnotation(null, '');
    rootRef?.focus();
  };
  const selectAdjacentNote = (direction: -1 | 1) => {
    const notes = annotations();
    const index = notes.findIndex(note => note.id === selectedAnnotationId());
    if (index < 0) return;
    const next = notes[index + direction];
    if (!next) return;
    selectAnnotation(next.id, next.comment);
  };
  const removeAnnotation = (id: string) => {
    const index = annotations().findIndex(note => note.id === id);
    const note = annotations()[index];
    const captureId = frameMeta()?.captureId;
    if (note && captureId) setDeletedNote({ note, index, captureId });
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    if (selectedAnnotationId() === id) {
      setSelectedAnnotationId(null);
      setActiveComment('');
      rootRef?.focus();
    }
  };
  const undoDelete = () => {
    const deleted = deletedNote();
    setDeletedNote(undefined);
    if (!deleted || deleted.captureId !== frameMeta()?.captureId || annotations().some(note => note.id === deleted.note.id)) return;
    setAnnotations(notes => [...notes.slice(0, deleted.index), deleted.note, ...notes.slice(deleted.index)]);
    setSelectedAnnotationId(deleted.note.id);
    setActiveComment(deleted.note.comment);
  };
  // Keep the complete review independently of the subset submitted to the agent.
  createEffect(() => {
    const meta = frameMeta(), source = frameSource(), notes = annotations();
    if (!props.active || !meta || !source) return;
    let current = true;
    const timer = setTimeout(() => {
      window.ipc.saveDesignDraft({ version: 1, id: meta.captureId, ...meta, source, annotations: notes, state: 'editing' }).then(result => {
        if (!current) return;
        if (!result.ok) { setSaveOutcome('error'); setSaveStatus('Could not save review'); }
        else if (saveStatus() === 'Could not save review') { setSaveOutcome('normal'); setSaveStatus(null); }
      }).catch(() => {
        if (!current) return;
        setSaveOutcome('error'); setSaveStatus('Could not save review');
      });
    }, 300);
    onCleanup(() => { current = false; clearTimeout(timer); });
  });

  const buildDraft = (meta: { captureId: string; captureSha256: string }, notes = annotations()): DesignDraft => {
    const key = JSON.stringify(notes);
    if (draftKey !== key) draftId = undefined;
    draftKey = key;
    draftId ??= `draft-${Date.now().toString(16).slice(-8)}${Math.random().toString(16).slice(2, 6)}`;
    return {
    version: 1,
    id: draftId,
    captureId: meta.captureId,
    captureSha256: meta.captureSha256,
    source: frameSource() || {
      kind: 'web',
      url: window.location.href,
      title: document.title || 'Web View',
    },
    annotations: notes.map((a) => ({
      id: a.id,
      selection: a.selection,
      comment: a.comment,
      ...(a.sourceRange ? { sourceRange: a.sourceRange } : {}),
    })),
    state: 'editing',
    };
  };
  const send = async (notes = pendingNotes()) => {
    const meta = frameMeta();
    const source = frameSource();
    const reviewNotes = annotations();
    const request = frameRequest;
    const isCurrentReview = () => props.active && request === frameRequest && frameMeta()?.captureId === meta?.captureId;
    notes = notes.filter(note => note.comment.trim());
    if (notes.length === 0 || isSaving() || !meta) return;
    setIsSaving(true);
    try {
      if (frameSource()?.kind === 'terminal' && !recipient()) {
        try {
          const clients = await window.ipc.listReviewRecipients();
          if (!isCurrentReview()) return;
          const preferred = clients.find(client => client.preferred);
          if (preferred && await window.ipc.selectReviewRecipient(preferred.id)) {
            if (!isCurrentReview()) return;
            setRecipient(preferred.id);
          } else {
            if (!isCurrentReview()) return;
            recipientNotes = notes;
            setRecipients(clients);
            setSaveStatus(clients.length ? '' : 'Open an agent chat, then retry.');
            return;
          }
        } catch {
          if (!isCurrentReview()) return;
          setSaveStatus('Could not find an agent chat. Try again.');
          return;
        }
      }
      if (!isCurrentReview()) return;
      const payload = { ...buildDraft(meta, notes), ...(source ? { source } : {}) };
      const submitted = Object.fromEntries(notes.map((note) => [note.id, [annotationRevision(note)]]));
      setSendingNoteIds(notes.map(note => note.id));
      setSaveOutcome('normal');
      setSaveStatus('Sending…');
      const saved = await window.ipc.saveDesignDraft({ ...payload, id: meta.captureId, annotations: reviewNotes });
      if (!isCurrentReview()) return;
      if (!saved.ok) throw new Error(saved.error || 'Could not save full review');
      const res = await window.ipc.sendDesignFeedback(payload);
      if (!isCurrentReview() || draftId !== payload.id) return;
      if (res.ok) {
        // Keep every acknowledged revision: reverting a note to earlier sent text stays sent.
        setSentNotes((previous) => {
          const merged = { ...previous };
          for (const [noteId, acknowledged] of Object.entries(submitted)) {
            merged[noteId] = [...new Set([...(merged[noteId] ?? []), ...acknowledged])];
          }
          return merged;
        });
        setSaveStatus('Accepted');
      }
      else if (res.noConnectedAgent) {
        setSaveOutcome('warning');
        setSaveStatus('No agent found. Notes copied to the clipboard.');
      } else {
        setSaveOutcome('error');
        setSaveStatus(`Could not send: ${res.error || 'unknown error'}`);
      }
    } catch (err: any) {
      if (!isCurrentReview()) return;
      setSaveOutcome('error');
      setSaveStatus(`Could not send: ${err?.message || 'unknown error'}`);
    } finally {
      setSendingNoteIds([]);
      setIsSaving(false);
    }
  };

  const chooseRecipient = async (id: string) => {
    if (isSaving()) return;
    const notes = recipientNotes;
    const request = frameRequest;
    const isCurrentChoice = () => props.active && request === frameRequest && recipientNotes === notes && !!notes;
    setIsSaving(true);
    let selected = false;
    try {
      const connected = await window.ipc.selectReviewRecipient(id);
      if (!isCurrentChoice()) return;
      if (!connected) throw new Error('Chat disconnected. Try sending again.');
      setRecipient(id);
      setRecipients([]);
      setSaveStatus('');
      selected = true;
    } catch (error) {
      if (!isCurrentChoice()) return;
      setRecipients([]);
      setSaveStatus(error instanceof Error ? error.message : 'Could not connect to chat');
    } finally {
      setIsSaving(false);
    }
    if (selected && isCurrentChoice()) {
      recipientNotes = undefined;
      await send(notes);
    }
  };

  return (
    <Show when={props.active}>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Visual review"
        class="design-review fixed inset-0 z-50 select-none text-[var(--ui-text)] focus:outline-none overflow-hidden"
        classList={{ "design-review-terminal": frameSource()?.kind === "terminal" || !frameDataUrl() }}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onWheel={(e) => e.stopPropagation()}
      >
        {/* Full-bleed viewport */}
        <div
          ref={viewportRef}
          class={`absolute inset-0 w-full h-full ${
            'cursor-crosshair'
          }`}
          style={{ "touch-action": "none" }}
          onPointerDown={handleMouseDown}
          onPointerMove={handleMouseMove}
          onPointerUp={handleMouseUp}
          onPointerCancel={cancelSelection}
          onLostPointerCapture={cancelSelection}
          onPointerLeave={handleMouseLeave}
        >
          {/* Frozen frame */}
          <Show when={frameDataUrl() ? frameMeta()?.captureId : undefined} keyed>
            {(captureId) => (
              <img
                src={frameDataUrl() ?? undefined}
                alt="Frozen frame"
                onLoad={() => {
                  // Image load precedes layout/paint; reveal only after the
                  // complete review has had a rendering opportunity.
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (props.active && frameMeta()?.captureId === captureId) window.ipc.designFrameReady(captureId);
                  }));
                }}
                class="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
              />
            )}
          </Show>

          {/* Persistent Annotated Highlights */}
          <For each={annotations()}>
            {(ann, idx) => {
              const box = () => getViewBox(ann) ?? { x: 0, y: 0, width: 0, height: 0 };
              const isSelected = () => selectedAnnotationId() === ann.id;
              return (
                <div
                  class={`absolute rounded-sm pointer-events-none ${
                    isSelected()
                      ? 'border-2 border-[var(--ui-accent)] bg-[var(--ui-accent)]/5'
                      : 'border border-[var(--ui-accent)] bg-[var(--ui-accent)]/5'
                  }`}
                  style={{
                    display: getViewBox(ann) ? undefined : 'none',
                    left: `${box().x}px`,
                    top: `${box().y}px`,
                    width: `${box().width}px`,
                    height: `${box().height}px`,
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Note ${idx() + 1}`}
                    aria-expanded={isSelected()}
                    title={ann.comment || `Note ${idx() + 1}`}
                    style={{
                      top: `${(pins()[idx()]?.y ?? box().y) - box().y - 1}px`,
                      left: `${(pins()[idx()]?.x ?? box().x) - box().x - 1}px`,
                      width: `${PIN_WIDTH}px`,
                      height: `${PIN_HEIGHT}px`,
                      'box-sizing': 'border-box',
                    }}
                    class={`absolute max-w-[200px] truncate px-1.5 rounded-full text-[10px] font-medium pointer-events-auto cursor-pointer ${
                      isSelected()
                        ? 'bg-[var(--ui-accent)] text-[var(--ui-bg)]'
                        : 'bg-[var(--ui-surface)] text-[var(--ui-accent)] border border-[var(--ui-accent)]'
                    }`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      selectAnnotation(ann.id, ann.comment);
                    }}
                  >
                    {`#${idx() + 1}`}
                  </button>
                </div>
              );
            }}
          </For>

          {/* Hovered Element Highlight */}
          <Show when={!isDragging() && hoveredElement()}>
            {(el) => {
              return (
                <div
                  class="absolute border-2 border-[var(--accent)] bg-[var(--accent)]/15 pointer-events-none rounded-sm"
                  style={{
                    left: `${el().bounds.x}px`,
                    top: `${el().bounds.y}px`,
                    width: `${el().bounds.width}px`,
                    height: `${el().bounds.height}px`,
                  }}
                >
                  {/* An annotated element already shows its pin here. */}
                  <Show
                    when={
                      !annotations().some(
                        (n) => n.selection.kind === 'element' && n.selection.elementId === el().elementId,
                      )
                    }
                  >
                    <span class="absolute -top-4 left-0 px-1 py-0.2 rounded-lg text-[10px] font-medium bg-[var(--accent)] text-[var(--ui-bg)] whitespace-nowrap overflow-hidden max-w-[200px] text-ellipsis">
                      {el().selector}
                    </span>
                  </Show>
                </div>
              );
            }}
          </Show>

          {/* Active Drag Marquee */}
          <Show when={isDragging() && currentDragRect()}>
            {(rect) => (
              <div
                class="absolute border-2 border-[var(--ui-accent)] bg-[var(--ui-accent)]/15 pointer-events-none rounded-sm"
                style={{
                  left: `${rect().x}px`,
                  top: `${rect().y}px`,
                  width: `${rect().width}px`,
                  height: `${rect().height}px`,
                }}
              />
            )}
          </Show>
        </div>

        {/* Top bar: tool, save, send */}
        <div
          ref={observeBar}
          class="absolute z-[41] flex flex-col items-center gap-1 select-none w-max max-w-[calc(100%-16px)] max-h-[calc(100%-16px)]"
          style={{
            left: `${Math.max(8, Math.min((viewportDims().width - barSize().width) / 2 + barOffset().x, viewportDims().width - barSize().width - 8))}px`,
            top: `${compact() ? 8 : Math.max(8, Math.min(12 + barOffset().y, viewportDims().height - barSize().height - 8))}px`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
        >
          <div class="design-review-toolbar relative flex shrink-0 max-w-full items-center gap-1 p-1 rounded-full border text-xs">
            <div
              class="design-review-grip absolute right-full top-0 bottom-0 flex items-center px-2 cursor-grab select-none"
              title="Drag to move"
              aria-label="Move controls"
              onMouseDown={startBarDrag}
            >
              ⠿
            </div>
            <Show when={pendingNotes().length > 0 && (pendingNotes().length > 1 || !selectedAnnotation() || pendingNotes()[0].id !== selectedAnnotationId())}>
            <button
              class="design-review-send px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition-colors [@media(max-width:200px)]:px-1.5 [@media(max-height:127px)]:py-0.5"
              disabled={pendingNotes().length === 0 || isSaving()}
              title="Send all unsent notes"
              onClick={() => send()}
            >
              {isSaving() ? 'Sending…' : `Send all (${pendingNotes().length})`}
            </button>
            </Show>
            <button
              class="px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition-colors [@media(max-width:200px)]:px-1.5 [@media(max-height:127px)]:py-0.5"
              title="Return to app (Escape)"
              aria-label="Return to app"
              onClick={() => props.onExit()}
            >
              Return
            </button>
          </div>
          <div class="flex min-h-0 max-w-full flex-col items-center gap-1 overflow-y-auto overscroll-contain">
            <Show when={recipients().length > 0 && !recipient()}>
              <div role="group" aria-label="Send feedback to" class="flex flex-col gap-1 p-2 rounded-lg border bg-[var(--ui-bg)] text-[var(--ui-text)] text-xs w-full break-words">
                <span>Choose a chat</span>
                <For each={recipients()}>{client => (
                  <button type="button" disabled={isSaving()} class="text-left px-2 py-1 rounded hover:opacity-80 disabled:opacity-50" onClick={() => chooseRecipient(client.id)}>{client.label}</button>
                )}</For>
                <button type="button" onClick={() => { recipientNotes = undefined; setRecipients([]); setSaveStatus(''); }}>Cancel</button>
              </div>
            </Show>
            <Show when={deletedNote()}>
              <div role="status" class="flex flex-wrap justify-center items-center gap-2 max-w-full px-3 py-1 bg-[var(--ui-surface)] border border-[var(--ui-line-strong)] rounded-lg text-xs text-[var(--ui-text)]">
                Note deleted<button class="underline underline-offset-2" onClick={undoDelete}>Undo</button>
              </div>
            </Show>
            <Show
              when={saveStatus()}
              fallback={
                <Show when={annotations().length === 0}>
                  <div class="flex flex-col items-center gap-1 max-w-full break-words px-3 py-2 rounded-xl border border-[var(--ui-line)] bg-[var(--ui-surface)] text-center text-xs text-[var(--ui-text)] [@media(max-height:127px)]:p-1">
                    <textarea
                      ref={(el) => queueMicrotask(() => el.focus())}
                      rows={2}
                      spellcheck={false}
                      aria-label="Ask the agent about this page"
                      class="awrit-feedback-input w-72 max-w-full shrink-0 box-border px-3 py-2 text-xs bg-[var(--ui-bg)] border border-[var(--ui-line-strong)] rounded-lg text-[var(--ui-text)] focus:outline-none focus:border-[var(--ui-accent)] resize-none [@media(max-height:127px)]:h-8 [@media(max-height:127px)]:px-2 [@media(max-height:127px)]:py-1"
                      placeholder="Ask about this page…"
                      onKeyDown={(e) => {
                        if (e.isComposing || e.keyCode === 229) return;
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          e.stopPropagation();
                          askAboutFrame(e.currentTarget.value);
                        } else if (e.key.startsWith('Arrow')) {
                          e.stopPropagation();
                        }
                      }}
                    />
                    <span class="text-[11px] text-[var(--ui-muted)] [@media(max-height:127px)]:hidden">↵ Send · ⇧↵ New line</span>
                    <span class="[@media(max-height:127px)]:hidden">{isAdb() || frameSource()?.kind === 'terminal' ? 'Drag to add a note' : 'Click or drag to add a note'}</span>
                    <Show when={!isAdb() && frameSource()?.kind !== 'terminal'}>
                      <span class="text-[11px] text-[var(--ui-muted)]">↑ ↓ adjust element · Shift+click adds to note</span>
                    </Show>
                  </div>
                </Show>
              }
            >
              <div
                role="status"
                aria-live="polite"
                class={`max-w-full break-words px-2 py-0.5 rounded-xl text-[11px] border border-[var(--ui-line-strong)] bg-[var(--ui-surface)]/95 ${
                  saveOutcome() === 'warning'
                    ? 'text-[var(--ui-warn)]'
                    : saveOutcome() === 'error'
                      ? 'text-[var(--ui-danger)]'
                      : 'text-[var(--ui-muted)]'
                }`}
              >
                {saveStatus()}
              </div>
            </Show>
          </div>
        </div>

        {/* Note bubble next to the selected annotation */}
        <Show when={selectedAnnotation()}>
          {(ann) => {
            const pos = () => bubblePosition(ann());
            return (
              <Show when={pos()}>
                {(p) => (
                  <div
                    class="design-review-comment absolute z-40 rounded-xl border border-[var(--ui-line)] bg-[var(--ui-surface)] flex flex-col gap-1.5 p-2.5 box-border overflow-y-auto overscroll-contain [@media(max-height:199px)]:p-1"
                    style={{
                      left: `${p().x}px`,
                      top: `${p().y}px`,
                      width: `${bubbleSize().width}px`,
                      height: `${bubbleSize().height}px`,
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerMove={(e) => e.stopPropagation()}
                    onWheel={(e) => {
                      if (!(e.target instanceof HTMLTextAreaElement) || e.deltaY === 0 || e.ctrlKey) return;
                      const editor = e.target;
                      const atEdge = e.deltaY < 0 ? editor.scrollTop <= 0
                        : editor.scrollTop >= editor.scrollHeight - editor.clientHeight - 1;
                      if (!atEdge || e.currentTarget.scrollHeight <= e.currentTarget.clientHeight) return;
                      // Chromium can keep wheel scrolling latched to the editor at its edge.
                      e.preventDefault();
                      const step = e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.currentTarget.clientHeight
                        : e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
                      e.currentTarget.scrollTop += e.deltaY * step;
                    }}
                  >
                    <div class="design-review-note-header flex shrink-0 items-center gap-1 text-[11px] text-[var(--ui-muted)]">
                      <span class="mr-auto truncate">
                        #{annotations().findIndex((a) => a.id === ann().id) + 1} {kindLabel(ann())}
                      </span>
                      <Show when={annotations().length > 1}>
                        <nav aria-label="Review notes" class="flex items-center gap-0.5">
                          <button
                            class="min-w-7 min-h-7 inline-flex items-center justify-center rounded disabled:opacity-40"
                            title="Previous note"
                            aria-label="Previous note"
                            disabled={annotations()[0]?.id === ann().id}
                            onClick={() => selectAdjacentNote(-1)}
                          >
                            <Icon name="chevron-left" class="w-3.5 h-3.5" />
                          </button>
                          <span class="tabular-nums">
                            {annotations().findIndex((note) => note.id === ann().id) + 1}/{annotations().length}
                          </span>
                          <button
                            class="min-w-7 min-h-7 inline-flex items-center justify-center rounded disabled:opacity-40"
                            title="Next note"
                            aria-label="Next note"
                            disabled={annotations().at(-1)?.id === ann().id}
                            onClick={() => selectAdjacentNote(1)}
                          >
                            <Icon name="chevron-right" class="w-3.5 h-3.5" />
                          </button>
                        </nav>
                      </Show>
                      <button
                        class="min-w-7 min-h-7 inline-flex items-center justify-center rounded hover:text-[var(--ui-danger)]"
                        title="Delete note"
                        aria-label="Delete note"
                        onClick={() => removeAnnotation(ann().id)}
                      >
                        <Icon name="trash" class="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <textarea
                      ref={(el) => queueMicrotask(() => el.focus())}
                      aria-label="Feedback"
                      class="awrit-feedback-input w-full flex-1 min-h-9 box-border px-2 py-1.5 text-xs bg-[var(--ui-bg)] border border-[var(--ui-line-strong)] rounded-lg text-[var(--ui-text)] focus:outline-none focus:border-[var(--ui-accent)] resize-none"
                      placeholder="What should change?"
                      value={activeComment()}
                      onInput={(e) => {
                        const val = e.currentTarget.value;
                        setActiveComment(val);
                        const id = ann().id;
                        setAnnotations((prev) =>
                          prev.map((a) => (a.id === id ? { ...a, comment: val } : a)),
                        );
                      }}
                      onKeyDown={(e) => {
                        if (e.isComposing || e.keyCode === 229) return;
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!wasSent(ann())) void send([ann()]);
                        }
                      }}
                    />
                    <div class="design-review-note-actions flex shrink-0 items-center justify-between gap-2 text-[10px] text-[var(--ui-muted)]">
                      <span title="Enter sends · Shift+Enter adds a new line">↵ Send · ⇧↵ New line</span>
                      <button
                      class="design-review-note-send shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full disabled:opacity-50"
                      disabled={isSaving() || wasSent(ann()) || !ann().comment.trim()}
                      onClick={() => send([ann()])}
                      aria-label={wasSent(ann()) ? 'Note sent' : sendingNoteIds().includes(ann().id) ? 'Sending note' : 'Send note'}
                      title={wasSent(ann()) ? 'Sent' : ann().comment.trim() ? 'Send this note' : 'Write a note first'}
                    >
                      <Show when={!sendingNoteIds().includes(ann().id)} fallback={<span aria-hidden="true">…</span>}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          {wasSent(ann()) ? <path d="m5 12 4 4L19 6" /> : <path d="M12 19V5m-6 6 6-6 6 6" />}
                        </svg>
                      </Show>
                    </button>
                    </div>
                  </div>
                )}
              </Show>
            );
          }}
        </Show>
      </div>
    </Show>
  );
}
