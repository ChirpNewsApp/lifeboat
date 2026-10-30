// Vercel serverless function: POST /api/account
// Accounts are handled by Clerk. This function does one thing: it tells the page
// which plan the logged-in person has, by looking up their username in plans.json.
//
//   { "action": "my-plan" }   with header   Authorization: Bearer <Clerk session token>
//
// Environment variable (set in Vercel, see ACCOUNTS-SETUP.md):
//   CLERK_SECRET_KEY   SECRET. Never put this in the page or on GitHub.

const { verifyToken, createClerkClient } = require('@clerk/backend');
const PLAN_DATA = require('../plans.json'); // edit plans.json to give someone a plan

// Kept in one place so tests can swap them for fakes.
const deps = {
  // Returns the verified token contents, or throws if the token is fake or expired.
  async verify(token, secretKey) {
    const result = await verifyToken(token, { secretKey });
    if (result && Array.isArray(result.errors) && result.errors.length) throw new Error('bad token');
    const payload = result && 'data' in result ? result.data : result;
    if (!payload || !payload.sub) throw new Error('bad token');
    return payload;
  },
  async username(userId, secretKey) {
    const user = await createClerkClient({ secretKey }).users.getUser(userId);
    return user && user.username ? String(user.username) : '';
  },
};

async function myPlan(req, res, secretKey) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ ok: false, error: 'Log in first.' });

  let userId;
  try {
    userId = (await deps.verify(token, secretKey)).sub;
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Log in first.' });
  }

  const username = await deps.username(userId, secretKey);

  const plans = PLAN_DATA.plans || {};
  const assigned = String((PLAN_DATA.assignments || {})[username.toLowerCase()] || 'free').trim().toLowerCase();
  const key = plans[assigned] ? assigned : 'free'; // unknown plan names fall back to free
  const plan = plans[key] || { label: 'Free', storageGB: 1 };

  return res.status(200).json({ ok: true, username, plan: key, label: plan.label, storageGB: plan.storageGB });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Use POST.' });
  }
  const secretKey = process.env.CLERK_SECRET_KEY || '';
  if (!secretKey) return res.status(500).json({ ok: false, error: 'Accounts are not set up yet.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  try {
    if (body.action === 'my-plan') return await myPlan(req, res, secretKey);
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Something went wrong. Try again in a minute.' });
  }
}

module.exports = handler;
module.exports._deps = deps;
