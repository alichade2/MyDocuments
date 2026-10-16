// UI layer: renders the dashboard and wires events to the document service.
import { createDatabase, capacitorSqliteDriver, isNativePlatform } from './database.js';
import { createDocumentService, capacitorAdapters } from './documents.js';
import { createMockService } from './mock.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  pdf: { cls: 't-pdf', label: 'PDF' },
  jpg: { cls: 't-img' }, jpeg: { cls: 't-img' }, png: { cls: 't-img' }, webp: { cls: 't-img' }, gif: { cls: 't-img' },
  doc: { cls: 't-doc', label: 'DOC' }, docx: { cls: 't-doc', label: 'DOC' },
  txt: { cls: 't-txt', label: 'TXT' },
};

let service;
const state = { categories: [], docs: new Map(), open: new Set() };

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

function imageIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', 'M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z');
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
function showError(err) {
  const msg = err?.message || String(err);
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

async function guarded(fn) {
  try { return await fn(); } catch (err) { console.error('MyDocs error:', err?.code || err?.name || 'error'); showError(err); }
}

function renderCard(doc) {
  const icon = ICONS[doc.fileType] ?? { cls: 't-other', label: (doc.fileType || '?').slice(0, 3) };
  const iconEl = el('span', { class: `card-icon ${icon.cls}` });
  if (icon.label) iconEl.textContent = icon.label; else iconEl.append(imageIcon());
  const meta = [doc.fileType?.toUpperCase(), formatSize(doc.fileSize), doc.createdAt?.slice(0, 10)].filter(Boolean).join(' · ');
  return el('article', { class: `card${doc.missing ? ' missing' : ''}` },
    el('button', { class: 'card-main', type: 'button', 'aria-label': `Open ${doc.name}`, onclick: () => guarded(() => service.open(doc.id)) },
      iconEl,
      el('span', { class: 'card-text' }, el('span', { class: 'card-name' }, doc.name), el('br'), el('span', { class: 'card-meta' }, meta))),
    ...(doc.missing ? [el('div', { class: 'card-warn' }, 'File missing from storage')] : []),
    el('div', { class: 'card-actions' },
      el('button', { type: 'button', onclick: () => renameDoc(doc) }, 'Rename'),
      el('button', { type: 'button', class: 'danger', onclick: () => deleteDoc(doc) }, 'Delete')));
}

function renderCategory(cat) {
  const docs = state.docs.get(cat.id) ?? [];
  const isOpen = state.open.has(cat.id);
  const bodyId = `cat-body-${cat.id}`;
  const chevron = document.createElementNS(SVG_NS, 'svg');
  chevron.setAttribute('class', 'chevron'); chevron.setAttribute('viewBox', '0 0 24 24'); chevron.setAttribute('aria-hidden', 'true');
  const cp = document.createElementNS(SVG_NS, 'path');
  cp.setAttribute('d', 'M7 10l5 5 5-5z'); cp.setAttribute('fill', 'currentColor');
  chevron.append(cp);

  const header = el('button', { class: 'category-header', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': bodyId, onclick: () => toggle(cat.id) },
    el('span', { class: 'category-title' }, cat.name), el('span', { class: 'count' }, String(docs.length)), chevron);

  const body = el('div', { class: 'category-body', id: bodyId },
    el('div', { class: 'toolbar' }, el('button', { class: 'btn filled', type: 'button', onclick: () => addDoc(cat.id) }, 'Add document')),
    docs.length
      ? el('div', { class: 'grid' }, ...docs.map(renderCard))
      : el('div', { class: 'empty' }, `No documents in ${cat.name} yet.`));
  body.hidden = !isOpen;
  return el('section', { class: `category${isOpen ? ' open' : ''}` }, el('h3', { class: 'category-heading' }, header), body);
}

function render() {
  $('categories').replaceChildren(...state.categories.map(renderCategory));
}

function toggle(id) {
  if (!state.open.delete(id)) state.open.add(id);
  render();
}

async function refresh() {
  state.categories = await service.listCategories();
  for (const cat of state.categories) state.docs.set(cat.id, await service.list(cat.id));
  render();
}

const addDoc = (categoryId) => guarded(async () => {
  const doc = await service.importFromPicker(categoryId);
  if (doc) { state.open.add(categoryId); await refresh(); }
});

const deleteDoc = (doc) => guarded(async () => {
  if (!confirm(`Delete "${doc.name}"? This removes the stored file too.`)) return;
  await service.remove(doc.id);
  await refresh();
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
    await service.rename(renaming.id, $('rename-input').value);
    renaming = null;
    await refresh();
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
    b.textContent = 'Browser preview: sample data only, nothing is saved. Run the Android app for real storage.';
    b.hidden = false;
  }
  state.open.add(1);
  await refresh();
}

init().catch((err) => { console.error('MyDocs init failed:', err?.message); showError(new Error(`Startup failed: ${err?.message || err}`)); });
