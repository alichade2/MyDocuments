// Theme preference: the user's choice (not the device setting) decides. Colours live in CSS custom properties
// (styles.css: :root = light, :root[data-theme="dark"] = dark); switching only changes one attribute on <html>.

export const THEME_KEY = 'mydocs.theme'; // also read by theme-init.js before first paint
export const DEFAULT_THEME = 'light';

export const THEME_OPTIONS = [
  { id: 'light', label: 'Light', icon: 'sun', description: 'A clean and bright appearance' },
  { id: 'dark', label: 'Dark', icon: 'moon', description: 'Easy on the eyes in low-light environments' },
];

export const normalizeTheme = (value) => (value === 'dark' ? 'dark' : DEFAULT_THEME);

export function loadTheme(storage = globalThis.localStorage) {
  try { return normalizeTheme(storage?.getItem(THEME_KEY)); } catch { return DEFAULT_THEME; }
}

/** Returns true when the preference was stored. */
export function saveTheme(theme, storage = globalThis.localStorage) {
  try { storage.setItem(THEME_KEY, normalizeTheme(theme)); return true; } catch { return false; }
}

/**
 * Applies a theme immediately: <html data-theme>, the browser/WebView theme colour and, on Android, the
 * status-bar icon style (light icons on the dark header). No reload, no screen recreation.
 */
export function applyTheme(theme, { root = document.documentElement, systemBars = globalThis.Capacitor?.Plugins?.SystemBars, animate = false } = {}) {
  const t = normalizeTheme(theme);
  if (animate && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theme-transition'); // brief colour cross-fade instead of a hard flip
    setTimeout(() => root.classList.remove('theme-transition'), 350);
  }
  root.setAttribute('data-theme', t);
  const header = getComputedStyle(root).getPropertyValue('--header-bg').trim();
  const meta = root.ownerDocument?.querySelector('meta[name="theme-color"]');
  if (meta && header) meta.setAttribute('content', header);
  systemBars?.setStyle?.({ style: t === 'dark' ? 'DARK' : 'DEFAULT' })?.catch?.(() => {}); // DARK = light icons for a dark bar
  return t;
}
