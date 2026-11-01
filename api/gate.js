// Lifeboat security check (Cloudflare Turnstile).
//
// The home page, the Feedback board and the vault show a full-page
// "Verifying you are human" screen (see /gate.js), skipped for 15 minutes after passing.
//
//   GET  /api/gate            -> { siteKey }   ('' while the check is switched off)
//   POST /api/gate {token}    -> asks Cloudflare if the token is real; if so,
//                                returns a 15-minute "human pass": pages skip the
//                                check while it lasts, and the Feedback form uses
//                                it instead of a second check.
//
// Switched on only when BOTH of these are set in Vercel:
//   TURNSTILE_SITE_KEY     public. From Cloudflare > Turnstile > your widget.
//   TURNSTILE_SECRET_KEY   SECRET. Same place. Never put it in GitHub or chat.

const crypto = require('crypto');

const PASS_MINUTES = 15; // passing the check counts this long (gate.js uses the same)

function on() { return !!(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY); }
function siteKey() { return on() ? process.env.TURNSTILE_SITE_KEY : ''; }

const deps = {
  now() { return Date.now(); },
  // Ask Cloudflare whether the token from the page came from a real person.
  async verify(token, ip) {
    const form = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY || '', response: token });
    if (ip) form.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const d = await r.json();
    return !!(d && d.success);
  },
};

function signPass(exp) {
  return crypto.createHmac('sha256', process.env.TURNSTILE_SECRET_KEY || '').update('lifeboat-human:' + exp).digest('hex').slice(0, 40);
}
function makePass(now) {
  const exp = Math.floor(now / 1000) + PASS_MINUTES * 60;
  return { pass: exp + '.' + signPass(exp), exp };
}
function passOk(pass, now) {
  if (!on()) return false;
  const m = /^(\d{10})\.([a-f0-9]{40})$/.exec(String(pass || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 < (now || deps.now())) return false;
  const want = Buffer.from(signPass(exp));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function clientIp(req) {
  return String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
}
// Shared with the Feedback board: true if the token passes Cloudflare's check.
async function tokenOk(token, ip) {
  token = String(token || '');
  if (!token || token.length > 2048) return false;
  try { return await deps.verify(token, ip); } catch (e) { console.error('Lifeboat security check could not reach Cloudflare:', e); return false; }
}

async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ ok: true, siteKey: siteKey() });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'Use GET or POST.' }); }
  if (!on()) return res.status(200).json({ ok: true, off: true });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  if (!(await tokenOk(body.token, clientIp(req)))) return res.status(400).json({ ok: false, error: 'The security check failed. Try again.' });
  return res.status(200).json(Object.assign({ ok: true }, makePass(deps.now())));
}

module.exports = handler;
module.exports._deps = deps;
module.exports.on = on;
module.exports.siteKey = siteKey;
module.exports.passOk = passOk;
module.exports.tokenOk = tokenOk;
module.exports.clientIp = clientIp;
module.exports._makePass = makePass;
