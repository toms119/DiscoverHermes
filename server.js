// DiscoverHermes — a tiny discovery portal for Hermes agent use cases.
//
// Everything lives in this one file on purpose: the whole backend is
// ~100 lines of glue around SQLite + Express. No migrations, no ORM,
// no build step on the frontend. Keep it that way.

const path = require('path');
const fs = require('fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
// DATA_DIR is overridable so production (e.g. Railway) can point at a
// mounted volume like /data. Local dev falls back to ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function clean(str, max) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
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

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'admin disabled' });
  const token = req.get('x-admin-token');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- public API ----------

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded, try again later' },
});

app.post('/api/submissions', submitLimiter, (req, res) => {
  const title = clean(req.body.title, 120);
  const description = clean(req.body.description, 1200);
  if (!title || !description) {
    return res.status(400).json({ error: 'title and description are required' });
  }

  const imageUrl = clean(req.body.image_url, 500);
  const videoUrl = clean(req.body.video_url, 500);
  if (imageUrl && !isHttpUrl(imageUrl)) {
    return res.status(400).json({ error: 'image_url must be an http(s) URL' });
  }
  if (videoUrl && !isHttpUrl(videoUrl)) {
    return res.status(400).json({ error: 'video_url must be an http(s) URL' });
  }

  const handle = normalizeHandle(req.body.twitter_handle);

  const info = db
    .prepare(
      `INSERT INTO submissions (title, description, image_url, video_url, twitter_handle)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(title, description, imageUrl, videoUrl, handle);

  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

app.get('/api/submissions', (req, res) => {
  const sort = req.query.sort === 'top' ? 'likes DESC, created_at DESC' : 'created_at DESC';
  const rows = db
    .prepare(`SELECT * FROM submissions WHERE approved = 1 ORDER BY ${sort} LIMIT 200`)
    .all();
  res.json(rows);
});

const likeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60 });
app.post('/api/submissions/:id/like', likeLimiter, (req, res) => {
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

// ---------- admin (token-gated, optional) ----------

app.post('/api/admin/submissions/:id/approve', requireAdmin, (req, res) => {
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

// ---------- fallthrough ----------

app.get('/submit', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'submit.html'));
});

app.listen(PORT, () => {
  console.log(`DiscoverHermes listening on http://localhost:${PORT}`);
});
