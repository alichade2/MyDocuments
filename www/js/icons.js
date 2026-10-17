// Central icon registry. Everything stored in the database is a stable KEY (e.g. "account_balance"); the SVG path
// lives only here, so icons can be restyled or replaced without touching saved data, and an unknown key can never
// break rendering: it falls back to the folder icon. Shared by category cards, Manage Categories and the add/edit form.

export const ICON_PATHS = {
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
  // balance scales
  gavel: 'M11 2h2v2.1l5 .9v1.6l2.9 6.6c0 1.6-1.3 2.8-2.9 2.8s-2.9-1.2-2.9-2.8L17 7l-4-.7V19h4v2H7v-2h4V6.3L7 7l2.9 6.6C9.9 15.2 8.6 16.4 7 16.4s-2.9-1.2-2.9-2.8L7 7V5.1l4-.9V2ZM7 9.6 5.6 13h2.8L7 9.6Zm10 0L15.6 13h2.8L17 9.6Z',
  plane: 'M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5Z',
  folder: 'M4 4h6l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  image: 'M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z',
  share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 1 0-3-3c0 .24.04.47.09.7L8.04 9.81A2.99 2.99 0 0 0 6 9a3 3 0 1 0 0 6c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65a2.92 2.92 0 1 0 2.92-2.92Z',
  delete: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58ZM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM11 1h2v3h-2V1Zm0 19h2v3h-2v-3ZM1 11h3v2H1v-2Zm19 0h3v2h-3v-2ZM4.22 5.64l1.42-1.42 2.12 2.12-1.42 1.42-2.12-2.12Zm12.02 12.02 1.42-1.42 2.12 2.12-1.42 1.42-2.12-2.12ZM5.64 19.78l-1.42-1.42 2.12-2.12 1.42 1.42-2.12 2.12ZM17.66 7.76l-1.42-1.42 2.12-2.12 1.42 1.42-2.12 2.12Z',
  moon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1Z',
  theme: 'M12 22c5.52 0 10-4.48 10-10S17.52 2 12 2 2 6.48 2 12s4.48 10 10 10Zm0-2V4a8 8 0 1 1 0 16Z',
  chevron: 'M9 5.6 15.4 12 9 18.4 10.4 20l8-8-8-8L9 5.6Z',

  // --- icons added for user-created categories (Material Design glyphs, 24x24) ---
  description: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6Zm2 16H8v-2h8v2Zm0-4H8v-2h8v2Zm-3-5V3.5L18.5 9H13Z',
  account_balance: 'M4 10v7h3v-7H4Zm6 0v7h3v-7h-3ZM2 22h19v-3H2v3Zm14-12v7h3v-7h-3Zm-4.5-9L2 6v2h19V6l-9.5-5Z',
  medical_services: 'M20 6h-4V4c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2ZM10 4h4v2h-4V4Zm6 11h-3v3h-2v-3H8v-2h3v-3h2v3h3v2Z',
  family: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3Zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5Zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z',
  assignment: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2Zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1Zm2 14H7v-2h7v2Zm3-4H7v-2h10v2Zm0-4H7V7h10v2Z',
  card_membership: 'M20 2H4c-1.11 0-2 .89-2 2v11c0 1.11.89 2 2 2h4v5l4-2 4 2v-5h4c1.11 0 2-.89 2-2V4c0-1.11-.89-2-2-2Zm0 13H4v-2h16v2Zm0-5H4V4h16v6Z',
  account_box: 'M3 5v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2H5c-1.11 0-2 .9-2 2Zm12 4c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3 3 1.34 3 3Zm-9 8c0-2 4-3.1 6-3.1s6 1.1 6 3.1v1H6v-1Z',
  shopping_bag: 'M18 6h-2c0-2.21-1.79-4-4-4S8 3.79 8 6H6c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2Zm-8 4c0 .55-.45 1-1 1s-1-.45-1-1V8h2v2Zm2-6c1.1 0 2 .9 2 2h-4c0-1.1.9-2 2-2Zm4 6c0 .55-.45 1-1 1s-1-.45-1-1V8h2v2Z',
  apartment: 'M17 11V3H7v4H3v14h8v-4h2v4h8V11h-4ZM7 19H5v-2h2v2Zm0-4H5v-2h2v2Zm0-4H5V9h2v2Zm4 4H9v-2h2v2Zm0-4H9V9h2v2Zm0-4H9V5h2v2Zm4 8h-2v-2h2v2Zm0-4h-2V9h2v2Zm0-4h-2V5h2v2Zm4 12h-2v-2h2v2Zm0-4h-2v-2h2v2Z',
  savings: 'M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4Z',
  local_library: 'M12 11.55C9.64 9.35 6.48 8 3 8v11c3.48 0 6.64 1.35 9 3.55 2.36-2.19 5.52-3.55 9-3.55V8c-3.48 0-6.64 1.35-9 3.55ZM12 8c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3Z',
  cloud: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96Z',
  inventory: 'M20 2H4c-1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-1-2-2-2Zm-5 12H9v-2h6v2Zm5-7H4V4h16v3Z',
  pets: 'M5 8.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm4-3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm4 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM12 11c-2.8 0-5.5 3.2-5.5 5.7 0 1.6 1.2 2.3 2.5 2.3 1 0 1.9-.5 3-.5s2 .5 3 .5c1.3 0 2.5-.7 2.5-2.3C17.5 14.2 14.8 11 12 11Z',
  more_horiz: 'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2Zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2Zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2Z',
  categories: 'M3 3h8v8H3V3Zm10 0h8v8h-8V3ZM3 13h8v8H3v-8Zm10 0h8v8h-8v-8Z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z',
};

export const DEFAULT_CATEGORY_ICON = 'folder';

/** Icons a user can pick for a custom category (key = what is stored, label = shown to the user). */
export const CATEGORY_ICON_CHOICES = [
  { key: 'folder', label: 'Folder' },
  { key: 'description', label: 'Document' },
  { key: 'school', label: 'Education' },
  { key: 'work', label: 'Work' },
  { key: 'person', label: 'Person' },
  { key: 'home', label: 'Home' },
  { key: 'account_balance', label: 'Finance' },
  { key: 'medical_services', label: 'Health' },
  { key: 'plane', label: 'Travel' },
  { key: 'car', label: 'Vehicle' },
  { key: 'receipt', label: 'Bills' },
  { key: 'shield', label: 'Security' },
  { key: 'family', label: 'Family' },
  { key: 'assignment', label: 'Assignment' },
  { key: 'card_membership', label: 'Membership' },
  { key: 'account_box', label: 'Account' },
  { key: 'shopping_bag', label: 'Shopping' },
  { key: 'apartment', label: 'Property' },
  { key: 'savings', label: 'Savings' },
  { key: 'local_library', label: 'Library' },
  { key: 'cloud', label: 'Cloud' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'pets', label: 'Pets' },
  { key: 'gavel', label: 'Legal' },
  { key: 'more_horiz', label: 'Other' },
];

export const isChoosableIcon = (key) => CATEGORY_ICON_CHOICES.some((c) => c.key === key);

/** SVG path for an icon key; unknown / missing keys resolve to the folder icon. */
export function iconPath(key) {
  return Object.hasOwn(ICON_PATHS, key) ? ICON_PATHS[key] : ICON_PATHS[DEFAULT_CATEGORY_ICON];
}
