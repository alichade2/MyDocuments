// Classic script in <head>, before the stylesheet: when App Lock is enabled, the page starts locked (content hidden by
// CSS) so no document can flash before the authentication prompt. Keep the key in sync with applock.js.
(function () {
  try { if (localStorage.getItem('mydocs.appLock') === '1') document.documentElement.setAttribute('data-locked', ''); } catch (e) { /* storage unavailable: App Lock is off */ }
})();
