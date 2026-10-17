// Classic script in <head>, before the stylesheet: records the saved language so Hindi starts hidden until the page text
// has been translated (no flash of English). Keep the key in sync with i18n.js. Defaults to English.
(function () {
  var lang = 'en';
  try { if (localStorage.getItem('mydocs.language') === 'hi') lang = 'hi'; } catch (e) { /* storage unavailable: English */ }
  document.documentElement.setAttribute('data-lang', lang);
  document.documentElement.lang = lang;
  // Safety net: never leave the page hidden if the app script fails to run.
  setTimeout(function () { document.documentElement.setAttribute('data-i18n-ready', ''); }, 4000);
})();
