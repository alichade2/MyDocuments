// Navigation menu and settings structure as plain data, so adding an entry is a one-line change.

/** Drawer destinations. `id` selects the handler in app.js (`destinations`), `icon` is a key of the icon set. */
export const MENU_ITEMS = [
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * Settings screen sections. Each row: { id, label, value? } - later features add rows here
 * (or whole sections) without touching the rendering code.
 */
export function buildSettingsSections({ version = '', build = '' } = {}) {
  const versionText = version ? `${version}${build ? ` (${build})` : ''}` : 'Unknown';
  return [
    { id: 'about', title: 'About', rows: [
      { id: 'app', label: 'App', value: 'MyDocs' },
      { id: 'version', label: 'Version', value: versionText },
    ] },
  ];
}
