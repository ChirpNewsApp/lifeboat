// Vercel serverless function: /api/team
// The public Team page. Anyone can read it. Admins (usernames in admins.json) can add, edit,
// reorder, and remove team members, with a role, a short bio, and a profile picture.
//
//   GET                                               public list (cached for a few seconds)
//   POST { "action": "list" }                         same list, plus whether you are an admin
//   POST { "action": "photo-url", "type": "image/jpeg", "size": 12345 }   admins: link to upload a picture
//   POST { "action": "save", "id"?: "...", "name": "...", "role": "...", "bio": "...", "photo"?: "key" | "" }
//   POST { "action": "delete", "id": "..." }
//   POST { "action": "move", "id": "...", "dir": -1 | 1 }
//
// Stored in the Backblaze bucket: team/members.json and team/photos/.

const crypto = require('crypto');
const account = require('./account');
const files = require('./files');
const ADMINS = require('../admins.json');

const LIST_KEY = 'team/members.json';
const PHOTO_KEY = /^team\/photos\/[a-f0-9]{24}\.(jpg|png|webp|gif)$/;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_PHOTO_BYTES = 5 * 1000 * 1000;
const MAX_MEMBERS = 50;

const deps = {
  send(cfg, cmd) { return files._deps.send(cfg, cmd); },
  sign(cfg, cmd, seconds) { return files._deps.sign(cfg, cmd, seconds); },
  cmd() { return files._deps.cmd(); },
};

function isAdmin(username) {
  const list = (ADMINS && ADMINS.admins) || [];
  return !!username && list.map((u) => String(u).toLowerCase()).indexOf(String(username).toLowerCase()) !== -1;
}
async function viewer(req, keys) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const userId = (await account._deps.verify(auth.slice(7), keys.clerk)).sub;
    const u = await account._deps.user(userId, keys.clerk);
    return { userId, username: u.username || '', admin: isAdmin(u.username) };
  } catch (e) { return null; }
}
async function readList(cfg) {
  const { GetObjectCommand } = deps.cmd();
  try { const r = await deps.send(cfg, new GetObjectCommand({ Bucket: cfg.bucket, Key: LIST_KEY })); return JSON.parse(await r.Body.transformToString()); }
  catch (e) { if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return []; throw e; }
}
async function writeList(cfg, list) {
  const { PutObjectCommand } = deps.cmd();
  await deps.send(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: LIST_KEY, Body: JSON.stringify(list), ContentType: 'application/json' }));
}
async function dropPhoto(cfg, key) {
  if (!key) return;
  const { DeleteObjectCommand } = deps.cmd();
  try { await deps.send(cfg, new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key })); } catch (e) { /* gone */ }
}
async function publicList(cfg, list) {
  const { GetObjectCommand } = deps.cmd();
  return Promise.all(list.map(async (m) => ({
    id: m.id, name: m.name, role: m.role, bio: m.bio || '',
    photo: m.photo ? await deps.sign(cfg, new GetObjectCommand({ Bucket: cfg.bucket, Key: m.photo }), 3600).catch(() => '') : '',
  })));
}
function clean(s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max); }

async function handler(req, res) {
  const keys = { clerk: process.env.CLERK_SECRET_KEY || '' };
  const cfg = files.config();
  if (!keys.clerk || !cfg) return res.status(500).json({ ok: false, error: 'The team page is not set up yet.' });
  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=300');
      return res.status(200).json({ ok: true, me: null, members: await publicList(cfg, await readList(cfg)) });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'Use GET or POST.' }); }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const me = await viewer(req, keys);

    if (body.action === 'list') {
      return res.status(200).json({ ok: true, me: me ? { name: me.username, admin: me.admin } : null, members: await publicList(cfg, await readList(cfg)) });
    }
    if (!me || !me.admin) return res.status(403).json({ ok: false, error: 'Only admins can change the team page.' });

    if (body.action === 'photo-url') {
      const ext = PHOTO_TYPES[String(body.type || '')];
      if (!ext) return res.status(400).json({ ok: false, error: 'Use a JPG, PNG, WebP, or GIF picture.' });
      const size = Number(body.size);
      if (!Number.isFinite(size) || size <= 0 || Math.floor(size) !== size) return res.status(400).json({ ok: false, error: 'Bad picture size.' });
      if (size > MAX_PHOTO_BYTES) return res.status(413).json({ ok: false, error: 'Pictures can be up to 5 MB.' });
      const key = 'team/photos/' + crypto.randomBytes(12).toString('hex') + '.' + ext;
      const { PutObjectCommand } = deps.cmd();
      const url = await deps.sign(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: body.type, ContentLength: size }), 600);
      return res.status(200).json({ ok: true, url, key });
    }

    const list = await readList(cfg);
    if (body.action === 'save') {
      const name = clean(body.name, 80), role = clean(body.role, 80), bio = clean(body.bio, 300);
      if (!name) return res.status(400).json({ ok: false, error: 'Add their name.' });
      if (!role) return res.status(400).json({ ok: false, error: 'Add their role.' });
      const photo = body.photo === undefined ? undefined : String(body.photo || '');
      if (photo && !PHOTO_KEY.test(photo)) return res.status(400).json({ ok: false, error: 'The picture did not upload properly. Try again.' });
      let m = body.id ? list.filter((x) => x.id === String(body.id))[0] : null;
      if (body.id && !m) return res.status(404).json({ ok: false, error: 'That team member is gone.' });
      if (!m) {
        if (list.length >= MAX_MEMBERS) return res.status(400).json({ ok: false, error: 'The team page holds up to ' + MAX_MEMBERS + ' people.' });
        m = { id: crypto.randomBytes(6).toString('hex'), photo: '' };
        list.push(m);
      }
      const oldPhoto = m.photo;
      m.name = name; m.role = role; m.bio = bio;
      if (photo !== undefined) m.photo = photo;
      await writeList(cfg, list);
      if (oldPhoto && oldPhoto !== m.photo) await dropPhoto(cfg, oldPhoto);
      return res.status(200).json({ ok: true, members: await publicList(cfg, list) });
    }
    if (body.action === 'delete') {
      const m = list.filter((x) => x.id === String(body.id || ''))[0];
      if (!m) return res.status(404).json({ ok: false, error: 'That team member is already gone.' });
      const next = list.filter((x) => x !== m);
      await writeList(cfg, next);
      await dropPhoto(cfg, m.photo);
      return res.status(200).json({ ok: true, members: await publicList(cfg, next) });
    }
    if (body.action === 'move') {
      const i = list.findIndex((x) => x.id === String(body.id || ''));
      const j = i + (Number(body.dir) < 0 ? -1 : 1);
      if (i === -1) return res.status(404).json({ ok: false, error: 'That team member is gone.' });
      if (j >= 0 && j < list.length) { const t = list[i]; list[i] = list[j]; list[j] = t; await writeList(cfg, list); }
      return res.status(200).json({ ok: true, members: await publicList(cfg, list) });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    console.error('Lifeboat team error:', err);
    return res.status(500).json({ ok: false, error: 'The team page had a problem. Try again in a minute.' });
  }
}

module.exports = handler;
module.exports._deps = deps;
