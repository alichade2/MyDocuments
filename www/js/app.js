// UI layer: dashboard card grid + single-page category view. No SQLite access here.
import { createDatabase, capacitorSqliteDriver, isNativePlatform } from './database.js';
import { createDocumentService, capacitorAdapters, DEMO_MESSAGE, IMAGE_TYPES, suggestName, validateName } from './documents.js';
import { createMockService } from './mock.js';
import { createThumbnail } from './images.js';
import { prefersReducedMotion, expandCategory, collapseCategory } from './transitions.js';
import { normalizeQuery } from './search.js';
import { createSelection } from './selection.js';
import { createDrawer } from './nav.js';
import { MENU_ITEMS, buildSettingsSections } from './menu.js';

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
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z',
  share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 1 0-3-3c0 .24.04.47.09.7L8.04 9.81A2.99 2.99 0 0 0 6 9a3 3 0 1 0 0 6c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65a2.92 2.92 0 1 0 2.92-2.92Z',
  delete: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58ZM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6Z',
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
    if (err?.code !== 'DEMO_DOCUMENT') console.error('MyDocs error:', err?.code || err?.name || 'error', err?.code ? '' : String(err?.stack ?? '').replace(/\s+/g, ' ').slice(0, 300));
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

function actionButton(action, icon, label, extraClass = '') {
  const b = el('button', { type: 'button', class: `icon-btn ${extraClass}`.trim(), 'data-action': action, 'aria-label': label, title: label.split(' ')[0] });
  b.append(svgIcon(icon));
  return b;
}

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
      actionButton('rename', 'edit', `Rename ${doc.name}`),
      actionButton('share', 'share', `Share ${doc.name}`),
      actionButton('delete', 'delete', `Delete ${doc.name}`, 'danger')));
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
  tabs.allDirty = true; // add / rename / delete all end up here; the All Documents tab refreshes when it is shown
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

let sharing = false;
function shareDoc(doc) {
  if (sharing) return; // ignore double taps while the share sheet is opening
  sharing = true;
  guarded(() => service.shareDocument(doc.id)).finally(() => { sharing = false; });
}

/** Opens exactly this document (by id): images in the full-screen viewer, other files in the system viewer. */
function openDocument(doc) {
  if (doc.isDemo) showMessage(DEMO_MESSAGE); // never pretend a sample file exists
  else if (IMAGE_TYPES.has(doc.fileType)) viewImage(doc);
  else guarded(() => service.open(doc.id));
}

function handleDocAction(e) {
  const btn = e.target.closest('[data-action]');
  const cardEl = btn?.closest('[data-doc-id]');
  if (!btn || !cardEl) return;
  const doc = view.docs.get(view.categoryId)?.find((d) => d.id === Number(cardEl.dataset.docId));
  if (!doc) return;
  const action = btn.dataset.action;
  if (action === 'open') {
    openDocument(doc);
  } else if (action === 'rename') {
    openNameDialog({
      title: 'Rename document', saveLabel: 'Save', initial: doc.name,
      onSave: async (name) => { await service.rename(doc.id, name); await reloadCategory(doc.categoryId); return 'Document renamed'; },
    });
  } else if (action === 'share') {
    shareDoc(doc);
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
  wireSearch();
  $('page-back').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.page && !drawer.isOpen() && !document.querySelector('dialog[open]')) closeSettings(); });
  wireAllDocuments();
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

/* ---------- Global search ---------- */

const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_MS = 300;
const search = { active: false, seq: 0, debounce: 0, spinnerTimer: 0, scroll: 0, results: new Map() };

function highlight(text, q) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return [document.createTextNode(text)];
  return [document.createTextNode(text.slice(0, i)), el('mark', {}, text.slice(i, i + q.length)), document.createTextNode(text.slice(i + q.length))];
}

function renderResult(doc, q) {
  const type = FILE_TYPES[doc.fileType] ?? { cls: 't-other', label: (doc.fileType || '?').slice(0, 3) };
  const iconEl = el('span', { class: `card-icon ${type.cls}` });
  if (type.icon) iconEl.append(svgIcon(type.icon)); else iconEl.textContent = type.label;
  let leading = iconEl;
  if (doc.thumbPath) {
    const img = el('img', { class: 'result-thumb', alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(iconEl), { once: true });
    service.thumbnailSrc(doc).then((src) => { if (src) img.src = src; else img.replaceWith(iconEl); }).catch(() => img.replaceWith(iconEl));
    leading = img;
  }
  const meta = el('span', { class: 'result-meta' }, `${doc.categoryName} · ${doc.createdAt?.slice(0, 10) ?? ''} · ${(doc.fileType ?? '').toUpperCase()}`);
  if (doc.isDemo) meta.append(el('span', { class: 'badge' }, 'Sample'));
  const name = el('span', { class: 'result-name' });
  name.append(...highlight(doc.name, q));
  // Two sibling buttons (never nested): the row opens the document, the share icon shares this exact document.
  const share = el('button', { type: 'button', class: 'icon-btn result-share', 'data-action': 'share', 'aria-label': `Share document ${doc.name}, ${doc.categoryName}`, title: 'Share document' });
  share.append(svgIcon('share'));
  return el('li', { class: 'result-row', 'data-doc-id': String(doc.id) },
    el('button', {
      type: 'button', class: 'result', 'data-action': 'open',
      'aria-label': `${doc.name}, ${doc.categoryName}, ${doc.createdAt?.slice(0, 10) ?? ''}${doc.isDemo ? ', sample' : ''}`,
    }, leading, el('span', { class: 'result-text' }, name, meta)),
    share);
}

function setSearchStatus(...nodes) { $('search-status').replaceChildren(...nodes); }

function renderSearchHint() {
  $('search-results').replaceChildren();
  search.results.clear();
  setSearchStatus(document.createTextNode('Search by document name or date, e.g. "passport" or 17/10/2026.'));
}

function renderSearchResults(rows, q) {
  search.results = new Map(rows.map((d) => [d.id, d]));
  const list = $('search-results');
  if (!rows.length) {
    list.replaceChildren();
    setSearchStatus(el('span', {}, el('strong', {}, 'No documents found'), document.createTextNode(' - check the name or try a date like 2026-10-17.')));
    return;
  }
  list.replaceChildren(...rows.map((d) => renderResult(d, q)));
  setSearchStatus(document.createTextNode(`${rows.length} ${rows.length === 1 ? 'document' : 'documents'} found`));
}

async function runSearch(q) {
  const mine = ++search.seq; // any older in-flight search is now stale
  clearTimeout(search.spinnerTimer);
  search.spinnerTimer = setTimeout(() => { if (mine === search.seq) setSearchStatus(el('span', { class: 'spinner', 'aria-hidden': 'true' }), document.createTextNode('Searching...')); }, 250);
  try {
    const rows = await service.search(q);
    if (mine !== search.seq) return; // a newer query (or closing search) superseded this one
    clearTimeout(search.spinnerTimer);
    renderSearchResults(rows, q);
  } catch (err) {
    if (mine !== search.seq) return;
    clearTimeout(search.spinnerTimer);
    console.error('MyDocs search error:', err?.code || err?.name || 'error');
    setSearchStatus(document.createTextNode('Search failed. Please try again.'));
  }
}

/** The clear (X) button exists only while the field holds text (ignoring surrounding whitespace). */
function syncClearButton() {
  $('search-clear').hidden = normalizeQuery($('search-input').value) === '';
}

function scheduleSearch({ immediate = false } = {}) {
  clearTimeout(search.debounce);
  search.seq++; // discard results of any query still in flight
  clearTimeout(search.spinnerTimer);
  const q = normalizeQuery($('search-input').value);
  syncClearButton();
  if (!q) { renderSearchHint(); return; }
  search.debounce = setTimeout(() => runSearch(q), immediate ? 0 : SEARCH_DEBOUNCE_MS);
}

function openSearch() {
  if (search.active || motion.busy) return;
  search.active = true;
  search.scroll = $('scroller').scrollTop;
  document.body.classList.add('searching');
  $('search-view').hidden = false;
  $('scroller').scrollTop = 0;
  renderSearchHint();
  syncClearButton(); // starts empty, so no clear button

  const bar = $('search-bar');
  const iconBtn = $('search-open');
  iconBtn.setAttribute('aria-expanded', 'true');
  const from = iconBtn.getBoundingClientRect();
  bar.hidden = false;
  const to = bar.getBoundingClientRect();
  $('search-input').focus(); // inside the tap handler, so the keyboard opens right away
  if (!prefersReducedMotion()) {
    bar.animate([{ width: `${from.width}px` }, { width: `${to.width}px` }], { duration: SEARCH_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    for (const child of bar.children) child.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: SEARCH_MS, easing: 'linear' });
    iconBtn.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
  } else {
    iconBtn.style.visibility = 'hidden';
  }
}

function closeSearch() {
  if (!search.active) return;
  search.active = false;
  search.seq++; // supersede any running search
  clearTimeout(search.debounce);
  clearTimeout(search.spinnerTimer);
  const bar = $('search-bar');
  const iconBtn = $('search-open');
  const from = bar.getBoundingClientRect();
  const to = iconBtn.getBoundingClientRect();
  $('search-input').blur();
  iconBtn.setAttribute('aria-expanded', 'false');

  // Put the dashboard/category (and its scroll position) back right away; the field collapses over it.
  document.body.classList.remove('searching');
  $('search-view').hidden = true;
  $('scroller').scrollTop = search.scroll;
  $('search-results').replaceChildren();
  search.results.clear();

  const done = () => {
    bar.hidden = true;
    $('search-input').value = '';
    syncClearButton();
    iconBtn.getAnimations().forEach((a) => a.cancel());
    bar.getAnimations({ subtree: true }).forEach((a) => a.cancel()); // drop fill-forwards fades so a re-open starts clean
    iconBtn.style.visibility = '';
    iconBtn.focus({ preventScroll: true });
  };
  if (prefersReducedMotion()) { done(); return; }
  const collapse = bar.animate([{ width: `${from.width}px` }, { width: `${to.width}px` }], { duration: SEARCH_MS - 50, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });
  for (const child of bar.children) child.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
  iconBtn.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: SEARCH_MS - 50, fill: 'forwards' });
  Promise.race([collapse.finished, new Promise((r) => setTimeout(r, SEARCH_MS + 300))]).then(done, done);
}

function wireSearch() {
  $('search-open').addEventListener('click', openSearch);
  $('search-close').addEventListener('click', closeSearch);
  $('search-clear').addEventListener('click', () => {
    $('search-input').value = '';
    scheduleSearch({ immediate: true });
    $('search-input').focus();
  });
  $('search-input').addEventListener('input', () => scheduleSearch());
  $('search-input').addEventListener('change', syncClearButton);
  $('search-input').addEventListener('keyup', syncClearButton);
  $('search-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
  $('search-bar').addEventListener('submit', (e) => { e.preventDefault(); $('search-input').blur(); }); // results are already live
  $('search-results').addEventListener('click', (e) => {
    const row = e.target.closest('[data-doc-id]');
    const doc = row && search.results.get(Number(row.dataset.docId)); // by unique id, never by name
    if (!doc) return;
    if (e.target.closest('[data-action="share"]')) shareDoc(doc); // same code path as the share icon on document cards
    else openDocument(doc);
  });
}

/* ---------- Bottom tabs + All Documents ---------- */

const tabs = { current: 'category', allDirty: true, scroll: { category: 0, all: 0 } };
const selection = createSelection();
const allState = { groups: new Map(), busy: false }; // categoryId -> { ids: [], header, rows: Map(id -> row) }

function switchTab(name) {
  if (tabs.current === name || motion.busy || allState.busy || nav.page) return;
  if (search.active) closeSearch();
  const from = tabs.current;
  tabs.scroll[from] = $(from === 'all' ? 'all-scroller' : 'scroller').scrollTop; // hidden scrollers lose their offset
  tabs.current = name;
  document.body.classList.toggle('tab-all', name === 'all');
  $('scroller').hidden = name === 'all';
  $('all-scroller').hidden = name !== 'all';
  $('share-files').hidden = name !== 'all';
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  const target = $(name === 'all' ? 'all-scroller' : 'scroller');
  const restore = () => { target.scrollTop = tabs.scroll[name]; };
  if (name === 'all' && tabs.allDirty) refreshAllDocuments().then(restore).catch((err) => { console.error('MyDocs list error:', err?.name || 'error', String(err?.stack ?? '').replace(/\s+/g, ' ').slice(0, 300)); showMessage('Could not load documents.'); }); else restore();
}

function updateSelectionUI() {
  const n = selection.size;
  $('sel-count').textContent = `${n} selected`;
  $('sel-clear').disabled = n === 0;
  $('share-files').setAttribute('aria-label', n ? `Share ${n} selected ${n === 1 ? 'file' : 'files'} as a ZIP` : 'Share selected files as a ZIP');
  for (const [, g] of allState.groups) {
    const st = selection.stateOf(g.ids);
    g.check.checked = st === 'all';
    g.check.indeterminate = st === 'some';
    for (const [id, row] of g.rows) {
      const on = selection.has(id);
      row.el.classList.toggle('selected', on);
      row.input.checked = on;
    }
  }
}

function renderAllRow(doc, g) {
  const type = FILE_TYPES[doc.fileType] ?? { cls: 't-other', label: (doc.fileType || '?').slice(0, 3) };
  const iconEl = el('span', { class: `card-icon ${type.cls}` });
  if (type.icon) iconEl.append(svgIcon(type.icon)); else iconEl.textContent = type.label;
  let leading = iconEl;
  if (doc.thumbPath) {
    const img = el('img', { class: 'result-thumb', alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(iconEl), { once: true });
    service.thumbnailSrc(doc).then((src) => { if (src) img.src = src; else img.replaceWith(iconEl); }).catch(() => img.replaceWith(iconEl));
    leading = img;
  }
  const meta = el('span', { class: 'result-meta' }, `${doc.createdAt?.slice(0, 10) ?? ''} · ${(doc.fileType ?? '').toUpperCase()}`);
  if (doc.isDemo) meta.append(el('span', { class: 'badge' }, 'Sample'));
  const input = el('input', { type: 'checkbox', class: 'doc-check', 'data-doc-id': String(doc.id), 'aria-label': `Select ${doc.name}, ${doc.categoryName}` });
  const label = el('label', { class: 'doc-row' }, leading,
    el('span', { class: 'result-text' }, el('span', { class: 'result-name' }, doc.name), meta),
    el('span', { class: 'check' }, input));
  g.rows.set(doc.id, { el: label, input });
  return label;
}

/** Re-reads every saved document (single source of truth: the repository) and rebuilds the grouped list. */
async function refreshAllDocuments() {
  const docs = await service.listAll();
  tabs.allDirty = false;
  if (selection.prune(docs.map((d) => d.id)) > 0) showMessage('Some selected documents were removed from the selection because they no longer exist.');
  const byCat = new Map();
  for (const d of docs) { if (!byCat.has(d.categoryId)) byCat.set(d.categoryId, { name: d.categoryName, docs: [] }); byCat.get(d.categoryId).docs.push(d); }
  allState.groups = new Map();
  const frag = document.createDocumentFragment();
  for (const [categoryId, { name, docs: list }] of byCat) {
    const check = el('input', { type: 'checkbox', class: 'group-check', 'aria-label': `Select all in ${name}` });
    const g = { ids: list.map((d) => d.id), check, rows: new Map() };
    allState.groups.set(categoryId, g);
    frag.append(el('section', { class: 'group', 'aria-label': name },
      el('label', { class: 'group-header' }, el('span', { class: 'group-title' }, name, el('span', { class: 'group-count' }, ` (${list.length})`)), el('span', { class: 'check' }, check)),
      ...list.map((d) => renderAllRow(d, g))));
  }
  if (!docs.length) frag.append(el('div', { class: 'empty' }, 'No documents saved yet.'));
  $('all-list').replaceChildren(frag);
  updateSelectionUI();
}

function wireAllDocuments() {
  $('all-list').addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('doc-check')) selection.toggle(Number(t.dataset.docId), t.checked); // by unique id, never by name
    else if (t.classList.contains('group-check')) {
      const g = [...allState.groups.values()].find((x) => x.check === t);
      if (g) selection.setMany(g.ids, t.checked);
    } else return;
    updateSelectionUI();
  });
  $('sel-clear').addEventListener('click', () => { selection.clear(); updateSelectionUI(); });
  $('share-files').addEventListener('click', shareSelected);
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => switchTab(t.dataset.tab));
  $('progress-dialog').addEventListener('cancel', (e) => e.preventDefault()); // cannot be dismissed while the ZIP is built
}

async function shareSelected() {
  if (allState.busy) return; // no duplicate submissions while the archive is being built
  if (selection.size === 0) { showMessage('Please select at least one document to share'); return; }
  allState.busy = true;
  $('share-files').disabled = true;
  $('pg-text').textContent = 'Preparing ZIP file...';
  $('progress-dialog').showModal();
  try {
    const res = await service.shareSelectedAsZip(selection.toList(), {
      onProgress: (done, total) => { $('pg-text').textContent = done < total ? `Preparing ZIP file... (${done + 1} of ${total})` : 'Opening share sheet...'; },
    });
    $('progress-dialog').close();
    if (res.shared) { // handed to the Android share sheet
      selection.clear();
      updateSelectionUI();
      showMessage(`Shared ${res.count} ${res.count === 1 ? 'document' : 'documents'} as ${res.fileName}`);
    } // dismissed sheet: keep the selection so the user can retry
  } catch (err) {
    $('progress-dialog').close();
    if (err?.code === 'SELECTION_STALE') await refreshAllDocuments();
    if (!['NOTHING_SELECTED', 'ZIP_UNAVAILABLE', 'SELECTION_STALE', 'ZIP_NO_SPACE', 'ZIP_TOO_LARGE'].includes(err?.code)) console.error('MyDocs ZIP error:', err?.code || err?.name || 'error');
    showMessage(err?.message || 'Could not create the ZIP file. Please try again.');
  } finally {
    allState.busy = false;
    $('share-files').disabled = false;
  }
}

/* ---------- Navigation drawer + Settings page ---------- */

const nav = { page: null, returnTab: 'category', returnScroll: 0 };
const scrollerOf = (tab) => $(tab === 'all' ? 'all-scroller' : 'scroller');
/** Drawer destinations by menu item id; add an entry here (and in menu.js) for new screens. */
const destinations = { settings: () => openSettings() };

const drawer = createDrawer({
  drawer: $('drawer'), scrim: $('drawer-scrim'), list: $('drawer-items'), openButton: $('menu-open'),
  background: [$('app-bar'), $('scroller'), $('all-scroller'), $('settings-scroller'), document.querySelector('.tab-bar')],
  items: MENU_ITEMS, renderIcon: (name) => svgIcon(name),
  isBlocked: () => motion.busy || allState.busy || nav.page !== null,
  onSelect: (id) => destinations[id]?.(),
});

function renderSettings(info = {}) {
  $('settings-list').replaceChildren(...buildSettingsSections(info).map((sec) => el('section', { class: 'settings-section', 'aria-label': sec.title },
    el('h2', {}, sec.title),
    el('ul', { class: 'settings-rows' }, ...sec.rows.map((r) => el('li', { class: 'settings-row' },
      el('span', { class: 'settings-label' }, r.label), r.value ? el('span', { class: 'settings-value' }, r.value) : document.createTextNode('')))))));
}

function openSettings() {
  if (nav.page === 'settings' || motion.busy || allState.busy) return; // repeated taps do nothing
  if (search.active) closeSearch();
  nav.page = 'settings';
  nav.returnTab = tabs.current;
  nav.returnScroll = scrollerOf(tabs.current).scrollTop;
  scrollerOf(tabs.current).hidden = true;
  $('settings-scroller').hidden = false;
  $('settings-scroller').scrollTop = 0;
  document.body.classList.add('page-settings');
  $('page-back').hidden = false;
  $('app-title').textContent = 'Settings';
  drawer.setActive('settings');
  $('page-back').focus({ preventScroll: true });
}

function closeSettings() {
  if (nav.page === null) return;
  nav.page = null;
  document.body.classList.remove('page-settings');
  $('page-back').hidden = true;
  $('settings-scroller').hidden = true;
  const back = scrollerOf(nav.returnTab);
  back.hidden = false;
  back.scrollTop = nav.returnScroll; // same screen, same scroll position as before
  $('app-title').textContent = 'MyDocs';
  drawer.setActive(null);
  $('menu-open').focus({ preventScroll: true });
}

/** Capacitor 8 does not handle the system Back button itself: dialogs first, then category -> dashboard, then exit. */
function wireBackButton() {
  const appPlugin = globalThis.Capacitor?.Plugins?.App;
  if (!appPlugin) return;
  appPlugin.addListener('backButton', () => {
    if ($('progress-dialog').open) return; // ZIP being prepared
    if (drawer.isOpen()) { drawer.close(); return; }
    if ($('viewer-dialog').open) { $('vw-close').click(); return; }
    if ($('name-dialog').open) { if (!saving) closeNameDialog(); return; }
    if ($('preview-dialog').open) { releasePending(); $('preview-dialog').close(); return; }
    if (search.active) { closeSearch(); return; }
    if (nav.page) { closeSettings(); return; }
    if (tabs.current === 'all') { if (selection.size) { selection.clear(); updateSelectionUI(); } else switchTab('category'); return; }
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
    const { storage, picker, viewer, camera, sharer } = capacitorAdapters();
    service = createDocumentService({ db, storage, picker, viewer, camera, sharer, thumbnailer: createThumbnail });
    await service.reconcile();
  } else {
    service = createMockService();
    globalThis.__mydocsPreview = service; // browser preview only: lets tests inspect the in-memory ZIP
    const b = $('banner');
    b.textContent = 'Browser preview: sample data from an in-memory mock, nothing is saved. Run the Android app for SQLite storage.';
    b.hidden = false;
  }
  renderSettings();
  globalThis.Capacitor?.Plugins?.App?.getInfo?.().then((info) => renderSettings({ version: info.version, build: info.build })).catch(() => {});
  await buildDashboard();
}

init().catch((err) => { console.error('MyDocs init failed:', err?.message); showMessage(`Startup failed: ${err?.message || err}`); });
