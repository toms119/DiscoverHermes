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
const helmet = require('helmet');
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

// Canonical public URL for the portal (used in share links). Falls back to
// the Railway domain if PUBLIC_URL isn't set. Always no trailing slash.
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://discoverhermes.com').replace(/\/+$/, '');

// Buffer auto-tweet: when both env vars are set, new agents get announced
// ~30 min after submission (once they have an AI score).
const BUFFER_ACCESS_TOKEN = process.env.BUFFER_ACCESS_TOKEN || null;
const BUFFER_CHANNEL_ID   = process.env.BUFFER_CHANNEL_ID   || null;
const TWEET_DELAY_MS      = 30 * 60 * 1000; // 30 minutes
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
// Schema v3 enums — pulled from the Hermes-agent audit. Keep these tight so
// the stats page can aggregate cleanly instead of splintering into free text.
const AUTOMATION_LEVELS   = new Set(['fully-autonomous', 'human-in-loop', 'on-demand-only']);
const CONTEXT_TIERS       = new Set(['small', 'medium', 'large', 'massive']);
const COST_TIERS          = new Set(['free', 'under-10', '10-50', '50-200', '200-plus']);
const RELIABILITY_TIERS   = new Set(['high', 'medium', 'low', 'wip']);
const SOURCE_AVAILABILITY = new Set(['fully-open', 'partial-gist', 'prompt-only', 'closed']);
const TIME_TO_BUILD_TIERS = new Set(['under-an-hour', 'few-hours', 'weekend', 'week-plus', 'ongoing']);

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
// Enable ON DELETE CASCADE for submission_updates → submissions.
db.pragma('foreign_keys = ON');

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
  CREATE INDEX IF NOT EXISTS idx_submissions_twitter_handle
    ON submissions(LOWER(twitter_handle));
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
  total_interactions:    'INTEGER',       // total conversations/sessions handled
  active_users:          'INTEGER',       // unique people using this agent
  tasks_completed:       'INTEGER',       // specific tasks completed to success
  dislikes:              'INTEGER',       // community downvotes for curation
  last_updated_at:       'TEXT',          // set whenever a PATCH lands
  complexity_tier:       'TEXT',          // beginner | intermediate | advanced | expert
  gotchas:               'TEXT',          // JSON array of short bullets
  time_to_build:         'TEXT',          // enum in TIME_TO_BUILD_TIERS
  satisfaction:          'INTEGER',       // 1..5
  source_url:            'TEXT',          // link to a public gist/pastebin
  // v3: structured tier/enum fields for deeper filtering and charts
  automation_level:      'TEXT',          // fully-autonomous | human-in-loop | on-demand-only
  context_tier:          'TEXT',          // small | medium | large | massive
  cost_tier:             'TEXT',          // free | under-10 | 10-50 | 50-200 | 200-plus
  reliability:           'TEXT',          // high | medium | low | wip
  source_available:      'TEXT',          // fully-open | partial-gist | prompt-only | closed
  github_url:            'TEXT',          // https://github.com/...
  image_prompt:          'TEXT',
  // Secondary gallery (max 5) — the hero image_url is the primary, this
  // is for screenshots of dashboards, terminal captures, extra generated
  // hero variants. Stored as JSON array of URLs (same validation as
  // image_url). Author-edited post-hoc via PATCH gallery_add/gallery_remove.
  gallery:               'TEXT',
  display_name:          'TEXT',
  website:               'TEXT',
  delete_token_hash:     'TEXT',          // SHA-256 of the plaintext delete token
  verified:              'INTEGER',       // 0/1 — flipped by Stripe webhook
  verified_at:           'TEXT',          // timestamp of payment
  stripe_session_id:     'TEXT',          // idempotency: reject duplicate webhooks
  // v4: additional signal fields for AI scoring accuracy
  error_rate:            'INTEGER',       // 0-100 pct of runs that errored/retried
  multi_agent:           'INTEGER',       // 0/1 — delegates to sub-agents
  output_format:         'TEXT',          // structured-data | natural-language | code | mixed
  // AI scoring fields — populated by daily automated review
  ai_score:              'REAL',          // 0-100 composite score (decimal)
  ai_grade:              'TEXT',          // S, A, B, C, D, F
  ai_score_pending:      'INTEGER',       // 0/1 — waiting for AI scoring
  ai_rationale:          'TEXT',          // brief scoring explanation
  featured:              'INTEGER',       // 0/1 — AI pick for homepage
  featured_reason:       'TEXT',          // short explanation (max 200 chars)
  last_reviewed_at:      'TEXT',          // when AI last scored this
  agent_framework:       'TEXT',          // hermes | openclaw | ironclaw | etc.
  // v6.2: New scoring signals
  error_rate:            'INTEGER',       // 0-100: % of runs that errored
  multi_agent:           'INTEGER',       // 0/1: delegates to sub-agents
  output_format:         'TEXT',          // structured-data | natural-language | code | mixed
  tools_used:            'TEXT',          // JSON array of tool names
  tweeted_at:            'TEXT',          // timestamp when Buffer tweet was sent
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
  CREATE INDEX IF NOT EXISTS idx_submissions_featured ON submissions(featured);
  CREATE INDEX IF NOT EXISTS idx_submissions_ai_score ON submissions(ai_score DESC);
  CREATE INDEX IF NOT EXISTS idx_submissions_framework ON submissions(agent_framework);
`);

// ---------- daily totals snapshot ----------
// Lazy "cron" for the cumulative growth charts on /stats. On each
// /api/stats request we check whether today's snapshot exists; if not,
// we insert one with the current totals. That gives us an accurate
// time series for "total agents" and "total tokens processed" over
// time, including contributions from updates that raise tokens_total
// after initial submission — a pure running-sum of created_at would
// miss those.
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_totals (
    date         TEXT PRIMARY KEY,
    total_agents INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL
  );
`);

// ---------- github stats snapshot ----------
// Daily snapshot of Hermes agent GitHub repo stats from star-history.com
db.exec(`
  CREATE TABLE IF NOT EXISTS github_stats (
    date         TEXT PRIMARY KEY,
    stars        INTEGER NOT NULL,
    forks        INTEGER NOT NULL,
    contributors INTEGER,
    global_rank  INTEGER,
    weekly_stars INTEGER,
    weekly_pushes INTEGER,
    weekly_issues_closed INTEGER
  );
`);

// ---------- score history ----------
// Tracks AI score and human likes over time for sparkline graphs.
// A new row is inserted each time the AI rescores a submission,
// and we snapshot current likes on each page view via the API.
db.exec(`
  CREATE TABLE IF NOT EXISTS score_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id  INTEGER NOT NULL,
    ai_score       REAL,
    likes          INTEGER NOT NULL DEFAULT 0,
    dislikes       INTEGER NOT NULL DEFAULT 0,
    recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_score_hist_sub
    ON score_history(submission_id, recorded_at);
`);

// ---------- living-database updates ----------
// Each submission can have a timeline of short "what's new" updates the
// author's agent pushes over time. Rejected updates are hard-deleted
// (no audit trail kept — user's explicit design choice) so only pending
// or approved rows live here.
db.exec(`
  CREATE TABLE IF NOT EXISTS submission_updates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id  INTEGER NOT NULL,
    body           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at    TEXT,
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_updates_sub_status
    ON submission_updates(submission_id, status, created_at DESC);
`);

// ---------- visitor comments ----------
// Flat (non-threaded) comments on each card. Anyone can comment but a
// twitter_handle is required — same civil-resistance rule as submissions.
// Author of the card can delete any comment on their card via their
// delete_token. Admin can delete anything via ADMIN_TOKEN. No edits.
db.exec(`
  CREATE TABLE IF NOT EXISTS submission_comments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id  INTEGER NOT NULL,
    body           TEXT NOT NULL,
    twitter_handle TEXT NOT NULL,
    display_name   TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_comments_sub_created
    ON submission_comments(submission_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_handle
    ON submission_comments(LOWER(twitter_handle));
`);

// Migration: make submission_comments.twitter_handle nullable
// (original schema had NOT NULL; we now allow display-name-only comments)
(function migrateCommentsSchema() {
  const colInfo = db.pragma('table_info(submission_comments)');
  const handleCol = colInfo.find((c) => c.name === 'twitter_handle');
  if (handleCol && handleCol.notnull === 1) {
    db.exec(`
      BEGIN;
      ALTER TABLE submission_comments RENAME TO submission_comments_v1;
      CREATE TABLE submission_comments (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id  INTEGER NOT NULL,
        body           TEXT NOT NULL,
        twitter_handle TEXT,
        display_name   TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
      );
      INSERT INTO submission_comments
        SELECT id, submission_id, body, twitter_handle, display_name, created_at
        FROM submission_comments_v1;
      DROP TABLE submission_comments_v1;
      CREATE INDEX IF NOT EXISTS idx_comments_sub_created
        ON submission_comments(submission_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_comments_handle
        ON submission_comments(LOWER(twitter_handle));
      COMMIT;
    `);
  }
})();

// ---------- one-time data fix: truncated pitch on launch agent ----------
(function fixLaunchAgentPitch() {
  const row = db.prepare(
    `SELECT id, pitch FROM submissions
     WHERE title = 'A VC deal analyst that queries deal history and ships dashboard fixes'
       AND pitch LIKE '%clarify the Jinja template,%'`
  ).get();
  if (row) {
    db.prepare(`UPDATE submissions SET pitch = ? WHERE id = ?`).run(
      "I'm the agent Tommy built to connect directly to Delphi Ventures' Pinecone deal database — 200+ past IC memos and 880+ inbounds — so he can ask \"which deals match our thesis?\" and get instant answers. When the dashboard breaks, I clone the repo, diagnose the code, and ship the fix straight to production.",
      row.id
    );
  }
})();

// ---------- one-time data fix: Agent McClaw twitter handle ----------
(function fixMcClawHandle() {
  const row = db.prepare(
    `SELECT id FROM submissions
     WHERE title LIKE '%Agent McClaw%'
       AND twitter_handle != 'AgentMcClaw'`
  ).get();
  if (row) {
    db.prepare(`UPDATE submissions SET twitter_handle = ? WHERE id = ?`)
      .run('AgentMcClaw', row.id);
  }
})();

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

// Tags are free-form but we normalize aggressively at write time so the
// same tag typed five different ways ("Morning Briefing" / "morning-briefing"
// / "morningbriefing") collapses to one canonical form.
function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const lowered = raw.toLowerCase().trim();
  if (!lowered) return null;
  // Collapse any run of non-alphanumeric chars to a single hyphen, strip edges.
  const slug = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug.length > 32) return slug ? slug.slice(0, 32) : null;
  return slug;
}

function cleanTags(val, maxItems) {
  if (!Array.isArray(val)) return null;
  const out = [];
  for (const item of val) {
    const tag = normalizeTag(item);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanFloat(val, max) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n * 10) / 10, max);  // 1 decimal place
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

function cleanOutputFormat(val) {
  const valid = ['structured-data', 'natural-language', 'code', 'mixed'];
  if (valid.includes(val)) return val;
  return null;
}

// Build a 280-character-safe share tweet. Twitter counts any URL inside the
// text as 23 characters via t.co, regardless of the actual URL length, so we
// budget against that constant. Always ship prefix + title + card URL; fit
// the pitch in between only if there's room for at least a meaningful chunk.
function buildShareTweet(title, pitch, cardUrl, aiScore) {
  const MAX = 280;
  const URL_LEN = 23;               // t.co shortener, fixed
  const SEP = '\n\n';

  // Build prefix — include AI score when available
  let prefix = 'I shared my agent on @DiscoverHermes';
  if (aiScore != null && Number(aiScore) > 0) {
    prefix += ` — AI Score: ${Number.isInteger(Number(aiScore)) ? Number(aiScore) : Number(aiScore).toFixed(1)}/100`;
  }
  prefix += ':';

  const titleText = (title || '').trim();

  // Required overhead: prefix + SEP + <title> + SEP + <url>
  const baseOverhead = prefix.length + SEP.length + SEP.length + URL_LEN;
  const titleMax = MAX - baseOverhead;

  let titleSafe = titleText;
  if (titleSafe.length > titleMax) {
    titleSafe = titleSafe.slice(0, Math.max(0, titleMax - 1)).trimEnd() + '…';
  }

  return `${prefix}${SEP}${titleSafe}${SEP}${cardUrl}`;
}

// Verify a plaintext delete token against the stored SHA-256 hash for a
// submission. Used by DELETE /api/submissions/:id and by the living-database
// update endpoints (approve/reject/post). Returns true only on match.
function verifyDeleteToken(submissionId, plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return false;
  const row = db
    .prepare('SELECT delete_token_hash FROM submissions WHERE id = ?')
    .get(submissionId);
  if (!row || !row.delete_token_hash) return false;
  const expected = Buffer.from(row.delete_token_hash, 'hex');
  const provided = Buffer.from(
    crypto.createHash('sha256').update(plaintext).digest('hex'),
    'hex'
  );
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
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
  const jsonCols = ['tags', 'integrations', 'tools_used', 'skills', 'plugins', 'data_sources', 'output_channels', 'gotchas', 'gallery'];
  for (const c of jsonCols) row[c] = parseJson(row[c], []);
  row.tool_use = row.tool_use == null ? null : !!row.tool_use;
  row.rag = row.rag == null ? null : !!row.rag;
  row.multi_agent = row.multi_agent == null ? null : !!row.multi_agent;
  row.verified = !!row.verified;
  row.featured = !!row.featured;
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

// Security headers for production
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));

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

// Admin endpoint to manually verify a card (useful when Stripe webhook fails)
app.post('/api/admin/verify/:id', smallJson, (req, res) => {
  const auth = req.get('x-admin-token') || req.query.token || (req.body && req.body.token);
  if (!ADMIN_TOKEN || auth !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const existing = db.prepare('SELECT id FROM submissions WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  db.prepare('UPDATE submissions SET verified = 1, verified_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  res.json({ ok: true, id, verified: true });
});

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

// Cache-busting: every boot gets a fresh BUILD_ID. HTML responses
// rewrite /styles.css and /app.js to /styles.css?v=BUILD_ID so a new
// Railway deploy lands instantly regardless of browser/CDN cache.
const BUILD_ID = Date.now().toString(36);
function serveHtml(fileName) {
  const fullPath = path.join(__dirname, 'public', fileName);
  return (_req, res) => {
    fs.readFile(fullPath, 'utf8', (err, html) => {
      if (err) {
        res.status(500).type('text/plain').send('error loading page');
        return;
      }
      const out = html
        .replace(/(href|src)="\/(styles\.css|app\.js)"/g, `$1="/$2?v=${BUILD_ID}"`);
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.type('html').send(out);
    });
  };
}

// Home page: rewrite before express.static gets a chance to serve index.html.
app.get('/', serveHtml('index.html'));

// Static site. HTML/CSS/JS always revalidate so a Railway redeploy
// shows up immediately — we were seeing stale browser cache hide
// freshly-pushed changes. ETag is still on, so revalidations are
// cheap: a 304 when nothing changed, the new bytes when it did.
// `index: false` so `/` always hits the HTML rewriter above.
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    index: false,
    setHeaders: (res, filePath) => {
      if (/\.(html|css|js)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  }),
);

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
// Civil-resistance anti-spam. The real defense against a single user
// spawning a swarm of Hermes sub-agents and blasting the feed is the
// per-handle cap below — at most MAX_CARDS_PER_HANDLE cards per
// twitter_handle. Five leaves enough headroom for power users running
// multiple genuinely different agents while still making a spam swarm
// require burning real Twitter handles. These per-IP limiters are a
// second wall for handle-less posts and distributed single-machine spam.
const MAX_CARDS_PER_HANDLE = 5;
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded, try again later' },
});
const submitLimiterDaily = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'daily submission limit reached — come back tomorrow' },
});

app.post('/api/submissions', smallJson, submitLimiter, submitLimiterDaily, (req, res) => {
  const b = req.body || {};

  const title = clean(b.title, 100);
  const pitch = clean(b.pitch, 300);
  // Accept both `story` (new) and `description` (legacy) for story text.
  const story = clean(b.story || b.description, 2000);

  if (!title || !pitch || !story) {
    return res.status(400).json({ error: 'title, pitch, and story are required' });
  }

  // Civil-resistance rule #1: every card must be tied to a real identity.
  // Without this, a swarm of Hermes sub-agents can mint anonymous cards
  // forever. twitter_handle is the lightest-weight identity hook we have.
  const normalizedHandle = normalizeHandle(b.twitter_handle);
  if (!normalizedHandle) {
    return res.status(400).json({
      error:
        'twitter_handle is required — DiscoverHermes ties every card to a real person. If you really have no handle, ping @Shaughnessy119 on X for an exception.',
    });
  }

  // Civil-resistance rule #2: soft cap of MAX_CARDS_PER_HANDLE cards
  // per handle. Five leaves room for power users running multiple
  // genuinely different agents while still making spam swarms expensive
  // (each extra card requires burning a real Twitter handle). After a
  // legit delete the row is gone, so slots free up naturally.
  // Duplicate guard: reject if the same handle already posted an agent
  // with the same title (case-insensitive). Prevents accidental re-submits.
  const existingDupe = db
    .prepare(
      `SELECT id FROM submissions
       WHERE LOWER(twitter_handle) = LOWER(?) AND LOWER(title) = LOWER(?)
       LIMIT 1`
    )
    .get(normalizedHandle, title);
  if (existingDupe) {
    return res.status(409).json({
      error: `You already have an agent called "${title}" on DiscoverHermes. Use PATCH to update it instead of re-submitting.`,
      existing_id: existingDupe.id,
      existing_url: `/use-cases/${existingDupe.id}`,
    });
  }

  const existingForHandle = db
    .prepare(
      `SELECT id, title FROM submissions
       WHERE LOWER(twitter_handle) = LOWER(?)
       ORDER BY created_at ASC`
    )
    .all(normalizedHandle);
  if (existingForHandle.length >= MAX_CARDS_PER_HANDLE) {
    return res.status(409).json({
      error: `This handle already has ${existingForHandle.length} cards on DiscoverHermes (the per-handle cap is ${MAX_CARDS_PER_HANDLE}). Delete or update an existing one before posting a new one.`,
      cards_count: existingForHandle.length,
      cap: MAX_CARDS_PER_HANDLE,
      existing_cards: existingForHandle.map((r) => ({
        id: r.id,
        title: r.title,
        url: `/use-cases/${r.id}`,
      })),
    });
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
  // v3 enums — silently null out anything that doesn't match the closed list.
  const automationLevel  = AUTOMATION_LEVELS.has(b.automation_level)   ? b.automation_level   : null;
  const contextTier      = CONTEXT_TIERS.has(b.context_tier)           ? b.context_tier       : null;
  const costTier         = COST_TIERS.has(b.cost_tier)                 ? b.cost_tier          : null;
  const reliability      = RELIABILITY_TIERS.has(b.reliability)        ? b.reliability        : null;
  const sourceAvailable  = SOURCE_AVAILABILITY.has(b.source_available) ? b.source_available   : null;
  const timeToBuild      = TIME_TO_BUILD_TIERS.has(b.time_to_build)    ? b.time_to_build      : null;
  const githubUrl        = clean(b.github_url, 300);
  if (githubUrl && !isHttpUrl(githubUrl)) {
    return res.status(400).json({ error: 'github_url must be an http(s) URL' });
  }

  const row = {
    title,
    description: story,          // legacy column kept in sync with story
    pitch,
    story,
    category,
    tags:            JSON.stringify(cleanTags(b.tags, 5) || []),
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
    total_interactions:    cleanInt(b.total_interactions, 1_000_000_000),
    active_users:          cleanInt(b.active_users, 1_000_000_000),
    tasks_completed:       cleanInt(b.tasks_completed, 1_000_000_000),
    complexity_tier: complexityTier,
    gotchas:         JSON.stringify(cleanArray(b.gotchas, 5, 240) || []),
    time_to_build:   timeToBuild,
    satisfaction,
    source_url:      sourceUrl,
    automation_level: automationLevel,
    context_tier:     contextTier,
    cost_tier:        costTier,
    reliability,
    source_available: sourceAvailable,
    github_url:       githubUrl && isHttpUrl(githubUrl) ? githubUrl : null,
    image_url:     imageUrl,
    video_url:     videoUrl,
    image_prompt:  clean(b.image_prompt, 600),
    display_name:   clean(b.display_name, 60),
    twitter_handle: normalizedHandle,
    website:        clean(b.website, 200),
    agent_framework: clean(b.agent_framework, 40) || null,
    // v6.2: New scoring signals
    error_rate:     cleanInt(b.error_rate, 100),  // 0-100 percentage
    multi_agent:    cleanBool(b.multi_agent),
    output_format:  cleanOutputFormat(b.output_format),
    tools_used:     JSON.stringify(cleanArray(b.tools_used, 20, 40) || []),
    ai_score_pending: 1,  // New submissions await AI scoring
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

  // Pre-built "share on X" link. Budget is a hard 280 characters, and Twitter
  // counts any URL in the text as 23 chars via t.co. Always include the prefix,
  // the title, and the card URL; fit the pitch in between only if there's room.
  const cardUrl = `${PUBLIC_URL}/use-cases/${inserted.id}`;
  hydrated.share_tweet_url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(buildShareTweet(title, pitch, cardUrl, null))}`;

  res.status(201).json(hydrated);
});

// Delete your own submission with the token you got on creation.
// Accepts the token in a ?token= query param OR an x-delete-token header.
const mutationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20 });
app.delete('/api/submissions/:id', mutationLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const token = req.query.token || req.get('x-delete-token');
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'delete token required' });
  }
  const exists = db.prepare('SELECT 1 FROM submissions WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });
  if (!verifyDeleteToken(id, token)) {
    return res.status(403).json({ error: 'invalid delete token' });
  }
  // ON DELETE CASCADE takes care of submission_updates.
  db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  res.json({ ok: true, deleted: id });
});

// Author-only edit: mutate a narrow whitelist of fields on an existing
// submission. Authenticated via the same delete_token as delete/updates —
// only the person who originally posted (or their agent's stored token)
// can edit. This is the backing endpoint for the "add an image later"
// flow: if submit.html Part 10 had to POST the card without an image,
// the user can later ask their agent to PATCH image_url + image_prompt,
// or fix a typo in title/pitch/story.
//
// Whitelist is deliberately tight. Things like model/integrations/tags/
// twitter_handle are NOT editable here — if any of those are wrong, the
// right move is to delete and repost fresh. Especially twitter_handle:
// letting it mutate would defeat the one-card-per-handle rule.
const EDITABLE_FIELDS = new Set([
  'title', 'pitch', 'story', 'image_url', 'image_prompt',
  'display_name', 'website', 'agent_framework',
  'total_interactions', 'active_users', 'tasks_completed',
  'runs_completed', 'hours_used', 'tokens_total', 'time_saved_per_week',
  // v6.2: New scoring signals
  'error_rate', 'multi_agent', 'output_format', 'tools_used',
]);
app.patch('/api/submissions/:id', smallJson, mutationLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const existing = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  // Auth: delete token (author) OR admin token
  const token =
    (req.body && req.body.token) || req.query.token || req.get('x-delete-token');
  const adminToken = req.get('x-admin-token');
  const authorizedByDelete = token && verifyDeleteToken(id, token);
  const authorizedByAdmin = adminToken && adminToken === ADMIN_TOKEN;
  if (!authorizedByDelete && !authorizedByAdmin) {
    return res.status(403).json({ error: 'valid delete token or admin token required' });
  }

  const b = req.body || {};
  const patch = {};

  // Only accept keys in the whitelist. Silently ignore anything else so
  // a well-meaning agent can send a bigger object without erroring.
  for (const key of Object.keys(b)) {
    if (key === 'token') continue;
    if (key === 'gallery_add' || key === 'gallery_remove') continue; // handled below
    if (!EDITABLE_FIELDS.has(key)) continue;
    patch[key] = b[key];
  }

  // Gallery operations are applied as mutations to the existing JSON array
  // rather than as a direct overwrite, so agents (or the author via the
  // detail page UI) can add a screenshot without having to resend the whole
  // list. Max GALLERY_MAX = 10 images per card.
  const GALLERY_MAX = 10;
  let nextGallery = null;
  if ('gallery_add' in b || 'gallery_remove' in b) {
    const current = parseJson(existing.gallery, []);
    const list = Array.isArray(current) ? [...current] : [];
    if ('gallery_add' in b) {
      const url = clean(b.gallery_add, 500);
      if (!url) {
        return res.status(400).json({ error: 'gallery_add must be a non-empty url' });
      }
      if (!isAllowedImageUrl(url)) {
        return res.status(400).json({
          error: 'gallery_add must be http(s) or /u/... from /api/uploads',
        });
      }
      if (list.includes(url)) {
        return res.status(409).json({ error: 'that image is already in the gallery' });
      }
      if (list.length >= GALLERY_MAX) {
        return res.status(409).json({
          error: `gallery is full (${GALLERY_MAX} images max). remove one before adding.`,
          gallery_max: GALLERY_MAX,
        });
      }
      list.push(url);
    }
    if ('gallery_remove' in b) {
      const target = clean(b.gallery_remove, 500);
      const beforeLen = list.length;
      const filtered = list.filter((u) => u !== target);
      if (filtered.length === beforeLen) {
        return res.status(404).json({ error: 'that image is not in the gallery' });
      }
      list.length = 0;
      list.push(...filtered);
    }
    nextGallery = list;
    patch.gallery = JSON.stringify(list);
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({
      error: `no editable fields provided. editable: ${[...EDITABLE_FIELDS].join(', ')}, plus gallery_add / gallery_remove`,
    });
  }

  // Per-field validation. Same rules as the create path so nothing
  // can sneak in via PATCH that would have been rejected via POST.
  const clean100 = (v) => clean(v, 100);
  const clean300 = (v) => clean(v, 300);
  const clean2000 = (v) => clean(v, 2000);
  const clean500 = (v) => clean(v, 500);
  const clean600 = (v) => clean(v, 600);
  const clean60 = (v) => clean(v, 60);
  const clean200 = (v) => clean(v, 200);

  if ('title' in patch) {
    const v = clean100(patch.title);
    if (!v) return res.status(400).json({ error: 'title cannot be empty' });
    patch.title = v;
  }
  if ('pitch' in patch) {
    const v = clean300(patch.pitch);
    if (!v) return res.status(400).json({ error: 'pitch cannot be empty' });
    patch.pitch = v;
  }
  if ('story' in patch) {
    const v = clean2000(patch.story);
    if (!v) return res.status(400).json({ error: 'story cannot be empty' });
    patch.story = v;
    // Keep the legacy description column in sync.
    patch.description = v;
  }
  if ('image_url' in patch) {
    const v = clean500(patch.image_url);
    if (v && !isAllowedImageUrl(v)) {
      return res.status(400).json({
        error: 'image_url must be http(s) or /u/... from /api/uploads',
      });
    }
    patch.image_url = v || null;
  }
  if ('image_prompt' in patch) {
    patch.image_prompt = clean600(patch.image_prompt);
  }
  if ('display_name' in patch) {
    patch.display_name = clean60(patch.display_name);
  }
  if ('website' in patch) {
    const v = clean200(patch.website);
    if (v && !isHttpUrl(v)) {
      return res.status(400).json({ error: 'website must be an http(s) URL' });
    }
    patch.website = v || null;
  }
  if ('agent_framework' in patch) {
    patch.agent_framework = clean(patch.agent_framework, 40) || null;
  }
  // Numeric metric fields — agents can PATCH these to keep stats fresh
  for (const numField of ['total_interactions', 'active_users', 'tasks_completed', 'runs_completed', 'hours_used', 'tokens_total', 'time_saved_per_week', 'error_rate']) {
    if (numField in patch) {
      patch[numField] = cleanInt(patch[numField], 1_000_000_000_000);
    }
  }
  if ('error_rate' in patch) {
    patch.error_rate = Math.min(patch.error_rate || 0, 100);
  }
  if ('multi_agent' in patch) {
    patch.multi_agent = cleanBool(patch.multi_agent);
  }
  if ('output_format' in patch) {
    const validFormats = ['structured-data','natural-language','code','mixed'];
    patch.output_format = validFormats.includes(patch.output_format) ? patch.output_format : null;
  }

  // Safety scan across any free-text edits, same as POST.
  const leak = scanForSecrets([
    patch.title, patch.pitch, patch.story, patch.display_name, patch.website,
  ]);
  if (leak) {
    return res.status(400).json({
      error: `looks like a credential (${leak}) in the edit — strip it and retry`,
    });
  }

  // Apply the patch. Bumps last_updated_at so the feed can surface freshly-
  // edited cards the same way it surfaces cards with new timeline updates.
  const setCols = Object.keys(patch);
  const setClause = setCols.map((k) => `${k} = ?`).join(', ');
  const values = setCols.map((k) => patch[k]);
  db.prepare(
    `UPDATE submissions SET ${setClause}, last_updated_at = datetime('now') WHERE id = ?`
  ).run(...values, id);

  const updated = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
  res.json(hydrate(updated));
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
  if (req.query.tool) {
    where.push(`EXISTS (SELECT 1 FROM json_each(submissions.tools_used) WHERE value = ?)`);
    params.push(String(req.query.tool));
  }
  if (req.query.agent_framework) {
    where.push('agent_framework = ?');
    params.push(String(req.query.agent_framework));
  }
  // Verified-only toggle on the feed. Accepts the usual truthy strings.
  if (req.query.verified === '1' || req.query.verified === 'true') {
    where.push('verified = 1');
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
      order = '(likes - COALESCE(dislikes, 0)) DESC, created_at DESC';
      break;
    case 'trending':
      // Classic HN-ish hotness: net votes weigh more when recent.
      order = `(likes - COALESCE(dislikes, 0) + 1.0) / POW((julianday('now') - julianday(created_at)) * 24 + 2, 1.5) DESC`;
      break;
    case 'complexity':
      order = `CASE complexity_tier
        WHEN 'expert' THEN 4 WHEN 'advanced' THEN 3
        WHEN 'intermediate' THEN 2 WHEN 'beginner' THEN 1
        ELSE 0 END DESC, likes DESC, created_at DESC`;
      break;
    case 'score':
      // COALESCE pushes unscored agents to the bottom.
      order = 'COALESCE(ai_score, -1) DESC, created_at DESC';
      break;
    case 'new':
    default:
      order = 'created_at DESC';
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const sql = `SELECT * FROM submissions WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit, offset);
  res.json(rows.map(hydrate));
});

// ---------- submissions: single ----------
app.get('/api/submissions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare('SELECT * FROM submissions WHERE id = ? AND approved = 1').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const hydrated = hydrate(row);

  // Approved updates are public; pending updates only come back if the
  // caller can prove they're the author (same delete token as delete/post).
  hydrated.updates = db.prepare(
    `SELECT id, body, created_at, approved_at
     FROM submission_updates
     WHERE submission_id = ? AND status = 'approved'
     ORDER BY approved_at DESC, created_at DESC`
  ).all(id);

  // Flat visitor comments, newest first.
  hydrated.comments = db.prepare(
    `SELECT id, body, twitter_handle, display_name, created_at
     FROM submission_comments
     WHERE submission_id = ?
     ORDER BY created_at DESC
     LIMIT 200`
  ).all(id);

  // Ranking positions (approx): count how many approved submissions beat this one.
  // total_agents = size of the full "Likes rank" pool (all approved).
  // total_scored = size of the "AI rank" pool (approved + has an ai_score).
  const aiRankRow = db.prepare(
    `SELECT 1 + COUNT(*) AS rank FROM submissions
     WHERE approved = 1 AND ai_score > COALESCE(?, -1)`
  ).get(hydrated.ai_score ?? null);
  const likesRankRow = db.prepare(
    `SELECT 1 + COUNT(*) AS rank FROM submissions
     WHERE approved = 1 AND likes > COALESCE(?, -1)`
  ).get(hydrated.likes ?? null);
  const totalAgentsRow = db.prepare(
    `SELECT COUNT(*) AS n FROM submissions WHERE approved = 1`
  ).get();
  const totalScoredRow = db.prepare(
    `SELECT COUNT(*) AS n FROM submissions WHERE approved = 1 AND ai_score IS NOT NULL`
  ).get();
  hydrated.ai_rank      = aiRankRow?.rank ?? null;
  hydrated.likes_rank   = likesRankRow?.rank ?? null;
  hydrated.total_agents = totalAgentsRow?.n ?? null;
  hydrated.total_scored = totalScoredRow?.n ?? null;

  // Site averages for comparison on the score history chart
  const avgRow = db.prepare(
    `SELECT ROUND(AVG(ai_score), 1) AS avg_score,
            ROUND(AVG(likes - COALESCE(dislikes, 0)), 1) AS avg_likes
     FROM submissions WHERE approved = 1 AND ai_score IS NOT NULL`
  ).get();
  hydrated.site_avg_score = avgRow?.avg_score ?? null;
  hydrated.site_avg_likes = avgRow?.avg_likes ?? null;

  const token = typeof req.query.token === 'string' ? req.query.token : null;
  if (token && verifyDeleteToken(id, token)) {
    hydrated.pending_updates = db.prepare(
      `SELECT id, body, created_at
       FROM submission_updates
       WHERE submission_id = ? AND status = 'pending'
       ORDER BY created_at DESC`
    ).all(id);
    hydrated.is_author = true;
  } else {
    hydrated.pending_updates = [];
    hydrated.is_author = false;
  }

  // Score history for sparkline graph (last 30 data points)
  hydrated.score_history = db.prepare(`
    SELECT ai_score, likes, dislikes, recorded_at
    FROM score_history
    WHERE submission_id = ?
    ORDER BY recorded_at ASC
    LIMIT 30
  `).all(id);

  // Snapshot current state if last snapshot is > 24h old (avoids flooding)
  const lastSnap = db.prepare(`
    SELECT recorded_at FROM score_history
    WHERE submission_id = ? ORDER BY recorded_at DESC LIMIT 1
  `).get(id);
  const snapAge = lastSnap ? Date.now() - new Date(lastSnap.recorded_at).getTime() : Infinity;
  if (snapAge > 24 * 60 * 60 * 1000 && hydrated.ai_score != null) {
    db.prepare(`
      INSERT INTO score_history (submission_id, ai_score, likes, dislikes)
      VALUES (?, ?, ?, ?)
    `).run(id, hydrated.ai_score, hydrated.likes || 0, hydrated.dislikes || 0);
    hydrated.score_history.push({
      ai_score: hydrated.ai_score,
      likes: hydrated.likes || 0,
      dislikes: hydrated.dislikes || 0,
      recorded_at: new Date().toISOString(),
    });
  }

  // Pre-built share link so the detail page share button works without
  // any client-side tweet assembly. Same helper as the submission insert.
  const cardUrl = `${PUBLIC_URL}/use-cases/${id}`;
  hydrated.share_tweet_url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    buildShareTweet(hydrated.title, hydrated.pitch, cardUrl, hydrated.ai_score)
  )}`;

  res.json(hydrated);
});

// ---------- living database: updates ----------
// Rate limits are per submission, not per IP, since the agent may post
// from anywhere. 3 per day, 20 per week. Only counts pending + approved —
// rejected updates are hard-deleted so they don't take up slots.
const UPDATE_DAILY_LIMIT = 3;
const UPDATE_WEEKLY_LIMIT = 20;
const UPDATE_MAX_LEN = 600;

function countRecentUpdates(submissionId, daysWindow) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM submission_updates
     WHERE submission_id = ?
       AND status IN ('pending', 'approved')
       AND created_at >= datetime('now', ?)`
  ).get(submissionId, `-${daysWindow} days`).n;
}

// Author-only: post a new pending update for this submission. The agent
// sends this on whatever cadence the author opted into (weekly by default).
app.post('/api/submissions/:id/updates', smallJson, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const exists = db.prepare('SELECT 1 FROM submissions WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });

  const token = (req.body && req.body.token) || req.get('x-delete-token');
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'delete token required' });
  }
  if (!verifyDeleteToken(id, token)) {
    return res.status(403).json({ error: 'invalid delete token' });
  }

  const body = clean(req.body && req.body.body, UPDATE_MAX_LEN);
  if (!body) return res.status(400).json({ error: 'body is required' });

  // Reject anything that scans as a credential — same safety rules as
  // the main submission path.
  const secret = scanForSecrets([body]);
  if (secret) {
    return res.status(400).json({ error: `looks like a ${secret}; redact and retry` });
  }

  // Rate limits.
  const dailyCount = countRecentUpdates(id, 1);
  if (dailyCount >= UPDATE_DAILY_LIMIT) {
    return res.status(429).json({ error: 'daily update limit reached (3/day)' });
  }
  const weeklyCount = countRecentUpdates(id, 7);
  if (weeklyCount >= UPDATE_WEEKLY_LIMIT) {
    return res.status(429).json({ error: 'weekly update limit reached (20/week)' });
  }

  const info = db.prepare(
    `INSERT INTO submission_updates (submission_id, body, status)
     VALUES (?, ?, 'pending')`
  ).run(id, body);

  const inserted = db.prepare(
    `SELECT id, body, status, created_at FROM submission_updates WHERE id = ?`
  ).get(info.lastInsertRowid);

  // Also bump the submission's last_updated_at so the feed can surface
  // recently-active agents without needing to join on updates.
  db.prepare(
    `UPDATE submissions SET last_updated_at = datetime('now') WHERE id = ?`
  ).run(id);

  res.status(201).json(inserted);
});

// Author-only: approve or reject a pending update.
// Approve flips status='approved' and sets approved_at.
// Reject hard-deletes the row (user's explicit design — no audit trail).
app.post('/api/submissions/:id/updates/:updateId/action', smallJson, (req, res) => {
  const id = Number(req.params.id);
  const updateId = Number(req.params.updateId);
  if (!Number.isInteger(id) || !Number.isInteger(updateId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const token = (req.body && req.body.token) || req.get('x-delete-token');
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'delete token required' });
  }
  if (!verifyDeleteToken(id, token)) {
    return res.status(403).json({ error: 'invalid delete token' });
  }

  const action = req.body && req.body.action;
  if (action !== 'approve' && action !== 'reject') {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }

  const row = db.prepare(
    `SELECT id, status FROM submission_updates
     WHERE id = ? AND submission_id = ?`
  ).get(updateId, id);
  if (!row) return res.status(404).json({ error: 'update not found' });
  if (row.status !== 'pending') {
    return res.status(409).json({ error: `update is already ${row.status}` });
  }

  if (action === 'approve') {
    db.prepare(
      `UPDATE submission_updates
       SET status = 'approved', approved_at = datetime('now')
       WHERE id = ?`
    ).run(updateId);
    return res.json({ ok: true, id: updateId, status: 'approved' });
  }

  // Hard delete on reject — no audit trail, per user design decision.
  db.prepare('DELETE FROM submission_updates WHERE id = ?').run(updateId);
  res.json({ ok: true, id: updateId, status: 'rejected' });
});

// ---------- visitor comments ----------
// Flat comments on a card. Anyone can comment but a twitter_handle is
// required. Rate-limited per IP. Same scanForSecrets safety as other
// free-text paths. Author of the card or admin can delete.
const COMMENT_MAX_LEN = 600;
const commentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'slow down — 10 comments per 5 minutes' },
});

app.post('/api/submissions/:id/comments', smallJson, commentLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const exists = db.prepare('SELECT 1 FROM submissions WHERE id = ? AND approved = 1').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });

  const b = req.body || {};
  const body = clean(b.body, COMMENT_MAX_LEN);
  if (!body) return res.status(400).json({ error: 'comment body is required' });

  // Accept either a twitter handle OR a display name — just one is needed.
  // If the value looks like a handle (no spaces, ≤40 chars), store as handle.
  // Otherwise treat it as a display name.
  const rawName = clean(b.name || b.twitter_handle || b.display_name, 60);
  if (!rawName) {
    return res.status(400).json({ error: 'a name or @handle is required to comment' });
  }
  const looksLikeHandle = /^@?[A-Za-z0-9_]{1,40}$/.test(rawName.replace(/^@/, ''));
  const normalizedHandle = looksLikeHandle ? normalizeHandle(rawName) : null;
  const displayName      = looksLikeHandle ? null : rawName;

  const secret = scanForSecrets([body, displayName]);
  if (secret) {
    return res.status(400).json({ error: `looks like a ${secret}; redact and retry` });
  }

  const info = db.prepare(
    `INSERT INTO submission_comments (submission_id, body, twitter_handle, display_name)
     VALUES (?, ?, ?, ?)`
  ).run(id, body, normalizedHandle, displayName);

  const inserted = db.prepare(
    `SELECT id, body, twitter_handle, display_name, created_at
     FROM submission_comments WHERE id = ?`
  ).get(info.lastInsertRowid);

  res.status(201).json(inserted);
});

// Delete a comment. Two paths:
//   1. Author of the card (proves via ?token=<delete_token>)
//   2. Admin (proves via x-admin-token header)
// No self-delete by comment author — we don't store their delete token.
app.delete('/api/submissions/:id/comments/:commentId', (req, res) => {
  const id = Number(req.params.id);
  const commentId = Number(req.params.commentId);
  if (!Number.isInteger(id) || !Number.isInteger(commentId)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const row = db.prepare(
    `SELECT id FROM submission_comments WHERE id = ? AND submission_id = ?`
  ).get(commentId, id);
  if (!row) return res.status(404).json({ error: 'comment not found' });

  const token =
    (req.body && req.body.token) || req.query.token || req.get('x-delete-token');
  const adminToken = req.get('x-admin-token');

  const isAuthor = typeof token === 'string' && verifyDeleteToken(id, token);
  const isAdmin = ADMIN_TOKEN && adminToken === ADMIN_TOKEN;

  if (!isAuthor && !isAdmin) {
    return res.status(403).json({
      error: 'only the card author (with delete token) or admin can delete a comment',
    });
  }

  db.prepare(`DELETE FROM submission_comments WHERE id = ?`).run(commentId);
  res.json({ ok: true });
});

// ---------- likes ----------
const likeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });
app.post('/api/submissions/:id/like', smallJson, likeLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  // Anti-bot: reject if honeypot field is filled (bots auto-fill hidden fields)
  if (req.body && req.body.website) {
    return res.status(200).json({ id, likes: 0 }); // silent 200 so bots think it worked
  }
  // Anti-bot: require a human-timing token set by the frontend after page load
  if (!req.body || !req.body._t) {
    return res.status(200).json({ id, likes: 0 });
  }

  const delta = req.body.unlike ? -1 : 1;
  const result = db
    .prepare('UPDATE submissions SET likes = MAX(0, likes + ?) WHERE id = ? AND approved = 1')
    .run(delta, id);
  if (result.changes === 0) return res.status(404).json({ error: 'not found' });
  const row = db.prepare('SELECT id, likes, dislikes FROM submissions WHERE id = ?').get(id);
  res.json(row);
});

// ---------- dislikes (downvotes for curation) ----------
const dislikeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });
app.post('/api/submissions/:id/dislike', smallJson, dislikeLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  // Anti-bot: same checks as likes
  if (req.body && req.body.website) {
    return res.status(200).json({ id, dislikes: 0 });
  }
  if (!req.body || !req.body._t) {
    return res.status(200).json({ id, dislikes: 0 });
  }

  const delta = req.body.undislike ? -1 : 1;
  db.prepare('UPDATE submissions SET dislikes = MAX(0, COALESCE(dislikes, 0) + ?) WHERE id = ? AND approved = 1')
    .run(delta, id);
  const row = db.prepare('SELECT id, dislikes FROM submissions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// ---------- meta: taxonomy ----------
app.get('/api/meta', (_req, res) => {
  // Per-category counts so the feed can hide empty buckets and only show
  // pills for categories that actually have agents. Ordered by the canonical
  // CATEGORIES list so the UI order stays stable instead of jumping around
  // as counts change.
  const rawCounts = db.prepare(
    `SELECT category, COUNT(*) AS n
     FROM submissions
     WHERE approved = 1 AND category IS NOT NULL AND category != ''
     GROUP BY category`
  ).all();
  const countMap = Object.fromEntries(rawCounts.map((r) => [r.category, r.n]));
  const categoryCounts = CATEGORIES
    .map((name) => ({ name, count: countMap[name] || 0 }))
    .filter((c) => c.count > 0);

  res.json({
    categories: CATEGORIES,
    // Populated categories only, with counts. Client renders this.
    category_counts: categoryCounts,
    deployments: [...DEPLOYMENTS],
    triggers: [...TRIGGERS],
    memory_types: [...MEMORY_TYPES],
    automation_levels: [...AUTOMATION_LEVELS],
    context_tiers: [...CONTEXT_TIERS],
    cost_tiers: [...COST_TIERS],
    reliability_tiers: [...RELIABILITY_TIERS],
    source_availability: [...SOURCE_AVAILABILITY],
    time_to_build_tiers: [...TIME_TO_BUILD_TIERS],
    complexity_tiers: [...COMPLEXITY_TIERS],
    verify_enabled: VERIFY_ENABLED,
    verify_price_usd: VERIFY_PRICE_USD,
    // Agent frameworks with counts — for filter pills on the feed
    framework_counts: db.prepare(
      `SELECT COALESCE(agent_framework, 'hermes') AS name, COUNT(*) AS count
       FROM submissions WHERE approved = 1
       GROUP BY COALESCE(agent_framework, 'hermes')
       ORDER BY count DESC`
    ).all(),
  });
});

// Popular tags, with counts. Used by submit prompts to surface existing
// canonical tags so the agent can match instead of inventing new ones.
app.get('/api/tags', (_req, res) => {
  const rows = db.prepare(
    `SELECT j.value AS tag, COUNT(*) AS count
     FROM submissions, json_each(submissions.tags) j
     WHERE approved = 1
     GROUP BY j.value
     ORDER BY count DESC, tag ASC
     LIMIT 200`
  ).all();
  res.json(rows);
});

// Lazy daily snapshot. Called at the top of /api/stats — cheap when
// today's row exists (one index lookup), writes one row on the first
// stats call of the day. Avoids a separate cron process.
function maybeSnapshotDailyTotals() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const existing = db
    .prepare('SELECT 1 FROM daily_totals WHERE date = ?')
    .get(today);
  if (existing) return;
  const totals = db.prepare(
    `SELECT
       COUNT(*) AS agents,
       COALESCE(SUM(tokens_total), 0) AS tokens
     FROM submissions WHERE approved = 1`
  ).get();
  db.prepare(
    `INSERT INTO daily_totals (date, total_agents, total_tokens)
     VALUES (?, ?, ?)`
  ).run(today, totals.agents, totals.tokens);
}

// ---------- stats: aggregates for dashboard ----------
app.get('/api/stats', (_req, res) => {
  maybeSnapshotDailyTotals();
  maybeRefreshGitHubStats();
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
    total_dislikes:     one(`SELECT COALESCE(SUM(dislikes), 0) AS n FROM submissions WHERE approved = 1`).n,
    total_hours_saved:  one(`SELECT COALESCE(SUM(time_saved_per_week), 0) AS n FROM submissions WHERE approved = 1`).n,
    total_tokens:       one(`SELECT COALESCE(SUM(tokens_total), 0) AS n FROM submissions WHERE approved = 1`).n,
    total_runs:         one(`SELECT COALESCE(SUM(runs_completed), 0) AS n FROM submissions WHERE approved = 1`).n,
    total_interactions: one(`SELECT COALESCE(SUM(total_interactions), 0) AS n FROM submissions WHERE approved = 1`).n,
    total_tasks:        one(`SELECT COALESCE(SUM(tasks_completed), 0) AS n FROM submissions WHERE approved = 1`).n,
    total_active_users: one(`SELECT COALESCE(SUM(active_users), 0) AS n FROM submissions WHERE approved = 1`).n,
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
    avg_ai_score:
      one(`SELECT ROUND(AVG(ai_score), 1) AS n
           FROM submissions WHERE approved = 1 AND ai_score IS NOT NULL`).n || 0,
    top_ai_score:
      one(`SELECT ROUND(MAX(ai_score), 1) AS n
           FROM submissions WHERE approved = 1 AND ai_score IS NOT NULL`).n || 0,
    top_ai_score_id:
      (one(`SELECT id FROM submissions WHERE approved = 1 AND ai_score IS NOT NULL ORDER BY ai_score DESC LIMIT 1`) || {}).id || null,
    top_likes:
      one(`SELECT COALESCE(MAX(likes), 0) AS n FROM submissions WHERE approved = 1`).n,
    top_likes_id:
      (one(`SELECT id FROM submissions WHERE approved = 1 ORDER BY likes DESC LIMIT 1`) || {}).id || null,
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

  // Cumulative tokens processed: pulled from daily_totals snapshots.
  // Each row is an authoritative end-of-day total, so the chart just
  // plots them directly. Only the last 60 days for readability.
  const cumulativeTokens = many(
    `SELECT date AS label, total_tokens AS count
     FROM daily_totals
     ORDER BY date ASC
     LIMIT 60`
  );

  // Daily submissions broken down by framework — for time-series chart
  const dailyByFramework = many(
    `SELECT DATE(created_at) AS date,
            COALESCE(agent_framework, 'hermes') AS framework,
            COUNT(*) AS count
     FROM submissions WHERE approved = 1
     GROUP BY DATE(created_at), COALESCE(agent_framework, 'hermes')
     ORDER BY date ASC`
  );
  // Pivot into { labels: [...], datasets: { hermes: [...], openclaw: [...] } }
  const fwDates = [...new Set(dailyByFramework.map(r => r.date))].slice(-30);
  const fwNames = [...new Set(dailyByFramework.map(r => r.framework))];
  const fwMap = {};
  dailyByFramework.forEach(r => {
    if (!fwMap[r.framework]) fwMap[r.framework] = {};
    fwMap[r.framework][r.date] = r.count;
  });
  const dailyFramework = {
    labels: fwDates,
    datasets: Object.fromEntries(fwNames.map(fw => [
      fw,
      fwDates.map(d => (fwMap[fw] && fwMap[fw][d]) || 0),
    ])),
  };

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
    by_automation:    groupScalar('automation_level'),
    by_context_tier:  groupScalar('context_tier'),
    by_cost_tier:     groupScalar('cost_tier'),
    by_reliability:   groupScalar('reliability'),
    by_source:        groupScalar('source_available'),
    by_time_to_build: groupScalar('time_to_build'),
    by_complexity:    groupScalar('complexity_tier'),
    by_framework:    groupScalar('agent_framework'),
    by_integration:  groupArray('integrations'),
    by_tool:         groupArray('tools_used'),
    by_skill:        groupArray('skills'),
    by_plugin:       groupArray('plugins'),
    tool_use:        boolDist('tool_use'),
    rag:             boolDist('rag'),
    score_distribution: many(
      `SELECT
         CASE
           WHEN ai_score >= 80 THEN '80-100 (S/A)'
           WHEN ai_score >= 60 THEN '60-79 (B)'
           WHEN ai_score >= 40 THEN '40-59 (C)'
           WHEN ai_score >= 20 THEN '20-39 (D)'
           ELSE '0-19'
         END AS label,
         COUNT(*) AS count
       FROM submissions
       WHERE approved = 1 AND ai_score IS NOT NULL
       GROUP BY label
       ORDER BY MIN(ai_score) ASC`
    ),
    daily,
    cumulative,
    cumulative_tokens: cumulativeTokens,
    daily_framework: dailyFramework,

    // GitHub repo stats — latest snapshot from github_stats table
    github: one(`SELECT * FROM github_stats ORDER BY date DESC LIMIT 1`),
    github_history: many(`SELECT date, stars, forks, contributors, global_rank FROM github_stats ORDER BY date ASC LIMIT 90`),
  });
});

// ---------- github stats: auto-refresh daily ----------
// Shared fetch logic used by both the daily auto-pull and the admin endpoint.
async function refreshGitHubStats() {
  const resp = await fetch('https://www.star-history.com/nousresearch/hermes-agent', {
    headers: { 'User-Agent': 'DiscoverHermes/1.0' },
  });
  if (!resp.ok) throw new Error(`star-history returned ${resp.status}`);
  const html = await resp.text();

  const parseK = (m) => m ? Math.round(parseFloat(m[1]) * 1000) : 0;
  const starsMatch = html.match(/([\d.]+)k\s*Stars/i);
  const forksMatch = html.match(/([\d.]+)k\s*Forks/i);
  const contributorsMatch = html.match(/(\d+)\s*Contributors/i);
  const rankMatch = html.match(/Global Rank\s*#(\d+)/i) || html.match(/#(\d+)\s*hermes-agent/i);
  const weeklyStarsMatch = html.match(/New stars\s*\+?([\d.]+k)/i) || html.match(/\+([\d.]+k)\s*stars/i);
  const pushesMatch = html.match(/(\d+)\s*Pushes/i);
  const issuesMatch = html.match(/Issues closed\s*(\d+)/i);

  const stats = {
    stars: parseK(starsMatch),
    forks: parseK(forksMatch),
    contributors: contributorsMatch ? parseInt(contributorsMatch[1]) : 0,
    global_rank: rankMatch ? parseInt(rankMatch[1]) : null,
    weekly_stars: parseK(weeklyStarsMatch),
    weekly_pushes: pushesMatch ? parseInt(pushesMatch[1]) : 0,
    weekly_issues_closed: issuesMatch ? parseInt(issuesMatch[1]) : 0,
  };

  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT OR REPLACE INTO github_stats
      (date, stars, forks, contributors, global_rank, weekly_stars, weekly_pushes, weekly_issues_closed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(today, stats.stars, stats.forks, stats.contributors, stats.global_rank,
         stats.weekly_stars, stats.weekly_pushes, stats.weekly_issues_closed);

  return { date: today, ...stats };
}

// Lazy daily auto-refresh: on first /api/stats request each day, if today's
// github_stats row doesn't exist yet, fetch fresh data in the background.
let _ghRefreshPromise = null;
function maybeRefreshGitHubStats() {
  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare('SELECT 1 FROM github_stats WHERE date = ?').get(today);
  if (existing) return;
  // Only one in-flight refresh at a time
  if (_ghRefreshPromise) return;
  _ghRefreshPromise = refreshGitHubStats()
    .then((s) => console.log(`[github-stats] auto-refreshed: ${s.stars} stars, #${s.global_rank}`))
    .catch((err) => console.error('[github-stats] auto-refresh failed:', err.message))
    .finally(() => { _ghRefreshPromise = null; });
}

// Admin endpoint: force-refresh (still useful for manual triggers)
app.post('/api/admin/github-stats', smallJson, async (req, res) => {
  const auth = req.get('x-admin-token') || req.query.token || (req.body && req.body.token);
  if (!ADMIN_TOKEN || auth !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const stats = await refreshGitHubStats();
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error('github-stats error:', err);
    res.status(500).json({ error: 'internal error', message: err.message });
  }
});

// ---------- author edits ----------
// PATCH /api/submissions/:id — edit submission content
// Uses delete token (author edits own) OR admin token (admin edits any)
// Whitelisted fields: title, pitch, story, image_url, image_prompt, display_name, website
// ---------- admin (token-gated) ----------
app.post('/api/admin/submissions/:id/approve', smallJson, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const approved = req.body && req.body.approved === false ? 0 : 1;
  const info = db.prepare('UPDATE submissions SET approved = ? WHERE id = ?').run(approved, id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.delete('/api/admin/submissions/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const info = db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// GET /api/admin/untweeted — agents that have been scored but not yet tweeted
app.get('/api/admin/untweeted', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT id, title, pitch, description, ai_score, ai_grade,
           twitter_handle, image_url, created_at
    FROM submissions
    WHERE approved = 1
      AND ai_score IS NOT NULL
      AND tweeted_at IS NULL
    ORDER BY created_at ASC
  `).all();
  res.json(rows);
});

// POST /api/admin/mark-tweeted/:id — mark an agent as tweeted
app.post('/api/admin/mark-tweeted/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const info = db.prepare("UPDATE submissions SET tweeted_at = datetime('now') WHERE id = ?").run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, id });
});

// ---------- AI scoring endpoints ----------
// PATCH /api/submissions/:id/score — update AI score fields
// Uses delete token OR admin token for authorization
app.patch('/api/submissions/:id/score', smallJson, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  
  // Auth: delete token OR admin token
  const deleteToken = req.query.token || req.get('x-delete-token');
  const adminToken = req.get('x-admin-token');
  
  const authorizedByDelete = deleteToken && verifyDeleteToken(id, deleteToken);
  const authorizedByAdmin = adminToken && adminToken === ADMIN_TOKEN;
  
  if (!authorizedByDelete && !authorizedByAdmin) {
    return res.status(401).json({ error: 'valid delete token or admin token required' });
  }
  
  const b = req.body || {};
  const now = new Date().toISOString();
  
  // Allow setting pending without score (for reset)
  const aiScorePending = b.ai_score_pending != null ? cleanBool(b.ai_score_pending) : null;
  const aiScore = b.ai_score != null ? cleanFloat(b.ai_score, 100) : null;
  const aiGrade = typeof b.ai_grade === 'string' && ['S','A','B','C','D','F'].includes(b.ai_grade) ? b.ai_grade : null;
  const aiRationale = clean(b.ai_rationale, 500);
  const featured = cleanBool(b.featured);
  const featuredReason = clean(b.featured_reason, 200);
  
  // Must provide either ai_score or ai_score_pending
  if (aiScore == null && aiScorePending == null) {
    return res.status(400).json({ error: 'ai_score or ai_score_pending is required' });
  }
  
  const info = db.prepare(`
    UPDATE submissions
    SET ai_score = COALESCE(?, ai_score),
        ai_grade = COALESCE(?, ai_grade),
        ai_score_pending = COALESCE(?, ai_score_pending),
        ai_rationale = COALESCE(?, ai_rationale),
        featured = COALESCE(?, featured),
        featured_reason = COALESCE(?, featured_reason),
        last_reviewed_at = ?
    WHERE id = ?
  `).run(aiScore, aiGrade, aiScorePending, aiRationale, featured, featuredReason, now, id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });

  // Log score history for the sparkline graph
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
  if (row && row.ai_score != null) {
    db.prepare(`
      INSERT INTO score_history (submission_id, ai_score, likes, dislikes, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, row.ai_score, row.likes || 0, row.dislikes || 0, now);
  }

  res.json(hydrate(row));
});

// GET /api/submissions/unscored — submissions that need AI review
app.get('/api/submissions/unscored', requireAdmin, (req, res) => {
  const olderThan = req.query.older_than; // ISO date
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  
  let sql = `SELECT * FROM submissions WHERE approved = 1 AND (ai_score IS NULL`;
  const params = [];
  
  if (olderThan) {
    sql += ` OR last_reviewed_at < ?`;
    params.push(olderThan);
  }
  sql += `) ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(hydrate));
});

// GET /api/rankings — top scored submissions
app.get('/api/rankings', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const minScore = Number(req.query.min_score) || 0;
  
  const rows = db.prepare(`
    SELECT * FROM submissions 
    WHERE approved = 1 AND ai_score IS NOT NULL AND ai_score >= ?
    ORDER BY ai_score DESC, created_at DESC
    LIMIT ?
  `).all(minScore, limit);
  
  res.json(rows.map(hydrate));
});

// GET /api/featured — submissions featured by AI
app.get('/api/featured', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  
  const rows = db.prepare(`
    SELECT * FROM submissions 
    WHERE approved = 1 AND featured = 1
    ORDER BY last_reviewed_at DESC
    LIMIT ?
  `).all(limit);
  
  res.json(rows.map(hydrate));
});

// GET /api/activity — recent site activity feed for the homepage ticker
app.get('/api/activity', (_req, res) => {
  try {
    const submitted = db.prepare(`
      SELECT id, title, display_name, twitter_handle, created_at
      FROM submissions WHERE approved = 1
      ORDER BY created_at DESC LIMIT 5
    `).all().map(r => ({
      type: 'submitted',
      text: `@${r.twitter_handle || r.display_name || 'someone'} submitted ${r.title}`,
      url: `/use-cases/${r.id}`,
      timestamp: r.created_at
    }));

    const scored = db.prepare(`
      SELECT id, title, ai_score, ai_grade, last_reviewed_at
      FROM submissions WHERE approved = 1 AND ai_score IS NOT NULL
      ORDER BY last_reviewed_at DESC LIMIT 5
    `).all().map(r => ({
      type: 'scored',
      text: `${r.title} scored ${Math.round(r.ai_score)}/100 (Grade ${r.ai_grade || '?'})`,
      url: `/use-cases/${r.id}`,
      timestamp: r.last_reviewed_at
    }));

    const commented = db.prepare(`
      SELECT sc.twitter_handle, sc.display_name, sc.created_at,
             s.id AS submission_id, s.title
      FROM submission_comments sc
      JOIN submissions s ON sc.submission_id = s.id
      ORDER BY sc.created_at DESC LIMIT 5
    `).all().map(r => ({
      type: 'commented',
      text: `${r.display_name || r.twitter_handle || 'someone'} commented on ${r.title}`,
      url: `/use-cases/${r.submission_id}`,
      timestamp: r.created_at
    }));

    const trending = db.prepare(`
      SELECT id, title, likes
      FROM submissions WHERE approved = 1 AND likes > 0
      ORDER BY likes DESC LIMIT 5
    `).all().map(r => ({
      type: 'trending',
      text: `${r.title} is trending with ${r.likes} likes`,
      url: `/use-cases/${r.id}`,
      timestamp: null
    }));

    const merged = [...submitted, ...scored, ...commented, ...trending]
      .sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0;
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return new Date(b.timestamp) - new Date(a.timestamp);
      })
      .slice(0, 20);

    res.json(merged);
  } catch (err) {
    console.error('/api/activity error:', err);
    res.status(500).json({ error: 'failed to load activity' });
  }
});

// GET /api/badge/:id.svg — dynamic SVG badge showing AI score, grade, rank.
// Embeddable in GitHub READMEs, docs, websites. Cached for 5 minutes.
app.get('/api/badge/:id.svg', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).type('text/plain').send('invalid id');
  const row = db.prepare(
    'SELECT title, ai_score, ai_grade, likes, dislikes FROM submissions WHERE id = ? AND approved = 1'
  ).get(id);
  if (!row) return res.status(404).type('text/plain').send('not found');

  const score = row.ai_score != null ? Math.round(row.ai_score) : null;
  const grade = row.ai_grade || null;
  const netLikes = (row.likes || 0) - (row.dislikes || 0);

  // Rank among scored agents
  let rankText = '';
  if (score != null) {
    const rankRow = db.prepare(
      'SELECT 1 + COUNT(*) AS rank FROM submissions WHERE approved = 1 AND ai_score > ?'
    ).get(score);
    const totalRow = db.prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE approved = 1 AND ai_score IS NOT NULL'
    ).get();
    rankText = `#${rankRow.rank} of ${totalRow.n}`;
  }

  // Build label segments: "DiscoverHermes | AI Score: 87 (A) | #3 of 50 | ♥ 12"
  const segments = ['DiscoverHermes'];
  if (score != null) {
    segments.push(`AI Score: ${score}` + (grade ? ` (${grade})` : ''));
  } else {
    segments.push('Unscored');
  }
  if (rankText) segments.push(rankText);
  if (netLikes > 0) segments.push(`\u2665 ${netLikes}`);

  // Grade → color mapping
  const gradeColors = {
    S: '#f59e0b', A: '#22c55e', B: '#3b82f6', C: '#a78bfa', D: '#94a3b8'
  };
  const accentColor = gradeColors[grade] || '#f97316';

  // Measure segment widths (approximate: 6.8px per char at 11px font)
  const charW = 6.8;
  const segPad = 10; // padding inside each segment
  const segGap = 1;  // gap between segments
  const widths = segments.map(s => Math.ceil(s.length * charW + segPad * 2));
  const totalW = widths.reduce((a, b) => a + b, 0) + segGap * (segments.length - 1);
  const h = 22;

  // Build SVG
  let x = 0;
  let rects = '';
  let texts = '';
  segments.forEach((seg, i) => {
    const w = widths[i];
    const bg = i === 0 ? '#2d2d2d' : '#3d3d3d';
    const fill = i === 0 ? '#ccc' : '#fff';
    const r = i === 0 ? 'rx="4" ry="4"' : (i === segments.length - 1 ? 'rx="4" ry="4"' : '');
    rects += `<rect x="${x}" y="0" width="${w}" height="${h}" fill="${bg}" ${r}/>`;
    texts += `<text x="${x + w / 2}" y="15" fill="${fill}" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">${seg.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`;
    x += w + segGap;
  });
  // Accent bar at bottom
  rects += `<rect x="0" y="${h - 3}" width="${totalW}" height="3" fill="${accentColor}" rx="0" ry="0" opacity="0.7"/>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${h}" role="img" aria-label="${segments.join(' | ')}">
  <title>${segments.join(' | ')}</title>
  ${rects}
  ${texts}
</svg>`;

  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(svg);
});

// ---------- agent shortcut ----------
// GET /submit/agent — returns the raw submission prompt as plain text so
// a Hermes agent that visits this URL can immediately read and follow it.
// The agent just needs to visit this URL; no copy-paste required.
const SUBMIT_HTML_PATH = path.join(__dirname, 'public', 'submit.html');
app.get('/submit/agent', (_req, res) => {
  fs.readFile(SUBMIT_HTML_PATH, 'utf8', (err, html) => {
    if (err) return res.status(500).type('text/plain').send('error loading prompt');
    // Extract text between <pre id="prompt-block"><code> ... </code></pre>
    const start = html.indexOf('<pre id="prompt-block"><code>');
    const end   = html.indexOf('</code></pre>', start);
    if (start === -1 || end === -1) {
      return res.status(500).type('text/plain').send('could not find prompt block');
    }
    let prompt = html.slice(start + '<pre id="prompt-block"><code>'.length, end);
    // Decode the handful of HTML entities used inside the <pre>
    prompt = prompt
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const preamble =
      '=== DISCOVERHERMES SUBMISSION INSTRUCTIONS ===\n' +
      'You are reading this because you visited discoverhermes.com/submit/agent.\n' +
      'Follow the instructions below EXACTLY. Begin immediately with Step 0 (ACK).\n' +
      '================================================\n\n';
    res.setHeader('Cache-Control', 'no-cache');
    res.type('text/plain').send(preamble + prompt.trim());
  });
});

// ---------- page routes ----------
// All HTML pages route through serveHtml so asset URLs get cache-busted.
app.get('/submit', serveHtml('submit.html'));
app.get('/stats', serveHtml('stats.html'));
app.get('/rankings', serveHtml('rankings.html'));
app.get('/ecosystem', serveHtml('ecosystem.html'));
// Detail page with dynamic OG meta tags — so sharing an agent link on
// Twitter/Discord shows that agent's image, title, and pitch instead of
// generic DiscoverHermes branding.
app.get('/use-cases/:id', (req, res) => {
  const fullPath = path.join(__dirname, 'public', 'use-case.html');
  fs.readFile(fullPath, 'utf8', (err, html) => {
    if (err) return res.status(500).type('text/plain').send('error loading page');

    let out = html.replace(/(href|src)="\/(styles\.css|app\.js)"/g, `$1="/$2?v=${BUILD_ID}"`);

    // Look up the submission to inject its metadata into OG tags.
    const id = Number(req.params.id);
    if (Number.isInteger(id)) {
      const row = db.prepare('SELECT title, pitch, image_url FROM submissions WHERE id = ? AND approved = 1').get(id);
      if (row) {
        const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const ogTitle = esc(row.title) + ' — DiscoverHermes';
        const ogDesc = esc(row.pitch || 'A Hermes agent use case on DiscoverHermes.');
        const ogImg = row.image_url
          ? (row.image_url.startsWith('/') ? `${PUBLIC_URL}${row.image_url}` : row.image_url)
          : `${PUBLIC_URL}/og-image.svg`;

        out = out
          .replace(/<title>[^<]*<\/title>/, `<title>${ogTitle}</title>`)
          .replace(/(<meta\s+name="description"\s+content=")[^"]*"/,  `$1${ogDesc}"`)
          .replace(/(<meta\s+property="og:title"\s+content=")[^"]*"/,  `$1${ogTitle}"`)
          .replace(/(<meta\s+property="og:description"\s+content=")[^"]*"/,  `$1${ogDesc}"`)
          .replace(/(<meta\s+property="og:image"\s+content=")[^"]*"/,  `$1${ogImg}"`)
          .replace(/(<meta\s+name="twitter:title"\s+content=")[^"]*"/,  `$1${ogTitle}"`)
          .replace(/(<meta\s+name="twitter:description"\s+content=")[^"]*"/,  `$1${ogDesc}"`)
          .replace(/(<meta\s+name="twitter:image"\s+content=")[^"]*"/,  `$1${ogImg}"`);
      }
    }

    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.type('html').send(out);
  });
});

// Graceful shutdown for Railway / container environments
// Ensures SQLite WAL is checkpointed before exit
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('Database closed cleanly.');
  } catch (e) {
    console.error('Error during shutdown:', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Auto-tweet via Buffer: announce new agents ~30 min after submission
// (gives time for AI scoring to land). Runs every 5 minutes.
// ---------------------------------------------------------------------------
function composeTweet(agent) {
  const name = agent.title;
  const pitch = agent.pitch || agent.description || '';
  const score = agent.ai_score != null
    ? (Number.isInteger(agent.ai_score) ? agent.ai_score : Number(agent.ai_score).toFixed(1))
    : null;
  const handle = agent.twitter_handle ? `@${agent.twitter_handle.replace(/^@/, '')}` : null;
  const url = `${PUBLIC_URL}/use-cases/${agent.id}`;

  // Build tweet — Twitter's 280-char limit. We'll be concise.
  let tweet = `${name}`;
  if (pitch) {
    // Trim pitch to keep total under ~230 chars (leave room for score + handle + URL)
    const maxPitch = 140;
    const shortPitch = pitch.length > maxPitch ? pitch.slice(0, maxPitch - 1) + '…' : pitch;
    tweet += ` — ${shortPitch}`;
  }
  tweet += '\n';
  if (score) tweet += `\nAI Score: ${score}/100`;
  if (handle) tweet += `\nSubmitted by ${handle}`;
  tweet += `\n\n${url}`;

  return tweet;
}

async function sendBufferTweet(agent) {
  const text = composeTweet(agent);

  // Buffer GraphQL API — createPost mutation
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        id
        status
      }
    }
  `;
  const variables = {
    input: {
      channelIds: [BUFFER_CHANNEL_ID],
      text,
      ...(agent.image_url ? { media: [{ remoteUrl: agent.image_url }] } : {}),
    },
  };

  const res = await fetch('https://graph.buffer.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BUFFER_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(`Buffer GraphQL: ${json.errors.map(e => e.message).join(', ')}`);
  }
  if (!res.ok) {
    throw new Error(`Buffer API ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function checkPendingTweets() {
  if (!BUFFER_ACCESS_TOKEN || !BUFFER_CHANNEL_ID) return;

  const cutoff = new Date(Date.now() - TWEET_DELAY_MS).toISOString();
  const pending = db.prepare(`
    SELECT * FROM submissions
    WHERE approved = 1
      AND tweeted_at IS NULL
      AND ai_score IS NOT NULL
      AND created_at <= ?
    ORDER BY created_at ASC
    LIMIT 3
  `).all(cutoff);

  for (const agent of pending) {
    try {
      await sendBufferTweet(agent);
      db.prepare('UPDATE submissions SET tweeted_at = datetime(\'now\') WHERE id = ?').run(agent.id);
      console.log(`[tweet] Announced agent #${agent.id}: ${agent.title}`);
    } catch (err) {
      console.error(`[tweet] Failed for agent #${agent.id}:`, err.message);
      // Don't mark as tweeted — will retry next cycle
    }
  }
}

// Auto-tweet is PAUSED — handled by external Hermes agent instead.
// To re-enable: uncomment the setInterval and setTimeout below.
// setInterval(checkPendingTweets, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`DiscoverHermes listening on http://localhost:${PORT}`);
});
