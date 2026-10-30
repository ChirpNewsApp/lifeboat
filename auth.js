// Shared login code for every page (home, pricing, vault).
// Clerk runs the logins. Put your Clerk publishable key below, in this one place.
(function () {
  // Paste your Clerk publishable key (starts with pk_test_ or pk_live_).
  // It is safe to keep here. Never paste the secret key (sk_...) into any page.
  var PUBLISHABLE_KEY = 'PASTE_YOUR_CLERK_PUBLISHABLE_KEY_HERE';

  var configured = PUBLISHABLE_KEY.indexOf('PASTE_') !== 0;
  var LB = (window.LB = { configured: configured, loaded: false, signedIn: false });
  var resolveReady, rejectReady;
  LB.ready = new Promise(function (res, rej) { resolveReady = res; rejectReady = rej; });
  LB.ready.catch(function () {});

  function abs(path) { return location.origin + path; }

  function addScript(src, key) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.crossOrigin = 'anonymous'; s.async = false;
      if (key) s.setAttribute('data-clerk-publishable-key', key);
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function showHeader() {
    document.querySelectorAll('[data-auth="in"]').forEach(function (el) { el.hidden = !LB.signedIn; });
    document.querySelectorAll('[data-auth="out"]').forEach(function (el) { el.hidden = LB.signedIn; });
  }

  // Sign in or sign up, then come back to `target` (the vault by default).
  function go(kind, target) {
    target = target || '/vault';
    if (!LB.loaded) { alert('Login is not available right now. Try again in a moment.'); return; }
    try { sessionStorage.setItem('lb_return', target); } catch (e) {}
    var url = abs(target);
    var opts = { redirectUrl: url, signInForceRedirectUrl: url, signUpForceRedirectUrl: url };
    if (kind === 'up') Clerk.redirectToSignUp(opts); else Clerk.redirectToSignIn(opts);
  }
  LB.signIn = function (target) { go('in', target); };
  LB.signUp = function (target) { go('up', target); };
  LB.signOut = async function () { await Clerk.signOut(); location.href = '/'; };
  LB.manage = function () { Clerk.openUserProfile(); };

  // Which plan this person has (from plans.json, looked up by username).
  LB.plan = async function () {
    var token = await Clerk.session.getToken();
    var r = await fetch('/api/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: 'my-plan' })
    });
    var d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || 'plan');
    return d;
  };
  LB.size = function (gb) { return gb >= 1000 ? (gb / 1000) + ' TB' : gb + ' GB'; };

  // Buttons on any page: data-signin, data-signup, data-signout, data-manage
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-signin],[data-signup],[data-signout],[data-manage]') : null;
    if (!el) return;
    e.preventDefault();
    var back = el.getAttribute('data-return') || '/vault';
    if (el.hasAttribute('data-signin')) LB.signIn(back);
    else if (el.hasAttribute('data-signup')) LB.signUp(back);
    else if (el.hasAttribute('data-signout')) LB.signOut();
    else if (el.hasAttribute('data-manage')) LB.manage();
  });

  async function start() {
    if (!configured) throw new Error('not configured');
    var host = atob(PUBLISHABLE_KEY.split('_')[2]).slice(0, -1);
    await addScript('https://' + host + '/npm/@clerk/ui@1/dist/ui.browser.js');
    await addScript('https://' + host + '/npm/@clerk/clerk-js@6/dist/clerk.browser.js', PUBLISHABLE_KEY);
    var opts = window.__internal_ClerkUICtor ? { ui: { ClerkUI: window.__internal_ClerkUICtor } } : {};
    await Clerk.load(opts);
    LB.loaded = true;
    LB.signedIn = !!Clerk.isSignedIn;
    LB.user = Clerk.user || null;

    // Just finished signing in? Send them where they were headed.
    var want = null;
    try { want = sessionStorage.getItem('lb_return'); } catch (e) {}
    if (LB.signedIn && want) {
      try { sessionStorage.removeItem('lb_return'); } catch (e) {}
      if (location.pathname.replace(/\/$/, '') !== want.replace(/\/$/, '')) { location.replace(want); return; }
    }
    showHeader();
    resolveReady(LB);
  }

  start().catch(function (err) {
    showHeader(); // shows Sign in and Get started
    rejectReady(err);
  });
})();
