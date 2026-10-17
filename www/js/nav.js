// Left navigation drawer: slide-in panel + scrim, focus handling, reduced-motion aware.
import { prefersReducedMotion } from './transitions.js';

const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)'; // Material emphasized decelerate
const EASE_IN = 'cubic-bezier(0.3, 0, 0.8, 0.15)'; // emphasized accelerate
const OPEN_MS = 280;
const CLOSE_MS = 220;

const finished = (anims, ms) => Promise.race([
  Promise.allSettled(anims.map((a) => a.finished)),
  new Promise((r) => setTimeout(r, ms + 300)), // never stay "busy" if frames are throttled
]);

/**
 * @param {object} o
 * @param {HTMLElement} o.drawer @param {HTMLElement} o.scrim @param {HTMLElement} o.list  (<ul>)
 * @param {HTMLElement} o.openButton @param {HTMLElement[]} o.background  elements made inert while open
 * @param {Array<{id,label,icon}>} o.items
 * @param {(name:string)=>SVGElement} o.renderIcon
 * @param {(id:string)=>void} o.onSelect  called after the drawer has closed
 * @param {()=>boolean} [o.isBlocked]  e.g. a screen transition is running
 */
export function createDrawer({ drawer, scrim, list, openButton, background, items, renderIcon, onSelect, isBlocked = () => false }) {
  let open = false;
  let busy = false;
  let active = null;
  let returnFocus = null;

  const buttons = new Map();
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drawer-item';
    btn.dataset.id = item.id;
    btn.append(renderIcon(item.icon), Object.assign(document.createElement('span'), { textContent: item.label }));
    const li = document.createElement('li');
    li.append(btn);
    list.append(li);
    buttons.set(item.id, btn);
  }

  function setActive(id) {
    active = id;
    for (const [bid, btn] of buttons) {
      const on = bid === id;
      btn.classList.toggle('active', on);
      if (on) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    }
  }

  async function show() {
    if (open || busy || isBlocked()) return;
    busy = true;
    open = true;
    returnFocus = document.activeElement;
    document.activeElement?.blur?.(); // also hides the on-screen keyboard if search had focus
    scrim.hidden = false;
    drawer.hidden = false;
    openButton.setAttribute('aria-expanded', 'true');
    for (const el of background) el.inert = true;
    if (!prefersReducedMotion()) {
      await finished([
        drawer.animate([{ transform: 'translateX(-100%)' }, { transform: 'none' }], { duration: OPEN_MS, easing: EASE_OUT }),
        scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'linear' }),
      ], OPEN_MS);
    }
    (buttons.get(active) ?? list.querySelector('button'))?.focus({ preventScroll: true });
    busy = false;
  }

  /** @param {{restoreFocus?: boolean}} [opts] */
  async function hide({ restoreFocus = true } = {}) {
    if (!open || busy) return;
    busy = true;
    if (!prefersReducedMotion()) {
      await finished([
        drawer.animate([{ transform: 'none' }, { transform: 'translateX(-100%)' }], { duration: CLOSE_MS, easing: EASE_IN, fill: 'forwards' }),
        scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: 'linear', fill: 'forwards' }),
      ], CLOSE_MS);
    }
    drawer.getAnimations().forEach((a) => a.cancel());
    scrim.getAnimations().forEach((a) => a.cancel());
    drawer.hidden = true;
    scrim.hidden = true;
    for (const el of background) el.inert = false;
    openButton.setAttribute('aria-expanded', 'false');
    open = false;
    busy = false;
    if (restoreFocus) (returnFocus?.isConnected ? returnFocus : openButton)?.focus?.({ preventScroll: true });
  }

  openButton.addEventListener('click', show);
  scrim.addEventListener('click', () => hide());
  drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('.drawer-item');
    if (!btn || busy || !open) return; // ignores repeated taps while the drawer is closing
    await hide({ restoreFocus: false });
    onSelect(btn.dataset.id);
  });

  return { open: show, close: hide, isOpen: () => open, setActive };
}
