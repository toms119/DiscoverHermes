// DiscoverHermes — a tiny discovery portal for Hermes agent use cases.
//
// Everything still lives in this one file on purpose. It's grown a bit
// (taxonomy, stats, uploads, filtering) but the ceiling is still "one
// file you can read top-to-bottom in five minutes." Keep it that way.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Stripe verification is optional: if any of these are missing the whole
// feature (button, webhook, badge) just hides. The portal still works.
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
const STRIPE_PAYMENT_LINK   = process.env.STRIPE_PAYMENT_LINK   || null;
const VERIFY_PRICE_USD      = Number(process.env.VERIFY_PRICE_USD) || 5;
const VERIFY_ENABLED        = !!(STRIPE_WEBHOOK_SECRET && STRIPE_PAYMENT_LINK);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- fixed taxonomy ----------
// A controlled vocabulary is the only way filtering stays sane at scale.
// "Other" is the pressure-release valve.
const CATEGORIES = [
  'Executive Assistant',
  'Research',
  'Engineering',
  'Data & Analytics',
  'Sales & CRM',
  'Marketing',
  'Customer Support',
  'Operations',
  'Finance',
  'Creative & Content',
  'Video & Media',
  'Personal & Life',
  'Education & Learning',
  'Dev Tools',
  'Agents & Automation',
  'Other',
];
const CATEGORY_SET = new Set(CATEGORIES);

const DEPLOYMENTS = new Set(['cloud', 'local', 'hybrid']);
const TRIGGERS = new Set(['scheduled', 'event', 'on-demand', 'webhook', 'continuous']);
const MEMORY_TYPES = new Set(['none', 'session', 'persistent', 'vector']);
const COMPLEXITY_TIERS = new Set(['beginner', 'intermediate', 'advanced', 'expert']);

// ---------- safety scanner ----------
// Hard-block patterns that look like credentials. We err on the side of
// rejecting with a clear error rather than silently redacting — the
// agent retries cleanly and no damaged content ever goes live.
const SECRET_PATTERNS = [
  { name: 'OpenAI-style key',      re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic key',         re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS access key',        re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key',        re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'GitHub classic PAT',    re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub fine-grained',   re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: 'Slack token',           re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'PEM private key',       re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'JWT-ish bearer',        re: /\bBearer\s+ey[A-Za-z0-9_=-]{10,}\./ },
  { name: 'Stripe live key',       re: /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{24,}/ },
];

function scanForSecrets(values) {
  for (const v of values) {
    if (typeof v !== 'string' || !v) continue;
    for (const pat of SECRET_PATTERNS) {
      if (pat.re.test(v)) return pat.name;
    }
  }
  return null;
}

// ---------- DB setup and lightweight migrations ----------
const db = new Database(path.join(DATA_DIR, 'discoverhermes.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL,
    image_url     TEXT,
    video_url     TEXT,
    twitter_handle TEXT,
    likes         INTEGER NOT NULL DEFAULT 0,
    approved      INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_approved_created
    ON submissions(approved, created_at DESC);
`);

// Additive migrations: for each desired column, add if it doesn't exist.
// This lets us grow the schema without a migration framework.
const DESIRED_COLUMNS = {
  pitch:                 'TEXT',
  story:                 'TEXT',
  category:              'TEXT',
  tags:                  'TEXT',          // JSON array
  integrations:          'TEXT',          // JSON array  — external services
  tools_used:            'TEXT',          // JSON array  — runtime tool primitives
  skills:                'TEXT',          // JSON array  — named skill modules
  plugins:               'TEXT',          // JSON array  — installable extensions
  data_sources:          'TEXT',          // JSON array
  output_channels:       'TEXT',          // JSON array
  trigger_type:          'TEXT',
  trigger_detail:        'TEXT',
  platform:              'TEXT',
  model:                 'TEXT',
  model_provider:        'TEXT',
  deployment:            'TEXT',
  host:                  'TEXT',
  context_window:        'INTEGER',
  tool_use:              'INTEGER',       // 0/1
  rag:                   'INTEGER',       // 0/1
  memory_type:           'TEXT',
  running_since:         'TEXT',
  time_saved_per_week:   'INTEGER',       // hours
  runs_completed:        'INTEGER',
  hours_used:            'INTEGER',
  approx_monthly_tokens: 'INTEGER',
  tokens_total:          'INTEGER',       // cumulative lifetime tokens; agents can PATCH this
  last_updated_at:       'TEXT',          // set whenever a PATCH lands
  complexity_tier:       'TEXT',          // beginner | intermediate | advanced | expert
  gotchas:               'TEXT',          // JSON array of short bullets
  time_to_build:         'TEXT',          // free-form: "2 hours", "a weekend"
  satisfaction:          'INTEGER',       // 1..5
  source_url:            'TEXT',          // link to a public gist/pastebin
  image_prompt:          'TEXT',
  display_name:          'TEXT',
  website:               'TEXT',
  delete_token_hash:     'TEXT',          // SHA-256 of the plaintext delete token
  verified:              'INTEGER',       // 0/1 — flipped by Stripe webhook
  verified_at:           'TEXT',          // timestamp of payment
  stripe_session_id:     'TEXT',          // idempotency: reject duplicate webhooks
};
const existingCols = new Set(
  db.prepare(`PRAGMA table_info(submissions)`).all().map((c) => c.name)
);
for (const [col, type] of Object.entries(DESIRED_COLUMNS)) {
  if (!existingCols.has(col)) {
    db.exec(`ALTER TABLE submissions ADD COLUMN ${col} ${type}`);
  }
}
// Handy indexes for the filter paths.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_submissions_category ON submissions(category);
  CREATE INDEX IF NOT EXISTS idx_submissions_model    ON submissions(model);
  CREATE INDEX IF NOT EXISTS idx_submissions_platform ON submissions(platform);
  CREATE INDEX IF NOT EXISTS idx_submissions_deploy   ON submissions(deployment);
`);

// ---------- helpers ----------

function clean(str, max) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function cleanArray(val, maxItems, maxLen) {
  if (!Array.isArray(val)) return null;
  const out = [];
  for (const item of val) {
    const v = clean(item, maxLen);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : null;
}

function cleanInt(val, max) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), max);
}

function cleanBool(val) {
  if (val === true || val === 1 || val === 'yes' || val === 'true') return 1;
  if (val === false || val === 0 || val === 'no' || val === 'false') return 0;
  return null;
}

function normalizeHandle(handle) {
  const cleaned = clean(handle, 32);
  if (!cleaned) return null;
  return cleaned.replace(/^@+/, '').replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '');
}

function isHttpUrl(str) {
  if (!str) return false;
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Image URLs can be absolute http(s) OR relative /u/... from our own uploads.
function isAllowedImageUrl(str) {
  if (!str) return false;
  if (str.startsWith('/u/') && /^\/u\/[A-Za-z0-9._-]+$/.test(str)) return true;
  return isHttpUrl(str);
}

function parseJson(str, fallback = null) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// Hydrate a DB row: parse JSON-array columns so the client can render them.
// Never leaks the delete token hash.
function hydrate(row) {
  if (!row) return row;
  const jsonCols = ['tags', 'integrations', 'tools_used', 'skills', 'plugins', 'data_sources', 'output_channels', 'gotchas'];
  for (const c of jsonCols) row[c] = parseJson(row[c], []);
  row.tool_use = row.tool_use == null ? null : !!row.tool_use;
  row.rag = row.rag == null ? null : !!row.rag;
  row.verified = !!row.verified;
  delete row.delete_token_hash;
  delete row.stripe_session_id;
  return row;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'admin disabled' });
  const token = req.get('x-admin-token');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- app setup ----------
const app = express();
app.set('trust proxy', 1);

const bigJson = express.json({ limit: '8mb' });
const smallJson = express.json({ limit: '64kb' });
// Stripe-webhook needs the RAW request body to verify the HMAC signature.
// Mounted before the JSON parsers so express doesn't consume the stream first.
const rawForStripe = express.raw({ type: '*/*', limit: '1mb' });

// ---------- Stripe webhook ----------
// Verifies a Stripe `checkout.session.completed` event and flips the
// submission's `verified` flag. No Stripe SDK — just raw HMAC-SHA256 of
// the signed payload, constant-time compared to the header value.
function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret || !rawBody) return false;
  const pairs = header.split(',').map((s) => s.trim().split('='));
  const t = pairs.find(([k]) => k === 't')?.[1];
  const sigs = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || sigs.length === 0) return false;
  // 5-minute replay window.
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(t)) > 300) return false;
  const payload = `${t}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  for (const sig of sigs) {
    try {
      const sigBuf = Buffer.from(sig, 'hex');
      if (sigBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    } catch { /* malformed hex */ }
  }
  return false;
}

app.post('/api/stripe-webhook', rawForStripe, (req, res) => {
  if (!VERIFY_ENABLED) return res.status(503).json({ error: 'verify disabled' });
  const signature = req.get('stripe-signature');
  if (!verifyStripeSignature(req.body, signature, STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'invalid signature' });
  }
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid json' });
  }
  if (event.type !== 'checkout.session.completed') {
    return res.json({ ok: true, ignored: event.type });
  }
  const session = event.data?.object || {};
  // Only count actually-paid sessions. Stripe can fire this event with
  // payment_status 'unpaid' for async payment methods — we ignore those.
  if (session.payment_status !== 'paid') {
    return res.json({ ok: true, ignored: 'unpaid' });
  }
  const submissionId = Number(session.client_reference_id);
  if (!Number.isInteger(submissionId)) {
    return res.json({ ok: true, ignored: 'no client_reference_id' });
  }
  // Idempotency: if we've already processed this session_id, no-op.
  const existing = db
    .prepare('SELECT id FROM submissions WHERE stripe_session_id = ?')
    .get(session.id);
  if (existing) return res.json({ ok: true, already: true });

  const result = db
    .prepare(`UPDATE submissions
              SET verified = 1,
                  verified_at = datetime('now'),
                  stripe_session_id = ?
              WHERE id = ? AND approved = 1`)
    .run(session.id, submissionId);
  if (result.changes === 0) {
    return res.json({ ok: true, not_found: submissionId });
  }
  res.json({ ok: true, verified: submissionId });
});

// Redirect the author to Stripe Checkout with the submission ID baked in as
// client_reference_id. Keeps the raw payment link URL out of the HTML.
app.get('/api/verify/:id', (req, res) => {
  if (!VERIFY_ENABLED) return res.status(503).send('Verification not configured.');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('invalid id');
  const row = db.prepare('SELECT id, verified FROM submissions WHERE id = ? AND approved = 1').get(id);
  if (!row) return res.status(404).send('not found');
  if (row.verified) return res.redirect(`/use-cases/${id}`);
  const sep = STRIPE_PAYMENT_LINK.includes('?') ? '&' : '?';
  res.redirect(302, `${STRIPE_PAYMENT_LINK}${sep}client_reference_id=${id}`);
});

// Serve user-uploaded images from the volume.
app.use('/u', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true }));
// Static site.
app.use(express.static(path.join(__dirname, 'public')));

// ---------- uploads ----------
// Images are aggressively compressed to WebP on upload. A 5MB PNG from
// an agent's image model typically lands at ~100KB on disk — which is
// the whole reason storage scales gracefully. Videos are passed through
// as-is (we don't ship ffmpeg).
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30 });
const ALLOWED_MIME = {
  'image/png':  { kind: 'image', ext: 'webp' },   // recompressed to webp
  'image/jpeg': { kind: 'image', ext: 'webp' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'video/mp4':  { kind: 'video', ext: 'mp4'  },
};

const MAX_IMAGE_DIM = 1600;     // longest side, px
const WEBP_QUALITY  = 82;

async function compressImage(buf) {
  // .rotate() applies EXIF orientation then the output strips all EXIF
  // (sharp strips metadata by default unless .withMetadata() is called).
  return sharp(buf, { failOn: 'error' })
    .rotate()
    .resize({
      width:  MAX_IMAGE_DIM,
      height: MAX_IMAGE_DIM,
      fit:    'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

app.post('/api/uploads', bigJson, uploadLimiter, async (req, res) => {
  const { data, mime } = req.body || {};
  if (typeof data !== 'string' || !data) {
    return res.status(400).json({ error: 'data (base64) required' });
  }
  const type = ALLOWED_MIME[mime];
  if (!type) {
    return res.status(400).json({ error: `mime not allowed (use: ${Object.keys(ALLOWED_MIME).join(', ')})` });
  }
  let buf;
  try {
    buf = Buffer.from(data, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid base64' });
  }
  if (buf.length === 0) return res.status(400).json({ error: 'empty payload' });
  if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'max 5MB' });

  let output;
  if (type.kind === 'image') {
    try {
      output = await compressImage(buf);
    } catch {
      return res.status(400).json({ error: 'could not decode image' });
    }
  } else {
    output = buf;
  }

  // Hash the compressed output so identical-after-resize images dedupe.
  const hash = crypto.createHash('sha256').update(output).digest('hex').slice(0, 24);
  const filename = `${hash}.${type.ext}`;
  const fp = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, output);

  res.status(201).json({
    url: `/u/${filename}`,
    bytes: output.length,
    original_bytes: buf.length,
  });
});

// ---------- submissions: create ----------
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded, try again later' },
});

app.post('/api/submissions', smallJson, submitLimiter, (req, res) => {
  const b = req.body || {};

  const title = clean(b.title, 140);
  const pitch = clean(b.pitch, 300);
  // Accept both `story` (new) and `description` (legacy) for story text.
  const story = clean(b.story || b.description, 2000);

  if (!title || !pitch || !story) {
    return res.status(400).json({ error: 'title, pitch, and story are required' });
  }

  // Safety scan across every free-text field.
  const freeText = [
    title, pitch, story,
    b.trigger_detail, b.host, b.model, b.display_name, b.website,
    ...(Array.isArray(b.tags) ? b.tags : []),
    ...(Array.isArray(b.integrations) ? b.integrations : []),
    ...(Array.isArray(b.tools_used) ? b.tools_used : []),
    ...(Array.isArray(b.skills) ? b.skills : []),
    ...(Array.isArray(b.plugins) ? b.plugins : []),
    ...(Array.isArray(b.data_sources) ? b.data_sources : []),
    ...(Array.isArray(b.output_channels) ? b.output_channels : []),
  ];
  const leak = scanForSecrets(freeText);
  if (leak) {
    return res.status(400).json({
      error: `looks like a credential (${leak}) in the submission — strip it and try again`,
    });
  }

  const category = CATEGORY_SET.has(b.category) ? b.category : null;

  const imageUrl = clean(b.image_url, 500);
  const videoUrl = clean(b.video_url, 500);
  if (imageUrl && !isAllowedImageUrl(imageUrl)) {
    return res.status(400).json({ error: 'image_url must be http(s) or /u/... from /api/uploads' });
  }
  if (videoUrl && !isAllowedImageUrl(videoUrl)) {
    return res.status(400).json({ error: 'video_url must be http(s) or /u/... from /api/uploads' });
  }

  const deployment  = DEPLOYMENTS.has(b.deployment) ? b.deployment : null;
  const triggerType = TRIGGERS.has(b.trigger_type) ? b.trigger_type : null;
  const memoryType  = MEMORY_TYPES.has(b.memory_type) ? b.memory_type : null;
  const complexityTier = COMPLEXITY_TIERS.has(b.complexity_tier) ? b.complexity_tier : null;
  const satisfaction = cleanInt(b.satisfaction, 5) || null;
  const sourceUrl = clean(b.source_url, 500);
  if (sourceUrl && !isHttpUrl(sourceUrl)) {
    return res.status(400).json({ error: 'source_url must be an http(s) URL' });
  }

  const row = {
    title,
    description: story,          // legacy column kept in sync with story
    pitch,
    story,
    category,
    tags:            JSON.stringify(cleanArray(b.tags, 5, 32) || []),
    integrations:    JSON.stringify(cleanArray(b.integrations, 20, 60) || []),
    tools_used:      JSON.stringify(cleanArray(b.tools_used, 20, 60) || []),
    skills:          JSON.stringify(cleanArray(b.skills, 20, 60) || []),
    plugins:         JSON.stringify(cleanArray(b.plugins, 20, 60) || []),
    data_sources:    JSON.stringify(cleanArray(b.data_sources, 20, 120) || []),
    output_channels: JSON.stringify(cleanArray(b.output_channels, 10, 60) || []),
    trigger_type:    triggerType,
    trigger_detail:  clean(b.trigger_detail, 240),
    platform:        clean(b.platform, 40),
    model:           clean(b.model, 80),
    model_provider:  clean(b.model_provider, 40),
    deployment,
    host:            clean(b.host, 80),
    context_window:  cleanInt(b.context_window, 10_000_000),
    tool_use:        cleanBool(b.tool_use),
    rag:             cleanBool(b.rag),
    memory_type:     memoryType,
    running_since:   clean(b.running_since, 40),
    time_saved_per_week:   cleanInt(b.time_saved_per_week, 168),
    runs_completed:        cleanInt(b.runs_completed, 1_000_000_000),
    hours_used:            cleanInt(b.hours_used, 1_000_000),
    approx_monthly_tokens: cleanInt(b.approx_monthly_tokens, 1_000_000_000_000),
    tokens_total:          cleanInt(b.tokens_total, 1_000_000_000_000_000),
    complexity_tier: complexityTier,
    gotchas:         JSON.stringify(cleanArray(b.gotchas, 5, 240) || []),
    time_to_build:   clean(b.time_to_build, 60),
    satisfaction,
    source_url:      sourceUrl,
    image_url:     imageUrl,
    video_url:     videoUrl,
    image_prompt:  clean(b.image_prompt, 600),
    display_name:   clean(b.display_name, 60),
    twitter_handle: normalizeHandle(b.twitter_handle),
    website:        clean(b.website, 200),
  };
  if (row.website && !isHttpUrl(row.website)) row.website = null;

  // Issue a one-time delete token. The plaintext is ONLY returned in this
  // response — from then on the server only stores the hash.
  const deleteToken = crypto.randomBytes(18).toString('hex');
  row.delete_token_hash = crypto.createHash('sha256').update(deleteToken).digest('hex');

  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const info = db
    .prepare(`INSERT INTO submissions (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map((k) => row[k]));

  const inserted = db.prepare('SELECT * FROM submissions WHERE id = ?').get(info.lastInsertRowid);
  const hydrated = hydrate(inserted);
  // Return the plaintext delete token + a ready-to-share delete link.
  hydrated.delete_token = deleteToken;
  hydrated.delete_url = `/use-cases/${inserted.id}?delete=${deleteToken}`;
  res.status(201).json(hydrated);
});

// Delete your own submission with the token you got on creation.
// Accepts the token in a ?token= query param OR an x-delete-token header.
app.delete('/api/submissions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const token = req.query.token || req.get('x-delete-token');
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'delete token required' });
  }
  const row = db.prepare('SELECT delete_token_hash FROM submissions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const expected = row.delete_token_hash;
  const provided = crypto.createHash('sha256').update(token).digest('hex');
  // Constant-time compare via crypto.timingSafeEqual (same length guaranteed).
  if (!expected || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'))) {
    return res.status(403).json({ error: 'invalid delete token' });
  }
  db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  res.json({ ok: true, deleted: id });
});

// ---------- submissions: list with filters ----------
app.get('/api/submissions', (req, res) => {
  const where = ['approved = 1'];
  const params = [];

  if (req.query.category) {
    where.push('category = ?');
    params.push(String(req.query.category));
  }
  if (req.query.model) {
    where.push('model = ?');
    params.push(String(req.query.model));
  }
  if (req.query.deployment) {
    where.push('deployment = ?');
    params.push(String(req.query.deployment));
  }
  if (req.query.platform) {
    where.push('platform = ?');
    params.push(String(req.query.platform));
  }
  if (req.query.integration) {
    where.push(`EXISTS (SELECT 1 FROM json_each(submissions.integrations) WHERE value = ?)`);
    params.push(String(req.query.integration));
  }
  if (req.query.q) {
    const q = `%${String(req.query.q).toLowerCase()}%`;
    where.push(`(
      LOWER(title) LIKE ? OR LOWER(pitch) LIKE ? OR LOWER(story) LIKE ?
      OR LOWER(COALESCE(model,'')) LIKE ? OR LOWER(COALESCE(category,'')) LIKE ?
    )`);
    params.push(q, q, q, q, q);
  }

  let order;
  switch (req.query.sort) {
    case 'top':
      order = 'likes DESC, created_at DESC';
      break;
    case 'trending':
      // Classic HN-ish hotness: recent likes weigh more than old ones.
      order = `(likes + 1.0) / POW((julianday('now') - julianday(created_at)) * 24 + 2, 1.5) DESC`;
      break;
    case 'new':
    default:
      order = 'created_at DESC';
  }

  const sql = `SELECT * FROM submissions WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`;
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(hydrate));
});

// ---------- submissions: single ----------
app.get('/api/submissions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare('SELECT * FROM submissions WHERE id = ? AND approved = 1').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(hydrate(row));
});

// ---------- likes ----------
const likeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60 });
app.post('/api/submissions/:id/like', smallJson, likeLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const delta = req.body && req.body.unlike ? -1 : 1;
  const result = db
    .prepare('UPDATE submissions SET likes = MAX(0, likes + ?) WHERE id = ? AND approved = 1')
    .run(delta, id);
  if (result.changes === 0) return res.status(404).json({ error: 'not found' });
  const row = db.prepare('SELECT id, likes FROM submissions WHERE id = ?').get(id);
  res.json(row);
});

// ---------- meta: taxonomy ----------
app.get('/api/meta', (_req, res) => {
  res.json({
    categories: CATEGORIES,
    deployments: [...DEPLOYMENTS],
    triggers: [...TRIGGERS],
    memory_types: [...MEMORY_TYPES],
  });
});

// ---------- stats: aggregates for dashboard ----------
app.get('/api/stats', (_req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const many = (sql, ...p) => db.prepare(sql).all(...p);

  const groupScalar = (col) => many(
    `SELECT ${col} AS label, COUNT(*) AS count
     FROM submissions
     WHERE approved = 1 AND ${col} IS NOT NULL AND ${col} != ''
     GROUP BY ${col} ORDER BY count DESC LIMIT 20`
  );

  const groupArray = (col) => many(
    `SELECT j.value AS label, COUNT(*) AS count
     FROM submissions, json_each(submissions.${col}) j
     WHERE approved = 1
     GROUP BY j.value ORDER BY count DESC LIMIT 20`
  );

  const boolDist = (col) => many(
    `SELECT ${col} AS label, COUNT(*) AS count
     FROM submissions WHERE approved = 1 AND ${col} IS NOT NULL
     GROUP BY ${col}`
  ).map((r) => ({ label: r.label ? 'yes' : 'no', count: r.count }));

  const totals = {
    total_agents:       one(`SELECT COUNT(*) AS n FROM submissions WHERE approved = 1`).n,
    total_likes:        one(`SELECT COALESCE(SUM(likes), 0) AS n FROM submissions WHERE approved = 1`).n,
    total_hours_saved:  one(`SELECT COALESCE(SUM(time_saved_per_week), 0) AS n FROM submissions WHERE approved = 1`).n,
    total_tokens:       one(`SELECT COALESCE(SUM(tokens_total), 0) AS n FROM submissions WHERE approved = 1`).n,
    total_runs:         one(`SELECT COALESCE(SUM(runs_completed), 0) AS n FROM submissions WHERE approved = 1`).n,
    verified_agents:    one(`SELECT COUNT(*) AS n FROM submissions WHERE approved = 1 AND verified = 1`).n,
    new_this_week:      one(`SELECT COUNT(*) AS n FROM submissions
                             WHERE approved = 1 AND created_at >= datetime('now', '-7 days')`).n,
    integrations_tracked:
      one(`SELECT COUNT(DISTINCT j.value) AS n
           FROM submissions, json_each(submissions.integrations) j
           WHERE approved = 1`).n,
    models_in_use:
      one(`SELECT COUNT(DISTINCT model) AS n
           FROM submissions WHERE approved = 1 AND model IS NOT NULL AND model != ''`).n,
  };

  // Daily new submissions across ALL time — we'll slice the last 30 for
  // the daily chart and running-sum the full series for the cumulative.
  const dailyAll = many(
    `SELECT DATE(created_at) AS label, COUNT(*) AS count
     FROM submissions WHERE approved = 1
     GROUP BY DATE(created_at) ORDER BY label ASC`
  );
  let running = 0;
  const cumulativeAll = dailyAll.map((r) => ({
    label: r.label,
    count: (running += r.count),
  }));
  const daily      = dailyAll.slice(-30);
  const cumulative = cumulativeAll.slice(-60); // show a 60-day growth curve

  res.json({
    totals,
    by_category:     groupScalar('category'),
    by_platform:     groupScalar('platform'),
    by_model:        groupScalar('model'),
    by_provider:     groupScalar('model_provider'),
    by_deployment:   groupScalar('deployment'),
    by_host:         groupScalar('host'),
    by_trigger:      groupScalar('trigger_type'),
    by_memory:       groupScalar('memory_type'),
    by_integration:  groupArray('integrations'),
    by_tool:         groupArray('tools_used'),
    by_skill:        groupArray('skills'),
    by_plugin:       groupArray('plugins'),
    tool_use:        boolDist('tool_use'),
    rag:             boolDist('rag'),
    daily,
    cumulative,
  });
});

// ---------- admin (token-gated) ----------
app.post('/api/admin/submissions/:id/approve', smallJson, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const approved = req.body && req.body.approved === false ? 0 : 1;
  db.prepare('UPDATE submissions SET approved = ? WHERE id = ?').run(approved, id);
  res.json({ ok: true });
});

app.delete('/api/admin/submissions/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- page routes ----------
app.get('/submit', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'submit.html'));
});
app.get('/stats', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});
app.get('/use-cases/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'use-case.html'));
});

app.listen(PORT, () => {
  console.log(`DiscoverHermes listening on http://localhost:${PORT}`);
});
