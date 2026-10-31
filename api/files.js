// Vercel serverless function: POST /api/files
// Each person gets a private area in a Backblaze B2 bucket. Files go straight from the
// browser to B2 using short-lived signed links, so big files never pass through Vercel.
// Every action needs a logged-in person:  Authorization: Bearer <Clerk session token>
//
//   { "action": "list", "path": "photos" }                    folders and files inside a folder ("" = top)
//   { "action": "upload-url", "path": "photos/me.jpg", "size": 123, "type": "image/jpeg" }
//   { "action": "folder", "path": "photos/2026" }             make a folder
//   { "action": "download-url", "path": "photos/me.jpg" }
//   { "action": "delete", "path": "photos/me.jpg" }           add "folder": true to delete a folder and everything in it
//   { "action": "delete-all", "path": "photos" }             empty a folder but keep it ("" = the whole vault)
//   { "action": "upload-urls", "files": [{ "path", "size", "type" }] }   many upload links at once (folder backups)
//   { "action": "list-all", "path": "Minecraft/2026-10-31 at 14.05.00" }  every file under a folder, with links (for zips)
//   { "action": "pw-load" } / { "action": "pw-save", "data": "..." } / { "action": "pw-delete" }
//        the password vault. It is encrypted in the browser; the server only ever sees scrambled data.
//
// Every action except send-code and verify-code also needs a vault pass:  X-Vault-Access: <token>
//   { "action": "send-code" }                emails a 6-digit code to the account's email
//   { "action": "verify-code", "code": "123456" }   returns a token that opens the vault for 1 hour
//
// Add "space" to any file action to pick the area: files (default), games, social, sites.
//
// Environment variables (set in Vercel, see STORAGE-SETUP.md):
//   B2_KEY_ID, B2_APP_KEY   SECRET.  A Backblaze application key limited to your bucket.
//   B2_BUCKET               the bucket name
//   B2_ENDPOINT             e.g. https://s3.us-west-004.backblazeb2.com
//   CLERK_SECRET_KEY, STRIPE_SECRET_KEY   already set for the account function
//   RESEND_API_KEY, FROM_EMAIL            already set for the waitlist; used to email vault codes

const crypto = require('crypto');
const account = require('./account');

const MAX_FILE_BYTES = 4 * 1000 * 1000 * 1000; // one file can be up to 4 GB
const MAX_NAME = 200;
const MAX_PATH = 800;
const MAX_LIST_PAGES = 200;                     // safety stop when adding up storage (200,000 files)
const LINK_SECONDS = 600;
const PREVIEW_SECONDS = 3600;                  // image preview links last an hour
const MAX_PREVIEWS = 300;                       // per folder listing
const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;
const SPACES = { files: 'u', games: 'g', social: 's', sites: 'w' };   // each has its own folder tree
const PASSWORD_PREFIX = 'p';
const MAX_BATCH = 500;
const MAX_LIST_ALL = 10000;
const MAX_VAULT_BYTES = 2 * 1000 * 1000;
const CODE_MINUTES = 10;
const CODE_RESEND_SECONDS = 45;
const CODE_MAX_TRIES = 5;
const PASS_HOURS = 1;

// Kept in one place so tests can swap them for fakes.
const deps = {
  _clients: {},
  async s3(cfg) {
    if (this._clients[cfg.keyId]) return this._clients[cfg.keyId];
    const { S3Client } = require('@aws-sdk/client-s3');
    const m = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(cfg.endpoint);
    this._clients[cfg.keyId] = new S3Client({
      region: m ? m[1] : 'us-west-004',
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.appKey },
      // Backblaze does not accept the extra checksum headers newer SDK versions add by default.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return this._clients[cfg.keyId];
  },
  async send(cfg, command) {
    return (await this.s3(cfg)).send(command);
  },
  async sign(cfg, command, seconds) {
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    return getSignedUrl(await this.s3(cfg), command, { expiresIn: seconds });
  },
  cmd() { return require('@aws-sdk/client-s3'); },
  async codeState(userId, secretKey) {
    const { createClerkClient } = require('@clerk/backend');
    const u = await createClerkClient({ secretKey }).users.getUser(userId);
    const primary = (u.emailAddresses || []).find((e) => e.id === u.primaryEmailAddressId) || (u.emailAddresses || [])[0];
    return { email: primary ? primary.emailAddress : '', state: (u.privateMetadata && u.privateMetadata.vaultCode) || null };
  },
  async saveCodeState(userId, state, secretKey) {
    const { createClerkClient } = require('@clerk/backend');
    await createClerkClient({ secretKey }).users.updateUserMetadata(userId, { privateMetadata: { vaultCode: state } });
  },
  async sendEmail(to, subject, text, html) {
    const key = process.env.RESEND_API_KEY, from = process.env.FROM_EMAIL;
    if (!key || !from) throw Object.assign(new Error('Email is not set up (RESEND_API_KEY and FROM_EMAIL in Vercel).'), { code: 'no_email' });
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
    if (!r.ok) throw Object.assign(new Error('The email service refused the message (' + r.status + ').'), { code: 'email_failed' });
  },
};

// Accepts "s3.us-west-004.backblazeb2.com", with or without https:// and stray spaces or slashes.
function fixEndpoint(raw) {
  let e = String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  if (!e) return '';
  if (!/^https?:\/\//i.test(e)) e = 'https://' + e;
  const m = /^(https?:\/\/[^\/]+)/i.exec(e);
  return m ? m[1] : e;
}

function config() {
  const c = {
    keyId: String(process.env.B2_KEY_ID || '').trim(),
    appKey: String(process.env.B2_APP_KEY || '').trim(),
    bucket: String(process.env.B2_BUCKET || '').trim(),
    endpoint: fixEndpoint(process.env.B2_ENDPOINT),
  };
  return c.keyId && c.appKey && c.bucket && c.endpoint ? c : null;
}

// ---- paths: always inside the caller's own area, never anywhere else ----
function cleanPath(raw, allowEmpty) {
  let p = String(raw === undefined || raw === null ? '' : raw).normalize('NFC').replace(/^\/+|\/+$/g, '');
  if (!p) return allowEmpty ? '' : null;
  if (p.length > MAX_PATH) return null;
  const parts = p.split('/');
  for (const s of parts) {
    if (!s || s.length > MAX_NAME || s === '.' || s === '..') return null;
    if (/[\u0000-\u001f\u007f\\]/.test(s)) return null;
  }
  return parts.join('/');
}
function areaOf(userId, space) { return (SPACES[space || 'files'] || 'u') + '/' + userId + '/'; }

// How many bytes this person stores across every area (files, game saves, social, sites, passwords).
async function usedTotal(cfg, userId) {
  const prefixes = Object.values(SPACES).concat(PASSWORD_PREFIX).map((p) => p + '/' + userId + '/');
  const parts = await Promise.all(prefixes.map((p) => usedBytes(cfg, p)));
  return parts.reduce((s, n) => s + n, 0);
}

// How many bytes this person already stores.
async function usedBytes(cfg, area) {
  const { ListObjectsV2Command } = deps.cmd();
  let total = 0, token;
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    const r = await deps.send(cfg, new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: area, ContinuationToken: token }));
    for (const o of r.Contents || []) total += o.Size || 0;
    if (!r.IsTruncated) break;
    token = r.NextContinuationToken;
  }
  return total;
}

async function quotaBytes(keys, userId) {
  const plan = await account.resolvePlan(keys, userId);
  return { bytes: Math.round(plan.storageGB * 1e9), plan };
}

async function list(res, cfg, keys, userId, body) {
  const area = body._area;
  const path = cleanPath(body.path, true);
  if (path === null) return res.status(400).json({ ok: false, error: 'That folder name is not allowed.' });
  const prefix = area + (path ? path + '/' : '');
  const { ListObjectsV2Command } = deps.cmd();

  const folders = [], files = [];
  let token;
  for (let i = 0; i < 20; i++) {
    const r = await deps.send(cfg, new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }));
    for (const p of r.CommonPrefixes || []) folders.push(p.Prefix.slice(prefix.length).replace(/\/$/, ''));
    for (const o of r.Contents || []) {
      const name = o.Key.slice(prefix.length);
      if (!name || name.endsWith('/')) continue; // the empty marker that makes a folder
      files.push({ name, size: o.Size || 0, modified: o.LastModified ? new Date(o.LastModified).toISOString() : '' });
    }
    if (!r.IsTruncated) break;
    token = r.NextContinuationToken;
  }
  folders.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.name.localeCompare(b.name));

  // Short-lived view links for pictures, so the vault can show previews.
  const { GetObjectCommand } = deps.cmd();
  const pics = files.filter((f) => IMAGE_RE.test(f.name)).slice(0, MAX_PREVIEWS);
  await Promise.all(pics.map(async (f) => {
    try { f.preview = await deps.sign(cfg, new GetObjectCommand({ Bucket: cfg.bucket, Key: prefix + f.name }), PREVIEW_SECONDS); } catch (e) { /* no preview */ }
  }));

  const [used, q] = await Promise.all([usedTotal(cfg, userId), quotaBytes(keys, userId)]);
  return res.status(200).json({ ok: true, path, folders, files, used, quota: q.bytes, label: q.plan.label });
}

async function uploadUrl(res, cfg, keys, userId, body) {
  const path = cleanPath(body.path, false);
  if (!path) return res.status(400).json({ ok: false, error: 'That file name is not allowed.' });
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 0 || Math.floor(size) !== size) return res.status(400).json({ ok: false, error: 'Bad file size.' });
  if (size > MAX_FILE_BYTES) return res.status(413).json({ ok: false, code: 'too_big', error: 'That file is bigger than 4 GB, which is the most for one file.' });

  const area = body._area;
  const [used, q] = await Promise.all([usedTotal(cfg, userId), quotaBytes(keys, userId)]);
  if (used + size > q.bytes) return res.status(413).json({ ok: false, code: 'full', error: 'Not enough space left on your plan. Delete something or upgrade.' });

  const type = String(body.type || 'application/octet-stream').slice(0, 120).replace(/[^\x20-\x7e]/g, '') || 'application/octet-stream';
  const { PutObjectCommand } = deps.cmd();
  const url = await deps.sign(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: area + path, ContentType: type, ContentLength: size }), LINK_SECONDS);
  return res.status(200).json({ ok: true, url, type });
}

async function makeFolder(res, cfg, userId, body) {
  const path = cleanPath(body.path, false);
  if (!path) return res.status(400).json({ ok: false, error: 'That folder name is not allowed.' });
  const { PutObjectCommand } = deps.cmd();
  await deps.send(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: body._area + path + '/', Body: '' }));
  return res.status(200).json({ ok: true });
}

async function downloadUrl(res, cfg, userId, body) {
  const path = cleanPath(body.path, false);
  if (!path) return res.status(400).json({ ok: false, error: 'That file name is not allowed.' });
  const { GetObjectCommand } = deps.cmd();
  const name = path.split('/').pop().replace(/["\r\n]/g, '');
  const url = await deps.sign(cfg, new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: body._area + path,
    ResponseContentDisposition: 'attachment; filename="' + name.replace(/[^\x20-\x7e]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
  }), LINK_SECONDS);
  return res.status(200).json({ ok: true, url });
}

// Delete everything inside a folder but keep the folder. With path "" it empties the whole vault.
async function removeAll(res, cfg, userId, body) {
  const path = cleanPath(body.path, true);
  if (path === null) return res.status(400).json({ ok: false, error: 'That folder name is not allowed.' });
  const { DeleteObjectsCommand, ListObjectsV2Command } = deps.cmd();
  const prefix = body._area + (path ? path + '/' : '');
  let deleted = 0, token;
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    const r = await deps.send(cfg, new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (r.Contents || []).filter((o) => o.Key !== prefix).map((o) => ({ Key: o.Key }));
    if (keys.length) {
      await deps.send(cfg, new DeleteObjectsCommand({ Bucket: cfg.bucket, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    if (!r.IsTruncated) break;
    token = r.NextContinuationToken;
  }
  return res.status(200).json({ ok: true, deleted });
}

async function remove(res, cfg, userId, body) {
  const path = cleanPath(body.path, false);
  if (!path) return res.status(400).json({ ok: false, error: 'That name is not allowed.' });
  const { DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = deps.cmd();
  const area = body._area;

  if (!body.folder) {
    await deps.send(cfg, new DeleteObjectCommand({ Bucket: cfg.bucket, Key: area + path }));
    return res.status(200).json({ ok: true, deleted: 1 });
  }

  // A folder: delete everything under it, plus the folder marker itself.
  const prefix = area + path + '/';
  let deleted = 0, token;
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    const r = await deps.send(cfg, new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (r.Contents || []).map((o) => ({ Key: o.Key }));
    if (keys.length) {
      await deps.send(cfg, new DeleteObjectsCommand({ Bucket: cfg.bucket, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    if (!r.IsTruncated) break;
    token = r.NextContinuationToken;
  }
  return res.status(200).json({ ok: true, deleted });
}


// Many upload links at once, for backing up a whole folder. One storage check for the total.
async function uploadUrls(res, cfg, keys, userId, body) {
  const list = Array.isArray(body.files) ? body.files : [];
  if (!list.length) return res.status(400).json({ ok: false, error: 'No files given.' });
  if (list.length > MAX_BATCH) return res.status(400).json({ ok: false, error: 'Too many files at once.' });
  let total = 0;
  const clean = [];
  for (const f of list) {
    const path = cleanPath(f && f.path, false);
    const size = Number(f && f.size);
    if (!path) return res.status(400).json({ ok: false, error: 'A file name is not allowed: ' + String(f && f.path).slice(0, 80) });
    if (!Number.isFinite(size) || size < 0 || Math.floor(size) !== size) return res.status(400).json({ ok: false, error: 'Bad file size.' });
    if (size > MAX_FILE_BYTES) return res.status(413).json({ ok: false, code: 'too_big', error: path.split('/').pop() + ' is bigger than 4 GB, which is the most for one file.' });
    const type = String((f && f.type) || 'application/octet-stream').slice(0, 120).replace(/[^\x20-\x7e]/g, '') || 'application/octet-stream';
    clean.push({ path, size, type });
    total += size;
  }
  const [used, q] = await Promise.all([usedTotal(cfg, userId), quotaBytes(keys, userId)]);
  if (used + total > q.bytes) return res.status(413).json({ ok: false, code: 'full', error: 'Not enough space left on your plan for this backup. Delete something or upgrade.' });
  const { PutObjectCommand } = deps.cmd();
  const items = await Promise.all(clean.map(async (f) => ({
    path: f.path, type: f.type,
    url: await deps.sign(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: body._area + f.path, ContentType: f.type, ContentLength: f.size }), LINK_SECONDS),
  })));
  return res.status(200).json({ ok: true, items });
}

// Every file under a folder, with short-lived links, so the browser can build a zip.
async function listAll(res, cfg, userId, body) {
  const path = cleanPath(body.path, true);
  if (path === null) return res.status(400).json({ ok: false, error: 'That folder name is not allowed.' });
  const prefix = body._area + (path ? path + '/' : '');
  const { ListObjectsV2Command, GetObjectCommand } = deps.cmd();
  const found = [];
  let token;
  for (let i = 0; i < MAX_LIST_PAGES && found.length < MAX_LIST_ALL; i++) {
    const r = await deps.send(cfg, new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents || []) {
      const rel = o.Key.slice(prefix.length);
      if (!rel || rel.endsWith('/')) continue;
      found.push({ key: o.Key, path: rel, size: o.Size || 0 });
    }
    if (!r.IsTruncated) break;
    token = r.NextContinuationToken;
  }
  if (found.length >= MAX_LIST_ALL) return res.status(413).json({ ok: false, code: 'too_many', error: 'That folder has too many files to zip at once. Download smaller folders instead.' });
  const files = await Promise.all(found.map(async (f) => ({
    path: f.path, size: f.size,
    url: await deps.sign(cfg, new GetObjectCommand({ Bucket: cfg.bucket, Key: f.key }), PREVIEW_SECONDS),
  })));
  return res.status(200).json({ ok: true, files, total: files.reduce((s, f) => s + f.size, 0) });
}

// ---- password vault: one encrypted blob per person. The server never sees the master password. ----
function pwKey(userId, name) { return PASSWORD_PREFIX + '/' + userId + '/' + name; }

async function pwLoad(res, cfg, userId) {
  const { GetObjectCommand } = deps.cmd();
  try {
    const r = await deps.send(cfg, new GetObjectCommand({ Bucket: cfg.bucket, Key: pwKey(userId, 'vault.json') }));
    const data = r.Body && r.Body.transformToString ? await r.Body.transformToString() : String(r.Body || '');
    return res.status(200).json({ ok: true, exists: true, data });
  } catch (e) {
    if (e && (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return res.status(200).json({ ok: true, exists: false });
    throw e;
  }
}

function looksEncrypted(data) {
  if (typeof data !== 'string' || data.length > MAX_VAULT_BYTES) return false;
  let j; try { j = JSON.parse(data); } catch (e) { return false; }
  const b64 = /^[A-Za-z0-9+/=]+$/;
  return j && j.v === 1 && typeof j.iter === 'number' && j.iter >= 100000 && b64.test(j.salt || '') && b64.test(j.iv || '') && b64.test(j.ct || '');
}

async function pwSave(res, cfg, userId, body) {
  if (!looksEncrypted(body.data)) return res.status(400).json({ ok: false, error: 'The password vault must be encrypted before saving.' });
  const { PutObjectCommand, CopyObjectCommand } = deps.cmd();
  // Keep the previous version too, in case something goes wrong mid-save.
  try { await deps.send(cfg, new CopyObjectCommand({ Bucket: cfg.bucket, CopySource: encodeURI(cfg.bucket + '/' + pwKey(userId, 'vault.json')), Key: pwKey(userId, 'vault.prev.json') })); } catch (e) { /* first save */ }
  await deps.send(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: pwKey(userId, 'vault.json'), Body: body.data, ContentType: 'application/json' }));
  return res.status(200).json({ ok: true });
}

async function pwDelete(res, cfg, userId) {
  const { DeleteObjectsCommand } = deps.cmd();
  await deps.send(cfg, new DeleteObjectsCommand({ Bucket: cfg.bucket, Delete: { Objects: [{ Key: pwKey(userId, 'vault.json') }, { Key: pwKey(userId, 'vault.prev.json') }], Quiet: true } }));
  return res.status(200).json({ ok: true });
}

// ---- emailed code before the vault opens ----
function passSecret() {
  return crypto.createHmac('sha256', process.env.VAULT_SECRET || process.env.CLERK_SECRET_KEY || '').update('lifeboat-vault-pass-v1').digest();
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function codeHash(userId, code) { return b64url(crypto.createHmac('sha256', passSecret()).update('code:' + userId + ':' + code).digest()); }
function makePass(userId, exp) {
  const payload = b64url(JSON.stringify({ u: userId, exp }));
  return payload + '.' + b64url(crypto.createHmac('sha256', passSecret()).update(payload).digest());
}
function passOk(token, userId) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return false;
  if (!sameText(sig, b64url(crypto.createHmac('sha256', passSecret()).update(payload).digest()))) return false;
  let j; try { j = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch (e) { return false; }
  return j && j.u === userId && typeof j.exp === 'number' && j.exp > Date.now();
}
function maskEmail(e) {
  const [name, dom] = String(e).split('@');
  if (!dom) return 'your email';
  return (name.length <= 2 ? name[0] + '*' : name[0] + '***' + name[name.length - 1]) + '@' + dom;
}

async function sendCode(res, keys, userId) {
  const { email, state } = await deps.codeState(userId, keys.clerk);
  if (!email) return res.status(400).json({ ok: false, error: 'Your account has no email address. Add one under Account and security.' });
  const now = Date.now();
  if (state && state.sent && now - state.sent < CODE_RESEND_SECONDS * 1000 && state.exp > now) {
    return res.status(200).json({ ok: true, sent: false, to: maskEmail(email), wait: Math.ceil((CODE_RESEND_SECONDS * 1000 - (now - state.sent)) / 1000) });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await deps.saveCodeState(userId, { hash: codeHash(userId, code), exp: now + CODE_MINUTES * 60000, tries: 0, sent: now }, keys.clerk);
  const text = 'Your Lifeboat vault code is ' + code + '.\n\nIt works for ' + CODE_MINUTES + ' minutes. If you did not try to open your vault, someone may know your password: change it in Account and security.\n\nLifeboat';
  const html = '<div style="font-family:Arial,sans-serif;color:#0A3340;max-width:480px">'
    + '<p style="font-size:16px">Your Lifeboat vault code:</p>'
    + '<p style="font-size:34px;font-weight:bold;letter-spacing:6px;margin:8px 0 18px">' + code + '</p>'
    + '<p style="font-size:14px;color:#4F6E77">It works for ' + CODE_MINUTES + ' minutes. If you did not try to open your vault, someone may know your password: change it in Account and security.</p></div>';
  try {
    await deps.sendEmail(email, 'Your Lifeboat vault code: ' + code, text, html);
  } catch (e) {
    await deps.saveCodeState(userId, null, keys.clerk);
    return res.status(502).json({ ok: false, code: e.code || 'email_failed', error: e.message || 'Could not send the email.' });
  }
  return res.status(200).json({ ok: true, sent: true, to: maskEmail(email), wait: CODE_RESEND_SECONDS });
}

async function verifyCode(res, keys, userId, body) {
  const code = String(body.code || '').replace(/\D/g, '');
  if (code.length !== 6) return res.status(400).json({ ok: false, error: 'Enter the 6-digit code from the email.' });
  const { state } = await deps.codeState(userId, keys.clerk);
  const now = Date.now();
  if (!state || !state.hash || state.exp <= now) return res.status(400).json({ ok: false, code: 'expired', error: 'That code has expired. Send a new one.' });
  if ((state.tries || 0) >= CODE_MAX_TRIES) return res.status(400).json({ ok: false, code: 'expired', error: 'Too many wrong tries. Send a new code.' });
  if (!sameText(codeHash(userId, code), state.hash)) {
    const tries = (state.tries || 0) + 1;
    await deps.saveCodeState(userId, Object.assign({}, state, { tries }), keys.clerk);
    const left = CODE_MAX_TRIES - tries;
    return res.status(400).json({ ok: false, code: left > 0 ? 'wrong' : 'expired', error: left > 0 ? 'That code is not right. ' + left + (left === 1 ? ' try' : ' tries') + ' left.' : 'Too many wrong tries. Send a new code.' });
  }
  await deps.saveCodeState(userId, null, keys.clerk);
  const exp = now + PASS_HOURS * 3600000;
  return res.status(200).json({ ok: true, token: makePass(userId, exp), expires: exp });
}

// A self-check you can run from /vault?debug=1. It tests the signed upload from the server side
// (so CORS plays no part) and reads the bucket's CORS rules, then reports what it found.
async function selftest(res, cfg, userId) {
  const out = { ok: true, endpoint: cfg.endpoint, bucket: cfg.bucket };
  const { PutObjectCommand, DeleteObjectCommand, GetBucketCorsCommand } = deps.cmd();
  const key = areaOf(userId) + '.selftest';
  try {
    const url = await deps.sign(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: 'text/plain', ContentLength: 1 }), 120);
    out.signedHost = new URL(url).host;
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    out.putStatus = r.status;
    if (!r.ok) out.putBody = (await r.text()).replace(/\s+/g, ' ').slice(0, 300);
    try { await deps.send(cfg, new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key })); } catch (e) { /* ignore */ }
  } catch (e) { out.putError = String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e).slice(0, 200); }
  try {
    const c = await deps.send(cfg, new GetBucketCorsCommand({ Bucket: cfg.bucket }));
    out.cors = (c.CORSRules || []).map((x) => ({ origins: x.AllowedOrigins, methods: x.AllowedMethods, headers: x.AllowedHeaders }));
  } catch (e) { out.corsError = String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e).slice(0, 200); }
  return res.status(200).json(out);
}

// The Backblaze dashboard's CORS options only allow downloads. Browser uploads need a rule that
// allows PUT, which can only be set through the API. This sets it for your site's address.
// Uses B2_ADMIN_KEY_ID / B2_ADMIN_APP_KEY if you add them (a key allowed to change bucket settings),
// otherwise tries the normal key.
function siteOrigins(req) {
  const set = new Set();
  const add = (raw) => {
    if (!raw) return;
    let u; try { u = new URL(/^https?:\/\//.test(raw) ? raw : 'https://' + raw); } catch (e) { return; }
    const host = u.hostname.toLowerCase();
    set.add('https://' + host);
    if (!/\.vercel\.app$/.test(host) && host.split('.').length >= 2) {
      set.add('https://' + (host.startsWith('www.') ? host.slice(4) : 'www.' + host));
    }
  };
  add(process.env.SITE_URL);
  add(String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim());
  return [...set];
}

async function fixCors(req, res, cfg) {
  const adminId = String(process.env.B2_ADMIN_KEY_ID || '').trim();
  const adminKey = String(process.env.B2_ADMIN_APP_KEY || '').trim();
  const useCfg = adminId && adminKey ? Object.assign({}, cfg, { keyId: adminId, appKey: adminKey }) : cfg;
  const origins = siteOrigins(req);
  if (!origins.length) return res.status(400).json({ ok: false, error: 'Could not work out your site address. Set SITE_URL in Vercel.' });
  const { PutBucketCorsCommand } = deps.cmd();
  try {
    await deps.send(useCfg, new PutBucketCorsCommand({
      Bucket: cfg.bucket,
      CORSConfiguration: {
        CORSRules: [{
          AllowedOrigins: origins,
          AllowedMethods: ['GET', 'HEAD', 'PUT'],
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3600,
        }],
      },
    }));
    return res.status(200).json({ ok: true, fixed: true, origins, usedAdminKey: useCfg !== cfg });
  } catch (e) {
    const name = String((e && (e.name || e.Code)) || 'Error');
    const denied = /AccessDenied|Unauthorized|Forbidden|InvalidAccessKeyId|NotAuthorized/i.test(name + ' ' + (e && e.message));
    return res.status(200).json({
      ok: true, fixed: false, origins, usedAdminKey: useCfg !== cfg,
      reason: name + ': ' + String((e && e.message) || e).slice(0, 200),
      next: denied ? 'This key is not allowed to change bucket settings. Add a Master Application Key to Vercel as B2_ADMIN_KEY_ID and B2_ADMIN_APP_KEY, redeploy, and press the button again.' : '',
    });
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Use POST.' });
  }
  const keys = { clerk: process.env.CLERK_SECRET_KEY || '', stripe: process.env.STRIPE_SECRET_KEY || '' };
  if (!keys.clerk) return res.status(500).json({ ok: false, error: 'Accounts are not set up yet.' });
  const cfg = config();
  if (!cfg) return res.status(500).json({ ok: false, code: 'no_storage', error: 'File storage is not set up yet.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const userId = await account.whoIs(req, res, keys.clerk);
  if (!userId) return;

  try {
    // The emailed code comes first. Nothing else works without a fresh vault pass.
    if (body.action === 'send-code') return await sendCode(res, keys, userId);
    if (body.action === 'verify-code') return await verifyCode(res, keys, userId, body);
    if (!passOk(req.headers['x-vault-access'], userId)) return res.status(403).json({ ok: false, code: 'need_code', error: 'Enter the code we email you to open your vault.' });

    const space = body.space || 'files';
    if (!SPACES[space]) return res.status(400).json({ ok: false, error: 'Unknown area.' });
    body._area = areaOf(userId, space);

    if (body.action === 'list') return await list(res, cfg, keys, userId, body);
    if (body.action === 'upload-url') return await uploadUrl(res, cfg, keys, userId, body);
    if (body.action === 'upload-urls') return await uploadUrls(res, cfg, keys, userId, body);
    if (body.action === 'list-all') return await listAll(res, cfg, userId, body);
    if (body.action === 'folder') return await makeFolder(res, cfg, userId, body);
    if (body.action === 'download-url') return await downloadUrl(res, cfg, userId, body);
    if (body.action === 'delete') return await remove(res, cfg, userId, body);
    if (body.action === 'delete-all') return await removeAll(res, cfg, userId, body);
    if (body.action === 'pw-load') return await pwLoad(res, cfg, userId);
    if (body.action === 'pw-save') return await pwSave(res, cfg, userId, body);
    if (body.action === 'pw-delete') return await pwDelete(res, cfg, userId);
    if (body.action === 'selftest') return await selftest(res, cfg, userId);
    if (body.action === 'fix-cors') return await fixCors(req, res, cfg);
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    const why = String((err && err.name) || 'Error') + ': ' + String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 160);
    console.error('Lifeboat storage error:', err);
    return res.status(500).json({ ok: false, error: 'Storage had a problem.', reason: why });
  }
}

module.exports = handler;
module.exports._deps = deps;
module.exports._cleanPath = cleanPath;
module.exports._makePass = makePass;
module.exports._codeHash = codeHash;
