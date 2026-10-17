// Container-transform style transitions between the dashboard and a category view.
// Built on the Web Animations API (no libraries). The category view is temporarily turned into a
// fixed overlay whose clip-path animates between the tapped card's rectangle and the full screen,
// so content is revealed/cropped rather than scaled (no distortion, one cheap animated property).

const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)'; // Material emphasized decelerate
const EASE_STD = 'cubic-bezier(0.4, 0, 0.2, 1)'; // Material standard
const T_TAP = 90;
const T_EXPAND = 380;
const T_COLLAPSE = 300;
const RADIUS = 16;

export const prefersReducedMotion = () =>
  !Element.prototype.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const FULL = 'inset(0px 0px 0px 0px round 0px)';

function insetFor(rect, { top, height: h }) {
  const t = Math.max(0, rect.top - top);
  const r = Math.max(0, innerWidth - rect.right);
  const b = Math.max(0, h - (rect.bottom - top));
  return `inset(${t}px ${r}px ${b}px ${Math.max(0, rect.left)}px round ${RADIUS}px)`;
}

/** Positions the view as a fixed overlay whose content lines up exactly with its normal in-flow position. */
function enterOverlay(view, { appBar, main, banner, scroller }) {
  const top = appBar.getBoundingClientRect().bottom;
  const bottom = scroller.getBoundingClientRect().bottom; // the overlay stops above the bottom tab bar
  const mainRect = main.getBoundingClientRect();
  const cs = getComputedStyle(main);
  const bannerOffset = banner.hidden ? 0 : banner.offsetHeight + parseFloat(getComputedStyle(banner).marginBottom || '0');
  view.style.setProperty('--cv-top', `${top}px`);
  view.style.setProperty('--cv-bottom', `${innerHeight - bottom}px`);
  view.style.setProperty('--cv-pad-top', `${parseFloat(cs.paddingTop) + bannerOffset}px`);
  view.style.setProperty('--cv-pad-l', `${mainRect.left + parseFloat(cs.paddingLeft)}px`);
  view.style.setProperty('--cv-pad-r', `${innerWidth - mainRect.right + parseFloat(cs.paddingRight)}px`);
  view.classList.add('cv-overlay');
  return { top, height: bottom - top };
}

function leaveOverlay(view) {
  view.classList.remove('cv-overlay');
  for (const p of ['--cv-top', '--cv-bottom', '--cv-pad-top', '--cv-pad-l', '--cv-pad-r']) view.style.removeProperty(p);
}

// Waits for the animations, but never longer than a safety timeout (e.g. throttled background WebView),
// so navigation can't get stuck in a "busy" state.
const settled = (anims, limit = 1200) => Promise.race([
  Promise.allSettled(anims.map((a) => a.finished)),
  new Promise((resolve) => setTimeout(resolve, limit)),
]);

/**
 * Dashboard -> category. Expects the category view's content to be rendered already.
 * els: { card, view, dashboard, scroller, appBar, main, banner, icon, title, staggered: [elements...] }
 */
export async function expandCategory(els) {
  const { card, view, dashboard, icon, title, staggered, scroller } = els;
  const cardRect = card.getBoundingClientRect();
  const cardIcon = card.querySelector('.category-icon').getBoundingClientRect();
  const cardName = card.querySelector('.cat-name').getBoundingClientRect();

  const press = card.animate([{ transform: 'scale(1)' }, { transform: 'scale(.95)' }], { duration: T_TAP, easing: 'ease-out', fill: 'forwards' });
  await settled([press]);

  view.hidden = false;
  const geo = enterOverlay(view, els);
  const anims = [press];

  anims.push(view.animate(
    [{ clipPath: insetFor(cardRect, geo), backgroundColor: token('--card') }, { clipPath: FULL, backgroundColor: token('--bg') }],
    { duration: T_EXPAND, easing: EASE_OUT, fill: 'both' }));
  anims.push(dashboard.animate([{ opacity: 1 }, { opacity: 0.4 }], { duration: T_EXPAND * 0.6, easing: EASE_STD, fill: 'forwards' }));

  // Shared elements: the card's icon and name travel to the heading position.
  const iconEnd = icon.getBoundingClientRect();
  const titleEnd = title.getBoundingClientRect();
  anims.push(icon.animate(
    [{ transform: `translate(${cardIcon.left - iconEnd.left}px, ${cardIcon.top - iconEnd.top}px)` }, { transform: 'none' }],
    { duration: T_EXPAND, easing: EASE_OUT, fill: 'backwards' }));
  const s = titleEnd.height ? cardName.height / titleEnd.height : 1;
  anims.push(title.animate(
    [{ transformOrigin: '0 0', transform: `translate(${cardName.left - titleEnd.left}px, ${cardName.top - titleEnd.top}px) scale(${s})` },
      { transformOrigin: '0 0', transform: 'none' }],
    { duration: T_EXPAND, easing: EASE_OUT, fill: 'backwards' }));

  // Everything else slides/fades in progressively.
  staggered.forEach((node, i) => anims.push(node.animate(
    [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }],
    { duration: 240, delay: 140 + i * 50, easing: EASE_OUT, fill: 'backwards' })));

  await settled(anims);

  leaveOverlay(view);
  dashboard.hidden = true;
  anims.forEach((a) => a.cancel());
  scroller.scrollTop = 0;
}

/**
 * Category -> dashboard: the view collapses back into the card it came from.
 * els: { card, view, dashboard, categories, scroller, appBar, main, banner, restoreScroll }
 */
export async function collapseCategory(els) {
  const { card, view, dashboard, categories, restoreScroll, scroller } = els;
  const contentScroll = scroller.scrollTop;
  const geo = enterOverlay(view, els);
  view.scrollTop = contentScroll; // keep the category content where the user left it while it shrinks
  dashboard.hidden = false;
  scroller.scrollTop = restoreScroll; // dashboard comes back exactly as it was; its DOM is never rebuilt
  const cardRect = card.getBoundingClientRect();

  const anims = [
    view.animate(
      [{ clipPath: FULL, opacity: 1, backgroundColor: token('--bg'), offset: 0 },
        { clipPath: insetFor(cardRect, geo), opacity: 1, offset: 0.65 },
        { clipPath: insetFor(cardRect, geo), opacity: 0, backgroundColor: token('--card'), offset: 1 }],
      { duration: T_COLLAPSE, easing: EASE_STD, fill: 'both' }),
    categories.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: T_COLLAPSE, easing: EASE_STD }),
    card.animate([{ transform: 'scale(1)' }, { transform: 'scale(.96)', offset: 0.6 }, { transform: 'scale(1)' }], { duration: T_COLLAPSE, easing: EASE_STD }),
  ];
  for (const child of view.children) anims.push(child.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear', fill: 'forwards' }));

  await settled(anims);

  view.hidden = true;
  leaveOverlay(view);
  anims.forEach((a) => a.cancel());
}
