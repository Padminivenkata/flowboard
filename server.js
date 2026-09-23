import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ROLES = ['viewer', 'editor', 'admin'];
const RANK = { viewer: 0, editor: 1, admin: 2 };

function resolveSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    const dir = path.join(__dirname, 'data');
    const file = path.join(dir, '.jwt-secret');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    fs.mkdirSync(dir, { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, s);
    return s;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}
const SECRET = resolveSecret();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

const bump = () => io.emit('board:changed');
const str = (v, max = 5000) => String(v ?? '').slice(0, max);
const numArr = (v) => Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
const safeJson = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

function normTask(r) {
  return {
    id: Number(r.id),
    column_id: Number(r.column_id),
    title: r.title,
    assignee: r.assignee || '',
    department: r.department || '',
    priority: r.priority || 'Medium',
    due: r.due || '',
    hours: r.hours || '',
    outcome: r.outcome || '',
    acceptance: r.acceptance || '',
    tags: safeJson(r.tags, []),
    customValues: safeJson(r.custom_values, {}),
    position: Number(r.position),
  };
}

async function loadUser(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SECRET);
    const r = await db.execute({ sql: 'SELECT id, username, role FROM users WHERE id = ?', args: [payload.id] });
    if (!r.rows[0]) return null;
    return { id: Number(r.rows[0].id), username: r.rows[0].username, role: r.rows[0].role };
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  loadUser(req.cookies?.token)
    .then((u) => {
      if (!u) return res.status(401).json({ error: 'Please log in' });
      req.user = u;
      next();
    })
    .catch(next);
}

function need(min) {
  return (req, res, next) => {
    if ((RANK[req.user.role] ?? -1) < RANK[min]) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}

function setToken(req, res, userId) {
  const token = jwt.sign({ id: userId }, SECRET, { expiresIn: '30d' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

async function getSettings() {
  const r = await db.execute('SELECT * FROM settings WHERE id = 1');
  const s = r.rows[0];
  if (!s) return null;
  return {
    workspace_name: s.workspace_name,
    board_name: s.board_name,
    sprint_name: s.sprint_name,
    sprint_start: s.sprint_start || '',
    sprint_end: s.sprint_end || '',
    sprint_active: Number(s.sprint_active) === 1,
    departments: safeJson(s.departments, []),
    priorities: safeJson(s.priorities, []),
  };
}

async function renumber(columnId) {
  const r = await db.execute({
    sql: 'SELECT id FROM tasks WHERE column_id = ? ORDER BY position, id',
    args: [columnId],
  });
  let i = 0;
  for (const row of r.rows) {
    await db.execute({ sql: 'UPDATE tasks SET position = ? WHERE id = ?', args: [i, Number(row.id)] });
    i++;
  }
}

// ---------- auth ----------
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = str(req.body?.username, 24).trim();
    const password = String(req.body?.password ?? '');
    if (name.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const exists = await db.execute({ sql: 'SELECT 1 FROM users WHERE username = ? COLLATE NOCASE', args: [name] });
    if (exists.rows.length) return res.status(400).json({ error: 'That username is already taken' });
    const count = await db.execute('SELECT COUNT(*) c FROM users');
    const role = Number(count.rows[0].c) === 0 ? 'admin' : 'editor';
    const hash = await bcrypt.hash(password, 10);
    const r = await db.execute({
      sql: 'INSERT INTO users (username, password_hash, role) VALUES (?,?,?)',
      args: [name, hash, role],
    });
    const user = { id: Number(r.lastInsertRowid), username: name, role };
    setToken(req, res, user.id);
    res.status(201).json({ user });
  } catch (e) { next(e); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const name = str(req.body?.username, 24).trim();
    const password = String(req.body?.password ?? '');
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE username = ? COLLATE NOCASE', args: [name] });
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
      return res.status(400).json({ error: 'Wrong username or password' });
    }
    const user = { id: Number(u.id), username: u.username, role: u.role };
    setToken(req, res, user.id);
    res.json({ user });
  } catch (e) { next(e); }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ---------- board ----------
app.get('/api/board', auth, async (req, res, next) => {
  try {
    const [s, c, t, g, f, m] = await Promise.all([
      getSettings(),
      db.execute('SELECT * FROM board_columns ORDER BY position, id'),
      db.execute('SELECT * FROM tasks ORDER BY position, id'),
      db.execute('SELECT * FROM tags ORDER BY name COLLATE NOCASE'),
      db.execute('SELECT * FROM custom_fields ORDER BY position, id'),
      db.execute('SELECT id, username, role FROM users ORDER BY username COLLATE NOCASE'),
    ]);
    res.json({
      me: req.user,
      settings: s || {
        workspace_name: 'APPX Delivery', board_name: 'Task Board', sprint_name: '',
        sprint_start: '', sprint_end: '', sprint_active: false, departments: [], priorities: [],
      },
      columns: c.rows.map((r) => ({ id: Number(r.id), name: r.name, color: r.color, position: Number(r.position) })),
      tasks: t.rows.map(normTask),
      tags: g.rows.map((r) => ({ id: Number(r.id), name: r.name, color: r.color })),
      customFields: f.rows.map((r) => ({
        id: Number(r.id), name: r.name, type: r.type,
        options: safeJson(r.options, []), position: Number(r.position),
      })),
      members: m.rows.map((r) => ({ id: Number(r.id), username: r.username, role: r.role })),
    });
  } catch (e) { next(e); }
});

// ---------- tasks ----------
app.post('/api/tasks', auth, need('editor'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const title = str(b.title, 300).trim();
    if (!title) return res.status(400).json({ error: 'Task name is required' });
    let colId = b.column_id != null ? Number(b.column_id) : null;
    if (!colId) {
      const first = await db.execute('SELECT id FROM board_columns ORDER BY position, id LIMIT 1');
      colId = first.rows[0] ? Number(first.rows[0].id) : null;
      if (!colId) return res.status(400).json({ error: 'Create a column first' });
    } else {
      const chk = await db.execute({ sql: 'SELECT 1 FROM board_columns WHERE id = ?', args: [colId] });
      if (!chk.rows.length) return res.status(404).json({ error: 'Column not found' });
    }
    const mx = await db.execute({ sql: 'SELECT COALESCE(MAX(position), -1) m FROM tasks WHERE column_id = ?', args: [colId] });
    const r = await db.execute({
      sql: `INSERT INTO tasks (column_id, title, assignee, department, priority, due, hours, outcome, acceptance, tags, custom_values, position)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        colId, title, str(b.assignee, 60), str(b.department, 60), str(b.priority, 20) || 'Medium',
        str(b.due, 20), str(b.hours, 10), str(b.outcome, 3000), str(b.acceptance, 3000),
        JSON.stringify(numArr(b.tags)), JSON.stringify(obj(b.customValues)), Number(mx.rows[0].m) + 1,
      ],
    });
    const row = await db.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [Number(r.lastInsertRowid)] });
    bump();
    res.status(201).json(normTask(row.rows[0]));
  } catch (e) { next(e); }
});

app.patch('/api/tasks/:id', auth, need('editor'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await db.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [id] });
    if (!cur.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = cur.rows[0];
    const b = req.body || {};

    const sets = [];
    const args = [];
    const put = (col, val) => { sets.push(`${col} = ?`); args.push(val); };
    if (b.title !== undefined) {
      const t = str(b.title, 300).trim();
      if (!t) return res.status(400).json({ error: 'Task name is required' });
      put('title', t);
    }
    if (b.assignee !== undefined) put('assignee', str(b.assignee, 60));
    if (b.department !== undefined) put('department', str(b.department, 60));
    if (b.priority !== undefined) put('priority', str(b.priority, 20));
    if (b.due !== undefined) put('due', str(b.due, 20));
    if (b.hours !== undefined) put('hours', str(b.hours, 10));
    if (b.outcome !== undefined) put('outcome', str(b.outcome, 3000));
    if (b.acceptance !== undefined) put('acceptance', str(b.acceptance, 3000));
    if (b.tags !== undefined) put('tags', JSON.stringify(numArr(b.tags)));
    if (b.customValues !== undefined) put('custom_values', JSON.stringify(obj(b.customValues)));

    if (sets.length) {
      await db.execute({ sql: `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
    }

    if (b.column_id !== undefined || b.beforeTaskId !== undefined) {
      let targetCol = b.column_id != null ? Number(b.column_id) : Number(task.column_id);
      let beforeId = b.beforeTaskId != null ? Number(b.beforeTaskId) : null;
      if (beforeId != null) {
        const br = await db.execute({ sql: 'SELECT column_id FROM tasks WHERE id = ?', args: [beforeId] });
        if (br.rows[0]) targetCol = Number(br.rows[0].column_id);
      }
      const colChk = await db.execute({ sql: 'SELECT 1 FROM board_columns WHERE id = ?', args: [targetCol] });
      if (!colChk.rows.length) return res.status(404).json({ error: 'Column not found' });

      const rows = await db.execute({
        sql: 'SELECT id FROM tasks WHERE column_id = ? AND id != ? ORDER BY position, id',
        args: [targetCol, id],
      });
      const ids = rows.rows.map((r) => Number(r.id));
      let idx = ids.length;
      if (beforeId != null) {
        const i = ids.indexOf(beforeId);
        if (i >= 0) idx = i;
      }
      ids.splice(idx, 0, id);
      await db.execute({ sql: "UPDATE tasks SET column_id = ?, updated_at = datetime('now') WHERE id = ?", args: [targetCol, id] });
      let i = 0;
      for (const tid of ids) {
        await db.execute({ sql: 'UPDATE tasks SET position = ? WHERE id = ?', args: [i, tid] });
        i++;
      }
    } else if (sets.length) {
      await db.execute({ sql: "UPDATE tasks SET updated_at = datetime('now') WHERE id = ?", args: [id] });
    }

    const after = await db.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [id] });
    bump();
    res.json(normTask(after.rows[0]));
  } catch (e) { next(e); }
});

app.delete('/api/tasks/:id', auth, need('editor'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await db.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [id] });
    if (!r.rowsAffected) return res.status(404).json({ error: 'Task not found' });
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- columns ----------
app.post('/api/board-columns', auth, need('editor'), async (req, res, next) => {
  try {
    const name = str(req.body?.name, 40).trim();
    if (!name) return res.status(400).json({ error: 'Column name is required' });
    const color = str(req.body?.color, 20) || '#9ba0ae';
    const mx = await db.execute('SELECT COALESCE(MAX(position), -1) m FROM board_columns');
    const r = await db.execute({
      sql: 'INSERT INTO board_columns (name, color, position) VALUES (?,?,?)',
      args: [name, color, Number(mx.rows[0].m) + 1],
    });
    bump();
    res.status(201).json({ id: Number(r.lastInsertRowid), name, color });
  } catch (e) { next(e); }
});

app.patch('/api/board-columns/:id', auth, need('editor'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const chk = await db.execute({ sql: 'SELECT 1 FROM board_columns WHERE id = ?', args: [id] });
    if (!chk.rows.length) return res.status(404).json({ error: 'Column not found' });
    const sets = [];
    const args = [];
    if (req.body?.name !== undefined) {
      const name = str(req.body.name, 40).trim();
      if (!name) return res.status(400).json({ error: 'Column name is required' });
      sets.push('name = ?');
      args.push(name);
    }
    if (req.body?.color !== undefined) {
      sets.push('color = ?');
      args.push(str(req.body.color, 20) || '#9ba0ae');
    }
    if (sets.length) {
      await db.execute({ sql: `UPDATE board_columns SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
    }
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/board-columns/reorder', auth, need('editor'), async (req, res, next) => {
  try {
    const ids = numArr(req.body?.ids);
    let i = 0;
    for (const id of ids) {
      await db.execute({ sql: 'UPDATE board_columns SET position = ? WHERE id = ?', args: [i, id] });
      i++;
    }
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/board-columns/:id', auth, need('editor'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const chk = await db.execute({ sql: 'SELECT 1 FROM board_columns WHERE id = ?', args: [id] });
    if (!chk.rows.length) return res.status(404).json({ error: 'Column not found' });
    const cnt = await db.execute({ sql: 'SELECT COUNT(*) c FROM tasks WHERE column_id = ?', args: [id] });
    const total = await db.execute('SELECT COUNT(*) c FROM board_columns');
    if (Number(cnt.rows[0].c) > 0) {
      const to = req.body?.reassignTo != null ? Number(req.body.reassignTo) : null;
      if (!to) return res.status(400).json({ error: 'Move its tasks to another column first', needsReassign: true });
      if (to === id) return res.status(400).json({ error: 'Pick a different column' });
      const tchk = await db.execute({ sql: 'SELECT 1 FROM board_columns WHERE id = ?', args: [to] });
      if (!tchk.rows.length) return res.status(400).json({ error: 'Target column not found' });
      await db.execute({ sql: 'UPDATE tasks SET column_id = ? WHERE column_id = ?', args: [to, id] });
      await renumber(to);
    } else if (Number(total.rows[0].c) <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last column' });
    }
    await db.execute({ sql: 'DELETE FROM board_columns WHERE id = ?', args: [id] });
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- tags ----------
app.post('/api/tags', auth, need('editor'), async (req, res, next) => {
  try {
    const name = str(req.body?.name, 30).trim();
    if (!name) return res.status(400).json({ error: 'Tag name is required' });
    const color = str(req.body?.color, 20) || '#5f6471';
    const r = await db.execute({ sql: 'INSERT INTO tags (name, color) VALUES (?,?)', args: [name, color] });
    bump();
    res.status(201).json({ id: Number(r.lastInsertRowid), name, color });
  } catch (e) { next(e); }
});

app.patch('/api/tags/:id', auth, need('editor'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const sets = [];
    const args = [];
    if (req.body?.name !== undefined) {
      const name = str(req.body.name, 30).trim();
      if (!name) return res.status(400).json({ error: 'Tag name is required' });
      sets.push('name = ?');
      args.push(name);
    }
    if (req.body?.color !== undefined) {
      sets.push('color = ?');
      args.push(str(req.body.color, 20) || '#5f6471');
    }
    if (!sets.length) return res.json({ ok: true });
    const r = await db.execute({ sql: `UPDATE tags SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
    if (!r.rowsAffected) return res.status(404).json({ error: 'Tag not found' });
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/tags/:id', auth, need('editor'), async (req, res, next) => {
  try {
    const r = await db.execute({ sql: 'DELETE FROM tags WHERE id = ?', args: [Number(req.params.id)] });
    if (!r.rowsAffected) return res.status(404).json({ error: 'Tag not found' });
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- custom fields ----------
app.post('/api/custom-fields', auth, need('editor'), async (req, res, next) => {
  try {
    const name = str(req.body?.name, 40).trim();
    const type = ['text', 'number', 'date', 'select'].includes(req.body?.type) ? req.body.type : 'text';
    if (!name) return res.status(400).json({ error: 'Field name is required' });
    let options = [];
    if (type === 'select') {
      options = (Array.isArray(req.body?.options) ? req.body.options : [])
        .map((o) => str(o, 40).trim()).filter(Boolean).slice(0, 30);
      if (!options.length) return res.status(400).json({ error: 'Select fields need at least one option' });
    }
    const mx = await db.execute('SELECT COALESCE(MAX(position), -1) m FROM custom_fields');
    const r = await db.execute({
      sql: 'INSERT INTO custom_fields (name, type, options, position) VALUES (?,?,?,?)',
      args: [name, type, JSON.stringify(options), Number(mx.rows[0].m) + 1],
    });
    bump();
    res.status(201).json({ id: Number(r.lastInsertRowid), name, type, options });
  } catch (e) { next(e); }
});

app.delete('/api/custom-fields/:id', auth, need('editor'), async (req, res, next) => {
  try {
    const r = await db.execute({ sql: 'DELETE FROM custom_fields WHERE id = ?', args: [Number(req.params.id)] });
    if (!r.rowsAffected) return res.status(404).json({ error: 'Field not found' });
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- settings ----------
app.patch('/api/settings', auth, need('editor'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [];
    const args = [];
    const simple = ['workspace_name', 'board_name', 'sprint_name', 'sprint_start', 'sprint_end'];
    for (const key of simple) {
      if (b[key] !== undefined) {
        sets.push(`${key} = ?`);
        args.push(str(b[key], 80));
      }
    }
    if (b.sprint_active !== undefined) {
      sets.push('sprint_active = ?');
      args.push(b.sprint_active ? 1 : 0);
    }
    for (const key of ['departments', 'priorities']) {
      if (b[key] !== undefined) {
        if (!Array.isArray(b[key])) return res.status(400).json({ error: `${key} must be a list` });
        const items = b[key].map((x) => str(x, 40).trim()).filter(Boolean).slice(0, 30);
        sets.push(`${key} = ?`);
        args.push(JSON.stringify(items));
      }
    }
    if (sets.length) {
      await db.execute({ sql: `UPDATE settings SET ${sets.join(', ')} WHERE id = 1`, args });
    }
    bump();
    res.json({ settings: await getSettings() });
  } catch (e) { next(e); }
});

// ---------- members (admin) ----------
app.patch('/api/members/:id/role', auth, need('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const role = String(req.body?.role || '');
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
    const r = await db.execute({ sql: 'UPDATE users SET role = ? WHERE id = ?', args: [role, id] });
    if (!r.rowsAffected) return res.status(404).json({ error: 'Member not found' });
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/members/:id', auth, need('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
    const r = await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
    if (!r.rowsAffected) return res.status(404).json({ error: 'Member not found' });
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- realtime ----------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

io.use((socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie).token;
  loadUser(token)
    .then((u) => {
      if (!u) return next(new Error('unauthorized'));
      socket.user = u;
      next();
    })
    .catch(() => next(new Error('unauthorized')));
});
io.on('connection', () => {});

// ---------- static & errors ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

await initDb();
server.listen(PORT, () => {
  console.log(`FlowBoard running at http://localhost:${PORT}`);
  if (!process.env.TURSO_DATABASE_URL && !process.env.DATABASE_URL) {
    console.log('Using local SQLite file (data/flowboard.db). Set TURSO_DATABASE_URL for a shared cloud database.');
  }
});
