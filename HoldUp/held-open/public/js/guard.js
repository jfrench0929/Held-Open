// Runs before the page paints. Sends people to the right page and applies the saved theme
// so there is no flash. Kept as a plain script (not a module) so it blocks rendering.
(function () {
  var SESSION_KEY = 'heldopen.session';
  var THEME_KEY = 'heldopen.theme';
  var mode = document.currentScript && document.currentScript.getAttribute('data-mode');

  try {
    var theme = localStorage.getItem(THEME_KEY);
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { /* storage blocked: follow the system theme */ }

  var session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { /* ignore */ }
  var signedIn = !!(session && session.id && session.code);

  if (mode === 'app' && !signedIn) {
    location.replace('/welcome.html');
  } else if (mode === 'welcome' && signedIn) {
    var onboarding = false;
    try { onboarding = sessionStorage.getItem('heldopen.onboarding') === '1'; } catch (e) { /* ignore */ }
    if (!onboarding) location.replace('/');
  }
})();
