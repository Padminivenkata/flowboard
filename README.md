# FlowBoard — Team Task Board

A real-time, multi-user task board (ClickUp-style) built with Node.js, Express, Socket.IO and SQLite (or Turso).

Users sign in with a username and password. The **first account becomes the admin**; everyone else joins as an editor and the admin can change roles.

## Roles

| Role | Can do |
|------|--------|
| **Viewer** | See the board, search and filter (read-only) |
| **Editor** | Add/edit/delete/move tasks, manage columns, tags and custom fields, edit board settings |
| **Admin** | Everything an editor can + manage members (set roles, remove people) |

Every change is broadcast live over WebSockets, so all open browsers update at once.

## Features

- Full task CRUD — click any card to edit or delete it
- Drag & drop between columns (drop on a card to insert before it)
- Custom columns — add, rename, colour, reorder, delete (tasks are moved to a column you pick)
- Tags — coloured labels you can define and attach to any task, filter by tag
- Custom fields — per-task fields of type Text / Number / Date / Select, shown on cards
- Board settings — workspace name, board title, sprint label + dates, departments, priorities, start/end sprint
- Members — admin assigns viewer/editor/admin roles

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Requires Node.js 18+. Data is stored in `data/flowboard.db` (SQLite file). Register your account — the first one becomes admin.

## Share with your team on different laptops

Every user just opens the website URL in their browser and signs in. The board and all changes are kept in one shared database.

### Option A — Render (recommended, free)

1. Push this folder to a GitHub repo (you can run `git init`).
2. On [render.com](https://render.com) (free account) choose **New → Web Service** and connect the repo.
3. Settings: Build command `npm install`, Start command `node server.js`.
4. Under **Environment**, add:
   - `JWT_SECRET` — a long random string (e.g. `openssl rand -hex 32`)
5. Deploy. Render gives you a public URL like `https://your-app.onrender.com` — share it with your team.

> Render's free tier has a **temporary** disk, so the SQLite file resets on redeploys/restarts. To keep data permanently, add a free Turso cloud database below.

### Option B — Free cloud database so data never resets (recommended with Render)

1. Create a free DB at [turso.tech](https://turso.tech) and install their CLI (`npm i -g @turso/cli`).
2. `turso db create flowboard` then `turso db show flowboard --url` (gives a `libsql://...` URL) and `turso db tokens create flowboard` (gives a token).
3. On Render add two more env vars: `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
4. Redeploy once — your board now lives in the cloud and survives restarts. (Local dev keeps on using the SQLite file unless you set the same env vars locally.)

### Option C — Any always-on server

The app is a plain Node process — deploy it to Railway, Fly.io, a VPS, or a Windows box that stays on, using the same `PORT`, `JWT_SECRET` and optional `TURSO_*` environment variables.

## Project layout

```
flowboard/
├── server.js        Express + Socket.IO + REST API + auth/roles
├── db.js            SQLite/Turso schema + seed data
├── public/          Frontend (index.html, style.css, app.js)
└── data/            Local SQLite file (created on first run)
```

## API summary

- `POST /api/auth/register|login|logout`, `GET /api/me`
- `GET /api/board` — whole board state for the signed-in user
- `POST /api/tasks`, `PATCH /api/tasks/:id` (fields + `column_id` + `beforeTaskId` for ordering), `DELETE /api/tasks/:id`
- `POST|PATCH|DELETE /api/board-columns[/:id|/reorder]`
- `POST|PATCH|DELETE /api/tags`
- `POST|DELETE /api/custom-fields`
- `PATCH /api/settings`
- `PATCH /api/members/:id/role`, `DELETE /api/members/:id` (admin only)