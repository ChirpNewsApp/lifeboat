// Vercel serverless function: POST /api/news
// The News and feedback board. Anyone can read. Signed-in people can post.
// Admins (usernames listed in admins.json) can post official news, delete any post,
// and give authors a blue or yellow verified badge.
//
//   { "action": "list" }                                         newest posts first (no login needed)
//   { "action": "post", "title": "...", "text": "...", "kind": "feedback" | "news" }
//   { "action": "delete", "id": "..." }                          your own post, or any post if you are an admin
//   { "action": "badge", "id": "...", "badge": "blue" | "yellow" | "" }   admins only: badge the post's author
//
// Posts are stored as small JSON files in the same Backblaze bucket, under news/.

const crypto = require('crypto');
const account = require('./account');
const files = require('./files');
const ADMINS = require('../admins.json');

const MAX_TITLE = 120;
const MAX_TEXT = 4000;
const MAX_LIST = 100;
const POST_GAP_SECONDS = 30;          // one post every 30 seconds per person
const BADGES = ['blue', 'yellow'];

const deps = {
  async user(userId, key) { return account._deps.user(userId, key); },
  send(cfg, cmd) { return files._deps.send(cfg, cmd); },
  cmd() { return files._deps.cmd(); },
  now() { return Date.now(); },
};

function isAdmin(username) {
  const list = (ADMINS && ADMINS.admins) || [];
  return !!username && list.map((u) => String(u).toLowerCase()).indexOf(String(username).toLowerCase()) !== -1;
}

async function readJson(cfg, key, fallback) {
  const { GetObjectCommand } = deps.cmd();
  try {
    const r = await deps.send(cfg, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return fallback;
    throw e;
  }
}
async function writeJson(cfg, key, data) {
  const { PutObjectCommand } = deps.cmd();
  await deps.send(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: JSON.stringify(data), ContentType: 'application/json' }));
}

// Newest first: keys start with (a big number minus the time), so a plain listing is already in order.
function postKey(id) { return 'news/posts/' + id + '.json'; }
function newId(now) { return String(9999999999999 - now).padStart(13, '0') + '-' + crypto.randomBytes(4).toString('hex'); }
function validId(id) { return /^\d{13}-[a-f0-9]{8}$/.test(String(id || '')); }

// Who is asking (optional for reading).
async function viewer(req, keys) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const userId = (await account._deps.verify(auth.slice(7), keys.clerk)).sub;
    const u = await deps.user(userId, keys.clerk);
    return { userId, username: u.username || '', admin: isAdmin(u.username) };
  } catch (e) { return null; }
}

function publicPost(p, badges, me) {
  return {
    id: p.id, title: p.title, text: p.text, kind: p.kind, created: p.created,
    author: { name: p.username || 'member', badge: badges[p.userId] || '', admin: isAdmin(p.username) },
    mine: !!(me && me.userId === p.userId),
    canDelete: !!(me && (me.userId === p.userId || me.admin)),
  };
}

async function list(req, res, cfg, keys) {
  const me = await viewer(req, keys);
  const { ListObjectsV2Command } = deps.cmd();
  const r = await deps.send(cfg, new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: 'news/posts/', MaxKeys: MAX_LIST }));
  const keysFound = (r.Contents || []).map((o) => o.Key).filter((k) => k.endsWith('.json'));
  const [posts, badges] = await Promise.all([
    Promise.all(keysFound.map((k) => readJson(cfg, k, null))),
    readJson(cfg, 'news/badges.json', {}),
  ]);
  if (!me) res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=60');
  return res.status(200).json({
    ok: true,
    me: me ? { name: me.username, admin: me.admin } : null,
    posts: posts.filter(Boolean).map((p) => publicPost(p, badges, me)),
  });
}

async function post(req, res, cfg, keys, body) {
  const me = await viewer(req, keys);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to post.' });
  const title = String(body.title || '').replace(/\s+/g, ' ').trim();
  const text = String(body.text || '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!title) return res.status(400).json({ ok: false, error: 'Add a title.' });
  if (!text) return res.status(400).json({ ok: false, error: 'Write something in the post.' });
  if (title.length > MAX_TITLE) return res.status(400).json({ ok: false, error: 'Keep the title under ' + MAX_TITLE + ' characters.' });
  if (text.length > MAX_TEXT) return res.status(400).json({ ok: false, error: 'Keep the post under ' + MAX_TEXT.toLocaleString() + ' characters.' });
  const kind = body.kind === 'news' && me.admin ? 'news' : 'feedback';

  const now = deps.now();
  const rate = await readJson(cfg, 'news/rate/' + me.userId + '.json', null);
  if (rate && now - rate.last < POST_GAP_SECONDS * 1000 && !me.admin) {
    return res.status(429).json({ ok: false, error: 'Wait a few seconds before posting again.' });
  }
  const p = { id: newId(now), title, text, kind, created: new Date(now).toISOString(), userId: me.userId, username: me.username };
  await writeJson(cfg, postKey(p.id), p);
  await writeJson(cfg, 'news/rate/' + me.userId + '.json', { last: now });
  const badges = await readJson(cfg, 'news/badges.json', {});
  return res.status(200).json({ ok: true, post: publicPost(p, badges, me) });
}

async function remove(req, res, cfg, keys, body) {
  const me = await viewer(req, keys);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in first.' });
  if (!validId(body.id)) return res.status(400).json({ ok: false, error: 'Unknown post.' });
  const p = await readJson(cfg, postKey(body.id), null);
  if (!p) return res.status(404).json({ ok: false, error: 'That post is already gone.' });
  if (p.userId !== me.userId && !me.admin) return res.status(403).json({ ok: false, error: 'You can only delete your own posts.' });
  const { DeleteObjectCommand } = deps.cmd();
  await deps.send(cfg, new DeleteObjectCommand({ Bucket: cfg.bucket, Key: postKey(body.id) }));
  return res.status(200).json({ ok: true });
}

async function badge(req, res, cfg, keys, body) {
  const me = await viewer(req, keys);
  if (!me || !me.admin) return res.status(403).json({ ok: false, error: 'Only admins can give badges.' });
  if (!validId(body.id)) return res.status(400).json({ ok: false, error: 'Unknown post.' });
  const want = String(body.badge || '');
  if (want && BADGES.indexOf(want) === -1) return res.status(400).json({ ok: false, error: 'Badges are blue or yellow.' });
  const p = await readJson(cfg, postKey(body.id), null);
  if (!p) return res.status(404).json({ ok: false, error: 'That post is gone.' });
  const badges = await readJson(cfg, 'news/badges.json', {});
  if (want) badges[p.userId] = want; else delete badges[p.userId];
  await writeJson(cfg, 'news/badges.json', badges);
  return res.status(200).json({ ok: true, name: p.username, badge: want });
}

async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'Use POST.' }); }
  const keys = { clerk: process.env.CLERK_SECRET_KEY || '' };
  const cfg = files.config();
  if (!keys.clerk || !cfg) return res.status(500).json({ ok: false, error: 'The news board is not set up yet.' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  try {
    if (body.action === 'list') return await list(req, res, cfg, keys);
    if (body.action === 'post') return await post(req, res, cfg, keys, body);
    if (body.action === 'delete') return await remove(req, res, cfg, keys, body);
    if (body.action === 'badge') return await badge(req, res, cfg, keys, body);
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    console.error('Lifeboat news error:', err);
    return res.status(500).json({ ok: false, error: 'The news board had a problem. Try again in a minute.' });
  }
}

module.exports = handler;
module.exports._deps = deps;
