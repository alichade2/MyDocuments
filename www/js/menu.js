// Navigation menu and settings structure as plain data, so adding an entry is a one-line change.
// Labels come from the translation tables (i18n.js); `label` is the English fallback used by tests and as default text.
import { t } from './i18n.js';

/** Drawer destinations. `id` selects the handler in app.js (`destinations`), `icon` is a key of the icon set, `labelKey` a translation key. */
export const MENU_ITEMS = [
  { id: 'manage-categories', label: 'Manage Categories', labelKey: 'menu.manageCategories', icon: 'categories' },
  { id: 'settings', label: 'Settings', labelKey: 'menu.settings', icon: 'settings' },
];

/**
 * Settings screen sections. Each row: { id, label, value?, description?, icon?, action?, toggle?, checked? } (a row with `action` is tappable; `toggle` rows are on/off switches)
 * - later features add rows here (or whole sections) without touching the rendering code. Text is translated when built,
 * so call it again after a language change.
 */
export function buildSettingsSections({ version = '', build = '', theme = 'light', appLock = false, languageName = '' } = {}) {
  const versionText = version ? `${version}${build ? ` (${build})` : ''}` : t('set.unknown');
  return [
    { id: 'appearance', title: t('set.appearance'), rows: [
      { id: 'theme', label: t('set.theme'), description: t('set.themeDesc'), icon: 'theme', value: theme === 'dark' ? t('theme.darkValue') : t('theme.lightValue'), action: 'theme' },
      { id: 'language', label: t('set.language'), description: t('set.languageDesc'), icon: 'language', value: languageName, action: 'language' },
    ] },
    { id: 'security', title: t('set.security'), rows: [
      { id: 'app-lock', label: t('set.appLock'), description: t('set.appLockDesc'), icon: 'lock', toggle: true, checked: Boolean(appLock), action: 'app-lock' },
    ] },
    { id: 'about', title: t('set.about'), rows: [
      { id: 'app', label: t('set.app'), value: 'MyDocs' },
      { id: 'version', label: t('set.version'), value: versionText },
    ] },
  ];
}
