import type { WebContents } from 'electron';
import { debuggerManager } from '../debugger';
import { encodeToolResult } from './encode';
import { elementLabelCode } from './preview';

export interface AccessibilityStates {
  selected?: boolean;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  busy?: boolean;
  multiselectable?: boolean;
  orientation?: 'horizontal' | 'vertical';
  expanded?: boolean;
  disabled?: boolean;
  focused?: boolean;
  required?: boolean;
  invalid?: boolean | string;
  readonly?: boolean;
}

export interface AccessibleNode {
  id: string;
  ref?: string;
  role: string;
  name: string;
  description?: string;
  states?: AccessibilityStates;
  children?: string[];
}

export type AccessibilityObservation =
  | {
      status: 'captured';
      url: string;
      title: string;
      observedAt: number;
      snapshotId: string;
      nodes: AccessibleNode[];
      truncated: boolean;
      limitation: string;
    }
  | {
      status: 'unavailable';
      reason: string;
    };

const FIXED_LIMITATION = 'Accessibility reflects only semantics exposed by the page; canvas content may require a screenshot.';
const MAX_NODES = 200;
const MAX_FIELD_CHARS = 160;
const MAX_TOTAL_TEXT = 12000;
const MAX_URL_CHARS = 2000;
const MAX_TITLE_CHARS = 200;

interface SnapshotRefData {
  snapshotId: string;
  frameUrl: string;
  generation: number;
  refToBackendNodeId: Map<string, number>;
}

interface WcState {
  wcPrefix: number;
  monotonicId: number;
  generation: number;
  latestSnapshot?: SnapshotRefData;
}

let nextWcPrefix = 1;
const wcStates = new WeakMap<WebContents, WcState>();
const trackedWebContents = new WeakSet<WebContents>();

function getOrCreateWcState(wc: WebContents): WcState {
  let state = wcStates.get(wc);
  if (!state) {
    state = {
      wcPrefix: nextWcPrefix++,
      monotonicId: 0,
      generation: 0,
    };
    wcStates.set(wc, state);
  }

  if (!trackedWebContents.has(wc)) {
    trackedWebContents.add(wc);

    const onNavStart = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame) {
        const cur = wcStates.get(wc);
        if (cur) {
          cur.generation += 1;
          cur.latestSnapshot = undefined;
        }
      }
    };

    const onDestroyed = () => {
      const cur = wcStates.get(wc);
      if (cur) {
        cur.generation += 1;
        cur.latestSnapshot = undefined;
      }
    };

    wc.on('did-start-navigation', onNavStart);
    wc.once('destroyed', onDestroyed);
  }

  return state;
}

function truncateString(str: string, maxLen: number): { text: string; truncated: boolean } {
  if (str.length <= maxLen) return { text: str, truncated: false };
  let end = maxLen;
  const last = str.charCodeAt(end - 1);
  const next = str.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return { text: str.slice(0, end), truncated: true };
}

function sanitizeField(value: unknown, maxLen = MAX_FIELD_CHARS): { text: string; truncated: boolean } {
  if (typeof value !== 'string') return { text: '', truncated: false };
  const trimmed = value.trim();
  return truncateString(trimmed, maxLen);
}

interface ValidatedAXNode {
  nodeId: string;
  ignored: boolean;
  role?: string;
  name?: string;
  description?: string;
  properties?: Array<{ name: string; value?: unknown }>;
  childIds: string[];
  backendDOMNodeId?: number;
}

function parseAndValidateAXNodes(rawArray: unknown[]): { nodes: ValidatedAXNode[]; truncated: boolean } {
  const result: ValidatedAXNode[] = [];
  const truncated = false;

  for (const raw of rawArray) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    if (typeof item.nodeId !== 'string' || !item.nodeId) continue;
    const nodeId = item.nodeId;
    const ignored = item.ignored === true;

    let role: string | undefined;
    if (item.role && typeof item.role === 'object' && 'value' in item.role && typeof (item.role as { value: unknown }).value === 'string') {
      role = (item.role as { value: string }).value;
    }

    let name: string | undefined;
    if (item.name && typeof item.name === 'object' && 'value' in item.name && typeof (item.name as { value: unknown }).value === 'string') {
      name = (item.name as { value: string }).value;
    }

    let description: string | undefined;
    if (item.description && typeof item.description === 'object' && 'value' in item.description && typeof (item.description as { value: unknown }).value === 'string') {
      description = (item.description as { value: string }).value;
    }

    const properties: Array<{ name: string; value?: unknown }> = [];
    if (Array.isArray(item.properties)) {
      for (const p of item.properties) {
        if (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string') {
          const propObj = p as { name: string; value?: { value?: unknown } };
          properties.push({
            name: propObj.name,
            value: propObj.value && typeof propObj.value === 'object' ? propObj.value.value : undefined,
          });
        }
      }
    }

    const childIds: string[] = [];
    if (Array.isArray(item.childIds)) {
      for (const cid of item.childIds) {
        if (typeof cid === 'string' && cid) childIds.push(cid);
      }
    }

    let backendDOMNodeId: number | undefined;
    if (typeof item.backendDOMNodeId === 'number' && item.backendDOMNodeId > 0) {
      backendDOMNodeId = item.backendDOMNodeId;
    }

    result.push({
      nodeId,
      ignored,
      role,
      name,
      description,
      properties,
      childIds,
      backendDOMNodeId,
    });
  }

  return { nodes: result, truncated };
}

const UNNAMED_WRAPPER_ROLES = new Set(['generic', 'none']);

// Flatten nodes that only repeat or wrap other nodes, like Chromium's ignored nodes, so the
// node budget goes to content: text boxes, unnamed wrappers and text that repeats its parent's name.
function markRedundantIgnored(nodes: ValidatedAXNode[]): void {
  const parentName = new Map<string, string>();
  for (const node of nodes) {
    for (const id of node.childIds) if (node.name) parentName.set(id, node.name.trim());
  }
  for (const node of nodes) {
    if (node.ignored || node.properties?.some(p => p.name === 'focusable' && p.value === true)) continue;
    const name = node.name?.trim() ?? '';
    if (node.role === 'InlineTextBox'
      || (UNNAMED_WRAPPER_ROLES.has(node.role ?? 'generic') && !name && !node.description)
      || (node.role === 'StaticText' && name !== '' && parentName.get(node.nodeId) === name)) {
      node.ignored = true;
    }
  }
}

/** Keeps only nodes whose role or name contains `query`; the rest flatten away as ignored. */
function keepMatching(nodes: ValidatedAXNode[], query: string): void {
  const needle = query.toLowerCase();
  for (const node of nodes) {
    if (!`${node.role ?? ''} ${node.name ?? ''}`.toLowerCase().includes(needle)) node.ignored = true;
  }
}

export async function captureAccessibility(wc: WebContents, query?: string): Promise<AccessibilityObservation> {
  try {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return { status: 'unavailable', reason: 'WebContents is destroyed' };
    }

    const state = getOrCreateWcState(wc);
    const startGeneration = state.generation;
    const startUrl = typeof wc.getURL === 'function' ? wc.getURL() : '';

    const lease = debuggerManager.acquire(wc);
    let treeResponse: unknown;
    try {
      treeResponse = await lease.sendCommand('Accessibility.getFullAXTree', { depth: 12 });
    } finally {
      lease.release();
    }

    // Pin capture generation and frame URL around CDP call
    const currentUrl = typeof wc.getURL === 'function' ? wc.getURL() : '';
    if (state.generation !== startGeneration || currentUrl !== startUrl) {
      return { status: 'unavailable', reason: 'Document changed during capture' };
    }

    if (!treeResponse || typeof treeResponse !== 'object' || !('nodes' in treeResponse) || !Array.isArray((treeResponse as { nodes: unknown }).nodes)) {
      return { status: 'unavailable', reason: 'Invalid accessibility tree response from browser' };
    }

    const rawArray = (treeResponse as { nodes: unknown[] }).nodes;
    const { nodes: validatedNodes, truncated: rawTruncated } = parseAndValidateAXNodes(rawArray);

    state.monotonicId += 1;
    const snapshotId = `w${state.wcPrefix}s${state.monotonicId}`;
    const refToBackendNodeId = new Map<string, number>();

    const rawNodeMap = new Map<string, ValidatedAXNode>();
    for (const raw of validatedNodes) {
      rawNodeMap.set(raw.nodeId, raw);
    }
    markRedundantIgnored(validatedNodes);
    if (query) keepMatching(validatedNodes, query);

    // Identify useful non-ignored nodes with bounded cycle guard
    function findUnignoredChildren(childIds: string[], visited: Set<string>): string[] {
      const result: string[] = [];
      const pending = [...childIds].reverse();
      while (pending.length && result.length <= MAX_NODES) {
        const cid = pending.pop();
        if (!cid || visited.has(cid)) continue;
        visited.add(cid);
        const child = rawNodeMap.get(cid);
        if (!child) continue;
        if (!child.ignored) result.push(cid);
        else for (let i = child.childIds.length - 1; i >= 0; i--) pending.push(child.childIds[i]);
      }
      return result;
    }

    let totalTextChars = 0;
    let truncated = rawTruncated || validatedNodes.some((node) => node.childIds.some((id) => !rawNodeMap.has(id)));
    let refIndex = 0;

    // Filter candidate nodes up to MAX_NODES and text budget
    const rawCandidates: ValidatedAXNode[] = [];
    const nodeIdToPublicId = new Map<string, string>();
    const publicIdToRef = new Map<string, string>();

    for (const raw of validatedNodes) {
      if (raw.ignored) continue;

      if (rawCandidates.length >= MAX_NODES) {
        truncated = true;
        break;
      }

      const roleRes = sanitizeField(raw.role ?? 'generic');
      const nameRes = sanitizeField(raw.name ?? '');
      const descRes = raw.description ? sanitizeField(raw.description) : undefined;

      if (roleRes.truncated || nameRes.truncated || descRes?.truncated) {
        truncated = true;
      }

      const textCost = roleRes.text.length + nameRes.text.length + (descRes ? descRes.text.length : 0);
      if (totalTextChars + textCost > MAX_TOTAL_TEXT) {
        truncated = true;
        break;
      }
      totalTextChars += textCost;

      const publicId = `${snapshotId}:n${rawCandidates.length}`;
      nodeIdToPublicId.set(raw.nodeId, publicId);

      if (raw.backendDOMNodeId) {
        const ref = `${snapshotId}:e${refIndex++}`;
        publicIdToRef.set(publicId, ref);
        refToBackendNodeId.set(ref, raw.backendDOMNodeId);
      }

      rawCandidates.push(raw);
    }

    const outputNodes: AccessibleNode[] = [];

    for (const raw of rawCandidates) {
      const publicId = nodeIdToPublicId.get(raw.nodeId);
      if (!publicId) continue;
      const ref = publicIdToRef.get(publicId);

      const roleRes = sanitizeField(raw.role ?? 'generic');
      const nameRes = sanitizeField(raw.name ?? '');
      const descRes = raw.description ? sanitizeField(raw.description) : undefined;

      const states: AccessibilityStates = {};
      let hasStates = false;

      if (raw.properties) {
        for (const prop of raw.properties) {
          const val = prop.value;

          switch (prop.name) {
            case 'selected':
              if (typeof val === 'boolean' || val === 'true' || val === 'false') {
                states.selected = val === true || val === 'true';
                hasStates = true;
              }
              break;
            case 'checked':
            case 'pressed':
              if (val === 'mixed') {
                states[prop.name] = 'mixed';
                hasStates = true;
              } else if (typeof val === 'boolean' || val === 'true' || val === 'false') {
                states[prop.name] = val === true || val === 'true';
                hasStates = true;
              }
              break;
            case 'busy':
            case 'multiselectable':
              if (typeof val === 'boolean' || val === 'true' || val === 'false') {
                states[prop.name] = val === true || val === 'true';
                hasStates = true;
              }
              break;
            case 'orientation':
              if (val === 'horizontal' || val === 'vertical') {
                states.orientation = val;
                hasStates = true;
              }
              break;
            case 'expanded':
              if (typeof val === 'boolean' || val === 'true' || val === 'false') {
                states.expanded = val === true || val === 'true';
                hasStates = true;
              }
              break;
            case 'disabled':
              if (typeof val === 'boolean' || val === 'true' || val === 'false') {
                states.disabled = val === true || val === 'true';
                hasStates = true;
              }
              break;
            case 'focused':
              if (typeof val === 'boolean' || val === 'true' || val === 'false') {
                states.focused = val === true || val === 'true';
                hasStates = true;
              }
              break;
            case 'required':
              if (typeof val === 'boolean' || val === 'true' || val === 'false') {
                states.required = val === true || val === 'true';
                hasStates = true;
              }
              break;
            case 'invalid':
              if (typeof val === 'boolean' || val === 'true' || val === 'false') {
                states.invalid = val === true || val === 'true';
                hasStates = true;
              } else if (typeof val === 'string') {
                states.invalid = sanitizeField(val).text;
                hasStates = true;
              }
              break;
            case 'readonly':
              if (typeof val === 'boolean' || val === 'true' || val === 'false') {
                states.readonly = val === true || val === 'true';
                hasStates = true;
              }
              break;
          }
        }
      }

      // Map raw child ids to included public ids only
      const unignoredRawChildIds = findUnignoredChildren(raw.childIds, new Set());
      const publicChildren: string[] = [];
      for (const cid of unignoredRawChildIds) {
        const pid = nodeIdToPublicId.get(cid);
        if (pid) {
          publicChildren.push(pid);
        }
      }

      const node: AccessibleNode = {
        id: publicId,
        role: roleRes.text,
        name: nameRes.text,
      };

      if (ref) node.ref = ref;
      if (descRes) node.description = descRes.text;
      if (hasStates) node.states = states;
      if (publicChildren.length > MAX_NODES) truncated = true;
      if (publicChildren.length > 0) node.children = publicChildren.slice(0, MAX_NODES);

      outputNodes.push(node);
    }

    // Bound the actual wire representation, including multibyte text and child/state overhead.
    while (outputNodes.length) {
      try {
        encodeToolResult(outputNodes, 32768);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !['Output byte limit exceeded', 'Input limit exceeded'].includes(error.message)) throw error;
        truncated = true;
        const removed = outputNodes.splice(Math.floor(outputNodes.length / 2));
        for (const node of removed) if (node.ref) refToBackendNodeId.delete(node.ref);
        const retained = new Set(outputNodes.map(node => node.id));
        for (const node of outputNodes) {
          if (!node.children) continue;
          node.children = node.children.filter(id => retained.has(id));
          if (!node.children.length) delete node.children;
        }
      }
    }

    state.latestSnapshot = {
      snapshotId,
      frameUrl: currentUrl,
      generation: state.generation,
      refToBackendNodeId,
    };

    const rawTitle = typeof wc.getTitle === 'function' ? wc.getTitle() : '';
    const titleRes = truncateString(rawTitle, MAX_TITLE_CHARS);
    const urlRes = truncateString(currentUrl, MAX_URL_CHARS);
    if (titleRes.truncated || urlRes.truncated) {
      truncated = true;
    }

    return {
      status: 'captured',
      url: urlRes.text,
      title: titleRes.text,
      observedAt: Date.now(),
      snapshotId,
      nodes: outputNodes,
      truncated,
      limitation: FIXED_LIMITATION,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

interface ValidatedRefState {
  backendNodeId: number;
  snapshotData: SnapshotRefData;
  state: WcState;
  frameUrl: string;
}

function resolveRefToBackendNodeId(wc: WebContents, ref: string): { data?: ValidatedRefState; error?: string } {
  const state = wcStates.get(wc);
  if (!state || !state.latestSnapshot) {
    return { error: 'No active accessibility snapshot' };
  }

  const latest = state.latestSnapshot;
  const currentUrl = typeof wc.getURL === 'function' ? wc.getURL() : '';
  if (latest.generation !== state.generation || latest.frameUrl !== currentUrl) {
    return { error: 'Accessibility snapshot is stale due to navigation' };
  }

  const colonIdx = ref.indexOf(':');
  if (colonIdx === -1) {
    return { error: `Invalid ref format: ${ref}` };
  }
  const refSnapshotId = ref.slice(0, colonIdx);
  if (refSnapshotId !== latest.snapshotId) {
    return { error: `Stale accessibility ref: ${ref} (current snapshot: ${latest.snapshotId})` };
  }

  const backendNodeId = latest.refToBackendNodeId.get(ref);
  if (!backendNodeId) {
    return { error: `Unknown accessibility ref: ${ref}` };
  }

  return { data: { backendNodeId, snapshotData: latest, state, frameUrl: currentUrl } };
}

function verifyRefUnchanged(wc: WebContents, validated: ValidatedRefState): void {
  const currentUrl = typeof wc.getURL === 'function' ? wc.getURL() : '';
  if (
    validated.state.generation !== validated.snapshotData.generation ||
    validated.state.latestSnapshot !== validated.snapshotData ||
    currentUrl !== validated.frameUrl
  ) {
    throw new Error('Accessibility ref invalidated during operation');
  }
}

export interface ResolvedRef {
  x: number;
  y: number;
  rect?: { x: number; y: number; width: number; height: number };
  label?: string;
}

export async function resolveAccessibilityRef(wc: WebContents, ref: string): Promise<ResolvedRef> {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
    throw new Error('WebContents is destroyed');
  }

  const { data: refState, error } = resolveRefToBackendNodeId(wc, ref);
  if (error || !refState) {
    throw new Error(error ?? 'Invalid ref');
  }

  const lease = debuggerManager.acquire(wc);
  let remoteObjectId: string | undefined;

  try {
    const resolved = (await lease.sendCommand('DOM.resolveNode', { backendNodeId: refState.backendNodeId })) as {
      object?: { objectId?: string };
    };

    // Re-verify document and snapshot state after await
    verifyRefUnchanged(wc, refState);

    remoteObjectId = resolved?.object?.objectId;
    if (!remoteObjectId) {
      throw new Error(`Failed to resolve DOM node for ref ${ref}`);
    }

    const evalResult = (await lease.sendCommand('Runtime.callFunctionOn', {
      objectId: remoteObjectId,
      functionDeclaration: `function() {
        if (!this || !(this instanceof Element)) {
          return { ok: false, error: 'Target is not an Element' };
        }
        if (!this.isConnected) {
          return { ok: false, error: 'Element is not connected to document' };
        }
        if (this.disabled || this.getAttribute('aria-disabled') === 'true') {
          return { ok: false, error: 'Element is disabled' };
        }
        this.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = this.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return { ok: false, error: 'Element has zero size or is not visible' };
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
          return { ok: false, error: 'Element is outside viewport after scroll' };
        }
        if (this.ownerDocument.defaultView !== this.ownerDocument.defaultView.top) {
          return { ok: false, error: 'Accessibility ref clicks in child frames are not supported' };
        }
        let target = this;
        while (target) {
          const root = target.getRootNode();
          const hit = root.elementFromPoint(x, y);
          if (!hit || (hit !== target && !target.contains(hit) && !hit.contains(target))) {
            return { ok: false, error: 'Element is covered by another element at target point' };
          }
          target = root.host;
        }
        return { ok: true, x, y, label: ${elementLabelCode('this')}, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
      }`,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: { ok: boolean; error?: string; x?: number; y?: number; rect?: ResolvedRef['rect']; label?: string } };
    };

    // Re-verify document and snapshot state after await
    verifyRefUnchanged(wc, refState);

    const val = evalResult?.result?.value;
    if (!val || !val.ok || typeof val.x !== 'number' || typeof val.y !== 'number') {
      throw new Error(val?.error ?? 'Failed to compute element center');
    }

    return { x: val.x, y: val.y, rect: val.rect, label: val.label };
  } finally {
    if (remoteObjectId) {
      try {
        await lease.sendCommand('Runtime.releaseObject', { objectId: remoteObjectId });
      } catch {
        // Ignore release errors
      }
    }
    lease.release();
  }
}

export async function focusAccessibilityRef(wc: WebContents, ref: string): Promise<void> {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
    throw new Error('WebContents is destroyed');
  }

  const { data: refState, error } = resolveRefToBackendNodeId(wc, ref);
  if (error || !refState) {
    throw new Error(error ?? 'Invalid ref');
  }

  const lease = debuggerManager.acquire(wc);
  let remoteObjectId: string | undefined;

  try {
    const resolved = (await lease.sendCommand('DOM.resolveNode', { backendNodeId: refState.backendNodeId })) as {
      object?: { objectId?: string };
    };

    // Re-verify document and snapshot state after await
    verifyRefUnchanged(wc, refState);

    remoteObjectId = resolved?.object?.objectId;
    if (!remoteObjectId) {
      throw new Error(`Failed to resolve DOM node for ref ${ref}`);
    }

    const evalResult = (await lease.sendCommand('Runtime.callFunctionOn', {
      objectId: remoteObjectId,
      functionDeclaration: `function() {
        if (!this || !(this instanceof Element)) {
          return { ok: false, error: 'Target is not an Element' };
        }
        if (!this.isConnected) {
          return { ok: false, error: 'Element is not connected to document' };
        }
        if (this.ownerDocument.defaultView !== this.ownerDocument.defaultView.top) {
          return { ok: false, error: 'Accessibility ref typing in child frames is not supported' };
        }
        const tag = this.tagName ? this.tagName.toUpperCase() : '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          return { ok: false, error: 'Element is not an input or textarea' };
        }
        const input = this;
        if (tag === 'INPUT') {
          const type = (input.type || 'text').toLowerCase();
          const nonTextTypes = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden']);
          if (nonTextTypes.has(type)) {
            return { ok: false, error: 'Input type "' + type + '" is not editable text' };
          }
        }
        if (input.disabled || input.getAttribute('aria-disabled') === 'true') {
          return { ok: false, error: 'Element is disabled' };
        }
        if (input.readOnly) {
          return { ok: false, error: 'Element is readOnly' };
        }
        this.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = this.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return { ok: false, error: 'Element has zero size or is not visible' };
        }
        input.focus();
        if (input.getRootNode().activeElement !== input) {
          return { ok: false, error: 'Element could not be activated as activeElement' };
        }
        if (typeof input.select === 'function') {
          input.select();
        }
        return { ok: true };
      }`,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: { ok: boolean; error?: string } };
    };

    // Re-verify document and snapshot state after await
    verifyRefUnchanged(wc, refState);

    const val = evalResult?.result?.value;
    if (!val || !val.ok) {
      throw new Error(val?.error ?? 'Failed to focus element');
    }
  } finally {
    if (remoteObjectId) {
      try {
        await lease.sendCommand('Runtime.releaseObject', { objectId: remoteObjectId });
      } catch {
        // Ignore release errors
      }
    }
    lease.release();
  }
}
