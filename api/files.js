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
//
// Environment variables (set in Vercel, see STORAGE-SETUP.md):
//   B2_KEY_ID, B2_APP_KEY   SECRET.  A Backblaze application key limited to your bucket.
//   B2_BUCKET               the bucket name
//   B2_ENDPOINT             e.g. https://s3.us-west-004.backblazeb2.com
//   CLERK_SECRET_KEY, STRIPE_SECRET_KEY   already set for the account function

const account = require('./account');

const MAX_FILE_BYTES = 4 * 1000 * 1000 * 1000; // one file can be up to 4 GB
const MAX_NAME = 200;
const MAX_PATH = 800;
const MAX_LIST_PAGES = 200;                     // safety stop when adding up storage (200,000 files)
const LINK_SECONDS = 600;

// Kept in one place so tests can swap them for fakes.
const deps = {
  _s3: null,
  async s3(cfg) {
    if (this._s3) return this._s3;
    const { S3Client } = require('@aws-sdk/client-s3');
    const m = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(cfg.endpoint);
    this._s3 = new S3Client({
      region: m ? m[1] : 'us-west-004',
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.appKey },
      // Backblaze does not accept the extra checksum headers newer SDK versions add by default.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return this._s3;
  },
  async send(cfg, command) {
    return (await this.s3(cfg)).send(command);
  },
  async sign(cfg, command, seconds) {
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    return getSignedUrl(await this.s3(cfg), command, { expiresIn: seconds });
  },
  cmd() { return require('@aws-sdk/client-s3'); },
};

function config() {
  const c = {
    keyId: process.env.B2_KEY_ID || '',
    appKey: process.env.B2_APP_KEY || '',
    bucket: process.env.B2_BUCKET || '',
    endpoint: (process.env.B2_ENDPOINT || '').replace(/\/+$/, ''),
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
function areaOf(userId) { return 'u/' + userId + '/'; }

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
  const area = areaOf(userId);
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

  const [used, q] = await Promise.all([usedBytes(cfg, area), quotaBytes(keys, userId)]);
  return res.status(200).json({ ok: true, path, folders, files, used, quota: q.bytes, label: q.plan.label });
}

async function uploadUrl(res, cfg, keys, userId, body) {
  const path = cleanPath(body.path, false);
  if (!path) return res.status(400).json({ ok: false, error: 'That file name is not allowed.' });
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 0 || Math.floor(size) !== size) return res.status(400).json({ ok: false, error: 'Bad file size.' });
  if (size > MAX_FILE_BYTES) return res.status(413).json({ ok: false, code: 'too_big', error: 'That file is bigger than 4 GB, which is the most for one file.' });

  const area = areaOf(userId);
  const [used, q] = await Promise.all([usedBytes(cfg, area), quotaBytes(keys, userId)]);
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
  await deps.send(cfg, new PutObjectCommand({ Bucket: cfg.bucket, Key: areaOf(userId) + path + '/', Body: '' }));
  return res.status(200).json({ ok: true });
}

async function downloadUrl(res, cfg, userId, body) {
  const path = cleanPath(body.path, false);
  if (!path) return res.status(400).json({ ok: false, error: 'That file name is not allowed.' });
  const { GetObjectCommand } = deps.cmd();
  const name = path.split('/').pop().replace(/["\r\n]/g, '');
  const url = await deps.sign(cfg, new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: areaOf(userId) + path,
    ResponseContentDisposition: 'attachment; filename="' + name.replace(/[^\x20-\x7e]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
  }), LINK_SECONDS);
  return res.status(200).json({ ok: true, url });
}

async function remove(res, cfg, userId, body) {
  const path = cleanPath(body.path, false);
  if (!path) return res.status(400).json({ ok: false, error: 'That name is not allowed.' });
  const { DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = deps.cmd();
  const area = areaOf(userId);

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
    if (body.action === 'list') return await list(res, cfg, keys, userId, body);
    if (body.action === 'upload-url') return await uploadUrl(res, cfg, keys, userId, body);
    if (body.action === 'folder') return await makeFolder(res, cfg, userId, body);
    if (body.action === 'download-url') return await downloadUrl(res, cfg, userId, body);
    if (body.action === 'delete') return await remove(res, cfg, userId, body);
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Storage had a problem. Try again in a minute.' });
  }
}

module.exports = handler;
module.exports._deps = deps;
module.exports._cleanPath = cleanPath;
