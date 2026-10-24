// Navigation menu and settings structure as plain data, so adding an entry is a one-line change.
// Labels come from the translation tables (i18n.js); `label` is the English fallback used by tests and as default text.
import { t } from './i18n.js';
import { SIZE_LIMIT_OPTIONS_MB, DEFAULT_SIZE_LIMIT_MB } from './sizelimit.js';

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
export function buildSettingsSections({ version = '', build = '', theme = 'light', appLock = false, languageName = '', sizeLimitMb = DEFAULT_SIZE_LIMIT_MB, plan = null, usage = null, formatDate = (ms) => new Date(ms).toISOString().slice(0, 10) } = {}) {
  const pro = plan === null ? true : plan.plan === 'pro';
  const versionText = version ? `${version}${build ? ` (${build})` : ''}` : t('set.unknown');
  const planDescription = plan === null ? '' : !pro ? (usage ? t('plan.usage', usage) : t('plan.descBasic')) : plan.lifetime ? t('plan.descProLifetime') : t('plan.descProUntil', { date: formatDate(plan.expiresAt) });
  return [
    ...(plan === null ? [] : [{ id: 'plan', title: t('plan.title'), rows: [
      { id: 'plan', label: t('plan.title'), description: planDescription, icon: 'premium', value: pro ? t('plan.pro') : t('plan.basic'), action: 'upgrade' },
    ] }]),
    { id: 'appearance', title: t('set.appearance'), rows: [
      { id: 'theme', label: t('set.theme'), description: t('set.themeDesc'), icon: 'theme', value: theme === 'dark' ? t('theme.darkValue') : t('theme.lightValue'), action: 'theme' },
      { id: 'language', label: t('set.language'), description: t('set.languageDesc'), icon: 'language', value: languageName, action: 'language' },
    ] },
    { id: 'documents', title: t('set.documents'), rows: [
      { id: 'size-limit', label: t('set.sizeLimit'), description: t('set.sizeLimitDesc'), icon: 'storage',
        select: { value: sizeLimitMb, options: SIZE_LIMIT_OPTIONS_MB.map((mb) => (pro || mb <= 3 ? { value: mb, label: `${mb} MB` } : { value: mb, label: t('set.sizeProOption', { size: `${mb} MB` }), disabled: true })) } },
      { id: 'backup', label: t('set.backup'), description: t('set.backupDesc'), icon: 'backup', value: pro ? '' : t('plan.proBadge'), action: 'backup' },
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
