import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { annotationRevision } from './sentRevisions';

test('Send all clears pending revisions only after delivery acknowledgement', async () => {
  const source = readFileSync(
    new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('  const send = async (notes = pendingNotes()) => {');
  const end = source.indexOf('\n  };', start) + 5;
  const code = new Bun.Transpiler({ loader: 'tsx' }).transformSync(source.slice(start, end));
  const note = {
    id: 'note-1',
    comment: 'Keep this note',
    selection: { kind: 'region', bounds: { x: 0, y: 0, width: 10, height: 10 } },
  };
  let sent: Record<string, string[]> = {};
  let saving = false;
  let accepted = false;
  const sendingStates: string[][] = [];
  const pendingNotes = () => (sent[note.id]?.includes(annotationRevision(note)) ? [] : [note]);
  const payload = { id: 'capture-1', annotations: [note] };
  const send = new Function(
    'pendingNotes',
    'frameMeta',
    'isSaving',
    'buildDraft',
    'annotationRevision',
    'setIsSaving',
    'setSaveOutcome',
    'setSaveStatus',
    'window',
    'annotations',
    'draftId',
    'setSentNotes',
    'setSendingNoteIds',
    `const props = { active: true }; const frameRequest = 0; const frameSource = () => ({ kind: 'web' }); ${code}; return send;`,
  )(
    pendingNotes,
    (() => { const meta = { captureId: payload.id }; return () => meta; })(),
    () => saving,
    () => payload,
    annotationRevision,
    (value: boolean) => {
      saving = value;
    },
    () => {},
    () => {},
    {
      ipc: {
        saveDesignDraft: async () => ({ ok: true }),
        sendDesignFeedback: async () => ({ ok: accepted }),
      },
    },
    () => [note],
    payload.id,
    (update: (previous: typeof sent) => typeof sent) => {
      sent = update(sent);
    },
    (ids: string[]) => sendingStates.push(ids),
  );
  await send();
  expect(sendingStates).toEqual([[note.id], []]);
  expect(pendingNotes()).toHaveLength(1);
  accepted = true;
  await send();
  expect(pendingNotes()).toHaveLength(0);
  expect(note.comment).toBe('Keep this note');
  note.comment = 'Edited after sending';
  expect(pendingNotes()).toHaveLength(1);
});


test('Send all locks during recipient lookup and reports preparation errors', async () => {
  const source = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const send = async (notes = pendingNotes()) => {');
  const end = source.indexOf('\n  };', start) + 5;
  const code = new Bun.Transpiler({ loader: 'tsx' }).transformSync(source.slice(start, end));
  let saving = false;
  let lookups = 0;
  let deliveries = 0;
  let selected = '';
  let outcome = '';
  let status = '';
  let failPreparation = false;
  const meta = { captureId: 'capture-1' };
  const props = { active: true };
  let cancelLookup = false;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const note = { id: 'note-1', comment: 'Fix this' };
  const bindings = {
    pendingNotes: () => [note], frameMeta: () => meta, props, frameRequest: 0,
    isSaving: () => saving, setIsSaving: (value: boolean) => { saving = value; },
    frameSource: () => ({ kind: 'terminal' }), recipient: () => selected,
    setRecipient: (id: string) => { selected = id; },
    setRecipients: () => {}, setSaveOutcome: (value: string) => { outcome = value; },
    setSaveStatus: (value: string) => { status = value; },
    buildDraft: () => {
      if (failPreparation) throw new Error('Preparation failed');
      return { id: 'capture-1' };
    },
    annotationRevision: () => 'revision', setSendingNoteIds: () => {},
    annotations: () => [note], draftId: 'capture-1', setSentNotes: () => {},
    window: { ipc: {
      listReviewRecipients: async () => { lookups++; await ready; if (cancelLookup) props.active = false; return [{ id: 'agent', preferred: true }]; },
      selectReviewRecipient: async () => true,
      saveDesignDraft: async () => ({ ok: true }),
      sendDesignFeedback: async () => { deliveries++; return { ok: true }; },
    } },
  };
  const send = new Function(...Object.keys(bindings), `let recipientNotes; ${code}; return send;`)(...Object.values(bindings));
  const first = send();
  expect(saving).toBe(true);
  await send();
  expect(lookups).toBe(1);
  release();
  await first;
  expect(deliveries).toBe(1);
  expect(saving).toBe(false);
  failPreparation = true;
  await send();
  expect(outcome).toBe('error');
  expect(status).toBe('Could not send: Preparation failed');
  expect(saving).toBe(false);
  expect(deliveries).toBe(1);
  failPreparation = false;
  selected = '';
  cancelLookup = true;
  await send();
  expect(deliveries).toBe(1);
  expect(selected).toBe('');
  expect(saving).toBe(false);
});


test('manual recipient choice ignores duplicate clicks and cancelled selections', async () => {
  const source = readFileSync(new URL('../toolbar/src/DesignModeOverlay.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const chooseRecipient = async');
  const end = source.indexOf('\n  };', start) + 5;
  const code = new Bun.Transpiler({ loader: 'tsx' }).transformSync(source.slice(start, end));
  let saving = false;
  let choices = 0;
  let sends = 0;
  let selected = '';
  let release!: (value: boolean) => void;
  const props = { active: true };
  const notes = [{ id: 'note-1', comment: 'Keep original notes' }];
  const bindings = {
    props, frameRequest: 0, isSaving: () => saving,
    setIsSaving: (value: boolean) => { saving = value; },
    setRecipient: (id: string) => { selected = id; },
    setRecipients: () => {}, setSaveStatus: () => {},
    send: async (submitted: unknown) => { expect(submitted).toBe(notes); sends++; },
    window: { ipc: { selectReviewRecipient: () => { choices++; return new Promise<boolean>(resolve => { release = resolve; }); } } },
  };
  const api = new Function(...Object.keys(bindings), 'notes',
    `let recipientNotes = notes; ${code}; return { chooseRecipient, cancel: () => { recipientNotes = undefined; } };`
  )(...Object.values(bindings), notes);
  const first = api.chooseRecipient('agent-1');
  await api.chooseRecipient('agent-2');
  expect(choices).toBe(1);
  api.cancel();
  release(true);
  await first;
  expect(selected).toBe('');
  expect(sends).toBe(0);
  expect(saving).toBe(false);
  const successful = new Function(...Object.keys(bindings), 'notes',
    `let recipientNotes = notes; ${code}; return chooseRecipient;`
  )(...Object.values(bindings), notes);
  const next = successful('agent-1');
  release(true);
  await next;
  expect(selected).toBe('agent-1');
  expect(sends).toBe(1);
  expect(saving).toBe(false);
});
