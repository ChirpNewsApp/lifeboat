/* Lifeboat security check: a full-page Cloudflare Turnstile screen shown on every
   visit to the pages that include this script. It stays out of the way when:
   - the Turnstile keys aren't set in Vercel yet (the server sends an empty key),
   - the visitor is a search engine (so Google can still list the site),
   - the server can't be reached (so an outage never locks everyone out),
   - the visitor passed the check less than 15 minutes ago (any tab). */
(function () {
  var ua = navigator.userAgent || '';
  if (/bot\b|bot\/|crawl|spider|slurp|bingpreview|mediapartners|google-inspectiontool|google-site-verification|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|lighthouse/i.test(ua)) return;

  var CACHE = 'lb_gate_key', PASS = 'lb_human', PASS_MS = 15 * 60000;
  // Passed recently? Then go straight in until the 15 minutes run out.
  try { var h = JSON.parse(localStorage.getItem(PASS) || 'null'); if (h && h.until > Date.now() && h.until - Date.now() <= PASS_MS) return; } catch (e) {}
  var cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(CACHE) || 'null'); } catch (e) {}
  if (cached && cached.key === '' && Date.now() - cached.t < 10 * 60000) return; // switched off (checked recently)

  var root = document.documentElement;
  root.classList.add('lb-gating');
  var css = document.createElement('style');
  css.textContent =
    'html.lb-gating,html.lb-gating body{overflow:hidden!important;background:#fff}' +
    'html.lb-gating body>*:not(#lb-gate){visibility:hidden!important}' +
    '#lb-gate{position:fixed;inset:0;z-index:2147483647;background:#fff;color:#313131;overflow:auto;' +
      'font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;visibility:visible!important;transition:opacity .25s}' +
    '#lb-gate.out{opacity:0;pointer-events:none}' +
    '#lb-gate .g-in{max-width:720px;margin:0 auto;padding:12vh 24px 40px;min-height:100%;box-sizing:border-box;display:flex;flex-direction:column}' +
    '#lb-gate h1{font-size:clamp(26px,6vw,40px);font-weight:500;line-height:1.2;margin:0 0 12px;word-break:break-word;display:flex;align-items:center;gap:.4em}' +
    '#lb-gate h1 img{width:1.1em;height:1.1em;flex:none;border-radius:22%}' +
    '#lb-gate .g-sub{font-size:clamp(18px,3.5vw,24px);font-weight:500;margin:0 0 28px}' +
    '#lb-gate .g-box{min-height:65px;margin:0 0 28px}' +
    '#lb-gate .g-why{margin:0}' +
    '#lb-gate .g-err{color:#c2321b;font-weight:600;margin:0 0 20px}' +
    '#lb-gate .g-err button{margin-left:8px;font:inherit;font-weight:600;color:#fff;background:#0a3340;border:0;border-radius:6px;padding:4px 12px;cursor:pointer}' +
    '#lb-gate .g-foot{margin-top:auto;padding-top:48px;border-top:1px solid #d9d9d9;font-size:13px;color:#595959;text-align:center}' +
    '#lb-gate .g-foot span{display:inline-block;margin:0 6px}' +
    '#lb-gate .g-ok{display:inline-flex;align-items:center;gap:8px}' +
    '#lb-gate .g-ok svg{width:22px;height:22px;flex:none}' +
    '@media (prefers-color-scheme:dark){html.lb-gating,html.lb-gating body,#lb-gate{background:#222}#lb-gate{color:#d9d9d9}#lb-gate .g-foot{border-color:#444;color:#a3a3a3}#lb-gate .g-err{color:#ff8a70}#lb-gate .g-err button{background:#d9d9d9;color:#222}}' +
    '@media (prefers-reduced-motion:reduce){#lb-gate{transition:none}}';
  (document.head || root).appendChild(css);

  var host = location.hostname || 'lifeboatrecovery.com';
  var gate, box, sub, err;
  function mount() {
    if (gate) return;
    gate = document.createElement('div');
    gate.id = 'lb-gate';
    gate.setAttribute('role', 'main');
    gate.innerHTML =
      '<div class="g-in">' +
        '<h1><img src="/favicon.svg" alt=""><span></span></h1>' +
        '<p class="g-sub" aria-live="polite">Verifying you are human. This may take a few seconds.</p>' +
        '<p class="g-err" hidden></p>' +
        '<div class="g-box"></div>' +
        '<p class="g-why"></p>' +
        '<div class="g-foot"><span>Lifeboat security check</span><span>Protected by Cloudflare Turnstile</span></div>' +
      '</div>';
    gate.querySelector('h1 span').textContent = host;
    gate.querySelector('.g-why').textContent = host + ' needs to review the security of your connection before proceeding.';
    box = gate.querySelector('.g-box'); sub = gate.querySelector('.g-sub'); err = gate.querySelector('.g-err');
    document.body.appendChild(gate);
  }
  function whenBody(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }

  var opened = false;
  function open() {
    if (opened) return; opened = true;
    if (!gate) { root.classList.remove('lb-gating'); return; }
    gate.classList.add('out');
    root.classList.remove('lb-gating');
    setTimeout(function () { if (gate && gate.parentNode) gate.parentNode.removeChild(gate); }, 300);
    try { window.dispatchEvent(new Event('lb-gate-passed')); } catch (e) {}
  }
  function fail(msg, retry) {
    if (!err) return;
    err.hidden = false; err.textContent = msg;
    if (retry) { var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Try again'; b.onclick = function () { location.reload(); }; err.appendChild(b); }
  }

  var widget = null;
  function render(key) {
    widget = window.turnstile.render(box, {
      sitekey: key, action: 'page', theme: 'auto', size: 'normal',
      callback: function (token) {
        sub.textContent = 'Checking…';
        fetch('/api/gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (d) {
            if (d && d.ok) {
              if (d.pass) { try { localStorage.setItem(PASS, JSON.stringify({ pass: d.pass, exp: d.exp, until: Date.now() + PASS_MS })); } catch (e) {} }
              sub.innerHTML = '<span class="g-ok"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#1e8e3e"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Verification successful</span>';
              setTimeout(open, 350);
            } else {
              sub.textContent = 'Verify you are human by completing the action below.';
              fail((d && d.error) || 'The security check failed. Try again.');
              try { window.turnstile.reset(widget); } catch (e) {}
            }
          })
          .catch(function () { open(); }); // our server is unreachable: don't lock people out
      },
      'before-interactive-callback': function () { sub.textContent = 'Verify you are human by completing the action below.'; },
      'expired-callback': function () { try { window.turnstile.reset(widget); } catch (e) {} },
      'error-callback': function (code) {
        sub.textContent = 'Verify you are human by completing the action below.';
        fail('The check did not pass' + (code ? ' (error ' + String(code).replace(/[^\w-]/g, '') + ')' : '') + '. Turn off any VPN or ad blocker for this site, then try again.', true);
      }
    });
  }
  function loadTurnstile(key) {
    if (window.turnstile && window.turnstile.render) return render(key);
    window.lbGateReady = function () { render(key); };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=lbGateReady';
    s.async = true; s.defer = true;
    s.onerror = function () { fail('The security check could not load. Check your connection or turn off blockers for this site.', true); };
    document.head.appendChild(s);
  }
  function start(key) {
    try { sessionStorage.setItem(CACHE, JSON.stringify({ key: key, t: Date.now() })); } catch (e) {}
    if (!key) return whenBody(open);
    whenBody(function () { mount(); loadTurnstile(key); });
  }

  if (cached && cached.key && Date.now() - cached.t < 10 * 60000) {
    start(cached.key);
  } else {
    fetch('/api/gate', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { start((d && d.ok && d.siteKey) || ''); })
      .catch(function () { whenBody(open); });
  }
})();
