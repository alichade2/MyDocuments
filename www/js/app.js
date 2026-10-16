// UI layer: dashboard card grid + single-page category view. No SQLite access here.
import { createDatabase, capacitorSqliteDriver, isNativePlatform } from './database.js';
import { createDocumentService, capacitorAdapters, DEMO_MESSAGE, IMAGE_TYPES, suggestName, validateName } from './documents.js';
import { createMockService } from './mock.js';
import { createThumbnail } from './images.js';
import { prefersReducedMotion, expandCategory, collapseCategory } from './transitions.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

// 24x24 icon paths (fill-rule evenodd), keyed by categories.icon.
const ICONS = {
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5Z',
  school: 'M12 3 1 9l11 6 9-4.9V17h2V9L12 3Zm-6 10.2v4L12 21l6-3.8v-4L12 16l-6-2.8Z',
  badge: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm5 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-3 8h6v-.5c0-1-2-1.5-3-1.5s-3 .5-3 1.5V16Zm9-6v1.5h6V10h-6Zm0 3v1.5h4V13h-4Z',
  work: 'M10 3h4a2 2 0 0 1 2 2v2h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4V5a2 2 0 0 1 2-2Zm0 2v2h4V5h-4Z',
  wallet: 'M3 6a2 2 0 0 1 2-2h14v3H5v1h16v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm14 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
  health: 'M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3Z',
  shield: 'M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Z',
  home: 'M12 3 2 12h3v8h5v-5h4v5h5v-8h3L12 3Z',
  car: 'M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11a2 2 0 0 1 2 2v5h-2v2h-3v-2H8v2H5v-2H3v-5a2 2 0 0 1 2-2Zm2.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM7.6 7 6.9 9.5h10.2L16.4 7H7.6Z',
  receipt: 'M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2V2Zm3 5v2h8V7H8Zm0 4v2h8v-2H8Z',
  // balance scales
  gavel: 'M11 2h2v2.1l5 .9v1.6l2.9 6.6c0 1.6-1.3 2.8-2.9 2.8s-2.9-1.2-2.9-2.8L17 7l-4-.7V19h4v2H7v-2h4V6.3L7 7l2.9 6.6C9.9 15.2 8.6 16.4 7 16.4s-2.9-1.2-2.9-2.8L7 7V5.1l4-.9V2ZM7 9.6 5.6 13h2.8L7 9.6Zm10 0L15.6 13h2.8L17 9.6Z',
  plane: 'M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5Z',
  folder: 'M4 4h6l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  image: 'M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z',
  chevron: 'M9 5.6 15.4 12 9 18.4 10.4 20l8-8-8-8L9 5.6Z',
};
const FILE_TYPES = {
  pdf: { cls: 't-pdf', label: 'PDF' },
  jpg: { cls: 't-img', icon: 'image' }, jpeg: { cls: 't-img', icon: 'image' }, png: { cls: 't-img', icon: 'image' },
  webp: { cls: 't-img', icon: 'image' }, gif: { cls: 't-img', icon: 'image' },
  doc: { cls: 't-doc', label: 'DOC' }, docx: { cls: 't-doc', label: 'DOC' },
  txt: { cls: 't-txt', label: 'TXT' },
};

let service;
/** categoryId -> { cat, count, countEl, cardEl } (dashboard cards are built once) */
const cards = new Map();
const view = { categoryId: null, docs: new Map(), scrollY: 0 };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v; else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svgIcon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('fill', 'currentColor'); p.setAttribute('fill-rule', 'evenodd');
  p.setAttribute('d', ICONS[name] ?? ICONS.folder);
  svg.append(p);
  return svg;
}

const plural = (n) => `${n} ${n === 1 ? 'document' : 'documents'}`;

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

let toastTimer;
function showMessage(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

async function guarded(fn) {
  try { return await fn(); } catch (err) {
    if (err?.code !== 'DEMO_DOCUMENT') console.error('MyDocs error:', err?.code || err?.name || 'error');
    showMessage(err?.message || String(err));
  }
}

/* ---------- Dashboard ---------- */

function buildCard(cat) {
  const countEl = el('span', { class: 'count' });
  const card = el('button', { class: 'cat-card', type: 'button', 'data-category-id': String(cat.id), id: `cat-${cat.slug}` },
    el('span', { class: 'cat-top' }, el('span', { class: 'category-icon' }, svgIcon(cat.icon)), svgIcon('chevron', 'chevron')),
    el('span', { class: 'cat-name' }, cat.name),
    countEl);
  const entry = { cat, count: 0, countEl, cardEl: card };
  cards.set(cat.id, entry);
  return entry;
}

function updateCardCount(entry, n) {
  entry.count = n;
  entry.countEl.textContent = plural(n);
  entry.cardEl.setAttribute('aria-label', `${entry.cat.name}, ${plural(n)}`);
}

async function buildDashboard() {
  const categories = await service.listCategories();
  const frag = document.createDocumentFragment();
  for (const cat of categories) {
    const entry = cards.get(cat.id) ?? buildCard(cat);
    const docs = await service.list(cat.id);
    view.docs.set(cat.id, docs);
    updateCardCount(entry, docs.length);
    frag.append(entry.cardEl);
  }
  $('categories').replaceChildren(frag);
}

/* ---------- Category view ---------- */

function renderDocCard(doc) {
  const type = FILE_TYPES[doc.fileType] ?? { cls: 't-other', label: (doc.fileType || '?').slice(0, 3) };
  const iconEl = el('span', { class: `card-icon ${type.cls}` });
  if (type.icon) iconEl.append(svgIcon(type.icon)); else iconEl.textContent = type.label;
  let leading = iconEl;
  if (doc.thumbPath) { // photo thumbnail; falls back to the icon if it cannot be loaded
    const img = el('img', { class: 'card-thumb', alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(iconEl), { once: true });
    service.thumbnailSrc(doc).then((src) => { if (src) img.src = src; else img.replaceWith(iconEl); }).catch(() => img.replaceWith(iconEl));
    leading = img;
  }
  const meta = [doc.fileType?.toUpperCase(), formatSize(doc.fileSize), doc.createdAt?.slice(0, 10)].filter(Boolean).join(' · ');
  const main = el('button', { class: 'card-main', type: 'button', 'data-action': 'open', 'aria-label': `${doc.name}${doc.isDemo ? ' (sample)' : ''}` },
    leading,
    el('span', { class: 'card-name' }, doc.name),
    el('span', { class: 'card-meta' }, meta));
  if (doc.isDemo) main.append(el('span', { class: 'badge' }, 'Sample'));
  if (doc.missing) main.append(el('span', { class: 'card-warn' }, 'File missing'));
  return el('article', { class: `card${doc.missing ? ' missing' : ''}`, 'data-doc-id': String(doc.id) }, main,
    el('div', { class: 'card-actions' },
      el('button', { type: 'button', 'data-action': 'rename' }, 'Rename'),
      el('button', { type: 'button', class: 'danger', 'data-action': 'delete' }, 'Delete')));
}

function renderCategoryView() {
  const entry = cards.get(view.categoryId);
  const docs = view.docs.get(view.categoryId) ?? [];
  $('cv-icon').replaceChildren(svgIcon(entry.cat.icon));
  $('cv-title').textContent = entry.cat.name;
  $('cv-count').textContent = plural(docs.length);
  $('cv-docs').replaceChildren(docs.length
    ? el('div', { class: 'grid' }, ...docs.map(renderDocCard))
    : el('div', { class: 'empty' }, `No documents in ${entry.cat.name} yet.`));
  updateCardCount(entry, docs.length);
}

async function reloadCategory(categoryId) {
  view.docs.set(categoryId, await service.list(categoryId));
  if (view.categoryId === categoryId) renderCategoryView(); else updateCardCount(cards.get(categoryId), view.docs.get(categoryId).length);
}

function show(categoryId, { restoreScroll = false } = {}) {
  view.categoryId = categoryId;
  const inCategory = categoryId != null;
  $('dashboard-view').hidden = inCategory;
  $('category-view').hidden = !inCategory;
  if (inCategory) {
    renderCategoryView();
    $('scroller').scrollTop = 0;
    $('cv-back').focus({ preventScroll: true });
  } else if (restoreScroll) {
    $('scroller').scrollTop = view.scrollY;
  }
}

/* Navigation: animated container transform; instant when reduced motion is requested or there is no origin card. */
const motion = { busy: false, queued: null };

async function runTransition(fn) {
  motion.busy = true;
  try { await fn(); } catch (err) { console.error('MyDocs transition error:', err?.name || 'error'); } finally {
    motion.busy = false;
    const next = motion.queued;
    motion.queued = null;
    next?.();
  }
}

const transitionEls = () => ({
  scroller: $('scroller'), view: $('category-view'), dashboard: $('dashboard-view'), categories: $('categories'),
  appBar: document.querySelector('.app-bar'), main: document.querySelector('main'), banner: $('banner'),
  icon: $('cv-icon'), title: $('cv-title'),
  staggered: [$('cv-back'), $('cv-count'), document.querySelector('.cv-actions'), $('cv-docs')],
});

function openCategory(categoryId) {
  if (motion.busy) return; // ignore rapid taps while a transition runs
  if (view.categoryId == null) view.scrollY = $('scroller').scrollTop;
  history.pushState({ categoryId }, '');
  if (prefersReducedMotion()) { show(categoryId); return; }
  const card = cards.get(categoryId).cardEl;
  view.categoryId = categoryId;
  renderCategoryView(); // content comes from state already in memory; nothing is reloaded for the animation
  runTransition(async () => {
    await expandCategory({ ...transitionEls(), card });
    $('cv-back').focus({ preventScroll: true });
  });
}

function leaveCategory() {
  if (motion.busy) { motion.queued = leaveCategory; return; }
  const prev = view.categoryId;
  if (prev == null) return;
  const card = cards.get(prev).cardEl;
  if (prefersReducedMotion()) { show(null, { restoreScroll: true }); card.focus({ preventScroll: true }); return; }
  view.categoryId = null;
  runTransition(async () => {
    await collapseCategory({ ...transitionEls(), card, restoreScroll: view.scrollY });
    card.focus({ preventScroll: true });
  });
}

function goBack() {
  if (history.state?.categoryId != null) history.back(); else leaveCategory();
}

window.addEventListener('popstate', (e) => {
  const id = e.state?.categoryId;
  if (id != null && cards.has(id)) {
    if (motion.busy) motion.queued = () => show(id); else show(id); // history-forward: no origin card, so no animation
  } else leaveCategory();
});

/* ---------- Actions ---------- */

/* Upload: pick file -> ask for a name -> save. Rename reuses the same dialog and validation. */
let nameFlow = null; // { title, saveLabel, fileLabel, initial, onSave(name) }
let saving = false;

function openNameDialog(flow) {
  nameFlow = flow;
  $('nd-title').textContent = flow.title;
  $('nd-save').textContent = flow.saveLabel;
  const f = $('nd-file');
  f.hidden = !flow.fileLabel;
  f.textContent = flow.fileLabel ? `File: ${flow.fileLabel}` : '';
  setNameError('');
  $('nd-input').placeholder = flow.placeholder ?? 'e.g., My Aadhaar Card';
  $('nd-input').value = flow.initial;
  $('name-dialog').showModal();
  $('nd-input').select();
}

/** Closes the name dialog and runs the flow's cleanup (e.g. discarding an unsaved capture). Idempotent. */
function closeNameDialog() {
  if ($('name-dialog').open) $('name-dialog').close();
  const flow = nameFlow;
  nameFlow = null;
  flow?.onClose?.();
}

function setNameError(msg) {
  const e = $('nd-error');
  e.textContent = msg; e.hidden = !msg;
  $('nd-input').setAttribute('aria-invalid', String(Boolean(msg)));
}

function setSaving(on) {
  saving = on;
  $('nd-save').disabled = on; $('nd-cancel').disabled = on; $('nd-input').disabled = on;
  $('nd-save').textContent = on ? 'Saving…' : nameFlow?.saveLabel ?? 'Save';
}

async function submitName(e) {
  e.preventDefault();
  if (saving || !nameFlow) return; // prevents double submission
  let name;
  try { name = validateName($('nd-input').value); } catch (err) {
    setNameError(err.code === 'INVALID_NAME' && !$('nd-input').value.trim() ? 'Please enter a document name.' : err.message);
    $('nd-input').focus();
    return;
  }
  setSaving(true);
  try {
    const message = await nameFlow.onSave(name);
    closeNameDialog();
    showMessage(message);
  } catch (err) {
    console.error('MyDocs error:', err?.code || err?.name || 'error');
    setNameError(err?.message || 'Could not save. Please try again.');
  } finally {
    setSaving(false);
  }
}

const addDoc = () => guarded(async () => {
  if (saving || $('name-dialog').open) return;
  const categoryId = view.categoryId; // captured: the upload belongs to the category it was started from
  const file = await service.pickFile();
  if (!file) return; // user cancelled the picker
  openNameDialog({
    title: 'Name your document', saveLabel: 'Save Document', fileLabel: file.name, initial: suggestName(file.name),
    onSave: async (name) => {
      await service.importFile(categoryId, file, name);
      await reloadCategory(categoryId);
      return `Saved "${name}"`;
    },
  });
});

/* Camera capture: capture -> preview (Retake / Continue / Cancel) -> name -> save. Nothing persists until Save. */
let pending = null; // { categoryId, photo } while a capture is being reviewed

function releasePending() {
  pending = null;
  $('pv-img').removeAttribute('src');
}

function showPreview(categoryId, photo) {
  pending = { categoryId, photo };
  $('pv-img').src = `data:${photo.mimeType};base64,${photo.data}`;
  if (!$('preview-dialog').open) $('preview-dialog').showModal();
}

const captureDoc = () => guarded(async () => {
  if (saving || $('name-dialog').open || $('preview-dialog').open) return;
  const categoryId = view.categoryId;
  const photo = await service.capturePhoto();
  if (photo) showPreview(categoryId, photo); // null = user left the camera; nothing happens
});

const retake = () => guarded(async () => {
  const prev = pending;
  if (!prev) return;
  $('preview-dialog').close(); // the camera is a separate activity
  let photo = null;
  try { photo = await service.capturePhoto(); } finally {
    showPreview(prev.categoryId, photo ?? prev.photo); // cancelled retake keeps the previous photo
  }
});

function continueCapture() {
  const { categoryId, photo } = pending;
  const day = new Date().toISOString().slice(0, 10);
  $('preview-dialog').close();
  openNameDialog({
    title: 'Name your document', saveLabel: 'Save Document', placeholder: 'e.g., Aadhaar Card Front', initial: `Captured Document ${day}`,
    onSave: async (name) => {
      await service.importFile(categoryId, photo, name);
      await reloadCategory(categoryId);
      return `Saved "${name}"`;
    },
    onClose: releasePending, // Cancel (or Esc) discards the capture
  });
}

async function viewImage(doc) {
  await guarded(async () => {
    const src = await service.imageSrc(doc.id);
    $('vw-title').textContent = doc.name;
    $('vw-img').alt = doc.name;
    $('vw-img').src = src;
    $('viewer-dialog').showModal();
  });
}

function handleDocAction(e) {
  const btn = e.target.closest('[data-action]');
  const cardEl = btn?.closest('[data-doc-id]');
  if (!btn || !cardEl) return;
  const doc = view.docs.get(view.categoryId)?.find((d) => d.id === Number(cardEl.dataset.docId));
  if (!doc) return;
  const action = btn.dataset.action;
  if (action === 'open') {
    if (doc.isDemo) showMessage(DEMO_MESSAGE); // never pretend a sample file exists
    else if (IMAGE_TYPES.has(doc.fileType)) viewImage(doc);
    else guarded(() => service.open(doc.id));
  } else if (action === 'rename') {
    openNameDialog({
      title: 'Rename document', saveLabel: 'Save', initial: doc.name,
      onSave: async (name) => { await service.rename(doc.id, name); await reloadCategory(doc.categoryId); return 'Document renamed'; },
    });
  } else if (action === 'delete') {
    guarded(async () => {
      const msg = doc.isDemo ? `Remove sample document "${doc.name}"?` : `Delete "${doc.name}"? This removes the stored file too.`;
      if (!confirm(msg)) return;
      await service.remove(doc.id);
      await reloadCategory(doc.categoryId);
    });
  }
}

function wireEvents() {
  // One delegated listener per container; nothing is re-registered when views change.
  $('categories').addEventListener('click', (e) => {
    const card = e.target.closest('[data-category-id]');
    if (card) openCategory(Number(card.dataset.categoryId));
  });
  $('cv-docs').addEventListener('click', handleDocAction);
  $('cv-back').addEventListener('click', goBack);
  $('cv-add').addEventListener('click', addDoc);
  $('cv-camera').addEventListener('click', captureDoc);
  $('pv-retake').addEventListener('click', retake);
  $('pv-continue').addEventListener('click', continueCapture);
  $('pv-cancel').addEventListener('click', () => { releasePending(); $('preview-dialog').close(); });
  $('preview-dialog').addEventListener('cancel', releasePending); // Esc / system back discards the capture
  $('vw-close').addEventListener('click', () => { $('viewer-dialog').close(); $('vw-img').removeAttribute('src'); });
  $('nd-cancel').addEventListener('click', closeNameDialog);
  $('name-form').addEventListener('submit', submitName);
  $('name-dialog').addEventListener('cancel', (e) => { if (saving) e.preventDefault(); else closeNameDialog(); }); // Esc / system back
  $('nd-input').addEventListener('input', () => setNameError(''));
}

/** Capacitor 8 does not handle the system Back button itself: dialogs first, then category -> dashboard, then exit. */
function wireBackButton() {
  const appPlugin = globalThis.Capacitor?.Plugins?.App;
  if (!appPlugin) return;
  appPlugin.addListener('backButton', () => {
    if ($('viewer-dialog').open) { $('vw-close').click(); return; }
    if ($('name-dialog').open) { if (!saving) closeNameDialog(); return; }
    if ($('preview-dialog').open) { releasePending(); $('preview-dialog').close(); return; }
    if (view.categoryId != null) { goBack(); return; }
    appPlugin.exitApp();
  });
}

async function init() {
  wireEvents();
  if (isNativePlatform()) {
    wireBackButton();
    const db = createDatabase(capacitorSqliteDriver());
    await db.init();
    const { storage, picker, viewer, camera } = capacitorAdapters();
    service = createDocumentService({ db, storage, picker, viewer, camera, thumbnailer: createThumbnail });
    await service.reconcile();
  } else {
    service = createMockService();
    const b = $('banner');
    b.textContent = 'Browser preview: sample data from an in-memory mock, nothing is saved. Run the Android app for SQLite storage.';
    b.hidden = false;
  }
  await buildDashboard();
}

init().catch((err) => { console.error('MyDocs init failed:', err?.message); showMessage(`Startup failed: ${err?.message || err}`); });
