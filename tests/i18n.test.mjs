// Hindi/English localisation: translation tables stay in sync, built-in category labels are localised while user data
// (document names, custom category names) is never touched, and every service message has a Hindi text.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import en from '../www/js/locales/en.js';
import hi from '../www/js/locales/hi.js';
import {
  t, tn, setLanguage, getLanguage, loadLanguage, saveLanguage, normalizeLanguage, LANGUAGE_KEY, categoryLabel,
  errorText, ERROR_PATTERNS, LANGUAGES,
} from '../www/js/i18n.js';
import { CATEGORIES } from '../www/js/seed.js';
import { MENU_ITEMS, buildSettingsSections } from '../www/js/menu.js';
import { THEME_OPTIONS } from '../www/js/theme.js';
import { CATEGORY_ICON_CHOICES } from '../www/js/icons.js';
import { DEMO_MESSAGE, validateName, validateCategoryName } from '../www/js/documents.js';
import { lockMessage, LOCK_MESSAGES } from '../www/js/applock.js';
import { createMockService } from '../www/js/mock.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const DEVANAGARI = /[ऀ-ॿ]/;
const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
afterEach(() => setLanguage('en'));
const memStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

test('English and Hindi tables have exactly the same keys, no empty text and the same {placeholders}', () => {
  assert.deepEqual(Object.keys(hi).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.ok(en[key] !== '' && hi[key] !== '', key);
    assert.equal(params(hi[key]), params(en[key]), `placeholders of ${key}`);
  }
});

test('Hindi strings are really Hindi (Devanagari) apart from names that are intentionally Latin', () => {
  const allowed = new Set(['lang.code', 'lang.name.en', 'lang.sub.hi']);
  for (const [key, value] of Object.entries(hi)) if (!allowed.has(key)) assert.match(value, DEVANAGARI, key);
});

test('the Hindi names required by the specification', () => {
  setLanguage('hi');
  const expected = {
    'tab.category': 'श्रेणियाँ', 'tab.all': 'सभी दस्तावेज़', 'menu.manageCategories': 'श्रेणियाँ प्रबंधित करें', 'menu.settings': 'सेटिंग्स',
    'manage.add': 'श्रेणी जोड़ें', 'cat.addDocument': 'दस्तावेज़ जोड़ें', 'cat.capture': 'कैमरे से स्कैन करें',
    'category.personal-documents': 'व्यक्तिगत दस्तावेज़', 'category.educational-documents': 'शैक्षणिक दस्तावेज़',
    'category.identity-documents': 'पहचान संबंधी दस्तावेज़', 'category.financial-documents': 'वित्तीय दस्तावेज़',
    'category.agricultural-documents': 'कृषि संबंधी दस्तावेज़',
    'act.rename': 'नाम बदलें', 'act.share': 'साझा करें', 'act.delete': 'हटाएं', 'share.files': 'फ़ाइलें साझा करें',
    'name.save': 'दस्तावेज़ सहेजें', 'common.cancel': 'रद्द करें', 'search.open': 'दस्तावेज़ खोजें', 'name.label': 'दस्तावेज़ का नाम',
    'set.appearance': 'दिखावट', 'set.theme': 'थीम', 'theme.light': 'लाइट थीम', 'theme.dark': 'डार्क थीम', 'set.language': 'भाषा', 'set.appLock': 'ऐप लॉक',
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(t(key), value, key);
});

test('English is the default and its text matches the original UI (database names for built-in categories)', () => {
  assert.equal(getLanguage(), 'en');
  for (const c of CATEGORIES) assert.equal(t(`category.${c.slug}`), c.name, c.slug); // English labels = stored names
  assert.equal(t('tab.category'), 'Category');
  assert.equal(t('cat.capture'), 'Capture with Camera');
  assert.equal(t('set.appLockDesc'), "Protect your documents using your device's screen lock.");
  assert.equal(t('set.languageDesc'), 'Choose your preferred application language');
});

test('every built-in category has a Hindi label; user categories and unknown slugs keep their stored name', () => {
  for (const c of CATEGORIES) {
    assert.ok(Object.hasOwn(hi, `category.${c.slug}`), c.slug);
    assert.notEqual(hi[`category.${c.slug}`], en[`category.${c.slug}`]);
  }
  setLanguage('hi');
  assert.equal(categoryLabel({ slug: 'travel-documents', name: 'Travel Documents' }), 'यात्रा दस्तावेज़');
  assert.equal(categoryLabel({ categorySlug: 'travel-documents', categoryName: 'Travel Documents' }), 'यात्रा दस्तावेज़'); // search / All Documents rows
  assert.equal(categoryLabel({ slug: 'custom-1234', name: 'Pet Records' }), 'Pet Records');
  assert.equal(categoryLabel({ slug: 'custom-1234', name: 'Travel Documents' }), 'Travel Documents'); // even a lookalike name stays as typed
  assert.equal(categoryLabel({ slug: 'custom-9', name: 'मेरी श्रेणी' }), 'मेरी श्रेणी');
  assert.equal(categoryLabel({ slug: 'something-new', name: 'Whatever' }), 'Whatever');
  assert.equal(categoryLabel({ name: 'No slug' }), 'No slug');
});

test('document names are inserted verbatim in both languages (never translated, never re-interpreted)', () => {
  const names = ['Aadhaar Card', 'Birth Certificate', 'My Home Documents', 'Insurance Policy 2026', 'मेरा आधार कार्ड', '{n} {name} $& $1 <b>x</b>', 'Savings "2026"'];
  for (const lang of ['en', 'hi']) {
    setLanguage(lang);
    for (const name of names) {
      for (const key of ['doc.rename', 'doc.share', 'doc.delete', 'doc.saved', 'doc.confirmDelete', 'doc.confirmRemoveSample', 'doc.selectAllIn', 'cat.empty']) {
        assert.ok(t(key, { name }).includes(name), `${lang} ${key} ${name}`);
      }
      assert.ok(t('doc.shareAria', { name, category: 'X' }).includes(name));
    }
  }
});

test('plural labels: English singular/plural, Hindi uses one form; counts are Latin digits', () => {
  assert.equal(tn('docs', 1), '1 document');
  assert.equal(tn('docs', 5), '5 documents');
  assert.equal(tn('search.found', 1), '1 document found');
  setLanguage('hi');
  assert.equal(tn('docs', 1), '1 दस्तावेज़');
  assert.equal(tn('docs', 12), '12 दस्तावेज़');
  assert.equal(tn('search.found', 1), '1 दस्तावेज़ मिला');
  assert.equal(tn('search.found', 3), '3 दस्तावेज़ मिले');
});

test('language preference: English by default, persisted choice restored, garbage and broken storage fall back safely', () => {
  assert.equal(loadLanguage(memStorage()), 'en');
  const s = memStorage();
  assert.equal(saveLanguage('hi', s), true);
  assert.equal(s.m.get(LANGUAGE_KEY), 'hi');
  assert.equal(loadLanguage(s), 'hi');
  assert.equal(loadLanguage(memStorage({ [LANGUAGE_KEY]: 'fr' })), 'en');
  assert.equal(normalizeLanguage('hi'), 'hi');
  assert.equal(normalizeLanguage(undefined), 'en');
  assert.equal(loadLanguage({ getItem() { throw new Error('denied'); } }), 'en');
  assert.equal(saveLanguage('hi', { setItem() { throw new Error('denied'); } }), false);
  assert.deepEqual(LANGUAGES.map((l) => l.id), ['en', 'hi']);
});

test('missing keys fall back to English and then to the key itself; placeholders without a value stay visible', () => {
  setLanguage('hi');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(t('doc.rename', {}), '{name} का नाम बदलें');
});

test('settings and menu are built from translation keys: Language row, no Manage Categories row, all Hindi in Hindi', () => {
  for (const item of MENU_ITEMS) { assert.ok(Object.hasOwn(en, item.labelKey), item.labelKey); assert.equal(t(item.labelKey), item.label); }
  for (const o of THEME_OPTIONS) { assert.equal(t(o.labelKey), o.label); assert.equal(t(o.descKey), o.description); }
  for (const c of CATEGORY_ICON_CHOICES) assert.equal(t(`icon.${c.key}`), c.label, c.key);
  const rows = (lang, extra = {}) => { setLanguage(lang); return buildSettingsSections({ version: '1.0', build: '1', languageName: t(`lang.name.${lang}`), ...extra }); };
  const english = rows('en');
  const lang = english[0].rows.find((r) => r.id === 'language');
  assert.deepEqual([lang.label, lang.description, lang.value, lang.action], ['Language', 'Choose your preferred application language', 'English', 'language']);
  const hindi = rows('hi', { theme: 'dark' });
  const texts = hindi.flatMap((s) => [s.title, ...s.rows.flatMap((r) => [r.label, r.description, r.value])]).filter(Boolean);
  for (const text of texts) if (!['MyDocs', '1.0 (1)', 'हिन्दी'].includes(text)) assert.match(text, DEVANAGARI, text);
  assert.equal(hindi[0].rows[0].value, 'डार्क');
  assert.equal(hindi[0].rows.find((r) => r.id === 'language').value, 'हिन्दी');
  assert.ok(!hindi.flatMap((s) => s.rows).some((r) => r.id === 'manage-categories'));
});

test('App Lock messages and prompt texts exist in Hindi', () => {
  setLanguage('hi');
  for (const code of Object.keys(LOCK_MESSAGES)) assert.match(lockMessage(code), DEVANAGARI, code);
  assert.match(lockMessage('unknown'), DEVANAGARI);
  for (const key of ['auth.unlockTitle', 'auth.unlockSubtitle', 'auth.enableTitle', 'auth.disableTitle', 'auth.confirm']) assert.match(t(key), DEVANAGARI, key);
  setLanguage('en');
  assert.equal(lockMessage('CANCELED'), LOCK_MESSAGES.CANCELED);
});

test('every message the document service can produce has a Hindi text', () => {
  // 1) static messages found in the sources
  const found = [];
  for (const file of ['www/js/documents.js', 'www/js/mock.js']) {
    for (const m of read(file).matchAll(/new DocumentError\('[A-Z_]+',\s*'((?:[^'\\]|\\.)*)'/g)) found.push(m[1].replace(/\\'/g, "'"));
  }
  found.push(DEMO_MESSAGE);
  assert.ok(found.length > 30);
  setLanguage('hi');
  const english = (msg) => ERROR_PATTERNS.some(([re]) => re.test(msg));
  for (const msg of new Set(found)) {
    assert.ok(english(msg), `no pattern for: ${msg}`);
    assert.match(errorText({ message: msg }), DEVANAGARI, msg);
  }
  // 2) messages with values
  const dynamic = [
    ['Category name must be 40 characters or fewer.', '40'],
    ['Name must be 120 characters or fewer.', '120'],
    ['This category still contains 1 document. Choose where to move them first.', '1 दस्तावेज़'],
    ['This category still contains 4 documents. Choose where to move them first.', '4 दस्तावेज़'],
    ['Unsupported file type ".xyz".', 'xyz'],
    ['This document has no file that can be shared: "Aadhaar Card". Nothing was shared.', '"Aadhaar Card"'],
    ['These documents have no file that can be shared: "A", "B", "C" and 2 more. Nothing was shared.', '"A", "B", "C"'],
    ['Too many files for one ZIP archive.', ''],
    ['The selected files are too large for one ZIP archive.', ''],
  ];
  for (const [msg, keep] of dynamic) {
    const out = errorText({ message: msg });
    assert.match(out, DEVANAGARI, msg);
    assert.ok(out.includes(keep), `${msg} -> ${out}`);
  }
  assert.match(errorText({ message: 'These documents have no file that can be shared: "A", "B", "C" and 2 more. Nothing was shared.' }), /2 अन्य/);
  // real validation errors
  for (const fn of [() => validateName('  '), () => validateName('x'.repeat(500)), () => validateCategoryName(''), () => validateCategoryName('y'.repeat(100))]) {
    assert.throws(fn, (e) => /[ऀ-ॿ]/.test(errorText(e)));
  }
  // unknown messages are shown unchanged; no message falls back to the given key
  assert.equal(errorText({ message: 'Something odd happened' }), 'Something odd happened');
  assert.equal(errorText({}, 'zip.failed'), hi['zip.failed']);
  setLanguage('en');
  assert.equal(errorText({ message: 'Unknown category.' }), 'Unknown category.'); // English text is unchanged
  assert.equal(errorText({ message: 'Unsupported file type ".xyz".' }), 'Unsupported file type ".xyz".');
});

test('the page: every data-i18n key exists in both tables and the English default text in the HTML equals the English table', () => {
  const html = read('www/index.html');
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 40);
  for (const key of keys) { assert.ok(Object.hasOwn(en, key), `en: ${key}`); assert.ok(Object.hasOwn(hi, key), `hi: ${key}`); }
  // elements with text content keep the exact English text (so the English UI is unchanged)
  for (const m of html.matchAll(/<(\w+)[^>]*data-i18n="([^"]+)"[^>]*>([^<]*)</g)) assert.equal(m[3].trim(), en[m[2]], `${m[2]} default text`);
  for (const m of html.matchAll(/(aria-label|placeholder|alt)="([^"]*)"[^>]*data-i18n-\1="([^"]+)"/g)) assert.equal(m[2], en[m[3]], `${m[3]} default ${m[1]}`);
  assert.ok(html.indexOf('js/lang-init.js') > 0 && html.indexOf('js/lang-init.js') < html.indexOf('css/styles.css'));
  assert.match(html, /id="lang-dialog"/);
  assert.match(read('www/js/lang-init.js'), /mydocs\.language/);
  assert.equal(LANGUAGE_KEY, 'mydocs.language');
  assert.match(read('www/css/styles.css'), /html\[data-lang="hi"\]:not\(\[data-i18n-ready\]\) body \{ visibility: hidden; \}/);
});

test('app wiring: the language is applied before rendering and switching re-renders without a reload', () => {
  const app = read('www/js/app.js');
  assert.match(app, /setLanguage\(loadLanguage\(\)\);[^\n]*\n(?:[^\n]*\n)*?applyStaticTranslations\(\);/);
  assert.match(app, /function refreshLanguageUI\(\)/);
  assert.match(app, /saveLanguage\(id\)/);
  assert.doesNotMatch(app, /location\.reload|window\.location/);
});

test('localised display never changes stored data: the mock repository keeps English names and slugs in Hindi mode', async () => {
  const mock = createMockService();
  const before = JSON.stringify(await mock.listCategories());
  setLanguage('hi');
  const cats = await mock.listCategories();
  assert.equal(JSON.stringify(cats), before);
  assert.equal(categoryLabel(cats.find((c) => c.slug === 'bills-receipts')), 'बिल और रसीदें');
  assert.equal(cats.find((c) => c.slug === 'bills-receipts').name, 'Bills & Receipts');
  const custom = await mock.createCategory({ name: 'Pet Records', icon: 'pets' });
  assert.equal(categoryLabel(custom), 'Pet Records');
  const doc = (await mock.search('aadhaar'))[0];
  assert.equal(doc.name, 'Aadhaar Card');
  assert.equal(doc.categoryName, 'Identity Documents'); // data from the repository stays English; only the label is localised
  assert.equal(categoryLabel(doc), 'पहचान संबंधी दस्तावेज़');
});
