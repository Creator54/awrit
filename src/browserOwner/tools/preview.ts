import type { WebContents } from 'electron';

const HOST_ID = '__awrit_agent_overlay';
// Presence lease: each tool call renews it. There is no live link between calls, so "attached"
// means "called within the last minute".
const AGENT_LINGER_MS = 60_000;
/** In-page expression for a short human-readable name of `el`; never reads password values. */
export function elementLabelCode(el: string): string {
  return `((${el}.getAttribute('aria-label') || ${el}.innerText || (${el}.type === 'password' ? '' : ${el}.value) || ${el}.placeholder || ${el}.title || '').trim().replace(/\\s+/g, ' ').slice(0, 24))`;
}

const PARK_POINT = { x: 48, y: 48 };

export interface PreviewTarget {
  x: number;
  y: number;
  label: string;
  /** Show a short press pulse after the hold, so a click reads as a press. */
  press?: boolean;
}

export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PreviewArea = PreviewRect | 'viewport';

interface Point {
  x: number;
  y: number;
}

/** Where the cursor sat for each page, so it travels from there instead of jumping. */
const lastPoints = new WeakMap<WebContents, Point>();

/** Harness name for each page's current lease, shown in the cursor chip. */
const leases = new WeakMap<WebContents, { agent: string; until: number; timer?: ReturnType<typeof setTimeout> }>();

const SHADOW_CSS = `
.cursor { position: fixed; left: 0; top: 0; opacity: 1; will-change: transform; }
.cursor > .ripple { animation: awrit-ripple 1.8s ease-out infinite; }
.cursor > svg { animation: awrit-bob 3s ease-in-out infinite alternate; }
@keyframes awrit-bob { from { transform: translateY(0); } to { transform: translateY(2px); } }
.halo { position: fixed; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px;
  border-radius: 50%; pointer-events: none; animation: awrit-halo 2.4s ease-in-out infinite alternate;
  background: radial-gradient(circle, rgba(96, 165, 250, .4), rgba(96, 165, 250, .14) 50%, rgba(96, 165, 250, 0) 70%); }
@keyframes awrit-halo { from { transform: scale(.9); opacity: .7; } to { transform: scale(1.1); opacity: 1; } }
.cursor svg { display: block; transform-origin: top left; }
.cursor.pressed svg { animation: awrit-press .18s ease-out; }
.chip { position: absolute; padding: 3px 8px; border-radius: 6px; background: #111827; color: #f9fafb;
  font: 11px/1.4 -apple-system, system-ui, sans-serif; white-space: nowrap; max-width: 280px;
  overflow: hidden; text-overflow: ellipsis; box-shadow: 0 0 0 1px rgba(96, 165, 250, .5), 0 2px 8px rgba(0, 0, 0, .25); }
.edge { position: fixed; inset: 0; opacity: 0; transition: opacity .8s ease;
  animation: awrit-edge-breathe 2.6s ease-in-out infinite alternate; }
@keyframes awrit-edge-breathe {
  from {
    box-shadow: inset 0 0 0 2px rgba(96, 165, 250, .6), inset 0 0 16px rgba(59, 130, 246, .3), inset 0 0 40px rgba(59, 130, 246, .1);
  }
  to {
    box-shadow: inset 0 0 0 2px rgba(147, 197, 253, .9), inset 0 0 22px rgba(59, 130, 246, .4), inset 0 0 52px rgba(59, 130, 246, .15);
  }
}
/* Device frame: the glow sits mostly inside the screen, so a frame touching the pane edge
   cannot clip it; the outer glow spills into the dark bars where there is room. */
.edge.framed { border-radius: 4px; animation-name: awrit-frame-breathe; }
@keyframes awrit-frame-breathe {
  from {
    box-shadow: inset 0 0 28px 4px rgba(59, 130, 246, .55), inset 0 0 70px rgba(96, 165, 250, .25),
      0 0 28px 6px rgba(59, 130, 246, .45);
  }
  to {
    box-shadow: inset 0 0 40px 8px rgba(59, 130, 246, .7), inset 0 0 100px rgba(96, 165, 250, .35),
      0 0 44px 12px rgba(59, 130, 246, .6);
  }
}
.urlpill { position: fixed; left: 16px; top: 10px; max-width: 70vw; overflow: hidden; text-overflow: ellipsis;
  padding: 5px 12px; border-radius: 999px; background: #111827; color: #f9fafb; white-space: nowrap;
  font: 12px/1.4 -apple-system, system-ui, sans-serif; box-shadow: 0 0 0 2px rgba(37, 99, 235, .6);
  opacity: 0; transform: translateY(-8px); transition: opacity .2s ease, transform .28s cubic-bezier(.2, .9, .3, 1); }
.area { position: fixed; box-sizing: border-box; border: 2px solid rgba(37, 99, 235, .9);
  border-radius: 8px; background: rgba(37, 99, 235, .12); opacity: 1; transition: opacity .35s ease;
  box-shadow: 0 0 30px rgba(59, 130, 246, .6), inset 0 0 22px rgba(59, 130, 246, .25); }
@keyframes awrit-press { 40% { transform: scale(.82); } }
.burst { position: fixed; left: 0; top: 0; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
  border: 2px solid rgba(37, 99, 235, .9); pointer-events: none; animation: awrit-burst .5s ease-out forwards; }
@keyframes awrit-burst { from { transform: scale(.4); opacity: 1; } to { transform: scale(4.5); opacity: 0; } }
.chip.pop { animation: awrit-pop .22s cubic-bezier(.3, 1.6, .5, 1); transform-origin: left top; }
@keyframes awrit-pop { from { transform: scale(.7); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.ripple { position: fixed; left: 0; top: 0; width: 8px; height: 8px; margin: -4px 0 0 -4px;
  border-radius: 50%; border: 1.5px solid rgba(96, 165, 250, .6); opacity: 0; }
.cursor > .ripple:nth-child(3) { animation-delay: .6s; }
.cursor > .ripple:nth-child(4) { animation-delay: 1.2s; }
.area { animation: awrit-breathe 2.4s ease-in-out infinite alternate; }
@keyframes awrit-ripple { 0% { transform: scale(1); opacity: .6; } 100% { transform: scale(5); opacity: 0; } }
@keyframes awrit-breathe {
  from { box-shadow: 0 0 20px rgba(59, 130, 246, .5), 0 0 48px rgba(99, 102, 241, .22), inset 0 0 14px rgba(59, 130, 246, .2); }
  to { box-shadow: 0 0 34px rgba(129, 140, 248, .75), 0 0 72px rgba(99, 102, 241, .35), inset 0 0 24px rgba(59, 130, 246, .32); }
}
@media (prefers-reduced-motion: reduce) {
  .edge { animation: none; box-shadow: inset 0 0 0 2px rgba(37, 99, 235, .3); }
  .edge.framed { box-shadow: inset 0 0 32px 6px rgba(59, 130, 246, .6); }
  .cursor.pressed svg { animation: none; }
  .burst, .chip.pop, .halo { animation: none; }
  .urlpill { transition: opacity .2s ease; transform: none !important; }
  .cursor > svg { animation: none; }
  .cursor > .ripple { animation: none; opacity: 0; }
  .area { animation: none; transition: none; }
}
`;

const ARROW =
  '<svg width="16" height="20" viewBox="0 0 14 19" aria-hidden="true">' +
  '<path d="M1 1v15l4-3.6 2.6 5.4 3.3-1.6-2.6-5.3 5.2-.6z" fill="#111827" stroke="#fff" ' +
  'stroke-width="1.4" stroke-linejoin="round"/></svg>';

/**
 * Builds the shared page-side setup: one host per page with a closed shadow root, outside the
 * body, hidden from assistive technology and pointer hits.
 */
function hostSetup(): string {
  return `
  const id = ${JSON.stringify(HOST_ID)};
  let host = document.getElementById(id);
  if (host && !host.__awritRoot) { host.remove(); host = null; }
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0;' +
      'z-index: 2147483647; pointer-events: none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(SHADOW_CSS)};
    shadow.append(style);
    host.__awritRoot = shadow;
    document.documentElement.append(host);
  }
  const root = host.__awritRoot;`;
}

function cursorCode(target: PreviewTarget, from: Point): string {
  return `(() => {${hostSetup()}
  let cursor = root.getElementById('cursor');
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = 'cursor';
    cursor.className = 'cursor';
    cursor.innerHTML = ${JSON.stringify(
      '<div class="halo"></div>' + '<div class="ripple"></div>'.repeat(3) + ARROW + '<span class="chip"></span>',
    )};
    cursor.querySelector('.chip').style.cssText = 'left:15px;top:14px;';
    root.append(cursor);
  }
  const chip = cursor.querySelector('.chip');
  // Near the right edge the chip flips to the cursor's left so it is not clipped.
  chip.style.cssText = ${Number(target.x)} > window.innerWidth - 300
    ? 'right:6px;left:auto;top:14px;'
    : 'left:15px;top:14px;';
  if (chip.textContent !== ${JSON.stringify(target.label)}) {
    chip.textContent = ${JSON.stringify(target.label)};
    chip.classList.remove('pop');
    void chip.offsetWidth;
    chip.classList.add('pop');
  }
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  cursor.style.transition = 'none';
  cursor.style.transform = 'translate3d(${Number(from.x)}px, ${Number(from.y)}px, 0)';
  cursor.style.opacity = '1';
  void cursor.offsetWidth;
  cursor.style.transition = reduce ? 'none' : 'transform .26s cubic-bezier(.22, 1, .36, 1), opacity .4s ease';
  cursor.style.transform = 'translate3d(${Number(target.x)}px, ${Number(target.y)}px, 0)';
  clearTimeout(host.__awritFade);
  host.__awritFade = setTimeout(() => { cursor.style.opacity = '0'; }, ${AGENT_LINGER_MS + 3000});
})();`;
}

function pressCode(): string {
  return `(() => {${hostSetup()}
  const cursor = root.getElementById('cursor');
  if (!cursor) return;
  cursor.classList.remove('pressed');
  void cursor.offsetWidth;
  cursor.classList.add('pressed');
  const burst = document.createElement('div');
  burst.className = 'burst';
  cursor.append(burst);
  setTimeout(() => burst.remove(), 600);
})();`;
}

function areaCode(area: PreviewArea, label: string, chipAt: Point): string {
  const rect =
    area === 'viewport'
      ? '{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }'
      : JSON.stringify(area);
  return `(() => {${hostSetup()}
  const area = ${rect};
  let block = root.getElementById('area');
  if (!block) {
    block = document.createElement('div');
    block.id = 'area';
    block.className = 'area';
    block.innerHTML = '<span class="chip"></span>';
    root.append(block);
  }
  // The chip sits by the cursor, which stays where the agent last acted.
  block.querySelector('.chip').style.cssText = 'left:' + Math.max(8, Math.min(${chipAt.x} - area.x + 14, area.width - 160)) + 'px;top:' + Math.max(8, Math.min(${chipAt.y} - area.y + 14, area.height - 32)) + 'px;';
  block.querySelector('.chip').textContent = ${JSON.stringify(label)};
  block.querySelector('.chip').style.display = ${JSON.stringify(label ? '' : 'none')};
  block.style.left = area.x + 'px';
  block.style.top = area.y + 'px';
  block.style.width = area.width + 'px';
  block.style.height = area.height + 'px';
  block.style.opacity = '0';
  void block.offsetWidth;
  block.style.opacity = '1';
  clearTimeout(host.__awritAreaFade);
  host.__awritAreaFade = setTimeout(() => { block.style.opacity = '0'; }, 900);
})();`;
}

/**
 * Marks the pane as agent-controlled: the edge glows and breathes until the agent has been
 * quiet for a while. Every tool call refreshes it, so presence means "the agent worked here
 * recently", which is the honest signal - there is no live connection between calls.
 */
export function markAgentActivity(wc: WebContents, agent?: string): void {
  const before = leases.get(wc);
  const takingOver = !before || before.until <= performance.now();
  if (agent) leases.set(wc, { agent, until: 0 });
  const lease = leases.get(wc);
  if (lease) {
    lease.until = performance.now() + AGENT_LINGER_MS;
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => announceDeparture(wc), AGENT_LINGER_MS + 50);
    watchNavigation(wc);
  }
  const point = lastPoints.get(wc) ?? PARK_POINT;
  const label = lease ? (takingOver ? `${lease.agent} took over` : lease.agent) : '';
  try {
    wc.executeJavaScript(`(() => {${hostSetup()}
  let edge = root.getElementById('edge');
  if (!edge) {
    edge = document.createElement('div');
    edge.id = 'edge';
    edge.className = 'edge';
    root.append(edge);
  }
  // A device viewer glows around the phone frame, not the letterbox bars around it.
  const fit = () => {
    const s = document.getElementById('screen');
    const r = s && s.naturalWidth ? s.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height) {
      Object.assign(edge.style, { inset: '', left: '', top: '', width: '', height: '' });
      edge.classList.remove('framed');
      return;
    }
    const ratio = s.naturalWidth / s.naturalHeight;
    const w = Math.min(r.width, r.height * ratio), h = w / ratio;
    Object.assign(edge.style, { inset: 'auto', left: (r.left + (r.width - w) / 2) + 'px',
      top: (r.top + (r.height - h) / 2) + 'px', width: w + 'px', height: h + 'px' });
    edge.classList.add('framed');
  };
  fit();
  if (!host.__awritEdgeFit) { host.__awritEdgeFit = fit; addEventListener('resize', () => host.__awritEdgeFit()); }
  host.__awritEdgeFit = fit;
  edge.style.opacity = '1';
  clearTimeout(host.__awritEdgeFade);
  host.__awritEdgeFade = setTimeout(() => { edge.style.opacity = '0'; }, ${AGENT_LINGER_MS});
})();` + (label ? cursorCode({ ...point, label }, point) : ''), true).catch(() => {
      // The page may be gone; presence is a courtesy.
    });
  } catch {
    // Destroyed or missing WebContents; presence is a courtesy.
  }
}

/** Says the agent left instead of letting the cursor vanish unexplained. */
export function announceDeparture(wc: WebContents): void {
  const lease = leases.get(wc);
  if (!lease || lease.until > performance.now()) return;
  leases.delete(wc);
  try {
    wc.executeJavaScript(`(() => {${hostSetup()}
  const cursor = root.getElementById('cursor');
  if (!cursor) return;
  cursor.querySelector('.chip').textContent = ${JSON.stringify(`${lease.agent} left`)};
  cursor.style.opacity = '1';
  clearTimeout(host.__awritFade);
  host.__awritFade = setTimeout(() => { cursor.style.opacity = '0'; }, 2500);
})();`, true).catch(() => {
      // The page may be gone.
    });
  } catch {
    // Destroyed WebContents.
  }
}

/** Dims the cursor while the agent holds back because the user is using the page. */
export function showUserInControl(wc: WebContents): void {
  const lease = leases.get(wc);
  if (!lease) return;
  try {
    wc.executeJavaScript(`(() => {${hostSetup()}
  const cursor = root.getElementById('cursor');
  if (!cursor) return;
  cursor.querySelector('.chip').textContent = 'you\u2019re in control';
  cursor.style.opacity = '.35';
})();`, true).catch(() => {
      // The page may be gone.
    });
  } catch {
    // Destroyed WebContents.
  }
}

const watched = new WeakSet<WebContents>();

/** A navigation replaces the page and its overlay; redraw it while the lease is live. */
function watchNavigation(wc: WebContents): void {
  if (watched.has(wc)) return;
  watched.add(wc);
  wc.on('did-finish-load', () => {
    const lease = leases.get(wc);
    if (lease && lease.until > performance.now()) markAgentActivity(wc);
  });
}

/**
 * Moves the agent cursor to the point the agent is about to act on and waits, so the user can
 * see (and interrupt) the action. The cursor stays and fades out on its own a couple of seconds
 * after the last use, doubling as an "agent in control" sign. Preview failures never block the
 * action, and the cursor ignores pointer events, so it never changes what the action hits.
 */
export async function showActionPreview(wc: WebContents, target: PreviewTarget, ms: number): Promise<void> {
  markAgentActivity(wc);
  if (ms <= 0) return;
  const from = lastPoints.get(wc) ?? { x: target.x, y: target.y };
  try {
    const agent = leases.get(wc)?.agent;
    const label = agent ? `${agent} · ${target.label}` : target.label;
    await wc.executeJavaScript(cursorCode({ ...target, label }, from), true);
    lastPoints.set(wc, { x: target.x, y: target.y });
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (target.press) await wc.executeJavaScript(pressCode(), true);
  } catch {
    // The page may have navigated or closed; acting without a preview is still correct.
  }
}

export interface ImageBox extends PreviewRect {
  /** Intrinsic frame size, which sets the letterbox inside the box. */
  naturalWidth: number;
  naturalHeight: number;
}

/** Maps a device pixel to the page point where an `object-fit: contain` image shows it. */
export function devicePointOnPage(at: Point, box: ImageBox, device: { width: number; height: number }): Point {
  const ratio = (box.naturalWidth || device.width) / (box.naturalHeight || device.height);
  const width = Math.min(box.width, box.height * ratio);
  const height = width / ratio;
  return {
    x: Math.round(box.x + (box.width - width) / 2 + (at.x / device.width) * width),
    y: Math.round(box.y + (box.height - height) / 2 + (at.y / device.height) * height),
  };
}

/** Agent cursor over a device viewer: `at` is in device pixels, drawn over the `#screen` frame. */
export async function showDevicePreview(
  wc: WebContents,
  at: Point,
  device: { width: number; height: number },
  label: string,
  press: boolean,
  ms = 120,
): Promise<void> {
  const box: ImageBox | null = await wc
    .executeJavaScript(
      `(() => { const i = document.getElementById('screen'); if (!i) return null; const r = i.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight }; })()`,
      true,
    )
    .catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) return;
  await showActionPreview(wc, { ...devicePointOnPage(at, box, device), label, press }, ms);
}

/**
 * Shows the address the agent is about to open, with the cursor travelling to it, and waits
 * briefly so the page change is not a surprise. Drawn in the page overlay, not the toolbar: the
 * address bar is the user's own input and must keep their focus.
 */
export async function showNavigatePreview(wc: WebContents, url: string, ms: number): Promise<void> {
  markAgentActivity(wc);
  if (ms <= 0) return;
  const target = { x: 40, y: 22, label: 'navigate' };
  const from = lastPoints.get(wc) ?? PARK_POINT;
  try {
    const agent = leases.get(wc)?.agent;
    await wc.executeJavaScript(cursorCode({ ...target, label: agent ? `${agent} · navigate` : 'navigate' }, from), true);
    await wc.executeJavaScript(`(() => {${hostSetup()}
  let pill = root.getElementById('urlpill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'urlpill';
    pill.className = 'urlpill';
    root.append(pill);
  }
  pill.textContent = ${JSON.stringify(url)};
  pill.style.opacity = '1';
  pill.style.transform = 'translateY(0)';
  clearTimeout(host.__awritPill);
  host.__awritPill = setTimeout(() => { pill.style.opacity = '0'; pill.style.transform = 'translateY(-8px)'; }, ${ms + 400});
})();`, true);
    lastPoints.set(wc, { x: target.x, y: target.y });
    await new Promise((resolve) => setTimeout(resolve, ms));
  } catch {
    // The page may be gone; loading without a preview is still correct.
  }
}

/**
 * Outlines the region the agent is reading. Fire-and-forget: it never delays the tool, and the
 * block fades out on its own.
 */
export async function showAreaPreview(wc: WebContents, area: PreviewArea, label = ''): Promise<void> {
  markAgentActivity(wc);
  try {
    await wc.executeJavaScript(areaCode(area, label, lastPoints.get(wc) ?? PARK_POINT), true);
  } catch {
    // Showing the region is a courtesy; the tool still runs.
  }
}

/**
 * Runs a capture with the overlay hidden, so images show the page and not the
 * cursor, then shows it again where the agent left it.
 */
export async function withoutAgentPreview<T>(wc: WebContents, capture: () => Promise<T>): Promise<T> {
  await setOverlayVisible(wc, false);
  try {
    return await capture();
  } finally {
    await setOverlayVisible(wc, true);
  }
}

async function setOverlayVisible(wc: WebContents, visible: boolean): Promise<void> {
  const host = `document.getElementById(${JSON.stringify(HOST_ID)})`;
  // Hiding waits two frames so the next capture no longer contains the overlay.
  const code = visible
    ? `${host}?.style.removeProperty('visibility');`
    : `(() => { const h = ${host}; if (!h) return; h.style.visibility = 'hidden';
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`;
  try {
    await wc.executeJavaScript(code, true);
  } catch {
    // The page may be gone; nothing to hide or show.
  }
}
