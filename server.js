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

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
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
  integrations:          'TEXT',          // JSON array
  tools_used:            'TEXT',          // JSON array
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
  image_prompt:          'TEXT',
  display_name:          'TEXT',
  website:               'TEXT',
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
function hydrate(row) {
  if (!row) return row;
  const jsonCols = ['tags', 'integrations', 'tools_used', 'data_sources', 'output_channels'];
  for (const c of jsonCols) row[c] = parseJson(row[c], []);
  row.tool_use = row.tool_use == null ? null : !!row.tool_use;
  row.rag = row.rag == null ? null : !!row.rag;
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

// Serve user-uploaded images from the volume.
app.use('/u', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true }));
// Static site.
app.use(express.static(path.join(__dirname, 'public')));

// ---------- uploads ----------
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30 });
const ALLOWED_MIME = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4':  'mp4',
};

app.post('/api/uploads', bigJson, uploadLimiter, (req, res) => {
  const { data, mime } = req.body || {};
  if (typeof data !== 'string' || !data) {
    return res.status(400).json({ error: 'data (base64) required' });
  }
  const ext = ALLOWED_MIME[mime];
  if (!ext) {
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

  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
  const filename = `${hash}.${ext}`;
  const fp = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);

  res.status(201).json({ url: `/u/${filename}` });
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

  const row = {
    title,
    description: story,          // legacy column kept in sync with story
    pitch,
    story,
    category,
    tags:            JSON.stringify(cleanArray(b.tags, 5, 32) || []),
    integrations:    JSON.stringify(cleanArray(b.integrations, 20, 60) || []),
    tools_used:      JSON.stringify(cleanArray(b.tools_used, 20, 60) || []),
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
    image_url:     imageUrl,
    video_url:     videoUrl,
    image_prompt:  clean(b.image_prompt, 600),
    display_name:   clean(b.display_name, 60),
    twitter_handle: normalizeHandle(b.twitter_handle),
    website:        clean(b.website, 200),
  };
  if (row.website && !isHttpUrl(row.website)) row.website = null;

  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const info = db
    .prepare(`INSERT INTO submissions (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map((k) => row[k]));

  const inserted = db.prepare('SELECT * FROM submissions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(hydrate(inserted));
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
    total_runs:         one(`SELECT COALESCE(SUM(runs_completed), 0) AS n FROM submissions WHERE approved = 1`).n,
    integrations_tracked:
      one(`SELECT COUNT(DISTINCT j.value) AS n
           FROM submissions, json_each(submissions.integrations) j
           WHERE approved = 1`).n,
    models_in_use:
      one(`SELECT COUNT(DISTINCT model) AS n
           FROM submissions WHERE approved = 1 AND model IS NOT NULL AND model != ''`).n,
  };

  const daily = many(
    `SELECT DATE(created_at) AS label, COUNT(*) AS count
     FROM submissions WHERE approved = 1
     GROUP BY DATE(created_at) ORDER BY label DESC LIMIT 30`
  ).reverse();

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
    tool_use:        boolDist('tool_use'),
    rag:             boolDist('rag'),
    daily,
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
