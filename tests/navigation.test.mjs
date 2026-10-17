// Sidebar structure: Manage Categories sits directly above Settings and is no longer a Settings row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MENU_ITEMS, buildSettingsSections } from '../www/js/menu.js';
import { ICON_PATHS } from '../www/js/icons.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('sidebar lists Manage Categories directly above Settings, in that exact order, with icons from the registry', () => {
  assert.deepEqual(MENU_ITEMS.map((m) => [m.id, m.label]), [['manage-categories', 'Manage Categories'], ['settings', 'Settings']]);
  for (const m of MENU_ITEMS) assert.ok(Object.hasOwn(ICON_PATHS, m.icon), m.icon);
  assert.notEqual(MENU_ITEMS[0].icon, MENU_ITEMS[1].icon);
});

test('Settings no longer has a Manage Categories row; theme, App Lock and About remain', () => {
  const sections = buildSettingsSections({ version: '1.0', build: '1', appLock: true });
  const rows = sections.flatMap((s) => s.rows);
  assert.ok(!rows.some((r) => r.id === 'manage-categories' || r.action === 'manage-categories'));
  assert.deepEqual(sections.map((s) => s.id), ['appearance', 'documents', 'security', 'about']);
  assert.ok(rows.some((r) => r.action === 'theme'));
  assert.ok(rows.some((r) => r.action === 'app-lock' && r.checked === true));
});

test('app wiring: one Manage Categories screen, opened from the drawer through the shared page opener; Back returns to the tab', () => {
  const app = read('www/js/app.js');
  assert.match(app, /destinations = \{ 'manage-categories': \(\) => openManageCategories\(\), settings: \(\) => openSettings\(\) \}/);
  assert.doesNotMatch(app, /data-action="manage-categories"/);
  assert.equal((read('www/index.html').match(/id="categories-scroller"/g) ?? []).length, 1);
  assert.equal((app.match(/function openManageCategories/g) ?? []).length, 1);
  assert.match(app, /function pageBack\(\) \{\s*if \(nav\.page === 'backup'\)[\s\S]*?\n  closeSettings\(\);\s*\}/); // only Backup & Restore nests (under Settings); everything else returns to the tab
  // the Add button stays fixed while only the list scrolls (unchanged markup)
  assert.match(read('www/index.html'), /class="fixed-page-bar"[\s\S]*id="cat-add"[\s\S]*id="cat-scroller"/);
});
