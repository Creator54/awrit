import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'bun:test';
import type { WebContents } from 'electron';
import { encodeToolResult } from './encode';
import {
  captureAccessibility,
  focusAccessibilityRef,
  resolveAccessibilityRef,
  type AccessibilityObservation,
} from './accessibility';

class MockDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  responses: Map<string, unknown | ((params?: Record<string, unknown>) => unknown)> = new Map();

  isAttached() {
    return this.attached;
  }

  attach() {
    this.attached = true;
  }

  detach() {
    this.attached = false;
    this.emit('detach', {}, 'target_closed');
  }

  async sendCommand(method: string, params?: Record<string, unknown>) {
    this.commands.push({ method, params });
    if (this.responses.has(method)) {
      const handler = this.responses.get(method);
      if (typeof handler === 'function') {
        return (handler as (p?: Record<string, unknown>) => unknown)(params);
      }
      return handler;
    }
    return {};
  }
}

function createMockWebContents(url = 'https://example.com/page', title = 'Test Page') {
  const debuggerApi = new MockDebugger();
  let destroyed = false;
  let currentUrl = url;
  let currentTitle = title;

  const emitter = new EventEmitter();
  const wc = Object.assign(emitter, {
    debugger: debuggerApi,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      emitter.emit('destroyed');
    },
    getURL: () => currentUrl,
    setURL: (newUrl: string) => {
      currentUrl = newUrl;
    },
    getTitle: () => currentTitle,
    setTitle: (newTitle: string) => {
      currentTitle = newTitle;
    },
  }) as unknown as WebContents & {
    debugger: MockDebugger;
    destroy: () => void;
    setURL: (url: string) => void;
    setTitle: (title: string) => void;
  };

  return { wc, debuggerApi };
}

describe('captureAccessibility', () => {
  it('does not split a Unicode character at the field limit', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', { nodes: [{
      nodeId: 'unicode', role: { value: 'button' }, name: { value: 'x'.repeat(159) + '😀' },
    }] });
    const result = await captureAccessibility(wc);
    if (result.status !== 'captured') throw new Error('Expected captured observation');
    expect(result.nodes[0].name).toBe('x'.repeat(159));
    expect(result.truncated).toBe(true);
  });

  it('keeps dense multilingual observations inside the tool transport budget', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    const ids = Array.from({ length: 200 }, (_, i) => String(i));
    debuggerApi.responses.set('Accessibility.getFullAXTree', { nodes: ids.map(nodeId => ({
      nodeId, backendDOMNodeId: Number(nodeId) + 1, role: { value: 'button' },
      name: { value: '漢'.repeat(40) }, childIds: ids,
    })) });
    const observation = await captureAccessibility(wc);
    expect(observation.status).toBe('captured');
    if (observation.status !== 'captured') throw new Error('Expected captured observation');
    expect(observation.truncated).toBe(true);
    expect(() => encodeToolResult({ result: { dispatched: true }, observation })).not.toThrow();
    const retained = new Set(observation.nodes.map(node => node.id));
    expect(observation.nodes.every(node => node.children?.every(id => retained.has(id)) ?? true)).toBe(true);
  });
  it('exposes typed toggle, busy, multi-selection and orientation states without leaking invalid values', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'Formatting' }, properties: [
        { name: 'pressed', value: { value: 'mixed' } },
        { name: 'busy', value: { value: true } },
        { name: 'multiselectable', value: { value: 'false' } },
        { name: 'orientation', value: { value: 'vertical' } },
      ] }, { nodeId: '2', role: { value: 'button' }, properties: [
        { name: 'pressed', value: { value: 'not-a-state' } },
        { name: 'busy', value: { value: 'yes' } },
        { name: 'orientation', value: { value: 'diagonal' } },
      ] }],
    });
    const result = await captureAccessibility(wc);
    expect(result.status).toBe('captured');
    if (result.status !== 'captured') throw new Error('Expected captured observation');
    expect(result.nodes[0].states).toEqual({ pressed: 'mixed', busy: true, multiselectable: false, orientation: 'vertical' });
    expect(result.nodes[1].states).toBeUndefined();
  });
  it('captures flat accessible nodes with id, refs, states, and hierarchy while omitting ignored nodes', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        {
          nodeId: '1',
          role: { value: 'RootWebArea' },
          name: { value: 'Test Document' },
          backendDOMNodeId: 101,
          childIds: ['2', 'ignored_wrapper'],
        },
        {
          nodeId: 'ignored_wrapper',
          ignored: true,
          childIds: ['3'],
        },
        {
          nodeId: '2',
          role: { value: 'heading' },
          name: { value: 'Heading 1' },
          backendDOMNodeId: 102,
          childIds: [],
        },
        {
          nodeId: '3',
          role: { value: 'button' },
          name: { value: 'Submit' },
          backendDOMNodeId: 103,
          properties: [
            { name: 'disabled', value: { value: 'true' } },
            { name: 'checked', value: { value: 'false' } },
            { name: 'expanded', value: { value: false } },
          ],
        },
      ],
    });

    const res = await captureAccessibility(wc);
    expect(res.status).toBe('captured');
    if (res.status !== 'captured') return;

    expect(res.snapshotId).toMatch(/^w\d+s1$/);
    expect(res.url).toBe('https://example.com/page');
    expect(res.title).toBe('Test Page');
    expect(res.limitation).toBe('Accessibility reflects only semantics exposed by the page; canvas content may require a screenshot.');
    expect(res.nodes.length).toBe(3);

    const root = res.nodes[0];
    expect(root.id).toBe(`${res.snapshotId}:n0`);
    expect(root.ref).toBe(`${res.snapshotId}:e0`);
    expect(root.role).toBe('RootWebArea');
    expect(root.name).toBe('Test Document');

    const heading = res.nodes[1];
    expect(heading.id).toBe(`${res.snapshotId}:n1`);

    const btn = res.nodes[2];
    expect(btn.id).toBe(`${res.snapshotId}:n2`);
    expect(btn.ref).toBe(`${res.snapshotId}:e2`);
    expect(btn.role).toBe('button');
    expect(btn.name).toBe('Submit');
    // Normalized boolean states from strings
    expect(btn.states).toEqual({ disabled: true, checked: false, expanded: false });

    // Child resolution maps to public ids of included unignored nodes
    expect(root.children).toEqual([heading.id, btn.id]);

    // Debugger lease must be released
    expect(debuggerApi.attached).toBe(false);
  });

  it('keeps URLs in accessible names but never exposes passwords or AX values', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        {
          nodeId: '1',
          role: { value: 'link' },
          name: { value: 'Visit https://example.com/help today' },
          backendDOMNodeId: 101,
          value: { value: 'super_secret_password' },
        },
      ],
    });

    const res = await captureAccessibility(wc);
    expect(res.status).toBe('captured');
    if (res.status !== 'captured') return;

    const node = res.nodes[0];
    expect(node.name).toBe('Visit https://example.com/help today');
    // Ensure value field is not exposed in AccessibleNode
    expect('value' in node).toBe(false);
    expect('backendDOMNodeId' in node).toBe(false);
  });

  it('generates globally unique snapshot IDs across different webContents', async () => {
    const { wc: wc1, debuggerApi: d1 } = createMockWebContents();
    const { wc: wc2, debuggerApi: d2 } = createMockWebContents();
    d1.responses.set('Accessibility.getFullAXTree', { nodes: [] });
    d2.responses.set('Accessibility.getFullAXTree', { nodes: [] });

    const res1 = (await captureAccessibility(wc1)) as Extract<AccessibilityObservation, { status: 'captured' }>;
    const res2 = (await captureAccessibility(wc2)) as Extract<AccessibilityObservation, { status: 'captured' }>;

    expect(res1.snapshotId).not.toBe(res2.snapshotId);
  });

  it('flattens unnamed wrappers, text boxes and text that repeats its parent, but keeps focusable wrappers', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['wrap', 'clickable'] },
        { nodeId: 'wrap', role: { value: 'generic' }, childIds: ['link'] },
        { nodeId: 'link', role: { value: 'link' }, name: { value: 'Search' }, childIds: ['label'] },
        { nodeId: 'label', role: { value: 'StaticText' }, name: { value: 'Search' }, childIds: ['box'] },
        { nodeId: 'box', role: { value: 'InlineTextBox' }, name: { value: 'Search' } },
        { nodeId: 'clickable', role: { value: 'generic' }, properties: [{ name: 'focusable', value: { value: true } }] },
      ],
    });

    const res = await captureAccessibility(wc);
    expect(res.status).toBe('captured');
    if (res.status === 'captured') {
      expect(res.nodes.map(node => node.role)).toEqual(['RootWebArea', 'link', 'generic']);
      expect(res.nodes[1].children).toBeUndefined();
    }
  });

  it('query keeps only nodes whose role or name matches, case-insensitively', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Wiki' }, childIds: ['nav', 'box'] },
        { nodeId: 'nav', role: { value: 'navigation' }, childIds: ['home', 'go'] },
        { nodeId: 'home', role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 1 },
        { nodeId: 'go', role: { value: 'button' }, name: { value: 'Search Wikipedia' }, backendDOMNodeId: 2 },
        { nodeId: 'box', role: { value: 'searchbox' }, name: { value: 'Query' }, backendDOMNodeId: 3 },
      ],
    });

    const res = await captureAccessibility(wc, 'search');
    expect(res.status).toBe('captured');
    if (res.status === 'captured') {
      expect(res.nodes.map(node => node.name)).toEqual(['Search Wikipedia', 'Query']);
      expect(res.nodes.every(node => node.ref)).toBe(true);
    }
  });

  it('handles cyclical child references in ignored nodes safely with cycle guard', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['cycleA'] },
        { nodeId: 'cycleA', ignored: true, childIds: ['cycleB'] },
        { nodeId: 'cycleB', ignored: true, childIds: ['cycleA'] },
      ],
    });

    const res = await captureAccessibility(wc);
    expect(res.status).toBe('captured');
    if (res.status === 'captured') {
      expect(res.nodes.length).toBe(1);
      expect(res.nodes[0].children).toBeUndefined();
    }
  });

  it('bounds output count and text length and reports truncated flag', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    const mockNodes = [];
    for (let i = 0; i < 250; i++) {
      mockNodes.push({
        nodeId: `n${i}`,
        role: { value: 'button' },
        name: { value: `Button ${i}` },
        backendDOMNodeId: 200 + i,
      });
    }
    debuggerApi.responses.set('Accessibility.getFullAXTree', { nodes: mockNodes });

    const res = await captureAccessibility(wc);
    expect(res.status).toBe('captured');
    if (res.status !== 'captured') return;

    expect(res.nodes.length).toBe(200);
    expect(res.truncated).toBe(true);
  });

  it('reports truncated when individual field exceeds length limit', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    const longName = 'A'.repeat(250);
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        {
          nodeId: '1',
          role: { value: 'button' },
          name: { value: longName },
          backendDOMNodeId: 10,
        },
      ],
    });

    const res = await captureAccessibility(wc);
    expect(res.status).toBe('captured');
    if (res.status === 'captured') {
      expect(res.truncated).toBe(true);
      expect(res.nodes[0].name.length).toBe(160);
    }
  });

  it('returns unavailable on CDP errors or destroyed webContents without throwing', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.sendCommand = async () => {
      throw new Error('CDP failure');
    };

    const res = await captureAccessibility(wc);
    expect(res.status).toBe('unavailable');
    if (res.status === 'unavailable') {
      expect(res.reason).toContain('CDP failure');
    }

    const { wc: destroyedWc } = createMockWebContents();
    destroyedWc.destroy();
    const resDestroyed = await captureAccessibility(destroyedWc);
    expect(resDestroyed.status).toBe('unavailable');
  });

  it('rejects capture if navigation occurred during async CDP command', async () => {
    const { wc, debuggerApi } = createMockWebContents('https://initial.com');
    debuggerApi.responses.set('Accessibility.getFullAXTree', async () => {
      wc.setURL('https://navigated.com');
      return { nodes: [] };
    });

    const res = await captureAccessibility(wc);
    expect(res.status).toBe('unavailable');
    if (res.status === 'unavailable') {
      expect(res.reason).toContain('Document changed during capture');
    }
  });
});

describe('resolveAccessibilityRef', () => {
  it('resolves element center coordinates via DOM.resolveNode and Runtime.callFunctionOn', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        {
          nodeId: '1',
          role: { value: 'button' },
          name: { value: 'Click me' },
          backendDOMNodeId: 42,
        },
      ],
    });

    const capture = (await captureAccessibility(wc)) as Extract<AccessibilityObservation, { status: 'captured' }>;
    const ref = capture.nodes[0].ref ?? '';
    expect(ref).not.toBe('');

    debuggerApi.responses.set('DOM.resolveNode', (params?: Record<string, unknown>) => {
      expect(params?.backendNodeId).toBe(42);
      return { object: { objectId: 'remote-obj-1' } };
    });

    debuggerApi.responses.set('Runtime.callFunctionOn', (params?: Record<string, unknown>) => {
      expect(params?.objectId).toBe('remote-obj-1');
      return {
        result: {
          value: { ok: true, x: 150, y: 300 },
        },
      };
    });

    let releasedObjectId = '';
    debuggerApi.responses.set('Runtime.releaseObject', (params?: Record<string, unknown>) => {
      releasedObjectId = params?.objectId as string;
      return {};
    });

    const coords = await resolveAccessibilityRef(wc, ref);
    expect(coords).toEqual({ x: 150, y: 300 });
    expect(releasedObjectId).toBe('remote-obj-1');
    expect(debuggerApi.attached).toBe(false);
  });

  it('hit-tests inside the target shadow root and rejects iframe-local coordinates', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', { nodes: [
      { nodeId: '1', role: { value: 'button' }, backendDOMNodeId: 10 },
    ] });
    const snapshot = await captureAccessibility(wc);
    if (snapshot.status !== 'captured') throw new Error('Expected snapshot');
    const ref = snapshot.nodes[0].ref ?? '';
    debuggerApi.responses.set('DOM.resolveNode', { object: { objectId: 'shadow-button' } });
    class Element { contains(other: unknown) { return other === this; } }
    const top = {};
    const window = { innerWidth: 800, innerHeight: 600, top };
    Object.assign(window, { top: window });
    let covered = false;
    let hostCovered = false;
    const host = Object.assign(new Element(), {
      getRootNode: () => ({ elementFromPoint: () => hostCovered ? new Element() : host }),
    });
    const target = Object.assign(new Element(), {
      isConnected: true,
      ownerDocument: { defaultView: window },
      getAttribute: () => null,
      scrollIntoView() {},
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 40, height: 20 }),
      contains: (other: unknown) => other === target,
      getRootNode: () => ({ host, elementFromPoint: () => covered ? new Element() : target }),
    });
    debuggerApi.responses.set('Runtime.callFunctionOn', (params) => {
      const fn = runInNewContext(`(${params?.functionDeclaration})`, {
        Element, window, document: { elementFromPoint: () => new Element() },
      });
      return { result: { value: fn.call(target) } };
    });
    expect(await resolveAccessibilityRef(wc, ref)).toEqual({
      x: 30,
      y: 30,
      label: '',
      rect: { x: 10, y: 20, width: 40, height: 20 },
    });
    covered = true;
    await expect(resolveAccessibilityRef(wc, ref)).rejects.toThrow('covered');
    covered = false;
    hostCovered = true;
    await expect(resolveAccessibilityRef(wc, ref)).rejects.toThrow('covered');
    hostCovered = false;
    target.ownerDocument.defaultView = { ...window, top: window };
    await expect(resolveAccessibilityRef(wc, ref)).rejects.toThrow('frame');
  });

  it('rejects stale refs from an older snapshot', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: '1', role: { value: 'button' }, name: { value: 'First' }, backendDOMNodeId: 10 },
      ],
    });

    const firstCapture = (await captureAccessibility(wc)) as Extract<AccessibilityObservation, { status: 'captured' }>;
    const oldRef = firstCapture.nodes[0].ref ?? '';
    expect(oldRef).not.toBe('');

    // Second capture produces a new snapshot
    await captureAccessibility(wc);

    await expect(resolveAccessibilityRef(wc, oldRef)).rejects.toThrow('Stale accessibility ref');
  });

  it('rejects refs after navigation invalidation', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: '1', role: { value: 'button' }, name: { value: 'Button' }, backendDOMNodeId: 10 },
      ],
    });

    const capture = (await captureAccessibility(wc)) as Extract<AccessibilityObservation, { status: 'captured' }>;
    const ref = capture.nodes[0].ref ?? '';
    expect(ref).not.toBe('');

    // Same-document routing also invalidates refs, even if the final URL is unchanged.
    wc.emit('did-start-navigation', {}, 'https://example.com/page', true, true);

    await expect(resolveAccessibilityRef(wc, ref)).rejects.toThrow('No active accessibility snapshot');
  });

  it('rejects ref if navigation occurs during CDP call', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: '1', role: { value: 'button' }, name: { value: 'Button' }, backendDOMNodeId: 10 },
      ],
    });

    const capture = (await captureAccessibility(wc)) as Extract<AccessibilityObservation, { status: 'captured' }>;
    const ref = capture.nodes[0].ref ?? '';
    expect(ref).not.toBe('');

    debuggerApi.responses.set('DOM.resolveNode', () => {
      wc.setURL('https://example.com/changed-url');
      return { object: { objectId: 'remote-1' } };
    });

    await expect(resolveAccessibilityRef(wc, ref)).rejects.toThrow('invalidated during operation');
  });

  it('rejects disabled elements and releases remote object', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: '1', role: { value: 'button' }, name: { value: 'DisabledBtn' }, backendDOMNodeId: 50 },
      ],
    });

    const capture = (await captureAccessibility(wc)) as Extract<AccessibilityObservation, { status: 'captured' }>;
    const ref = capture.nodes[0].ref ?? '';
    expect(ref).not.toBe('');

    debuggerApi.responses.set('DOM.resolveNode', () => ({ object: { objectId: 'remote-disabled' } }));
    debuggerApi.responses.set('Runtime.callFunctionOn', () => ({
      result: {
        value: { ok: false, error: 'Element is disabled' },
      },
    }));

    let releasedObjectId = '';
    debuggerApi.responses.set('Runtime.releaseObject', (params?: Record<string, unknown>) => {
      releasedObjectId = params?.objectId as string;
      return {};
    });

    await expect(resolveAccessibilityRef(wc, ref)).rejects.toThrow('Element is disabled');
    expect(releasedObjectId).toBe('remote-disabled');
    expect(debuggerApi.attached).toBe(false);
  });
});

describe('focusAccessibilityRef', () => {
  it('focuses and selects input field successfully', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: '1', role: { value: 'textbox' }, name: { value: 'Username' }, backendDOMNodeId: 77 },
      ],
    });

    const capture = (await captureAccessibility(wc)) as Extract<AccessibilityObservation, { status: 'captured' }>;
    const ref = capture.nodes[0].ref ?? '';
    expect(ref).not.toBe('');

    debuggerApi.responses.set('DOM.resolveNode', () => ({ object: { objectId: 'input-obj' } }));
    debuggerApi.responses.set('Runtime.callFunctionOn', () => ({
      result: {
        value: { ok: true },
      },
    }));

    let releasedObjectId = '';
    debuggerApi.responses.set('Runtime.releaseObject', (params?: Record<string, unknown>) => {
      releasedObjectId = params?.objectId as string;
      return {};
    });

    await focusAccessibilityRef(wc, ref);
    expect(releasedObjectId).toBe('input-obj');
    expect(debuggerApi.attached).toBe(false);
  });

  it('confirms focus in the target shadow root rather than the document host', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', { nodes: [
      { nodeId: '1', role: { value: 'textbox' }, backendDOMNodeId: 77 },
    ] });
    const snapshot = await captureAccessibility(wc);
    if (snapshot.status !== 'captured') throw new Error('Expected snapshot');
    debuggerApi.responses.set('DOM.resolveNode', { object: { objectId: 'shadow-input' } });
    class Element {}
    const root: { activeElement?: unknown } = {};
    const window = { top: {} };
    Object.assign(window, { top: window });
    const input = Object.assign(new Element(), {
      isConnected: true, tagName: 'INPUT', type: 'text', ownerDocument: { defaultView: window },
      getAttribute: () => null, scrollIntoView() {}, select() {},
      getBoundingClientRect: () => ({ width: 20, height: 20 }),
      focus() { root.activeElement = input; }, getRootNode: () => root,
    });
    debuggerApi.responses.set('Runtime.callFunctionOn', (params) => ({ result: { value:
      runInNewContext(`(${params?.functionDeclaration})`, { Element, document: { activeElement: {} } }).call(input),
    } }));
    await focusAccessibilityRef(wc, snapshot.nodes[0].ref ?? '');
    expect(root.activeElement).toBe(input);
    input.ownerDocument.defaultView = { top: window };
    await expect(focusAccessibilityRef(wc, snapshot.nodes[0].ref ?? '')).rejects.toThrow('child frames');
  });

  it('rejects focusing non-editable or non-input elements', async () => {
    const { wc, debuggerApi } = createMockWebContents();
    debuggerApi.responses.set('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: '1', role: { value: 'heading' }, name: { value: 'Title' }, backendDOMNodeId: 88 },
      ],
    });

    const capture = (await captureAccessibility(wc)) as Extract<AccessibilityObservation, { status: 'captured' }>;
    const ref = capture.nodes[0].ref ?? '';
    expect(ref).not.toBe('');

    debuggerApi.responses.set('DOM.resolveNode', () => ({ object: { objectId: 'heading-obj' } }));
    debuggerApi.responses.set('Runtime.callFunctionOn', () => ({
      result: {
        value: { ok: false, error: 'Element is not an input or textarea' },
      },
    }));

    await expect(focusAccessibilityRef(wc, ref)).rejects.toThrow('Element is not an input or textarea');
    expect(debuggerApi.attached).toBe(false);
  });
});
