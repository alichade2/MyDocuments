// Classic (non-module) script loaded in <head> before the stylesheet: applies the saved theme before the first paint,
// so there is no light-to-dark flash. Keep the storage key in sync with theme.js. Defaults to light.
(function () {
  var theme = 'light';
  try { if (localStorage.getItem('mydocs.theme') === 'dark') theme = 'dark'; } catch (e) { /* storage unavailable: stay light */ }
  document.documentElement.setAttribute('data-theme', theme);
})();
