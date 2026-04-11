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

| Var            | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `PORT`         | Port to bind (default `3000`)                                 |
| `ADMIN_TOKEN`  | If set, enables `/api/admin/*` endpoints gated by this token  |

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

It's just a Node server + a SQLite file. Any VPS, Fly.io, Render, Railway, etc. Make sure the `data/` directory is on a persistent volume.
