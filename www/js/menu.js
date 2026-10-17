// Navigation menu and settings structure as plain data, so adding an entry is a one-line change.

/** Drawer destinations. `id` selects the handler in app.js (`destinations`), `icon` is a key of the icon set. */
export const MENU_ITEMS = [
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * Settings screen sections. Each row: { id, label, value?, description?, icon?, action? } (a row with `action` is tappable) - later features add rows here
 * (or whole sections) without touching the rendering code.
 */
export function buildSettingsSections({ version = '', build = '', theme = 'light', customCategories = 0 } = {}) {
  const versionText = version ? `${version}${build ? ` (${build})` : ''}` : 'Unknown';
  return [
    { id: 'appearance', title: 'Appearance', rows: [
      { id: 'theme', label: 'Theme', description: 'Choose how MyDocs looks', icon: 'theme', value: theme === 'dark' ? 'Dark' : 'Light', action: 'theme' },
    ] },
    { id: 'categories', title: 'Categories', rows: [
      { id: 'manage-categories', label: 'Manage Categories', description: 'Create and edit your own document categories', icon: 'categories', value: customCategories ? `${customCategories} custom` : '', action: 'manage-categories' },
    ] },
    { id: 'about', title: 'About', rows: [
      { id: 'app', label: 'App', value: 'MyDocs' },
      { id: 'version', label: 'Version', value: versionText },
    ] },
  ];
}
