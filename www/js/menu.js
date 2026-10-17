// Navigation menu and settings structure as plain data, so adding an entry is a one-line change.

/** Drawer destinations. `id` selects the handler in app.js (`destinations`), `icon` is a key of the icon set. */
export const MENU_ITEMS = [
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * Settings screen sections. Each row: { id, label, value?, description?, icon?, action?, toggle?, checked? } (a row with `action` is tappable; `toggle` rows are on/off switches) - later features add rows here
 * (or whole sections) without touching the rendering code.
 */
export function buildSettingsSections({ version = '', build = '', theme = 'light', customCategories = 0, appLock = false } = {}) {
  const versionText = version ? `${version}${build ? ` (${build})` : ''}` : 'Unknown';
  return [
    { id: 'appearance', title: 'Appearance', rows: [
      { id: 'theme', label: 'Theme', description: 'Choose how MyDocs looks', icon: 'theme', value: theme === 'dark' ? 'Dark' : 'Light', action: 'theme' },
    ] },
    { id: 'categories', title: 'Categories', rows: [
      { id: 'manage-categories', label: 'Manage Categories', description: 'Create and edit your own document categories', icon: 'categories', value: customCategories ? `${customCategories} custom` : '', action: 'manage-categories' },
    ] },
    { id: 'security', title: 'Security', rows: [
      { id: 'app-lock', label: 'App Lock', description: "Protect your documents using your device's screen lock.", icon: 'lock', toggle: true, checked: Boolean(appLock), action: 'app-lock' },
    ] },
    { id: 'about', title: 'About', rows: [
      { id: 'app', label: 'App', value: 'MyDocs' },
      { id: 'version', label: 'Version', value: versionText },
    ] },
  ];
}
