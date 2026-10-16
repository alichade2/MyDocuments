// UI layer: renders the dashboard and wires events to the document service.
import { createDatabase, capacitorSqliteDriver, isNativePlatform } from './database.js';
import { createDocumentService, capacitorAdapters, DEMO_MESSAGE } from './documents.js';
import { createMockService } from './mock.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

// 24x24 icon paths (drawn with fill-rule evenodd), keyed by categories.icon.
const CATEGORY_ICONS = {
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
  gavel: 'M6 2h9l5 5v15H6V2Zm8 1.5V8h4.5L14 3.5ZM9 12h8v1.5H9V12Zm0 3h8v1.5H9V15Z',
  plane: 'M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5Z',
  folder: 'M4 4h6l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  image: 'M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z',
  chevron: 'M7 10l5 5 5-5z',
};
const FILE_TYPES = {
  pdf: { cls: 't-pdf', label: 'PDF' },
  jpg: { cls: 't-img', icon: 'image' }, jpeg: { cls: 't-img', icon: 'image' }, png: { cls: 't-img', icon: 'image' },
  webp: { cls: 't-img', icon: 'image' }, gif: { cls: 't-img', icon: 'image' },
  doc: { cls: 't-doc', label: 'DOC' }, docx: { cls: 't-doc', label: 'DOC' },
  txt: { cls: 't-txt', label: 'TXT' },
};

let service;
/** categoryId -> { cat, open, docs, section, header, countEl, bodyEl, gridHost } */
const rows = new Map();

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
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
  p.setAttribute('d', CATEGORY_ICONS[name] ?? CATEGORY_ICONS.folder);
  svg.append(p);
  return svg;
}

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

function openDoc(doc) {
  if (doc.isDemo) { showMessage(DEMO_MESSAGE); return; } // never pretend a sample file exists
  guarded(() => service.open(doc.id));
}

function renderCard(doc) {
  const type = FILE_TYPES[doc.fileType] ?? { cls: 't-other', label: (doc.fileType || '?').slice(0, 3) };
  const iconEl = el('span', { class: `card-icon ${type.cls}` });
  if (type.icon) iconEl.append(svgIcon(type.icon)); else iconEl.textContent = type.label;
  const meta = [doc.fileType?.toUpperCase(), formatSize(doc.fileSize), doc.updatedAt?.slice(0, 10)].filter(Boolean).join(' · ');
  return el('article', { class: `card${doc.missing ? ' missing' : ''}` },
    el('button', { class: 'card-main', type: 'button', 'aria-label': `${doc.name}${doc.isDemo ? ' (sample)' : ''}`, onclick: () => openDoc(doc) },
      iconEl,
      el('span', { class: 'card-name' }, doc.name),
      el('span', { class: 'card-meta' }, meta),
      ...(doc.isDemo ? [el('span', { class: 'badge' }, 'Sample')] : []),
      ...(doc.missing ? [el('span', { class: 'card-warn' }, 'File missing')] : [])),
    el('div', { class: 'card-actions' },
      el('button', { type: 'button', onclick: () => renameDoc(doc) }, 'Rename'),
      el('button', { type: 'button', class: 'danger', onclick: () => deleteDoc(doc) }, 'Delete')));
}

/** (Re)builds only this category's grid + count. */
function renderDocs(row) {
  row.countEl.textContent = String(row.docs.length);
  row.header.setAttribute('aria-label', `${row.cat.name}, ${row.docs.length} documents`);
  row.gridHost.replaceChildren(row.docs.length
    ? el('div', { class: 'grid' }, ...row.docs.map(renderCard))
    : el('div', { class: 'empty' }, `No documents in ${row.cat.name} yet.`));
}

function buildCategory(cat) {
  const bodyId = `cat-body-${cat.slug}`;
  const countEl = el('span', { class: 'count' });
  const header = el('button', { class: 'category-header', type: 'button', id: `cat-btn-${cat.slug}`, 'aria-expanded': 'false', 'aria-controls': bodyId },
    el('span', { class: 'category-icon' }, svgIcon(cat.icon)),
    el('span', { class: 'category-title' }, cat.name), countEl, svgIcon('chevron', 'chevron'));
  const gridHost = el('div', { class: 'grid-host' });
  const inner = el('div', { class: 'category-inner' },
    el('div', { class: 'toolbar' }, el('button', { class: 'btn filled', type: 'button', onclick: () => addDoc(cat.id) }, 'Add document')),
    gridHost);
  const bodyEl = el('div', { class: 'category-body', id: bodyId, role: 'region', 'aria-labelledby': header.id, inert: '' }, inner);
  const section = el('section', { class: 'category' }, el('h3', { class: 'category-heading' }, header), bodyEl);
  const row = { cat, open: false, docs: [], section, header, countEl, bodyEl, gridHost };
  header.addEventListener('click', () => toggle(row));
  rows.set(cat.id, row);
  return row;
}

function toggle(row) {
  row.open = !row.open;
  row.header.setAttribute('aria-expanded', String(row.open));
  row.section.classList.toggle('open', row.open);
  if (row.open) row.bodyEl.removeAttribute('inert'); else row.bodyEl.setAttribute('inert', '');
}

async function refreshCategory(categoryId) {
  const row = rows.get(categoryId);
  row.docs = await service.list(categoryId);
  renderDocs(row);
}

async function refreshAll() {
  const categories = await service.listCategories();
  const frag = document.createDocumentFragment();
  for (const cat of categories) {
    const row = rows.get(cat.id) ?? buildCategory(cat);
    row.docs = await service.list(cat.id);
    renderDocs(row);
    frag.append(row.section);
  }
  $('categories').replaceChildren(frag);
}

const addDoc = (categoryId) => guarded(async () => {
  const doc = await service.importFromPicker(categoryId);
  if (doc) {
    await refreshCategory(categoryId);
    const row = rows.get(categoryId);
    if (!row.open) toggle(row);
  }
});

const deleteDoc = (doc) => guarded(async () => {
  const msg = doc.isDemo ? `Remove sample document "${doc.name}"?` : `Delete "${doc.name}"? This removes the stored file too.`;
  if (!confirm(msg)) return;
  await service.remove(doc.id);
  await refreshCategory(doc.categoryId);
});

let renaming = null;
function renameDoc(doc) {
  renaming = doc;
  $('rename-input').value = doc.name;
  $('rename-dialog').showModal();
  $('rename-input').select();
}

function wireDialog() {
  $('rename-cancel').addEventListener('click', () => $('rename-dialog').close());
  $('rename-form').addEventListener('submit', () => guarded(async () => {
    if (!renaming) return;
    const doc = renaming;
    renaming = null;
    await service.rename(doc.id, $('rename-input').value);
    await refreshCategory(doc.categoryId);
  }));
}

async function init() {
  wireDialog();
  if (isNativePlatform()) {
    const db = createDatabase(capacitorSqliteDriver());
    await db.init();
    const { storage, picker, viewer } = capacitorAdapters();
    service = createDocumentService({ db, storage, picker, viewer });
    await service.reconcile();
  } else {
    service = createMockService();
    const b = $('banner');
    b.textContent = 'Browser preview: sample data from an in-memory mock, nothing is saved. Run the Android app for SQLite storage.';
    b.hidden = false;
  }
  await refreshAll();
}

init().catch((err) => { console.error('MyDocs init failed:', err?.message); showMessage(`Startup failed: ${err?.message || err}`); });
