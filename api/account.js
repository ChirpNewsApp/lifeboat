// Vercel serverless function: POST /api/account
// Clerk handles logins. Stripe handles payments. This function connects them.
// Every action needs a logged-in person:  Authorization: Bearer <Clerk session token>
//
//   { "action": "my-plan" }                       which plan do I have?
//   { "action": "checkout", "plan": "personal" }  start a Stripe checkout (personal, family, creator)
//   { "action": "portal" }                        open Stripe's "manage billing" page
//
// Environment variables (set in Vercel, see STRIPE-SETUP.md):
//   CLERK_SECRET_KEY     SECRET.  From Clerk.
//   STRIPE_SECRET_KEY    SECRET.  From Stripe (sk_test_... while testing).
//   SITE_URL             optional, e.g. https://yourdomain.com (defaults to the address of the request)
//
// Plan names and storage sizes live in plans.json. Stripe price IDs live in stripe-prices.json.

const { verifyToken, createClerkClient } = require('@clerk/backend');
const PLAN_DATA = require('../plans.json');
const PRICES = require('../stripe-prices.json');

const ACTIVE = ['active', 'trialing', 'past_due']; // statuses that still count as "has a plan"
const BASE_PLANS = ['personal', 'family'];
const ADDON_GB = 250;                              // what the Creator add-on adds

// Kept in one place so tests can swap them for fakes.
const deps = {
  async verify(token, secretKey) {
    const result = await verifyToken(token, { secretKey });
    if (result && Array.isArray(result.errors) && result.errors.length) throw new Error('bad token');
    const payload = result && 'data' in result ? result.data : result;
    if (!payload || !payload.sub) throw new Error('bad token');
    return payload;
  },
  // Username, email, and the saved Stripe customer ID (kept in Clerk, so no database is needed).
  async user(userId, secretKey) {
    const u = await createClerkClient({ secretKey }).users.getUser(userId);
    const primary = (u.emailAddresses || []).find((e) => e.id === u.primaryEmailAddressId) || (u.emailAddresses || [])[0];
    return {
      username: u.username ? String(u.username) : '',
      email: primary ? primary.emailAddress : '',
      stripeCustomerId: (u.privateMetadata && u.privateMetadata.stripeCustomerId) || '',
    };
  },
  async saveCustomer(userId, customerId, secretKey) {
    await createClerkClient({ secretKey }).users.updateUserMetadata(userId, { privateMetadata: { stripeCustomerId: customerId } });
  },
};

// ---- Stripe helpers (plain web requests, no extra library) ----
function form(params) {
  const out = [];
  (function walk(prefix, v) {
    if (v === undefined || v === null) return;
    if (typeof v === 'object') Object.keys(v).forEach((k) => walk(prefix ? prefix + '[' + k + ']' : k, v[k]));
    else out.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(String(v)));
  })('', params);
  return out.join('&');
}

async function stripe(key, path, method, params) {
  const isGet = method === 'GET';
  const qs = isGet && params ? '?' + form(params) : '';
  const r = await fetch('https://api.stripe.com' + path + qs, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + key }, isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: isGet ? undefined : form(params || {}),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty */ }
  return { ok: r.ok, status: r.status, data };
}

function priceFor(plan) {
  const id = PRICES[plan];
  return id && String(id).indexOf('PASTE_') !== 0 ? String(id) : '';
}

// Which of our plans are on this Stripe customer's active subscriptions?
async function stripePlans(key, customerId) {
  const r = await stripe(key, '/v1/subscriptions', 'GET', { customer: customerId, status: 'all', limit: 20 });
  if (!r.ok || !r.data || !Array.isArray(r.data.data)) throw new Error('stripe');
  const bought = new Set();
  for (const sub of r.data.data) {
    if (ACTIVE.indexOf(sub.status) === -1) continue;
    for (const item of (sub.items && sub.items.data) || []) {
      const id = item.price && item.price.id;
      for (const plan of Object.keys(PRICES)) if (id && id === PRICES[plan]) bought.add(plan);
    }
  }
  return bought;
}

function describe(bought) {
  const plans = PLAN_DATA.plans || {};
  const base = bought.has('family') ? 'family' : bought.has('personal') ? 'personal' : 'free';
  const addon = bought.has('creator') && base !== 'free';
  const b = plans[base] || { label: 'Free', storageGB: 1 };
  return {
    plan: addon ? base + '+creator' : base,
    label: b.label + (addon ? ' + Creator' : ''),
    storageGB: b.storageGB + (addon ? ADDON_GB : 0),
  };
}

// ---- who is calling ----
async function whoIs(req, res, clerkKey) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { res.status(401).json({ ok: false, error: 'Log in first.' }); return null; }
  try {
    return (await deps.verify(token, clerkKey)).sub;
  } catch (e) {
    res.status(401).json({ ok: false, error: 'Log in first.' });
    return null;
  }
}

function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return 'https://' + host;
}

async function myPlan(req, res, keys) {
  const userId = await whoIs(req, res, keys.clerk);
  if (!userId) return;
  const user = await deps.user(userId, keys.clerk);

  // 1. Plans you give out by hand in plans.json always win.
  const plans = PLAN_DATA.plans || {};
  const manual = String((PLAN_DATA.assignments || {})[user.username.toLowerCase()] || '').trim().toLowerCase();
  if (manual && plans[manual]) {
    return res.status(200).json({ ok: true, username: user.username, source: 'manual', billing: !!user.stripeCustomerId, plan: manual, label: plans[manual].label, storageGB: plans[manual].storageGB });
  }

  // 2. Otherwise, whatever they pay for in Stripe.
  if (keys.stripe && user.stripeCustomerId) {
    try {
      const d = describe(await stripePlans(keys.stripe, user.stripeCustomerId));
      return res.status(200).json({ ok: true, username: user.username, source: d.plan === 'free' ? 'free' : 'stripe', billing: true, plan: d.plan, label: d.label, storageGB: d.storageGB });
    } catch (e) { /* fall through to Free */ }
  }

  const free = plans.free || { label: 'Free', storageGB: 1 };
  return res.status(200).json({ ok: true, username: user.username, source: 'free', billing: !!user.stripeCustomerId, plan: 'free', label: free.label, storageGB: free.storageGB });
}

async function ensureCustomer(keys, userId, user) {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const c = await stripe(keys.stripe, '/v1/customers', 'POST', {
    email: user.email || undefined,
    name: user.username || undefined,
    metadata: { clerk_user_id: userId },
  });
  if (!c.ok || !c.data || !c.data.id) throw new Error('stripe customer');
  await deps.saveCustomer(userId, c.data.id, keys.clerk);
  return c.data.id;
}

async function checkout(req, res, keys, body) {
  if (!keys.stripe) return res.status(500).json({ ok: false, error: 'Payments are not set up yet.' });
  const userId = await whoIs(req, res, keys.clerk);
  if (!userId) return;

  const plan = String(body.plan || '').toLowerCase();
  if (['personal', 'family', 'creator'].indexOf(plan) === -1) return res.status(400).json({ ok: false, error: 'Unknown plan.' });
  const price = priceFor(plan);
  if (!price) return res.status(500).json({ ok: false, error: 'Payments are not set up yet.' });

  const user = await deps.user(userId, keys.clerk);
  const customerId = await ensureCustomer(keys, userId, user);

  const bought = await stripePlans(keys.stripe, customerId);
  const hasBase = BASE_PLANS.some((p) => bought.has(p));
  if (bought.has(plan)) return res.status(409).json({ ok: false, code: 'has_plan', error: 'You already have that plan.' });
  if (plan === 'creator' && !hasBase) return res.status(400).json({ ok: false, code: 'needs_base', error: 'The Creator add-on needs a Personal or Family plan first.' });
  if (plan !== 'creator' && hasBase) return res.status(409).json({ ok: false, code: 'has_plan', error: 'You already have a plan. Use Manage billing to change it.' });

  const base = siteUrl(req);
  const s = await stripe(keys.stripe, '/v1/checkout/sessions', 'POST', {
    mode: 'subscription',
    customer: customerId,
    client_reference_id: userId,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: 'true',
    subscription_data: { metadata: { clerk_user_id: userId, plan } },
    success_url: base + '/vault?checkout=success',
    cancel_url: base + '/pricing',
  });
  if (!s.ok || !s.data || !s.data.url) return res.status(502).json({ ok: false, error: 'Could not start checkout. Try again.' });
  return res.status(200).json({ ok: true, url: s.data.url });
}

async function portal(req, res, keys) {
  if (!keys.stripe) return res.status(500).json({ ok: false, error: 'Payments are not set up yet.' });
  const userId = await whoIs(req, res, keys.clerk);
  if (!userId) return;
  const user = await deps.user(userId, keys.clerk);
  if (!user.stripeCustomerId) return res.status(400).json({ ok: false, error: 'You have no billing to manage yet.' });
  const p = await stripe(keys.stripe, '/v1/billing_portal/sessions', 'POST', {
    customer: user.stripeCustomerId,
    return_url: siteUrl(req) + '/vault',
  });
  if (!p.ok || !p.data || !p.data.url) return res.status(502).json({ ok: false, error: 'Could not open billing. Try again.' });
  return res.status(200).json({ ok: true, url: p.data.url });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Use POST.' });
  }
  const keys = { clerk: process.env.CLERK_SECRET_KEY || '', stripe: process.env.STRIPE_SECRET_KEY || '' };
  if (!keys.clerk) return res.status(500).json({ ok: false, error: 'Accounts are not set up yet.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  try {
    if (body.action === 'my-plan') return await myPlan(req, res, keys);
    if (body.action === 'checkout') return await checkout(req, res, keys, body);
    if (body.action === 'portal') return await portal(req, res, keys);
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Something went wrong. Try again in a minute.' });
  }
}

module.exports = handler;
module.exports._deps = deps;
