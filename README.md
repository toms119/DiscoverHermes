# DiscoverHermes

A tiny discovery portal for cool things people are building with their [Hermes](https://newsresearch.ai) agent. People post what they built straight from their agent (Telegram, web, wherever) and everyone else gets a visual feed of use cases to browse and like.

The whole project is deliberately small — one backend file, three frontend files. If you find yourself adding a framework, stop and reconsider.

## How it works

1. User opens `/submit`, copies a prompt, pastes it into their Hermes agent.
2. Their agent asks them for title, description, image URL, video URL, Twitter handle.
3. Their agent `POST`s the JSON to `/api/submissions`.
4. It shows up on the homepage feed immediately.

No file uploads — media is submitted as **public URLs**. This is intentional: it means we never host bytes, never run a moderation pipeline, and the site can run on anything.

## Running locally

```bash
npm install
npm start
# → http://localhost:3000
```

SQLite DB is created at `data/discoverhermes.db` on first run.

## Environment variables

| Var            | Purpose                                                            |
| -------------- | ------------------------------------------------------------------ |
| `PORT`         | Port to bind (default `3000`, Railway injects this automatically)  |
| `DATA_DIR`     | Where to put the SQLite file (default `./data`)                    |
| `ADMIN_TOKEN`  | If set, enables `/api/admin/*` endpoints gated by this token       |

## API

### `POST /api/submissions`
Create a use case. Rate-limited to 10/hr per IP.

```json
{
  "title":          "Hermes built me a morning market brief",
  "description":    "Every morning at 7am Hermes DMs me a 3-bullet briefing.",
  "image_url":      "https://example.com/screenshot.png",
  "video_url":      "https://example.com/demo.mp4",
  "twitter_handle": "yourhandle"
}
```

Only `title` and `description` are required.

### `GET /api/submissions?sort=new|top`
List approved submissions (max 200).

### `POST /api/submissions/:id/like`
Increment (or decrement with `{"unlike": true}`) the like counter.

### `POST /api/admin/submissions/:id/approve` *(admin)*
Body: `{"approved": true|false}`. Header: `x-admin-token: ...`

### `DELETE /api/admin/submissions/:id` *(admin)*
Header: `x-admin-token: ...`

## Deploying

It's just a Node server + a SQLite file. Any VPS, Fly.io, Render, Railway, etc. The only requirement is that wherever `DATA_DIR` points must be on a persistent volume — otherwise every redeploy wipes the feed.

### Railway

1. **New Project → Deploy from GitHub repo** → pick this repo and the `claude/hermes-discovery-portal-Zg0xi` branch.
2. Railway auto-detects Node via Nixpacks and runs `npm install && node server.js` (see `railway.json`).
3. In the service → **Settings → Volumes**, create a volume mounted at `/data`.
4. In **Variables**, set:
   - `DATA_DIR=/data`
   - `ADMIN_TOKEN=<some long random string>` (optional, only needed if you want moderation endpoints)
5. Under **Settings → Networking**, click **Generate Domain** for a `*.up.railway.app` URL, then add your custom domain (`discoverhermes.com`) and point your DNS `CNAME` at the target Railway gives you.

That's the whole deploy. `PORT` is injected by Railway automatically; the server already reads it.
