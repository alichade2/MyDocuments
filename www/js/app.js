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
import { THEME_OPTIONS, loadTheme, saveTheme, applyTheme } from './theme.js';
import { iconPath, CATEGORY_ICON_CHOICES, DEFAULT_CATEGORY_ICON } from './icons.js';
import { createAppLock, nativeAuthenticator, previewAuthenticator, lockMessage } from './applock.js';
import { createBackupService } from './backup.js';
import { nativeBackupAdapters } from './backup-native.js';
import { createDriveClient } from './drive.js';
import { createMockBackup } from './mock-backup.js';
import { SIZE_LIMIT_OPTIONS_MB, loadSizeLimitMb, saveSizeLimitMb, setSizeLimitMb, setSizeCapMb, getSizeLimitMb, formatSize as formatSizeText } from './sizelimit.js';
import { createAccessPolicy, EntitlementError, BASIC_LIMITS, PLAN } from './access.js';
import { createEntitlements } from './entitlements.js';
import { createBilling, BillingError } from './billing.js';
import { createPromoClient, PromoError, isBackendConfigured } from './promo.js';
import { createMockPlayBilling } from './mock-billing.js';
import { PRO_PRODUCT_ID, BACKEND_URL, PLAY_VERIFY_MODE, PLAY_LICENSE_KEY, PLAY_GRACE_DAYS, SIGNING_PUBLIC_KEY } from './entitlement-config.js';
import { importPublicKey } from './entitlement-token.js';
import { t, tn, countLabel, categoryLabel, errorText, LANGUAGES, loadLanguage, saveLanguage, setLanguage, getLanguage, applyStaticTranslations } from './i18n.js';

const $ = (id) => document.getElementById(id);
setLanguage(loadLanguage()); // before anything is rendered; English unless the user chose otherwise
setSizeLimitMb(loadSizeLimitMb()); // document size limit: 5 MB unless the user chose another
setSizeCapMb(BASIC_LIMITS.maxSizeMb); // fail-safe: Basic until the entitlement has been read
applyStaticTranslations();
const SVG_NS = 'http://www.w3.org/2000/svg';

const FILE_TYPES = {
  pdf: { cls: 't-pdf', label: 'PDF' },
  jpg: { cls: 't-img', icon: 'image' }, jpeg: { cls: 't-img', icon: 'image' }, png: { cls: 't-img', icon: 'image' },
  webp: { cls: 't-img', icon: 'image' }, gif: { cls: 't-img', icon: 'image' },
  doc: { cls: 't-doc', label: 'DOC' }, docx: { cls: 't-doc', label: 'DOC' },
  txt: { cls: 't-txt', label: 'TXT' },
};

let service;
let entitlements = null; // createEntitlements, set in init()
/** The single place that decides what the current plan may do (document count, size cap, Backup, Drive). */
const access = createAccessPolicy(() => entitlements?.effective() ?? { plan: PLAN.BASIC });
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
  p.setAttribute('d', iconPath(name));
  svg.append(p);
  return svg;
}

const plural = (n) => countLabel(n);

/** Size text on cards: same decimal units as the size limit (1 MB = 1,000,000 bytes). */
const formatSize = (bytes) => (bytes ? formatSizeText(bytes) : '');

let toastTimer;
function showMessage(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

async function guarded(fn) {
  try { return await fn(); } catch (err) {
    if (err instanceof EntitlementError) { showProPrompt(errorText(err)); return; }
    if (!access.isPro() && /^FILE_TOO_LARGE/.test(err?.code ?? '')) { showProPrompt(t('err.proSize')); return; }
    if (err?.code !== 'DEMO_DOCUMENT') console.error('MyDocs error:', err?.code || err?.name || 'error', err?.code ? '' : String(err?.stack ?? '').replace(/\s+/g, ' ').slice(0, 300));
    showMessage(errorText(err) || String(err));
  }
}

/* ---------- Dashboard ---------- */

function buildCard(cat) {
  const countEl = el('span', { class: 'count' });
  const card = el('button', { class: 'cat-card', type: 'button', 'data-category-id': String(cat.id), id: `cat-${cat.slug}` },
    el('span', { class: 'cat-top' }, el('span', { class: 'category-icon' }, svgIcon(cat.icon)), svgIcon('chevron', 'chevron')),
    el('span', { class: 'cat-name' }, categoryLabel(cat)),
    countEl);
  const entry = { cat, count: 0, countEl, cardEl: card };
  cards.set(cat.id, entry);
  return entry;
}

function updateCardCount(entry, n) {
  entry.count = n;
  entry.countEl.textContent = plural(n);
  entry.cardEl.setAttribute('aria-label', `${categoryLabel(entry.cat)}, ${plural(n)}`);
}

async function buildDashboard() {
  const categories = await service.listCategories();
  const ids = new Set(categories.map((c) => c.id));
  for (const id of [...cards.keys()]) if (!ids.has(id)) { cards.delete(id); view.docs.delete(id); } // deleted categories
  const frag = document.createDocumentFragment();
  for (const cat of categories) {
    const old = cards.get(cat.id);
    const entry = old && old.cat.name === cat.name && old.cat.icon === cat.icon ? old : buildCard(cat); // new or edited -> fresh card
    const docs = await service.list(cat.id);
    view.docs.set(cat.id, docs);
    updateCardCount(entry, docs.length);
    frag.append(entry.cardEl);
  }
  $('categories').replaceChildren(frag);
}

/* ---------- Category view ---------- */

function actionButton(action, icon, label, title, extraClass = '') {
  const b = el('button', { type: 'button', class: `icon-btn ${extraClass}`.trim(), 'data-action': action, 'aria-label': label, title });
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
  const main = el('button', { class: 'card-main', type: 'button', 'data-action': 'open', 'aria-label': `${doc.name}${doc.isDemo ? t('doc.sampleParen') : ''}` },
    leading,
    el('span', { class: 'card-name' }, doc.name),
    el('span', { class: 'card-meta' }, meta));
  if (doc.isDemo) main.append(el('span', { class: 'badge' }, t('doc.sample')));
  if (doc.missing) main.append(el('span', { class: 'card-warn' }, t('doc.fileMissing')));
  return el('article', { class: `card${doc.missing ? ' missing' : ''}`, 'data-doc-id': String(doc.id) }, main,
    el('div', { class: 'card-actions' },
      actionButton('rename', 'edit', t('doc.rename', { name: doc.name }), t('act.rename')),
      actionButton('share', 'share', t('doc.share', { name: doc.name }), t('act.share')),
      actionButton('delete', 'delete', t('doc.delete', { name: doc.name }), t('act.delete'), 'danger')));
}

function renderCategoryView() {
  const entry = cards.get(view.categoryId);
  const docs = view.docs.get(view.categoryId) ?? [];
  $('cv-icon').replaceChildren(svgIcon(entry.cat.icon));
  $('cv-title').textContent = categoryLabel(entry.cat);
  $('cv-count').textContent = plural(docs.length);
  $('cv-docs').replaceChildren(docs.length
    ? el('div', { class: 'grid' }, ...docs.map(renderDocCard))
    : el('div', { class: 'empty' }, t('cat.empty', { name: categoryLabel(entry.cat) })));
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
  f.textContent = flow.fileLabel ? t('name.file', { file: flow.fileLabel }) : '';
  setNameError('');
  $('nd-input').placeholder = flow.placeholder ?? t('name.placeholder');
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
  $('nd-save').textContent = on ? t('name.saving') : nameFlow?.saveLabel ?? t('common.save');
}

async function submitName(e) {
  e.preventDefault();
  if (saving || !nameFlow) return; // prevents double submission
  let name;
  try { name = validateName($('nd-input').value); } catch (err) {
    setNameError(err.code === 'INVALID_NAME' && !$('nd-input').value.trim() ? t('name.enter') : errorText(err));
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
    setNameError(errorText(err, 'name.saveFailed'));
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
    title: t('name.title'), saveLabel: t('name.save'), fileLabel: file.name, initial: suggestName(file.name),
    onSave: async (name) => {
      await service.importFile(categoryId, file, name);
      await reloadCategory(categoryId);
      return t('doc.saved', { name });
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
    title: t('name.title'), saveLabel: t('name.save'), placeholder: t('name.placeholderCapture'), initial: t('doc.capturedDefault', { day }),
    onSave: async (name) => {
      await service.importFile(categoryId, photo, name);
      await reloadCategory(categoryId);
      return t('doc.saved', { name });
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
  if (doc.isDemo) showMessage(errorText({ message: DEMO_MESSAGE })); // never pretend a sample file exists
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
      title: t('name.renameTitle'), saveLabel: t('common.save'), initial: doc.name,
      onSave: async (name) => { await service.rename(doc.id, name); await reloadCategory(doc.categoryId); return t('doc.renamed'); },
    });
  } else if (action === 'share') {
    shareDoc(doc);
  } else if (action === 'delete') {
    guarded(async () => {
      const msg = doc.isDemo ? t('doc.confirmRemoveSample', { name: doc.name }) : t('doc.confirmDelete', { name: doc.name });
      if (!confirm(msg)) return;
      await service.remove(doc.id);
      await reloadCategory(doc.categoryId);
    });
  }
}

function wireEvents() {
  wireSearch();
  $('page-back').addEventListener('click', pageBack);
  $('settings-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="theme"]')) openThemeDialog();
    else if (e.target.closest('[data-action="language"]')) openLanguageDialog();
    else if (e.target.closest('[data-action="backup"]')) openBackupPage();
    else if (e.target.closest('[data-action="upgrade"]')) openUpgradePage();
    else if (e.target.closest('[data-action="app-lock"]')) toggleAppLock();
  });
  $('settings-list').addEventListener('change', (e) => {
    if (e.target.dataset?.setting === 'size-limit') setDocumentSizeLimit(e.target.value);
  });
  wireCategories();
  $('th-options').addEventListener('change', (e) => {
    if (e.target.name !== 'theme') return;
    setTheme(e.target.value);
    setTimeout(() => $('theme-dialog').close(), 180); // brief moment to see the new selection
  });
  $('th-close').addEventListener('click', () => $('theme-dialog').close());
  $('lg-options').addEventListener('change', (e) => {
    if (e.target.name !== 'language') return;
    setAppLanguage(e.target.value);
    setTimeout(() => $('lang-dialog').close(), 180); // brief moment to see the new selection
  });
  $('lg-close').addEventListener('click', () => $('lang-dialog').close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.page && !drawer.isOpen() && !document.querySelector('dialog[open]')) pageBack(); });
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
  const meta = el('span', { class: 'result-meta' }, `${categoryLabel(doc)} · ${doc.createdAt?.slice(0, 10) ?? ''} · ${(doc.fileType ?? '').toUpperCase()}`);
  if (doc.isDemo) meta.append(el('span', { class: 'badge' }, t('doc.sample')));
  const name = el('span', { class: 'result-name' });
  name.append(...highlight(doc.name, q));
  // Two sibling buttons (never nested): the row opens the document, the share icon shares this exact document.
  const share = el('button', { type: 'button', class: 'icon-btn result-share', 'data-action': 'share', 'aria-label': t('doc.shareAria', { name: doc.name, category: categoryLabel(doc) }), title: t('doc.shareDocument') });
  share.append(svgIcon('share'));
  return el('li', { class: 'result-row', 'data-doc-id': String(doc.id) },
    el('button', {
      type: 'button', class: 'result', 'data-action': 'open',
      'aria-label': `${doc.name}, ${categoryLabel(doc)}, ${doc.createdAt?.slice(0, 10) ?? ''}${doc.isDemo ? t('doc.sampleAria') : ''}`,
    }, leading, el('span', { class: 'result-text' }, name, meta)),
    share);
}

function setSearchStatus(...nodes) { $('search-status').replaceChildren(...nodes); }

function renderSearchHint() {
  $('search-results').replaceChildren();
  search.results.clear();
  setSearchStatus(document.createTextNode(t('search.hint')));
}

function renderSearchResults(rows, q) {
  search.results = new Map(rows.map((d) => [d.id, d]));
  const list = $('search-results');
  if (!rows.length) {
    list.replaceChildren();
    setSearchStatus(el('span', {}, el('strong', {}, t('search.none')), document.createTextNode(t('search.noneHelp'))));
    return;
  }
  list.replaceChildren(...rows.map((d) => renderResult(d, q)));
  setSearchStatus(document.createTextNode(tn('search.found', rows.length)));
}

async function runSearch(q) {
  const mine = ++search.seq; // any older in-flight search is now stale
  clearTimeout(search.spinnerTimer);
  search.spinnerTimer = setTimeout(() => { if (mine === search.seq) setSearchStatus(el('span', { class: 'spinner', 'aria-hidden': 'true' }), document.createTextNode(t('search.searching'))); }, 250);
  try {
    const rows = await service.search(q);
    if (mine !== search.seq) return; // a newer query (or closing search) superseded this one
    clearTimeout(search.spinnerTimer);
    renderSearchResults(rows, q);
  } catch (err) {
    if (mine !== search.seq) return;
    clearTimeout(search.spinnerTimer);
    console.error('MyDocs search error:', err?.code || err?.name || 'error');
    setSearchStatus(document.createTextNode(t('search.failed')));
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
  if (name === 'all' && tabs.allDirty) refreshAllDocuments().then(restore).catch((err) => { console.error('MyDocs list error:', err?.name || 'error', String(err?.stack ?? '').replace(/\s+/g, ' ').slice(0, 300)); showMessage(t('all.loadFailed')); }); else restore();
}

function updateSelectionUI() {
  const n = selection.size;
  $('sel-count').textContent = t('sel.count', { n });
  $('sel-clear').disabled = n === 0;
  $('share-files').setAttribute('aria-label', n ? tn('share.zipAria', n) : t('share.zipAria'));
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
  if (doc.isDemo) meta.append(el('span', { class: 'badge' }, t('doc.sample')));
  const input = el('input', { type: 'checkbox', class: 'doc-check', 'data-doc-id': String(doc.id), 'aria-label': t('doc.selectAria', { name: doc.name, category: categoryLabel(doc) }) });
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
  if (selection.prune(docs.map((d) => d.id)) > 0) showMessage(t('all.pruned'));
  const byCat = new Map();
  for (const d of docs) { if (!byCat.has(d.categoryId)) byCat.set(d.categoryId, { name: categoryLabel(d), docs: [] }); byCat.get(d.categoryId).docs.push(d); }
  allState.groups = new Map();
  const frag = document.createDocumentFragment();
  for (const [categoryId, { name, docs: list }] of byCat) {
    const check = el('input', { type: 'checkbox', class: 'group-check', 'aria-label': t('doc.selectAllIn', { name }) });
    const g = { ids: list.map((d) => d.id), check, rows: new Map() };
    allState.groups.set(categoryId, g);
    frag.append(el('section', { class: 'group', 'aria-label': name },
      el('label', { class: 'group-header' }, el('span', { class: 'group-title' }, name, el('span', { class: 'group-count' }, ` (${list.length})`)), el('span', { class: 'check' }, check)),
      ...list.map((d) => renderAllRow(d, g))));
  }
  if (!docs.length) frag.append(el('div', { class: 'empty' }, t('all.empty')));
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
  if (selection.size === 0) { showMessage(t('zip.selectOne')); return; }
  allState.busy = true;
  $('share-files').disabled = true;
  $('pg-text').textContent = t('zip.preparing');
  $('progress-dialog').showModal();
  try {
    const res = await service.shareSelectedAsZip(selection.toList(), {
      onProgress: (done, total) => { $('pg-text').textContent = done < total ? t('zip.preparingN', { done: done + 1, total }) : t('zip.opening'); },
    });
    $('progress-dialog').close();
    if (res.shared) { // handed to the Android share sheet
      selection.clear();
      updateSelectionUI();
      showMessage(tn('zip.shared', res.count, { file: res.fileName }));
    } // dismissed sheet: keep the selection so the user can retry
  } catch (err) {
    $('progress-dialog').close();
    if (err?.code === 'SELECTION_STALE') await refreshAllDocuments();
    if (!['NOTHING_SELECTED', 'ZIP_UNAVAILABLE', 'SELECTION_STALE', 'ZIP_NO_SPACE', 'ZIP_TOO_LARGE'].includes(err?.code)) console.error('MyDocs ZIP error:', err?.code || err?.name || 'error');
    showMessage(errorText(err, 'zip.failed'));
  } finally {
    allState.busy = false;
    $('share-files').disabled = false;
  }
}

/* ---------- App Lock (policy in applock.js; the prompt itself is Android's BiometricPrompt) ---------- */

const authenticator = isNativePlatform() ? nativeAuthenticator(globalThis.Capacitor?.Plugins?.AppLock) : previewAuthenticator();
const appLock = createAppLock({ authenticator, onChange: (locked) => applyLockState(locked) });
globalThis.__mydocsAppLock = appLock; // browser preview / tests only

/** Closes everything that may show document content (and wipes pending photo data) before the lock screen takes over. */
function closeSensitiveDialogs() {
  if (drawer.isOpen()) drawer.close(); // only called from init(), after the drawer exists
  if ($('preview-dialog').open) { releasePending(); $('preview-dialog').close(); }
  if ($('name-dialog').open && !saving) closeNameDialog();
  if ($('viewer-dialog').open) $('vw-close').click();
  if ($('cat-dialog').open) closeCategoryDialog();
  for (const id of ['cdel-dialog', 'theme-dialog', 'lang-dialog', 'lockinfo-dialog', 'bk-ready-dialog', 'bk-restore-dialog']) if ($(id).open) $(id).close();
}

function applyLockState(locked) {
  document.documentElement.toggleAttribute('data-locked', locked);
  for (const node of document.body.children) if (node.id !== 'lock-screen') node.inert = locked; // no focus, no screen-reader access
  if (locked) {
    closeSensitiveDialogs();
    setLockMessage(t('lock.msg'), false);
    $('lock-unlock').textContent = t('lock.unlock');
  } else {
    setTimeout(() => $('menu-open')?.focus?.({ preventScroll: true }), 0);
  }
}

function setLockMessage(text, needsSettings) {
  $('lock-msg').textContent = text;
  $('lock-settings').hidden = !needsSettings;
}

/** Shows Android's authentication prompt. Failure or cancel keeps the app locked and offers a retry. */
async function promptUnlock() {
  if (!appLock.locked || appLock.prompting) return;
  const res = await appLock.unlock();
  if (res.ok || res.code === 'BUSY') return;
  setLockMessage(lockMessage(res.code), res.code === 'NO_SCREEN_LOCK');
  $('lock-unlock').textContent = t('common.retry');
}

const openSecuritySettings = () => appLock.external(async () => authenticator.openSecuritySettings?.());

let lockToggleBusy = false;
async function toggleAppLock() {
  if (lockToggleBusy) return;
  lockToggleBusy = true;
  const turningOn = !appLock.enabled;
  const button = document.querySelector('[data-action="app-lock"]');
  if (button) button.disabled = true;
  try {
    // external(): the system prompt may move the app to the background on older Android versions; that must not lock it.
    const res = await appLock.external(() => (turningOn ? appLock.enable() : appLock.disable()));
    if (res.ok) showMessage(turningOn ? t('lock.on') : t('lock.off'));
    else if (res.code === 'NO_SCREEN_LOCK') {
      $('li-text').textContent = t('lockinfo.text');
      $('lockinfo-dialog').showModal();
    } else if (res.code === 'CANCELED') showMessage(turningOn ? t('lock.notOn') : t('lock.stays'));
    else showMessage(lockMessage(res.code));
  } finally {
    lockToggleBusy = false;
    renderSettings();
  }
}

function wireAppLock() {
  $('lock-unlock').addEventListener('click', promptUnlock);
  $('lock-settings').addEventListener('click', openSecuritySettings);
  $('li-close').addEventListener('click', () => $('lockinfo-dialog').close());
  $('li-settings').addEventListener('click', () => { $('lockinfo-dialog').close(); openSecuritySettings(); });
  const app = globalThis.Capacitor?.Plugins?.App;
  if (isNativePlatform() && app?.addListener) {
    app.addListener('appStateChange', ({ isActive }) => { // leaving locks, returning asks Android to authenticate
      if (!isActive) appLock.background(); else promptUnlockAfterReturn();
    });
  } else {
    document.addEventListener('visibilitychange', () => { // browser preview
      if (document.hidden) appLock.background(); else promptUnlockAfterReturn();
    });
  }
}

async function promptUnlockAfterReturn() {
  const res = await appLock.foreground();
  if (!res.ok && res.code !== 'BUSY') { setLockMessage(lockMessage(res.code), res.code === 'NO_SCREEN_LOCK'); $('lock-unlock').textContent = t('common.retry'); }
}

/* ---------- Navigation drawer + Settings page ---------- */

const nav = { page: null, returnTab: 'category', returnScroll: 0 };
const scrollerOf = (tab) => $(tab === 'all' ? 'all-scroller' : 'scroller');
/** Drawer destinations by menu item id; add an entry here (and in menu.js) for new screens. */
const destinations = { 'manage-categories': () => openManageCategories(), settings: () => openSettings() };

const drawer = createDrawer({
  drawer: $('drawer'), scrim: $('drawer-scrim'), list: $('drawer-items'), openButton: $('menu-open'),
  background: [$('app-bar'), $('scroller'), $('all-scroller'), $('settings-scroller'), $('categories-scroller'), document.querySelector('.tab-bar')],
  items: MENU_ITEMS, label: (item) => t(item.labelKey), renderIcon: (name) => svgIcon(name),
  isBlocked: () => motion.busy || allState.busy || nav.page !== null,
  onSelect: (id) => destinations[id]?.(),
});

let settingsInfo = {};
let theme = loadTheme();

function renderSettings(info = settingsInfo) {
  settingsInfo = info;
  const sections = buildSettingsSections({ ...info, theme, appLock: appLock.enabled, sizeLimitMb: getSizeLimitMb(), plan: planInfo(), usage: planUsage(), formatDate: formatPlanDate, languageName: t(`lang.name.${getLanguage()}`) });
  $('settings-list').replaceChildren(...sections.map((sec) => el('section', { class: 'settings-section', 'aria-label': sec.title },
    el('h2', {}, sec.title),
    el('ul', { class: 'settings-rows' }, ...sec.rows.map((r) => {
      if (r.select) { // dropdown row (Document Size Limit)
        const id = `setting-${r.id}`;
        const select = el('select', { class: 'settings-select', id, 'data-setting': r.id, 'aria-label': `${r.label}. ${r.description ?? ''}` },
          ...r.select.options.map((o) => el('option', { value: String(o.value) }, o.label)));
        select.value = String(r.select.value);
        return el('li', { class: 'settings-field' },
          el('label', { class: 'settings-selectrow', for: id },
            el('span', { class: 'settings-icon' }, svgIcon(r.icon)),
            el('span', { class: 'settings-text' }, el('span', { class: 'settings-label' }, r.label), el('span', { class: 'settings-desc' }, r.description ?? '')),
            select));
      }
      if (r.toggle) { // on/off switch row (App Lock)
        return el('li', {}, el('button', { type: 'button', class: 'settings-switch', role: 'switch', 'data-action': r.action, 'aria-checked': String(r.checked), 'aria-label': `${r.label}. ${r.description ?? ''}` },
          el('span', { class: 'settings-icon' }, svgIcon(r.icon)),
          el('span', { class: 'settings-text' }, el('span', { class: 'settings-label' }, r.label), el('span', { class: 'settings-desc' }, r.description ?? '')),
          el('span', { class: 'switch-track', 'aria-hidden': 'true' })));
      }
      if (r.action) { // tappable row (icon, title, description, current value)
        const btn = el('button', { type: 'button', class: 'settings-action', 'data-action': r.action, 'aria-label': `${r.label}: ${r.value ?? ''}. ${r.description ?? ''}` },
          el('span', { class: 'settings-icon' }, svgIcon(r.icon)),
          el('span', { class: 'settings-text' }, el('span', { class: 'settings-label' }, r.label), el('span', { class: 'settings-desc' }, r.description ?? '')),
          el('span', { class: 'settings-value' }, r.value ?? ''), svgIcon('chevron', 'settings-chevron'));
        return el('li', {}, btn);
      }
      return el('li', { class: 'settings-row' }, el('span', { class: 'settings-label' }, r.label), r.value ? el('span', { class: 'settings-value' }, r.value) : document.createTextNode(''));
    })))));
}

/* ---------- Manage Categories ---------- */

const catUi = { editing: null, icon: DEFAULT_CATEGORY_ICON, saving: false, deleting: null };

async function refreshManageList() {
  const cats = await service.listCategoriesWithCounts();
  $('cat-list').replaceChildren(...cats.map((c) => {
    const row = el('li', { class: 'cat-row', 'data-category-id': String(c.id) },
      el('span', { class: 'category-icon' }, svgIcon(c.icon)),
      el('span', { class: 'cat-row-text' },
        el('span', { class: 'cat-row-name' }, categoryLabel(c)),
        el('span', { class: 'cat-row-sub' }, `${plural(c.docCount)} · ${c.isCustom ? t('manage.custom') : t('manage.builtin')}`)));
    if (c.isCustom) {
      const edit = el('button', { type: 'button', class: 'icon-btn', 'data-cat-action': 'edit', 'aria-label': t('manage.edit', { name: c.name }), title: t('common.edit') });
      edit.append(svgIcon('edit'));
      const del = el('button', { type: 'button', class: 'icon-btn danger', 'data-cat-action': 'delete', 'aria-label': t('manage.delete', { name: c.name }), title: t('common.delete') });
      del.append(svgIcon('delete'));
      row.append(edit, del);
    }
    return row;
  }));
  catUi.cache = cats;
}

/** Everything that shows categories re-reads them from the repository (single source of truth). */
async function categoriesChanged() {
  tabs.allDirty = true; // All Documents headings / counts
  await buildDashboard();
  await refreshManageList();
  renderSettings();
}

function setCatError(msg) {
  $('cd-error').textContent = msg;
  $('cd-error').hidden = !msg;
  $('cd-name').setAttribute('aria-invalid', String(Boolean(msg)));
}

function renderIconGrid() {
  $('cd-icons').replaceChildren(...CATEGORY_ICON_CHOICES.map((c) => {
    const b = el('button', { type: 'button', class: 'icon-choice', role: 'radio', 'aria-checked': String(c.key === catUi.icon), 'aria-label': t(`icon.${c.key}`), title: t(`icon.${c.key}`), 'data-icon': c.key });
    b.append(svgIcon(c.key));
    return b;
  }));
  $('cd-preview-icon').replaceChildren(svgIcon(catUi.icon));
}

function updateCatPreview() {
  const name = $('cd-name').value.replace(/\s+/g, ' ').trim();
  $('cd-preview-name').textContent = name || t('cd.previewDefault');
}

function openCategoryDialog(cat = null) {
  if ($('cat-dialog').open) return;
  catUi.editing = cat;
  catUi.icon = cat?.icon ?? DEFAULT_CATEGORY_ICON; // folder unless editing
  $('cd-title').textContent = cat ? t('cd.titleEdit') : t('cd.titleAdd');
  $('cd-save').textContent = t('cd.save');
  $('cd-name').value = cat?.name ?? '';
  setCatError('');
  renderIconGrid();
  updateCatPreview();
  $('cat-dialog').showModal();
  $('cd-name').focus({ preventScroll: true });
}

function closeCategoryDialog() {
  if (catUi.saving) return;
  if ($('cat-dialog').open) $('cat-dialog').close();
  catUi.editing = null; // unsaved changes are discarded
}

async function submitCategory(e) {
  e.preventDefault();
  if (catUi.saving) return; // no repeated submissions
  catUi.saving = true;
  $('cd-save').disabled = true; $('cd-cancel').disabled = true;
  $('cd-save').textContent = t('cd.saving');
  try {
    const wasEdit = Boolean(catUi.editing);
    const payload = { name: $('cd-name').value, icon: catUi.icon };
    if (wasEdit) await service.updateCategory(catUi.editing.id, payload); else await service.createCategory(payload);
    catUi.saving = false;
    closeCategoryDialog();
    await categoriesChanged();
    showMessage(wasEdit ? t('cd.updated') : t('cd.created'));
  } catch (err) {
    setCatError(err?.code && String(err.code).match(/CATEGORY|ICON/) ? errorText(err) : t('cd.saveFailed'));
    if (!err?.code) console.error('MyDocs category error:', err?.name || 'error');
    $('cd-name').focus({ preventScroll: true });
  } finally {
    catUi.saving = false;
    $('cd-save').disabled = false; $('cd-cancel').disabled = false;
    $('cd-save').textContent = t('cd.save');
  }
}

function openDeleteCategory(cat) {
  catUi.deleting = cat;
  $('cdel-title').textContent = t('cdel.title', { name: cat.name });
  $('cdel-error').hidden = true;
  const others = (catUi.cache ?? []).filter((c) => c.id !== cat.id);
  if (cat.docCount > 0) {
    $('cdel-text').textContent = t('cdel.withDocs', { docs: plural(cat.docCount) });
    $('cdel-target').replaceChildren(...others.map((c) => el('option', { value: String(c.id) }, categoryLabel(c))));
    $('cdel-move').hidden = false;
    $('cdel-confirm').textContent = t('cdel.moveAndDelete');
  } else {
    $('cdel-text').textContent = t('cdel.empty');
    $('cdel-move').hidden = true;
    $('cdel-confirm').textContent = t('common.delete');
  }
  $('cdel-dialog').showModal();
  $('cdel-cancel').focus({ preventScroll: true });
}

async function confirmDeleteCategory() {
  const cat = catUi.deleting;
  if (!cat || catUi.saving) return;
  catUi.saving = true;
  $('cdel-confirm').disabled = true;
  try {
    await service.deleteCategory(cat.id, cat.docCount > 0 ? { moveTo: Number($('cdel-target').value) } : {});
    $('cdel-dialog').close();
    catUi.deleting = null;
    await categoriesChanged();
    showMessage(cat.docCount > 0 ? t('cdel.deletedMoved', { docs: plural(cat.docCount) }) : t('cdel.deleted'));
  } catch (err) {
    $('cdel-error').textContent = errorText(err, 'cdel.failed');
    $('cdel-error').hidden = false;
  } finally {
    catUi.saving = false;
    $('cdel-confirm').disabled = false;
  }
}

function wireCategories() {
  $('cat-add').addEventListener('click', () => openCategoryDialog());
  $('cd-cancel').addEventListener('click', closeCategoryDialog);
  $('cat-dialog').addEventListener('cancel', (e) => { if (catUi.saving) e.preventDefault(); else catUi.editing = null; });
  $('cat-form').addEventListener('submit', submitCategory);
  $('cd-name').addEventListener('input', () => { setCatError(''); updateCatPreview(); });
  $('cd-icons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-icon]');
    if (!b) return;
    catUi.icon = b.dataset.icon;
    for (const x of $('cd-icons').children) x.setAttribute('aria-checked', String(x === b));
    $('cd-preview-icon').replaceChildren(svgIcon(catUi.icon));
  });
  $('cd-icons').addEventListener('keydown', (e) => { // arrow keys move the selection like a radio group
    const items = [...$('cd-icons').children];
    const i = items.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowDown: 5, ArrowLeft: -1, ArrowUp: -5 }[e.key];
    if (i < 0 || !step) return;
    e.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, i + step))];
    next.focus(); next.click();
  });
  $('cat-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat-action]');
    const id = Number(btn?.closest('[data-category-id]')?.dataset.categoryId);
    const cat = (catUi.cache ?? []).find((c) => c.id === id);
    if (!btn || !cat) return;
    if (btn.dataset.catAction === 'edit') openCategoryDialog(cat); else openDeleteCategory(cat);
  });
  $('cdel-cancel').addEventListener('click', () => { if (!catUi.saving) $('cdel-dialog').close(); });
  $('cdel-confirm').addEventListener('click', confirmDeleteCategory);
}

/** Applies and stores a theme right away; every screen updates through the CSS tokens (no restart, no re-render). */
function setTheme(next) {
  theme = applyTheme(next, { animate: true });
  saveTheme(theme);
  renderSettings();
  renderThemeOptions();
}

function renderThemeOptions() {
  $('th-options').replaceChildren(...THEME_OPTIONS.map((o) => {
    const input = el('input', { type: 'radio', name: 'theme', value: o.id, 'aria-label': t('theme.aria', { label: t(o.labelKey), desc: t(o.descKey) }) });
    input.checked = o.id === theme;
    return el('label', { class: `theme-option${o.id === theme ? ' selected' : ''}`, 'data-theme-option': o.id },
      el('span', { class: 'settings-icon' }, svgIcon(o.icon)),
      el('span', { class: 'settings-text' }, el('strong', {}, t(o.labelKey)), el('span', { class: 'settings-desc' }, t(o.descKey))),
      ...(o.id === theme ? [el('span', { class: 'theme-selected-mark' }, t('theme.selected'))] : []),
      input);
  }));
}

function openThemeDialog() {
  if ($('theme-dialog').open) return;
  renderThemeOptions();
  $('theme-dialog').showModal();
  $('th-options').querySelector('input:checked')?.focus({ preventScroll: true });
}

/* ---------- Plan, Upgrade to Pro and promo codes (the rules live in access.js / entitlements.js; this is only the screen) ---------- */

const DEVICE_ID_KEY = 'mydocs.deviceId';
let deviceIdValue = '';
const deviceId = () => deviceIdValue;
let billing = null; // createBilling (Google Play) - null when no Play plugin exists
let promo = null; // createPromoClient
const upgradeUi = { busy: false, product: null, productLoading: false };

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** A stable per-install identity: the native one when available (survives reinstall), else a random id kept in storage. */
async function resolveDeviceId(plugin) {
  try { const r = await plugin?.deviceId?.(); if (r?.deviceId) return String(r.deviceId); } catch { /* fall back below */ }
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!/^[0-9a-f]{32}$/.test(id ?? '')) { id = randomHex(); localStorage.setItem(DEVICE_ID_KEY, id); }
    return id;
  } catch { return randomHex(); }
}

/** Where the promo server is: BACKEND_URL, or (testing only, loopback addresses only) the value in localStorage "mydocs.devApiBase". */
function backendUrl() {
  try {
    const dev = localStorage.getItem('mydocs.devApiBase');
    if (dev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(dev)) return dev;
  } catch { /* storage unavailable */ }
  return BACKEND_URL;
}

const formatPlanDate = (ms) => new Date(ms).toLocaleDateString(getLanguage() === 'hi' ? 'hi-IN' : 'en-GB', { dateStyle: 'long' });

let usedDocuments = null;
/** Remaining Basic capacity for display: re-counted from the database when a screen that shows it opens or the plan changes. */
function planUsage() {
  if (usedDocuments === null || access.isPro()) return null;
  const max = BASIC_LIMITS.maxDocuments;
  return { used: usedDocuments, max, left: Math.max(0, max - usedDocuments) };
}
async function refreshUsage() {
  try { usedDocuments = await service.countDocuments(); } catch { usedDocuments = null; }
  renderSettings();
  renderUpgradePage();
}

function planInfo() { return entitlements?.effective() ?? { plan: PLAN.BASIC, source: 'none', lifetime: false, expiresAt: null }; }

function planTexts() {
  const p = planInfo();
  if (p.plan !== PLAN.PRO) return { title: t('up.currentBasic'), desc: planUsage() ? t('plan.usage', planUsage()) : t('plan.descBasic') };
  if (p.source === 'play') return { title: t('up.currentProPlay'), desc: t('plan.descProLifetime') };
  if (p.lifetime) return { title: t('up.currentProPromoLifetime'), desc: t('plan.descProLifetime') };
  return { title: t('up.currentProPromo'), desc: t('plan.descProUntil', { date: formatPlanDate(p.expiresAt) }) };
}

function setUpStatus(text, kind = 'info') {
  const s = $('up-status');
  s.textContent = text ?? '';
  s.hidden = !text;
  s.dataset.kind = kind;
}

function renderUpgradePage() {
  const { title, desc } = planTexts();
  $('up-plan').textContent = title;
  $('up-plan-desc').textContent = desc;
  const p = planInfo();
  const ownsPlay = p.plan === PLAN.PRO && p.source === 'play';
  $('up-buy-card').hidden = ownsPlay; // a purchased lifetime Pro needs no purchase button
  const product = upgradeUi.product;
  $('up-product').textContent = product ? product.name : '';
  $('up-product').hidden = !product;
  $('up-buy').textContent = product ? t('up.buyPrice', { price: product.price }) : t('up.buy');
  for (const id of ['up-buy', 'up-restore', 'up-redeem']) $(id).disabled = upgradeUi.busy;
  $('up-code').disabled = upgradeUi.busy;
}

function setUpgradeBusy(on, text) {
  upgradeUi.busy = on;
  if (text) setUpStatus(text);
  renderUpgradePage();
}

/** Reads the product name and the price in the user's currency from Google Play (nothing is hard-coded). */
async function loadUpgradeProduct() {
  if (!billing || upgradeUi.productLoading || upgradeUi.product) return;
  upgradeUi.productLoading = true;
  setUpStatus(t('up.loading'));
  try {
    upgradeUi.product = await billing.loadProduct();
    setUpStatus('');
  } catch (err) {
    setUpStatus(errorText(err), 'error');
  } finally {
    upgradeUi.productLoading = false;
    renderUpgradePage();
  }
}

async function buyPro() {
  if (upgradeUi.busy) return;
  setUpgradeBusy(true, t('up.purchasing'));
  try {
    if (!billing) throw new BillingError('UNAVAILABLE', 'Google Play purchases are not available on this device or in this build.');
    const result = await billing.purchase();
    setUpStatus(result.status === 'purchased' ? t('up.purchased') : result.status === 'pending' ? t('up.pending') : t('up.cancelled'), result.status === 'purchased' ? 'success' : 'info');
  } catch (err) {
    console.error('MyDocs purchase error:', err?.code || err?.name || 'error');
    setUpStatus(errorText(err), 'error');
  } finally {
    setUpgradeBusy(false);
  }
}

async function restorePurchases() {
  if (upgradeUi.busy) return;
  setUpgradeBusy(true, t('up.restoring'));
  try {
    let status = 'none';
    let playError = null;
    try { status = billing ? (await billing.restore()).status : 'none'; } catch (err) { playError = err; }
    if (status === 'restored') { setUpStatus(t('up.restored'), 'success'); return; }
    let promoRestored = 0;
    try { promoRestored = promo ? await promo.restore() : 0; } catch { /* promo server not reachable / configured: not an error for a restore */ }
    if (promoRestored > 0) setUpStatus(t('up.restoredPromo'), 'success');
    else if (playError) setUpStatus(errorText(playError), 'error');
    else setUpStatus(status === 'pending' ? t('up.pending') : t('up.none'));
  } finally {
    setUpgradeBusy(false);
  }
}

async function redeemPromo() {
  if (upgradeUi.busy) return;
  setUpgradeBusy(true, t('up.redeeming'));
  try {
    const result = await promo.redeem($('up-code').value);
    $('up-code').value = '';
    setUpStatus(result.expiresAt == null ? t('up.promoLifetime') : t('up.promoOk', { date: formatPlanDate(result.expiresAt) }), 'success');
  } catch (err) {
    if (!(err instanceof PromoError)) console.error('MyDocs promo error:', err?.code || err?.name || 'error');
    setUpStatus(errorText(err, 'err.promoServer'), 'error');
  } finally {
    setUpgradeBusy(false);
  }
}

/** Explains which Pro feature was needed and offers Upgrade / Redeem; shown only after the user tried something, never on its own. */
function showProPrompt(text) {
  if ($('pro-dialog').open) return;
  $('pr-text').textContent = text;
  $('pro-dialog').showModal();
  $('pr-upgrade').focus({ preventScroll: true });
}

function closeProPrompt() { if ($('pro-dialog').open) $('pro-dialog').close(); }

function wireUpgrade() {
  $('up-buy').addEventListener('click', buyPro);
  $('up-restore').addEventListener('click', restorePurchases);
  $('up-redeem').addEventListener('click', redeemPromo);
  $('up-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); redeemPromo(); } });
  $('pr-close').addEventListener('click', closeProPrompt);
  $('pr-upgrade').addEventListener('click', () => { closeProPrompt(); openUpgradePage(); });
  $('pr-redeem').addEventListener('click', () => { closeProPrompt(); openUpgradePage(); $('up-code').focus({ preventScroll: true }); });
}

/** Upgrade to Pro sits under Settings, but can also be opened from a main tab (e.g. from a "Pro required" prompt). */
function openUpgradePage() {
  if (nav.page === 'upgrade' || motion.busy || allState.busy) return;
  if (nav.page === 'backup') pageBack(); // back to Settings first
  if (nav.page === 'categories') return;
  if (nav.page === null) { openPage('settings'); if (nav.page !== 'settings') return; nav.upgradeFromTab = true; } else nav.upgradeFromTab = false;
  nav.page = 'upgrade';
  $('settings-scroller').hidden = true;
  $('upgrade-scroller').hidden = false;
  $('upgrade-scroller').scrollTop = 0;
  $('app-title').textContent = t('up.title');
  setUpStatus('');
  renderUpgradePage();
  refreshUsage();
  loadUpgradeProduct();
  $('page-back').focus({ preventScroll: true });
}

/* ---------- Backup & Restore (logic in backup.js / drive.js; this is only the screen) ---------- */

const LAST_BACKUP_KEY = 'mydocs.lastBackup';
const backupUi = { busy: false, cancel: false, created: null, picked: null, info: null };
let backup; // createBackupService (device) or the preview stand-in
let backupFiles; // { scratch, saveToDevice, pickBackup, ... }
let drive; // Google Drive client

const loadLastBackup = () => { try { return localStorage.getItem(LAST_BACKUP_KEY); } catch { return null; } };
const formatDateTime = (iso) => new Date(iso).toLocaleString(getLanguage() === 'hi' ? 'hi-IN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function renderBackupPage() {
  const last = loadLastBackup();
  $('bk-last').textContent = last ? t('bk.last', { date: formatDateTime(last) }) : t('bk.lastNone');
}

/** Only called after the backup has really been saved or Google Drive has confirmed the upload. */
function recordBackup() {
  try { localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch { /* the date is only informational */ }
  renderBackupPage();
}

function backupStageText(p) {
  switch (p.stage) {
    case 'collect': return t('bk.p.collect');
    case 'create': return t('bk.p.create', { done: Math.min(p.done + 1, p.total), total: p.total });
    case 'validate': return t('bk.p.validate');
    case 'restore': return t('bk.p.restore', { done: p.done, total: p.total });
    case 'sign-in': return t('bk.p.signin');
    case 'folder': return t('bk.p.folder');
    case 'upload': return t('bk.p.upload', { percent: Math.floor((p.done / p.total) * 100) });
    default: return t('bk.p.prepare');
  }
}

function showBackupProgress(text, { cancellable = false } = {}) {
  $('bkp-text').textContent = text;
  $('bkp-cancel').hidden = !cancellable;
  $('bkp-cancel').disabled = false;
  $('bkp-bar').hidden = true;
  if (!$('bk-progress-dialog').open) $('bk-progress-dialog').showModal();
}
function updateBackupProgress(p) {
  $('bkp-text').textContent = backupStageText(p);
  const percent = p.total ? Math.floor(((p.done ?? 0) / p.total) * 100) : null;
  $('bkp-bar').hidden = percent === null;
  if (percent !== null) $('bkp-bar').value = percent;
}
const closeBackupProgress = () => { if ($('bk-progress-dialog').open) $('bk-progress-dialog').close(); };

function setBackupBusy(on) {
  backupUi.busy = on;
  $('bk-create').disabled = on;
  $('bk-restore').disabled = on;
}

async function startBackup() {
  if (backupUi.busy) return;
  setBackupBusy(true);
  backupUi.cancel = false;
  showBackupProgress(t('bk.p.prepare'), { cancellable: true });
  try {
    const created = await backup.createBackup({ onProgress: updateBackupProgress, shouldCancel: () => backupUi.cancel });
    closeBackupProgress();
    openBackupReady(created);
  } catch (err) {
    closeBackupProgress();
    if (err?.code !== 'BACKUP_CANCELLED') { console.error('MyDocs backup error:', err?.code || err?.name || 'error'); showMessage(errorText(err, 'err.bkFailed')); }
  } finally {
    setBackupBusy(false);
  }
}

function openBackupReady(created) {
  backupUi.created = created;
  $('bkr-file').textContent = t('bk.ready.file', { name: created.fileName, size: formatSizeText(created.size) });
  $('bkr-summary').textContent = t('bk.ready.summary', { categories: created.summary.categories, documents: created.summary.documents });
  $('bkr-warn').hidden = !created.missingFiles;
  if (created.missingFiles) $('bkr-warn').textContent = t('bk.ready.warn', { n: created.missingFiles });
  setReadyStatus('');
  $('bkr-device').disabled = false;
  $('bkr-drive').disabled = false;
  $('bk-ready-dialog').showModal();
}

function setReadyStatus(text) {
  $('bkr-status').textContent = text;
  $('bkr-status').hidden = !text;
}

/** Deletes the temporary backup file (the user either has the backup now, or chose to leave without one). */
async function discardCreatedBackup() {
  const created = backupUi.created;
  backupUi.created = null;
  if (created) await backupFiles.scratch.remove(created.path).catch(() => {});
}

async function finishBackup(message) {
  $('bk-ready-dialog').close();
  await discardCreatedBackup();
  showMessage(message);
}

async function saveBackupToDevice() {
  const created = backupUi.created;
  if (!created || backupUi.busy) return;
  setBackupBusy(true);
  $('bkr-device').disabled = true; $('bkr-drive').disabled = true;
  try {
    const saved = await backupFiles.saveToDevice({ path: created.path, fileName: created.fileName });
    if (saved) { recordBackup(); await finishBackup(`${t('bk.saved')} ${t('bk.done')}`); } else setReadyStatus(t('bk.saveCancelled'));
  } catch (err) {
    console.error('MyDocs save error:', err?.code || err?.name || 'error');
    setReadyStatus(t('bk.saveFailed'));
  } finally {
    setBackupBusy(false);
    if ($('bk-ready-dialog').open) { $('bkr-device').disabled = false; $('bkr-drive').disabled = false; }
  }
}

async function uploadBackupToDrive() {
  const created = backupUi.created;
  if (!created || backupUi.busy) return;
  setBackupBusy(true);
  backupUi.cancel = false;
  $('bkr-device').disabled = true; $('bkr-drive').disabled = true;
  setReadyStatus(t('bk.p.signin'));
  try {
    const res = await drive.upload({
      name: created.fileName, size: created.size,
      readRange: (offset, length) => backupFiles.scratch.read(created.path, offset, length),
      onProgress: (p) => setReadyStatus(backupStageText(p)),
      shouldCancel: () => backupUi.cancel,
    });
    recordBackup(); // Drive has confirmed the file
    await finishBackup(`${t('bk.uploaded', { name: res.name, folder: res.folder })} ${t('bk.done')}`);
  } catch (err) {
    if (err?.code !== 'DRIVE_CANCELED') console.error('MyDocs Drive error:', err?.code || err?.name || 'error');
    setReadyStatus(`${errorText(err, 'err.driveFailed')}`); // the local backup is kept, the buttons stay available for a retry
  } finally {
    setBackupBusy(false);
    if ($('bk-ready-dialog').open) { $('bkr-device').disabled = false; $('bkr-drive').disabled = false; }
  }
}

function closeBackupReady() {
  if (backupUi.busy) { backupUi.cancel = true; return; } // an upload in progress is cancelled between chunks
  if ($('bk-ready-dialog').open) $('bk-ready-dialog').close();
  discardCreatedBackup();
}

/* restore */

async function startRestore() {
  if (backupUi.busy) return;
  setBackupBusy(true);
  showBackupProgress(t('bk.p.reading'));
  try {
    const picked = await backupFiles.pickBackup(); // system file picker; the file is copied into the cache folder
    if (!picked) { closeBackupProgress(); return; }
    let info;
    try { info = await backup.inspect(picked.path); } catch (err) {
      closeBackupProgress();
      await backupFiles.scratch.remove(picked.path).catch(() => {});
      showMessage(errorText(err, 'err.bkInvalid'));
      return;
    }
    closeBackupProgress();
    backupUi.picked = picked;
    backupUi.info = info;
    openRestoreDialog(picked, info);
  } catch (err) {
    closeBackupProgress();
    console.error('MyDocs restore error:', err?.code || err?.name || 'error');
    showMessage(t('bk.pickFailed'));
  } finally {
    setBackupBusy(false);
  }
}

function selectedRestoreMode() {
  return document.querySelector('input[name="bk-mode"]:checked')?.value ?? 'replace';
}

function syncRestoreMode() {
  const mode = selectedRestoreMode();
  for (const label of document.querySelectorAll('.bk-mode')) label.classList.toggle('selected', label.dataset.mode === mode);
  $('bks-confirm').textContent = mode === 'merge' ? t('bk.rs.confirmMerge') : t('bk.rs.confirmReplace');
  $('bks-confirm').classList.toggle('danger-fill', mode === 'replace');
  $('bks-confirm').classList.toggle('filled', mode === 'merge');
}

function openRestoreDialog(picked, info) {
  $('bks-file').textContent = t('bk.rs.file', { name: picked.name });
  $('bks-created').textContent = t('bk.rs.created', { date: formatDateTime(info.createdAt) });
  $('bks-summary').textContent = t('bk.rs.summary', { categories: info.categories, custom: info.customCategories, documents: info.documents });
  $('bks-missing').hidden = !info.withoutFile;
  if (info.withoutFile) $('bks-missing').textContent = t('bk.rs.missing', { n: info.withoutFile });
  $('bks-error').hidden = true;
  document.querySelector('input[name="bk-mode"][value="replace"]').checked = true;
  $('bks-safety').checked = true;
  syncRestoreMode();
  $('bk-restore-dialog').showModal();
}

function closeRestoreDialog() {
  if ($('bk-restore-dialog').open) $('bk-restore-dialog').close();
  const picked = backupUi.picked;
  backupUi.picked = null;
  if (picked) backupFiles.scratch.remove(picked.path).catch(() => {});
}

/** Everything on screen is rebuilt from the restored database (ids may now mean different categories). */
async function refreshAfterRestore() {
  selection.clear();
  tabs.allDirty = true;
  cards.clear();
  view.docs.clear();
  view.categoryId = null;
  $('dashboard-view').hidden = false;
  $('category-view').hidden = true;
  await buildDashboard();
  renderSettings();
  updateSelectionUI();
}

async function runRestore() {
  const picked = backupUi.picked;
  if (!picked || backupUi.busy) return;
  const mode = selectedRestoreMode();
  const wantsSafety = $('bks-safety').checked;
  $('bk-restore-dialog').close();
  setBackupBusy(true);
  try {
    if (wantsSafety) { // the current data is saved first; if that does not happen, nothing is restored
      backupUi.cancel = false;
      showBackupProgress(t('bk.p.safety'));
      const safety = await backup.createBackup({ onProgress: updateBackupProgress });
      closeBackupProgress();
      let saved = false;
      try { saved = await backupFiles.saveToDevice({ path: safety.path, fileName: safety.fileName.replace('MyDocs_Backup_', 'MyDocs_SafetyBackup_') }); } finally { await backupFiles.scratch.remove(safety.path).catch(() => {}); }
      if (!saved) { showMessage(t('bk.rs.safetyCancelled')); return; }
    }
    showBackupProgress(t('bk.rs.working'));
    const result = await backup.restore(picked.path, { mode, onProgress: updateBackupProgress });
    await refreshAfterRestore();
    closeBackupProgress();
    showMessage(mode === 'merge'
      ? t('bk.rs.doneMerge', { documents: result.addedDocuments, categories: result.addedCategories })
      : t('bk.rs.doneReplace', { documents: result.documents, categories: result.categories }));
  } catch (err) {
    closeBackupProgress();
    console.error('MyDocs restore error:', err?.code || err?.name || 'error');
    showMessage(errorText(err, 'err.bkRestoreFailed'));
  } finally {
    backupUi.picked = null;
    await backupFiles.scratch.remove(picked.path).catch(() => {});
    setBackupBusy(false);
  }
}

function wireBackup() {
  $('bk-create').addEventListener('click', startBackup);
  $('bk-restore').addEventListener('click', startRestore);
  $('bkp-cancel').addEventListener('click', () => { backupUi.cancel = true; $('bkp-cancel').disabled = true; });
  $('bk-progress-dialog').addEventListener('cancel', (e) => e.preventDefault()); // cannot be dismissed while working
  $('bkr-device').addEventListener('click', saveBackupToDevice);
  $('bkr-drive').addEventListener('click', uploadBackupToDrive);
  $('bkr-close').addEventListener('click', closeBackupReady);
  $('bk-ready-dialog').addEventListener('cancel', (e) => { e.preventDefault(); closeBackupReady(); });
  $('bks-cancel').addEventListener('click', closeRestoreDialog);
  $('bk-restore-dialog').addEventListener('cancel', (e) => { e.preventDefault(); closeRestoreDialog(); });
  $('bks-confirm').addEventListener('click', runRestore);
  for (const radio of document.querySelectorAll('input[name="bk-mode"]')) radio.addEventListener('change', syncRestoreMode);
}

/** The settings sub-page: Settings -> Backup & Restore (Back returns to Settings). */
function openBackupPage() {
  if (nav.page !== 'settings') return;
  if (!access.canUse('backup')) { showProPrompt(t('err.proBackup')); return; } // Basic: explained, not opened
  nav.page = 'backup';
  $('settings-scroller').hidden = true;
  $('backup-scroller').hidden = false;
  $('backup-scroller').scrollTop = 0;
  $('app-title').textContent = t('bk.title');
  renderBackupPage();
  $('page-back').focus({ preventScroll: true });
}

/* ---------- Language ---------- */

function renderLanguageOptions() {
  const current = getLanguage();
  $('lg-options').replaceChildren(...LANGUAGES.map((l) => {
    const input = el('input', { type: 'radio', name: 'language', value: l.id, 'aria-label': `${t(l.nameKey)} (${t(l.subKey)})` });
    input.checked = l.id === current;
    return el('label', { class: `lang-option${l.id === current ? ' selected' : ''}`, 'data-language-option': l.id, lang: l.id },
      el('span', { class: 'settings-text' }, el('strong', {}, t(l.nameKey)), el('span', { class: 'settings-desc', lang: 'en' }, t(l.subKey))),
      ...(l.id === current ? [el('span', { class: 'theme-selected-mark' }, t('theme.selected'))] : []),
      input);
  }));
}

function openLanguageDialog() {
  if ($('lang-dialog').open) return;
  renderLanguageOptions();
  $('lang-dialog').showModal();
  $('lg-options').querySelector('input:checked')?.focus({ preventScroll: true });
}

/** Text of whatever page is showing (not stored data): used after a language change. */
function currentTitle() {
  return nav.page ? t(PAGES[nav.page].titleKey) : 'MyDocs';
}

/**
 * Re-renders every piece of app-controlled text in the new language without reloading: static HTML (data-i18n),
 * drawer, titles, settings, cards, the open category, Manage Categories and the All Documents list. Documents,
 * file names and custom category names are data and are rendered exactly as stored.
 */
function refreshLanguageUI() {
  applyStaticTranslations();
  drawer.refreshLabels();
  $('app-title').textContent = currentTitle();
  renderSettings();
  for (const entry of cards.values()) {
    entry.cardEl.querySelector('.cat-name').textContent = categoryLabel(entry.cat);
    updateCardCount(entry, entry.count);
  }
  if (view.categoryId != null && cards.has(view.categoryId)) renderCategoryView();
  const banner = $('banner');
  if (!banner.hidden) banner.textContent = t('banner.preview');
  tabs.allDirty = true; // headings / counts / aria text are rebuilt when the list is next shown
  if (tabs.current === 'all' && !nav.page) refreshAllDocuments().catch(() => {});
  updateSelectionUI();
  if (nav.page === 'categories') refreshManageList();
  if (appLock.locked) { setLockMessage(t('lock.msg'), false); $('lock-unlock').textContent = t('lock.unlock'); }
  renderBackupPage();
  renderUpgradePage();
}

/** Applies and stores the document size limit right away: the next upload or capture is judged against it. */
function setDocumentSizeLimit(value) {
  if (Number(value) > BASIC_LIMITS.maxSizeMb && !access.canUse('sizeOptions')) { renderSettings(); showProPrompt(t('err.proSize')); return; }
  const mb = setSizeLimitMb(value);
  saveSizeLimitMb(mb);
  renderSettings();
  showMessage(t('limit.changed', { limit: `${mb} MB` }));
}

/** Applies and stores the language right away (no restart); the choice is read again on every launch. */
function setAppLanguage(next) {
  const id = setLanguage(next);
  saveLanguage(id);
  refreshLanguageUI();
  renderLanguageOptions();
  showMessage(t('lang.changed', { name: t(`lang.name.${id}`) }));
}

/** Drawer pages (Manage Categories, Settings): one page at a time, opened from either tab, Back returns to that tab. */
const PAGES = { settings: { titleKey: 'menu.settings', scroller: 'settings-scroller' }, categories: { titleKey: 'menu.manageCategories', scroller: 'categories-scroller' }, backup: { titleKey: 'bk.title', scroller: 'backup-scroller' }, upgrade: { titleKey: 'up.title', scroller: 'upgrade-scroller' } };

function openPage(name) {
  if (nav.page === name || motion.busy || allState.busy) return; // repeated taps do nothing
  if (nav.page !== null) return; // pages are only reachable from a main tab (the drawer is blocked on a page)
  if (search.active) closeSearch();
  nav.page = name;
  nav.returnTab = tabs.current;
  nav.returnScroll = scrollerOf(tabs.current).scrollTop;
  scrollerOf(tabs.current).hidden = true;
  $(PAGES[name].scroller).hidden = false;
  document.body.classList.add('page-settings');
  $('page-back').hidden = false;
  $('app-title').textContent = t(PAGES[name].titleKey);
  drawer.setActive(name === 'categories' ? 'manage-categories' : 'settings');
}

function openSettings() {
  openPage('settings');
  refreshUsage();
  if (nav.page !== 'settings') return;
  $('settings-scroller').scrollTop = 0;
  $('page-back').focus({ preventScroll: true });
}

/** Back arrow / Android Back on a drawer page: returns to the tab (and scroll position) it was opened from. */
function pageBack() {
  if (nav.page === 'upgrade') { // Upgrade to Pro: back to Settings, or straight to the tab it was opened from
    $('upgrade-scroller').hidden = true;
    nav.page = 'settings';
    $('settings-scroller').hidden = false;
    $('app-title').textContent = t('menu.settings');
    if (nav.upgradeFromTab) closeSettings();
    return;
  }
  if (nav.page === 'backup') { // Backup & Restore sits under Settings
    nav.page = 'settings';
    $('backup-scroller').hidden = true;
    $('settings-scroller').hidden = false;
    $('app-title').textContent = t('menu.settings');
    return;
  }
  closeSettings();
}

async function openManageCategories() {
  openPage('categories');
  if (nav.page !== 'categories') return;
  $('cat-scroller').scrollTop = 0; // only the list scrolls; the Add button stays fixed
  await refreshManageList();
  $('cat-add').focus({ preventScroll: true });
}

function closeSettings() {
  if (nav.page === null) return;
  $('categories-scroller').hidden = true;
  $('backup-scroller').hidden = true;
  $('upgrade-scroller').hidden = true;
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
  if (nav.returnTab === 'all' && tabs.allDirty) { // categories or the language changed while this tab was hidden
    refreshAllDocuments().then(() => { back.scrollTop = nav.returnScroll; }).catch(() => showMessage(t('all.loadFailed')));
  }
}

/** Capacitor 8 does not handle the system Back button itself: dialogs first, then category -> dashboard, then exit. */
function wireBackButton() {
  const appPlugin = globalThis.Capacitor?.Plugins?.App;
  if (!appPlugin) return;
  appPlugin.addListener('backButton', () => {
    if (appLock.locked) { (appPlugin.minimizeApp ?? appPlugin.exitApp).call(appPlugin); return; } // locked: never navigate behind the lock screen
    if ($('progress-dialog').open) return; // ZIP being prepared
    if (drawer.isOpen()) { drawer.close(); return; }
    if ($('cat-dialog').open) { closeCategoryDialog(); return; }
    if ($('cdel-dialog').open) { if (!catUi.saving) $('cdel-dialog').close(); return; }
    if ($('theme-dialog').open) { $('theme-dialog').close(); return; }
    if ($('lang-dialog').open) { $('lang-dialog').close(); return; }
    if ($('pro-dialog').open) { closeProPrompt(); return; }
    if ($('bk-progress-dialog').open) return; // backup / restore running
    if ($('bk-ready-dialog').open) { closeBackupReady(); return; }
    if ($('bk-restore-dialog').open) { closeRestoreDialog(); return; }
    if ($('viewer-dialog').open) { $('vw-close').click(); return; }
    if ($('name-dialog').open) { if (!saving) closeNameDialog(); return; }
    if ($('preview-dialog').open) { releasePending(); $('preview-dialog').close(); return; }
    if (search.active) { closeSearch(); return; }
    if (nav.page) { pageBack(); return; }
    if (tabs.current === 'all') { if (selection.size) { selection.clear(); updateSelectionUI(); } else switchTab('category'); return; }
    if (view.categoryId != null) { goBack(); return; }
    appPlugin.exitApp();
  });
}

/** Reads the stored entitlement, then keeps size cap, screens and the expiry timer in step with it. Runs before any service is used. */
async function setupEntitlements(playPlugin) {
  deviceIdValue = await resolveDeviceId(playPlugin);
  entitlements = createEntitlements({ publicKey: importPublicKey(SIGNING_PUBLIC_KEY), deviceId, playGraceDays: PLAY_GRACE_DAYS });
  await entitlements.init();
  setSizeCapMb(access.sizeCapMb());
  entitlements.subscribe(() => {
    setSizeCapMb(access.sizeCapMb());
    renderSettings();
    renderUpgradePage();
    if (!access.isPro() && nav.page === 'backup') pageBack(); // Pro ended while Backup & Restore was open
  });
  billing = createBilling({
    plugin: playPlugin, productId: PRO_PRODUCT_ID, entitlements, deviceId, isBackendConfigured,
    config: { mode: PLAY_VERIFY_MODE, backendUrl: backendUrl(), licenseKey: PLAY_LICENSE_KEY },
  });
  promo = createPromoClient({ baseUrl: backendUrl(), deviceId, entitlements });
  let expiryTimer;
  const scheduleExpiry = () => { // a temporary Pro ends on time even while the app stays open
    clearTimeout(expiryTimer);
    const ms = entitlements.msUntilExpiry();
    if (ms !== null) expiryTimer = setTimeout(() => { entitlements.tick(); scheduleExpiry(); }, Math.min(ms + 500, 2_000_000_000));
  };
  entitlements.subscribe(scheduleExpiry);
  scheduleExpiry();
  const recheck = () => { entitlements.tick(); billing.refresh().catch(() => {}); }; // Google Play stays the source of truth
  recheck();
  globalThis.Capacitor?.Plugins?.App?.addListener?.('resume', recheck);
}

async function init() {
  wireEvents();
  wireAppLock();
  wireBackup();
  wireUpgrade();
  // Lock first: with App Lock on, the page is already hidden (lock-init.js) and the system prompt is requested right away.
  if (appLock.start()) setTimeout(promptUnlock, 300);
  await setupEntitlements(isNativePlatform() ? globalThis.Capacitor?.Plugins?.PlayBilling : createMockPlayBilling());
  if (isNativePlatform()) {
    wireBackButton();
    const db = createDatabase(capacitorSqliteDriver());
    await db.init();
    const { storage, picker, viewer, camera, sharer } = capacitorAdapters(undefined, (fn) => appLock.external(fn));
    service = createDocumentService({ db, storage, picker, viewer, camera, sharer, thumbnailer: createThumbnail, access });
    await service.reconcile();
    backupFiles = nativeBackupAdapters(undefined, (fn) => appLock.external(fn));
    await backupFiles.cleanup(); // temporary backup / restore files left by an earlier run
    backup = createBackupService({
      db, storage, scratch: backupFiles.scratch, freeSpace: backupFiles.freeSpace, access,
      afterRestore: async () => { await service.reconcile(); await service.rebuildThumbnails(); },
    });
    drive = createDriveClient({ authorize: backupFiles.authorizeDrive, access });
    globalThis.__mydocsBackup = backup; // device testing aids (not used by the app itself)
    globalThis.__mydocsService = service;
  } else {
    service = createMockService({ access });
    ({ backup, native: backupFiles, drive } = createMockBackup({ access }));
    globalThis.__mydocsEntitlements = entitlements; // browser preview only: lets tests inspect / reset the plan
    globalThis.__mydocsPreview = service; // browser preview only: lets tests inspect the in-memory ZIP
    const b = $('banner');
    b.textContent = t('banner.preview');
    b.hidden = false;
  }
  applyTheme(theme); // idempotent: theme-init.js already set data-theme before first paint
  // Android resets the status-bar icon style while the activity starts and when it returns from the background,
  // so re-apply the saved theme once the app is up and on every resume.
  const reapply = () => applyTheme(theme);
  setTimeout(reapply, 700);
  globalThis.Capacitor?.Plugins?.App?.addListener?.('resume', () => setTimeout(reapply, 150));
  renderSettings();
  globalThis.Capacitor?.Plugins?.App?.getInfo?.().then((info) => renderSettings({ version: info.version, build: info.build })).catch(() => {});
  await buildDashboard();
  renderSettings();
}

init().catch((err) => { console.error('MyDocs init failed:', err?.message); showMessage(t('startup.failed', { message: err?.message || err })); });
