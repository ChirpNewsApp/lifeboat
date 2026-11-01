// Vercel serverless function: POST /api/news
// The News and feedback board. Anyone can read. Signed-in people can post.
// Admins (usernames listed in admins.json) can post official news, delete any post,
// and give authors a blue or yellow verified badge.
//
//   { "action": "list" }                                         newest posts first (no login needed)
//   { "action": "post", "title": "...", "text": "...", "kind": "other" | "bug" | "staff" | "news" }   a tag is required; news is admins only
//   Staff reports are private: only admins and the person who wrote it can see or reply to them.
//   Bug reports email everyone on the team (admins plus the Team tag) and get an instant reply from Lifeboat Bot.
//   { "action": "delete", "id": "..." }                          your own post, or any post if you are an admin
//   { "action": "badge", "id": "...", "badge": "blue" | "yellow" | "" }   admins only: badge the post's author
//   { "action": "avatar-url", "type": "image/jpeg", "size": 12345 }   admins only: link to upload a profile picture
//   { "action": "avatar-set", "key": "..." } / { "action": "avatar-remove" }   admins only
//   { "action": "image-url", "type": "image/png", "size": 12345 }   admins only: link to upload one photo for a post
//   Posts can include "images": [keys from image-url], admins only, up to 4.
//   { "action": "pin", "id": "...", "pinned": true | false }   admins only: pinned posts show first
//   { "action": "reply", "id": "...", "text": "..." }   admins and people with the yellow badge only
//   { "action": "reply-delete", "id": "...", "replyId": "..." }   the reply's author or an admin
//   { "action": "tag", "id": "...", "tag": "team" | "bughunter", "on": true | false }   admins only: give the post's author a tag
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
const TAGS = ['team', 'bughunter'];    // tags admins can give, shown next to the name (admins always show Team)
const MAX_AVATAR_BYTES = 5 * 1000 * 1000;
const AVATAR_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const AVATAR_KEY = /^news\/avatars\/[a-f0-9]{24}\.(jpg|png|webp|gif)$/;
const MAX_IMAGES = 4;
const MAX_PINS = 10;
const MAX_REPLY = 1000;
const MAX_REPLIES = 100;
const MAX_IMAGE_BYTES = 10 * 1000 * 1000;
const IMAGE_KEY = /^news\/img\/[a-f0-9]{24}\.(jpg|png|webp|gif)$/;

const deps = {
  async user(userId, key) { return account._deps.user(userId, key); },
  send(cfg, cmd) { return files._deps.send(cfg, cmd); },
  sign(cfg, cmd, seconds) { return files._deps.sign(cfg, cmd, seconds); },
  // Everyone on the team: admins (admins.json) and people with the Team tag.
  async teamEmails(keys, tags) {
    const out = new Set();
    const tagged = Object.keys(tags || {}).filter((id) => tags[id] && tags[id].team);
    await Promise.all(tagged.map(async (id) => { try { const u = await account._deps.user(id, keys.clerk); if (u && u.email) out.add(String(u.email).toLowerCase()); } catch (e) { /* skip */ } }));
    await Promise.all(((ADMINS && ADMINS.admins) || []).map(async (name) => { try { const u = await files._deps.findUser(name, keys.clerk); if (u && u.email) out.add(String(u.email).toLowerCase()); } catch (e) { /* skip */ } }));
    return [...out].slice(0, 25);
  },
  sendEmail(to, subject, text, html) { return files._deps.sendEmail(to, subject, text, html); },
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

// Profile pictures (admins only). Returns a function that gives a short-lived view link per person.
async function avatarLinks(cfg) {
  const map = await readJson(cfg, 'news/avatars.json', {});
  const { GetObjectCommand } = deps.cmd();
  const cache = {};
  return async function (userId, username) {
    if (!isAdmin(username) || !map[userId]) return '';
    if (!(userId in cache)) cache[userId] = deps.sign(cfg, new GetObjectCommand({ Bucket: cfg.bucket, Key: map[userId] }), 3600).catch(() => '');
    return cache[userId];
  };
}

function tagsOf(tags, userId) { return TAGS.filter((t) => tags && tags[userId] && tags[userId][t]); }
async function authorOf(userId, username, badges, tags, avatarOf) {
  if (userId === BOT.id) return { name: BOT.name, badge: 'yellow', admin: false, tags: ['team'], avatar: BOT.avatar, bot: true };
  return { name: username || 'member', badge: badges[userId] || '', admin: isAdmin(username), tags: tagsOf(tags, userId), avatar: avatarOf ? await avatarOf(userId, username) : '' };
}

async function publicPost(cfg, p, badges, me, avatarOf, tags) {
  const { GetObjectCommand } = deps.cmd();
  const images = await Promise.all((p.images || []).map((k) => deps.sign(cfg, new GetObjectCommand({ Bucket: cfg.bucket, Key: k }), 3600).catch(() => '')));
  return {
    id: p.id, title: p.title, text: p.text, kind: p.kind, created: p.created, images: images.filter(Boolean),
    author: await authorOf(p.userId, p.username, badges, tags, avatarOf),
    mine: !!(me && me.userId === p.userId),
    canDelete: !!(me && (me.userId === p.userId || me.admin)),
    replies: await Promise.all((p.replies || []).map(async (r) => ({
      id: r.id, text: r.text, created: r.created,
      author: await authorOf(r.userId, r.username, badges, tags, avatarOf),
      canDelete: !!(me && (me.admin || (r.userId !== BOT.id && me.userId === r.userId))),
    }))),
  };
}

// Only admins and people with the yellow badge can reply.
// Who can reply: admins, people with the yellow badge, and people with the Team tag.
function canReply(me, badges, tags) { return !!me && (me.admin || badges[me.userId] === 'yellow' || !!(tags && tags[me.userId] && tags[me.userId].team)); }
// Staff reports are only for admins and the person who wrote them.
function canSee(p, me) { return p.kind !== 'staff' || (!!me && (me.admin || me.userId === p.userId)); }
const KINDS = ['other', 'bug', 'staff'];
const BOT = { id: 'lifeboat-bot', name: 'Lifeboat Bot', avatar: '/bot.svg' };
const BOT_BUG_REPLY = 'Thanks for reporting a bug. Staff have been notified and will be with you soon.';
const SITE = 'https://www.lifeboatrecovery.com';

async function list(req, res, cfg, keys) {
  const me = await viewer(req, keys);
  const { ListObjectsV2Command } = deps.cmd();
  const [r, pins] = await Promise.all([
    deps.send(cfg, new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: 'news/posts/', MaxKeys: MAX_LIST })),
    readJson(cfg, 'news/pins.json', []),
  ]);
  // Pinned posts come first (most recently pinned on top), even if they are older than the newest 100.
  const pinKeys = pins.filter(validId).map(postKey);
  const keysFound = pinKeys.concat((r.Contents || []).map((o) => o.Key).filter((k) => k.endsWith('.json') && pinKeys.indexOf(k) === -1));
  const [posts, badges, avatarOf, tags] = await Promise.all([
    Promise.all(keysFound.map((k) => readJson(cfg, k, null))),
    readJson(cfg, 'news/badges.json', {}),
    avatarLinks(cfg),
    readJson(cfg, 'news/tags.json', {}),
  ]);
  if (!me) res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=60');
  return res.status(200).json({
    ok: true,
    me: me ? { name: me.username, admin: me.admin, canReply: canReply(me, badges, tags), avatar: me.admin ? await avatarOf(me.userId, me.username) : '' } : null,
    posts: await Promise.all(posts.filter((p) => p && canSee(p, me)).map(async (p) => Object.assign(await publicPost(cfg, p, badges, me, avatarOf, tags), { pinned: pins.indexOf(p.id) !== -1 }))),
  });
}

async function reply(req, res, cfg, keys, body) {
  const me = await viewer(req, keys);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in first.' });
  const [badges, avatarOf, tags] = await Promise.all([readJson(cfg, 'news/badges.json', {}), avatarLinks(cfg), readJson(cfg, 'news/tags.json', {})]);
  if (!validId(body.id)) return res.status(400).json({ ok: false, error: 'Unknown post.' });
  const text = String(body.text || '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Write a reply first.' });
  if (text.length > MAX_REPLY) return res.status(400).json({ ok: false, error: 'Keep replies under ' + MAX_REPLY.toLocaleString() + ' characters.' });
  const p = await readJson(cfg, postKey(body.id), null);
  if (!p || !canSee(p, me)) return res.status(404).json({ ok: false, error: 'That post is gone.' });
  // Staff reports: staff and the author can talk. Everything else: admins and yellow badges.
  const allowed = p.kind === 'staff' ? (me.admin || me.userId === p.userId) : canReply(me, badges, tags);
  if (!allowed) return res.status(403).json({ ok: false, error: 'Only the team and people with the yellow badge can reply.' });
  p.replies = p.replies || [];
  if (p.replies.length >= MAX_REPLIES) return res.status(400).json({ ok: false, error: 'This post has reached the reply limit.' });
  const now = deps.now();
  const r = { id: now.toString(36) + crypto.randomBytes(3).toString('hex'), text, created: new Date(now).toISOString(), userId: me.userId, username: me.username };
  p.replies.push(r);
  await writeJson(cfg, postKey(p.id), p);
  return res.status(200).json({ ok: true, reply: {
    id: r.id, text: r.text, created: r.created,
    author: await authorOf(r.userId, r.username, badges, tags, avatarOf),
    canDelete: true,
  } });
}

async function replyDelete(req, res, cfg, keys, body) {
  const me = await viewer(req, keys);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in first.' });
  if (!validId(body.id)) return res.status(400).json({ ok: false, error: 'Unknown post.' });
  const p = await readJson(cfg, postKey(body.id), null);
  if (!p) return res.status(404).json({ ok: false, error: 'That post is gone.' });
  const r = (p.replies || []).filter((x) => x.id === String(body.replyId || ''))[0];
  if (!r) return res.status(404).json({ ok: false, error: 'That reply is already gone.' });
  if (r.userId !== me.userId && !me.admin) return res.status(403).json({ ok: false, error: 'You can only delete your own replies.' });
  p.replies = p.replies.filter((x) => x !== r);
  await writeJson(cfg, postKey(p.id), p);
  return res.status(200).json({ ok: true });
}

async function pin(req, res, cfg, keys, body) {
  const me = await viewer(req, keys);
  if (!me || !me.admin) return res.status(403).json({ ok: false, error: 'Only admins can pin posts.' });
  if (!validId(body.id)) return res.status(400).json({ ok: false, error: 'Unknown post.' });
  if (!(await readJson(cfg, postKey(body.id), null))) return res.status(404).json({ ok: false, error: 'That post is gone.' });
  let pins = (await readJson(cfg, 'news/pins.json', [])).filter((x) => x !== body.id);
  if (body.pinned) {
    if (pins.length >= MAX_PINS) return res.status(400).json({ ok: false, error: 'You can pin up to ' + MAX_PINS + ' posts. Unpin one first.' });
    pins.unshift(body.id);
  }
  await writeJson(cfg, 'news/pins.json', pins);
  return res.status(200).json({ ok: true, pinned: !!body.pinned });
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
  const want = String(body.kind || '');
  if (want === 'news' && !me.admin) return res.status(403).json({ ok: false, error: 'Only admins can post news.' });
  if (want !== 'news' && KINDS.indexOf(want) === -1) return res.status(400).json({ ok: false, error: 'Pick a tag for your post: Other, Bug Report, or Staff Report.' });
  const kind = want;
  const images = Array.isArray(body.images) ? body.images.map(String) : [];
  if (images.length && !me.admin) return res.status(403).json({ ok: false, error: 'Only admins can add photos.' });
  if (images.length > MAX_IMAGES) return res.status(400).json({ ok: false, error: 'Up to ' + MAX_IMAGES + ' photos per post.' });
  if (images.some((k) => !IMAGE_KEY.test(k))) return res.status(400).json({ ok: false, error: 'One of the photos did not upload properly. Try again.' });

  const now = deps.now();
  const rate = await readJson(cfg, 'news/rate/' + me.userId + '.json', null);
  if (rate && now - rate.last < POST_GAP_SECONDS * 1000 && !me.admin) {
    return res.status(429).json({ ok: false, error: 'Wait a few seconds before posting again.' });
  }
  const p = { id: newId(now), title, text, kind, images, created: new Date(now).toISOString(), userId: me.userId, username: me.username };
  if (kind === 'bug') p.replies = [{ id: 'bot' + now.toString(36), text: BOT_BUG_REPLY, created: new Date(now + 1000).toISOString(), userId: BOT.id, username: BOT.name }];
  await writeJson(cfg, postKey(p.id), p);
  if (kind === 'bug') await notifyTeam(cfg, keys, p);
  await writeJson(cfg, 'news/rate/' + me.userId + '.json', { last: now });
  const [badges, avatarOf, tags] = await Promise.all([readJson(cfg, 'news/badges.json', {}), avatarLinks(cfg), readJson(cfg, 'news/tags.json', {})]);
  return res.status(200).json({ ok: true, post: await publicPost(cfg, p, badges, me, avatarOf, tags) });
}

// Email the team about a new bug report. Failures never block the post.
async function notifyTeam(cfg, keys, p) {
  try {
    const tags = await readJson(cfg, 'news/tags.json', {});
    const to = await deps.teamEmails(keys, tags);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const preview = p.text.length > 400 ? p.text.slice(0, 397) + '...' : p.text;
    const subject = 'New bug report: respond now!';
    const text = '@' + p.username + ' reported a bug on Lifeboat.\n\n' + p.title + '\n\n' + preview + '\n\nRespond now: ' + SITE + '/news';
    const html = '<div style="font-family:Arial,sans-serif;color:#0A3340;max-width:520px">'
      + '<p style="font-size:13px;font-weight:bold;color:#C2321B;margin:0 0 6px">NEW BUG REPORT</p>'
      + '<p style="font-size:20px;font-weight:bold;margin:0 0 4px">' + esc(p.title) + '</p>'
      + '<p style="font-size:14px;color:#4F6E77;margin:0 0 14px">from @' + esc(p.username) + '</p>'
      + '<p style="font-size:15px;white-space:pre-wrap;margin:0 0 18px">' + esc(preview) + '</p>'
      + '<p><a href="' + SITE + '/news" style="display:inline-block;background:#FF5B2E;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Respond now</a></p></div>';
    await Promise.all(to.map((addr) => deps.sendEmail(addr, subject, text, html).catch(() => null)));
  } catch (e) { console.error('Lifeboat bug-report email failed:', e); }
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
  for (const k of p.images || []) { try { await deps.send(cfg, new DeleteObjectCommand({ Bucket: cfg.bucket, Key: k })); } catch (e) { /* already gone */ } }
  const pins = await readJson(cfg, 'news/pins.json', []);
  if (pins.indexOf(body.id) !== -1) await writeJson(cfg, 'news/pins.json', pins.filter((x) => x !== body.id));
  return res.status(200).json({ ok: true });
}

async function tag(req, res, cfg, keys, body) {
  const me = await viewer(req, keys);
  if (!me || !me.admin) return res.status(403).json({ ok: false, error: 'Only admins can give tags.' });
  if (!validId(body.id)) return res.status(400).json({ ok: false, error: 'Unknown post.' });
  const t = String(body.tag || '');
  if (TAGS.indexOf(t) === -1) return res.status(400).json({ ok: false, error: 'Unknown tag.' });
  const p = await readJson(cfg, postKey(body.id), null);
  if (!p) return res.status(404).json({ ok: false, error: 'That post is gone.' });
  const tags = await readJson(cfg, 'news/tags.json', {});
  const mine = Object.assign({}, tags[p.userId] || {});
  if (body.on) mine[t] = true; else delete mine[t];
  if (Object.keys(mine).length) tags[p.userId] = mine; else delete tags[p.userId];
  await writeJson(cfg, 'news/tags.json', tags);
  return res.status(200).json({ ok: true, name: p.username, tag: t, on: !!body.on });
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

async function uploadLink(req, res, cfg, keys, body) {
  const forPost = body.action === 'image-url';
  const me = await viewer(req, keys);
  if (!me || !me.admin) return res.status(403).json({ ok: false, error: forPost ? 'Only admins can add photos.' : 'Only admins can upload a profile picture.' });
  const ext = AVATAR_TYPES[String(body.type || '')];
  if (!ext) return res.status(400).json({ ok: false, error: 'Use a JPG, PNG, WebP, or GIF picture.' });
  const size = Number(body.size);
  const max = forPost ? MAX_IMAGE_BYTES : MAX_AVATAR_BYTES;
  if (!Number.isFinite(size) || size <= 0 || Math.floor(size) !== size) return res.status(400).json({ ok: false, error: 'Bad picture size.' });
  if (size > max) return res.status(413).json({ ok: false, error: (forPost ? 'Each photo' : 'Profile pictures') + ' can be up to ' + (max / 1e6) + ' MB.' });
  const key = (forPost ? 'news/img/' : 'news/avatars/') + crypto.randomBytes(12).toString('hex') + '.' + ext;
  const { PutObjectCommand } = deps.cmd();
  const url = await deps.sign(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: body.type, ContentLength: size }), 600);
  return res.status(200).json({ ok: true, url, key });
}

async function avatarSet(req, res, cfg, keys, body) {
  const me = await viewer(req, keys);
  if (!me || !me.admin) return res.status(403).json({ ok: false, error: 'Only admins can upload a profile picture.' });
  const remove = body.action === 'avatar-remove';
  const key = String(body.key || '');
  if (!remove && !AVATAR_KEY.test(key)) return res.status(400).json({ ok: false, error: 'The picture did not upload properly. Try again.' });
  const map = await readJson(cfg, 'news/avatars.json', {});
  const old = map[me.userId];
  if (remove) delete map[me.userId]; else map[me.userId] = key;
  await writeJson(cfg, 'news/avatars.json', map);
  if (old && old !== key) { const { DeleteObjectCommand } = deps.cmd(); try { await deps.send(cfg, new DeleteObjectCommand({ Bucket: cfg.bucket, Key: old })); } catch (e) { /* gone */ } }
  let avatar = '';
  if (!remove) { const { GetObjectCommand } = deps.cmd(); avatar = await deps.sign(cfg, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), 3600); }
  return res.status(200).json({ ok: true, avatar });
}

async function handler(req, res) {
  // GET is the public, cacheable list (no login), so pages can pre-load the news quickly.
  if (req.method === 'GET') {
    const cfgG = files.config();
    if (!process.env.CLERK_SECRET_KEY || !cfgG) return res.status(500).json({ ok: false, error: 'The news board is not set up yet.' });
    try { req.headers = Object.assign({}, req.headers, { authorization: '' }); return await list(req, res, cfgG, { clerk: process.env.CLERK_SECRET_KEY }); }
    catch (err) { console.error('Lifeboat news error:', err); return res.status(500).json({ ok: false, error: 'The news board had a problem. Try again in a minute.' }); }
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'Use GET or POST.' }); }
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
    if (body.action === 'tag') return await tag(req, res, cfg, keys, body);
    if (body.action === 'pin') return await pin(req, res, cfg, keys, body);
    if (body.action === 'reply') return await reply(req, res, cfg, keys, body);
    if (body.action === 'reply-delete') return await replyDelete(req, res, cfg, keys, body);
    if (body.action === 'avatar-url' || body.action === 'image-url') return await uploadLink(req, res, cfg, keys, body);
    if (body.action === 'avatar-set' || body.action === 'avatar-remove') return await avatarSet(req, res, cfg, keys, body);
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    console.error('Lifeboat news error:', err);
    return res.status(500).json({ ok: false, error: 'The news board had a problem. Try again in a minute.' });
  }
}

module.exports = handler;
module.exports._deps = deps;
