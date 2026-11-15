// The toolbar is rendered offscreen, so the browser's native `title` hover
// label has no window to appear in. Draw it in the page instead, for every
// element that has a `title`.
const DELAY_MS = 450;
const GAP = 8;

export function installTooltips(doc: Document = document): void {
  const tip = doc.createElement('div');
  tip.setAttribute('role', 'tooltip');
  tip.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:260px;' +
    'padding:4px 8px;border-radius:6px;background:var(--ui-surface);color:var(--ui-text);font-size:12px;' +
    'line-height:1.3;border:1px solid var(--ui-line-strong);box-shadow:var(--ui-shadow)';
  doc.body.append(tip);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let owner: Element | null = null;

  const hide = () => {
    clearTimeout(timer);
    owner = null;
    tip.style.display = 'none';
  };

  const show = (el: Element) => {
    const text = el.getAttribute('title');
    if (!text) return;
    tip.textContent = text;
    tip.style.display = 'block';
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(GAP, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - GAP));
    const below = r.bottom + GAP;
    const top = below + h > innerHeight - GAP ? Math.max(GAP, r.top - h - GAP) : below;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  doc.addEventListener('mouseover', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[title]') : null;
    if (el === owner) return;
    hide();
    if (!el) return;
    owner = el;
    timer = setTimeout(() => show(el), DELAY_MS);
  });
  for (const type of ['mousedown', 'keydown', 'wheel', 'blur']) {
    doc.addEventListener(type, hide, true);
  }
  doc.addEventListener('mouseleave', hide);
}
