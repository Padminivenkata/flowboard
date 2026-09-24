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

const attempts = new Map();
function throttle(key, limit = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  rec.count += 1;
  attempts.set(key, rec);
  return rec.count > limit;
}
function validPassword(p) {
  return p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
}

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

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function mondayOf(s) {
  const d = s instanceof Date ? new Date(s) : new Date(String(s) + 'T00:00:00');
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function weekDates(monday, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(dateKey(addDays(monday, i)));
  return out;
}
function holidaysInWeek(monday, holidays) {
  const days = weekDates(monday, 7).filter((d) => new Date(d + 'T00:00:00').getDay() !== 0 && new Date(d + 'T00:00:00').getDay() !== 6);
  return days.filter((d) => holidays.includes(d));
}
function workingDaysBetween(start, end, holidays) {
  const s = new Date((start || '') + 'T00:00:00');
  const e = new Date((end || '') + 'T00:00:00');
  if (isNaN(s) || isNaN(e)) return 0;
  let n = 0;
  for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const dw = d.getDay();
    if (dw === 0 || dw === 6) continue;
    if (holidays.includes(dateKey(d))) continue;
    n++;
  }
  return n;
}
function nextRecurDate(due, recur) {
  const d = new Date((due || dateKey(new Date())) + 'T00:00:00');
  if (recur === 'daily') d.setDate(d.getDate() + 1);
  else if (recur === 'weekly') d.setDate(d.getDate() + 7);
  else if (recur === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (recur === 'quarterly') d.setMonth(d.getMonth() + 3);
  else if (recur === 'half') d.setMonth(d.getMonth() + 6);
  else if (recur === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else return due;
  return dateKey(d);
}
const RECUR_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', '6mo': '6 months', yearly: 'Yearly' };

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
    recur: r.recur || '',
    recurHistory: safeJson(r.recur_history, []),
    loggedMinutes: Number(r.logged_minutes) || 0,
    spilled: Number(r.spilled) ? 1 : 0,
    sprint_id: Number(r.sprint_id) || 0,
    position: Number(r.position),
  };
}

function normSprint(r) {
  return {
    id: Number(r.id),
    name: r.name || 'Sprint',
    start: r.start_date || '',
    end: r.end_date || '',
    status: r.status || 'future',
    plannedHours: Math.round(((Number(r.planned_minutes) || 0) / 60) * 10) / 10,
    actualHours: Math.round(((Number(r.actual_minutes) || 0) / 60) * 10) / 10,
    spilled: Number(r.spilled_count) || 0,
  };
}

async function activeSprintId() {
  const r = await db.execute('SELECT active_sprint_id FROM settings WHERE id = 1');
  return Number(r.rows[0]?.active_sprint_id) || 0;
}

async function setActiveSprint(id) {
  await db.execute({ sql: 'UPDATE settings SET active_sprint_id = ? WHERE id = 1', args: [id] });
}

function defaultSprintName() {
  return db.execute('SELECT COUNT(*) c FROM sprints')
    .then((r) => `Sprint ${Number(r.rows[0].c) + 1}`);
}

function nextSprintDates(fromDate) {
  const ref = new Date((fromDate || dateKey(new Date())) + 'T00:00:00');
  const tomorrow = new Date(ref);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const mon = mondayOf(tomorrow);
  return { start: dateKey(mon), end: dateKey(addDays(mon, 4)) };
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
  const activeId = Number(s.active_sprint_id) || 0;
  let current = null;
  if (activeId) {
    const sp = await db.execute({ sql: 'SELECT * FROM sprints WHERE id = ?', args: [activeId] });
    current = sp.rows[0] || null;
  }
  const all = await db.execute('SELECT * FROM sprints ORDER BY id DESC LIMIT 200');
  return {
    workspace_name: s.workspace_name,
    board_name: s.board_name,
    sprint_name: (current && current.name) || s.sprint_name,
    sprint_start: (current && current.start_date) || s.sprint_start || '',
    sprint_end: (current && current.end_date) || s.sprint_end || '',
    sprint_active: current ? String(current.status) === 'active' : false,
    active_sprint_id: activeId,
    sprints: all.rows.map(normSprint),
    departments: safeJson(s.departments, []),
    priorities: safeJson(s.priorities, []),
    invite_code: s.invite_code || '',
    holidays: safeJson(s.holidays, []),
    work_hours_per_day: Number(s.work_hours_per_day) || 6,
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
    if (throttle('register:' + req.ip)) {
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    const name = str(req.body?.username, 24).trim();
    const password = String(req.body?.password ?? '');
    if (name.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and include a letter and a number' });
    }
    const exists = await db.execute({ sql: 'SELECT 1 FROM users WHERE username = ? COLLATE NOCASE', args: [name] });
    if (exists.rows.length) return res.status(400).json({ error: 'That username is already taken' });
    const count = await db.execute('SELECT COUNT(*) c FROM users');
    const isFirst = Number(count.rows[0].c) === 0;
    const role = isFirst ? 'admin' : 'editor';
    if (!isFirst) {
      const st = await db.execute('SELECT invite_code FROM settings WHERE id = 1');
      const code = (st.rows[0]?.invite_code || '').trim();
      const given = str(req.body?.inviteCode, 40).trim();
      if (!code) return res.status(400).json({ error: 'Registration is invite-only. Ask the admin to generate an invite code first.' });
      if (given.toLowerCase() !== code.toLowerCase()) return res.status(400).json({ error: 'Invalid invite code. Ask your admin for the current code.' });
    }
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
    if (throttle('login:' + req.ip)) {
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    const name = str(req.body?.username, 24).trim();
    const password = String(req.body?.password ?? '');
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE username = ? COLLATE NOCASE', args: [name] });
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
      return res.status(400).json({ error: 'Wrong username or password' });
    }
    if (Number(u.is_active) === 0) {
      return res.status(403).json({ error: 'This account is disabled. Contact the admin.' });
    }
    attempts.delete('login:' + req.ip);
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
const hoursInt = (h) => {
  const n = parseFloat(String(h || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const dailyCapOf = (m, wh) => {
  const d = Number(m.daily_capacity) || 0;
  if (d > 0) return d;
  const cap = Number(m.capacity) || 0;
  return cap > 0 ? cap / 5 : wh;
};

app.get('/api/board', auth, async (req, res, next) => {
  try {
    const [s, c, t, g, f, m, mv] = await Promise.all([
      getSettings(),
      db.execute('SELECT * FROM board_columns ORDER BY position, id'),
      db.execute('SELECT * FROM tasks ORDER BY position, id'),
      db.execute('SELECT * FROM tags ORDER BY name COLLATE NOCASE'),
      db.execute('SELECT * FROM custom_fields ORDER BY position, id'),
      db.execute('SELECT * FROM users ORDER BY username COLLATE NOCASE'),
      db.execute('SELECT * FROM task_moves ORDER BY at, id'),
    ]);

    const columns = c.rows.map((r) => ({
      id: Number(r.id), name: r.name, color: r.color,
      position: Number(r.position), stage: r.stage || 'normal',
    }));
    const startCol = columns.find((x) => x.stage === 'start');
    const doneCol = columns.find((x) => x.stage === 'done');

    const movesByTask = {};
    for (const r of mv.rows) {
      const tid = Number(r.task_id);
      (movesByTask[tid] ||= []).push({ col: Number(r.column_id), at: Number(r.at) });
    }

    const tasks = t.rows.map((r) => {
      const task = normTask(r);
      const moves = movesByTask[task.id] || [];
      let startedAt = null;
      let doneAt = null;
      let cycleMinutes = null;
      if (startCol) {
        const started = moves.filter((ev) => ev.col === startCol.id)[0];
        startedAt = started ? started.at : null;
      }
      if (startCol && doneCol && startedAt != null) {
        const done = moves.filter((ev) => ev.col === doneCol.id && ev.at > startedAt)[0];
        doneAt = done ? done.at : null;
        if (doneAt != null) cycleMinutes = Math.round((doneAt - startedAt) / 60);
      }
      task.startedAt = startedAt;
      task.doneAt = doneAt;
      task.cycleMinutes = cycleMinutes;
      return task;
    });

    const wh = Number((s || {}).work_hours_per_day) || 6;
    const capacity = m.rows.map((u) => ({
      id: Number(u.id), username: u.username, role: u.role,
      capacity: Math.round(dailyCapOf(u, wh) * 5 * 10) / 10,
      department: u.department || '',
      dailyCap: dailyCapOf(u, wh),
      workload: Math.round(tasks
        .filter((t) => t.assignee === u.username && (!doneCol || t.column_id !== doneCol.id))
        .reduce((s2, t) => s2 + hoursInt(t.hours), 0) * 10) / 10,
    }));

    const cycles = tasks.filter((t) => t.cycleMinutes != null).map((t) => t.cycleMinutes);
    const stats = {
      avgCycleMinutes: cycles.length ? Math.round(cycles.reduce((a, b2) => a + b2, 0) / cycles.length) : null,
      doneCount: doneCol ? tasks.filter((t) => t.column_id === doneCol.id).length : 0,
      openCount: doneCol ? tasks.filter((t) => t.column_id !== doneCol.id).length : tasks.length,
      totalHours: Math.round(tasks.reduce((s2, t) => s2 + hoursInt(t.hours), 0) * 10) / 10,
      cycleCount: cycles.length,
    };

    res.json({
      me: req.user,
      settings: s || {
        workspace_name: 'APPX Delivery', board_name: 'Task Board', sprint_name: '',
        sprint_start: '', sprint_end: '', sprint_active: false, active_sprint_id: 0,
        sprints: [], departments: [], priorities: [],
      },
      columns,
      tasks,
      tags: g.rows.map((r) => ({ id: Number(r.id), name: r.name, color: r.color })),
      customFields: f.rows.map((r) => ({
        id: Number(r.id), name: r.name, type: r.type,
        options: safeJson(r.options, []), position: Number(r.position),
      })),
      members: m.rows.map((r) => ({
        id: Number(r.id), username: r.username, role: r.role, capacity: Number(r.capacity) || 0,
        dailyCap: dailyCapOf(r, wh), department: r.department || '',
        employeeId: r.employee_id || '', title: r.title || '', manager: r.manager || '',
        isActive: Number(r.is_active) === 1,
      })),
      capacity,
      stats,
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
    const leftmost = (await db.execute('SELECT id FROM board_columns ORDER BY position, id LIMIT 1')).rows[0];
    const sprintId = (leftmost && Number(leftmost.id) === colId) ? 0 : await activeSprintId();
    const r = await db.execute({
      sql: `INSERT INTO tasks (column_id, title, assignee, department, priority, due, hours, outcome, acceptance, tags, custom_values, position, recur, logged_minutes, sprint_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        colId, title, str(b.assignee, 60), str(b.department, 60), str(b.priority, 20) || 'Medium',
        str(b.due, 20), str(b.hours, 10), str(b.outcome, 3000), str(b.acceptance, 3000),
        JSON.stringify(numArr(b.tags)), JSON.stringify(obj(b.customValues)), Number(mx.rows[0].m) + 1,
        ['daily', 'weekly', 'monthly', 'quarterly', 'half', 'yearly'].includes(b.recur) ? b.recur : '',
        Math.max(0, Math.min(600000, Math.round(Number(b.loggedMinutes) || 0))),
        sprintId,
      ],
    });
    const newId = Number(r.lastInsertRowid);
    await db.execute({ sql: "INSERT INTO task_moves (task_id, column_id, at) VALUES (?, ?, strftime('%s','now'))", args: [newId, colId] });
    const row = await db.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [newId] });
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

    if (b.recur !== undefined) {
      const rec = ['daily', 'weekly', 'monthly', 'quarterly', 'half', 'yearly'].includes(b.recur) ? b.recur : '';
      put('recur', rec);
    }
    if (b.loggedMinutes !== undefined) {
      const mins = Math.max(0, Math.min(600000, Math.round(Number(b.loggedMinutes) || 0)));
      put('logged_minutes', mins);
    }

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
      const leftmost = (await db.execute('SELECT id FROM board_columns ORDER BY position, id LIMIT 1')).rows[0];
      const leftId = leftmost ? Number(leftmost.id) : null;
      let sprintId = Number(task.sprint_id) || 0;
      if (leftId != null) {
        if (targetCol === leftId) sprintId = 0;
        else if (targetCol !== Number(task.column_id)) sprintId = await activeSprintId();
      }
      await db.execute({ sql: "UPDATE tasks SET column_id = ?, sprint_id = ?, updated_at = datetime('now') WHERE id = ?", args: [targetCol, sprintId, id] });
      await db.execute({ sql: "INSERT INTO task_moves (task_id, column_id, at) VALUES (?, ?, strftime('%s','now'))", args: [id, targetCol] });
      let i = 0;
      for (const tid of ids) {
        await db.execute({ sql: 'UPDATE tasks SET position = ? WHERE id = ?', args: [i, tid] });
        i++;
      }

      if (task.recur) {
        const dc = (await db.execute("SELECT id FROM board_columns WHERE stage='done' ORDER BY id LIMIT 1")).rows[0];
        if (dc && Number(dc.id) === targetCol) {
          const hist = safeJson(task.recur_history, []);
          hist.push({ done: dateKey(new Date()) });
          const next = nextRecurDate(task.due, task.recur);
          const bl = (await db.execute('SELECT id FROM board_columns ORDER BY position, id LIMIT 1')).rows[0];
          if (bl) {
            await db.execute({
              sql: "INSERT INTO task_moves (task_id, column_id, at) VALUES (?, ?, strftime('%s','now'))",
              args: [id, Number(bl.id)],
            });
            await db.execute({
              sql: "UPDATE tasks SET column_id = ?, due = ?, recur_history = ?, spilled = 0, sprint_id = 0, updated_at = datetime('now') WHERE id = ?",
              args: [Number(bl.id), next, JSON.stringify(hist), id],
            });
            await renumber(Number(bl.id));
          }
        }
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
async function clearColumnStage(stage, exceptId = null) {
  await db.execute({
    sql: 'UPDATE board_columns SET stage = ? WHERE stage = ? AND (? IS NULL OR id != ?)',
    args: ['normal', stage, exceptId == null ? null : exceptId, exceptId == null ? null : exceptId],
  });
}

app.post('/api/board-columns', auth, need('editor'), async (req, res, next) => {
  try {
    const name = str(req.body?.name, 40).trim();
    if (!name) return res.status(400).json({ error: 'Column name is required' });
    const color = str(req.body?.color, 20) || '#9ba0ae';
    const stage = ['start', 'done'].includes(req.body?.stage) ? req.body.stage : 'normal';
    if (stage !== 'normal') await clearColumnStage(stage);
    const mx = await db.execute('SELECT COALESCE(MAX(position), -1) m FROM board_columns');
    const r = await db.execute({
      sql: 'INSERT INTO board_columns (name, color, position, stage) VALUES (?,?,?,?)',
      args: [name, color, Number(mx.rows[0].m) + 1, stage],
    });
    bump();
    res.status(201).json({ id: Number(r.lastInsertRowid), name, color, stage });
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
    if (req.body?.stage !== undefined) {
      const stage = ['start', 'done'].includes(req.body.stage) ? req.body.stage : 'normal';
      if (stage !== 'normal') await clearColumnStage(stage, id);
      sets.push('stage = ?');
      args.push(stage);
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
      await db.execute({ sql: "INSERT INTO task_moves (task_id, column_id, at) SELECT id, ?, strftime('%s','now') FROM tasks WHERE column_id = ?", args: [to, id] });
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

// ---------- sprints ----------
async function finalizeSprintById(sprintId, mode) {
  const sprint = (await db.execute({ sql: 'SELECT * FROM sprints WHERE id = ?', args: [sprintId] })).rows[0];
  if (!sprint) return;
  const doneCol = (await db.execute("SELECT id FROM board_columns WHERE stage='done' ORDER BY id LIMIT 1")).rows[0];
  const startCol = (await db.execute("SELECT id FROM board_columns WHERE stage='start' ORDER BY id LIMIT 1")).rows[0];
  const backlog = (await db.execute('SELECT id FROM board_columns ORDER BY position, id LIMIT 1')).rows[0];
  const doneId = doneCol ? Number(doneCol.id) : -1;
  const startId = startCol ? Number(startCol.id) : -1;
  const backlogId = backlog ? Number(backlog.id) : null;
  const startSec = sprint.start_date ? Math.floor(new Date(sprint.start_date + 'T00:00:00Z').getTime() / 1000) : 0;
  const endSec = sprint.end_date ? Math.floor(new Date(sprint.end_date + 'T00:00:00Z').getTime() / 1000) : Math.floor(Date.now() / 1000);

  const rows = (await db.execute({ sql: 'SELECT * FROM tasks WHERE sprint_id = ?', args: [sprintId] })).rows;
  const moves = (await db.execute('SELECT task_id, column_id, at FROM task_moves ORDER BY task_id, at')).rows;
  const byTask = {};
  for (const m of moves) (byTask[Number(m.task_id)] ||= []).push({ col: Number(m.column_id), at: Number(m.at) });

  let planned = 0;
  let actual = 0;
  const unfinished = [];
  for (const t of rows) {
    const nt = normTask(t);
    planned += hoursInt(nt.hours) * 60;
    const mv = byTask[nt.id] || [];
    let startedAt = null;
    let doneAt = null;
    if (startId >= 0) {
      const s = mv.find((m) => m.col === startId);
      startedAt = s ? s.at : null;
    }
    if (doneId >= 0 && startedAt != null) {
      const d = mv.find((m) => m.col === doneId && m.at > startedAt);
      doneAt = d ? d.at : null;
    }
    if (doneId >= 0 && doneAt != null && doneAt >= startSec && doneAt <= endSec) {
      if (startedAt != null) actual += (doneAt - startedAt);
      actual += nt.loggedMinutes;
    }
    if (doneId >= 0 && nt.column_id !== doneId) unfinished.push(nt);
  }

  let nextId = 0;
  if (mode === 'next') {
    const cnt = await db.execute('SELECT COUNT(*) c FROM sprints');
    const ds = nextSprintDates(sprint.end_date || sprint.start_date);
    const ins = await db.execute({
      sql: 'INSERT INTO sprints (name, start_date, end_date, status) VALUES (?,?,?,?)',
      args: [`Sprint ${Number(cnt.rows[0].c) + 1}`, ds.start, ds.end, 'future'],
    });
    nextId = Number(ins.lastInsertRowid);
  }

  for (const nt of unfinished) {
    if (mode === 'next') {
      await db.execute({
        sql: "UPDATE tasks SET sprint_id = ?, spilled = 1, updated_at = datetime('now') WHERE id = ?",
        args: [nextId, nt.id],
      });
    } else if (backlogId != null) {
      await db.execute({
        sql: "UPDATE tasks SET column_id = ?, sprint_id = 0, spilled = 1, updated_at = datetime('now') WHERE id = ?",
        args: [backlogId, nt.id],
      });
      await db.execute({
        sql: "INSERT INTO task_moves (task_id, column_id, at) VALUES (?, ?, strftime('%s','now'))",
        args: [nt.id, backlogId],
      });
    }
  }
  if (mode !== 'next' && backlogId != null) await renumber(backlogId);

  await db.execute({
    sql: "UPDATE sprints SET status = 'complete', planned_minutes = ?, actual_minutes = ?, spilled_count = ? WHERE id = ?",
    args: [planned, Math.round(actual), unfinished.length, sprintId],
  });
  await setActiveSprint(nextId);

  await db.execute({
    sql: 'INSERT INTO sprint_history (name, start_date, end_date, planned_minutes, actual_minutes, spilled_count) VALUES (?,?,?,?,?,?)',
    args: [sprint.name || 'Sprint', sprint.start_date || '', sprint.end_date || '', planned, Math.round(actual), unfinished.length],
  });
}

app.get('/api/sprints', auth, async (req, res, next) => {
  try {
    const r = await db.execute('SELECT * FROM sprints ORDER BY id');
    res.json(r.rows.map(normSprint));
  } catch (e) { next(e); }
});

app.post('/api/sprints', auth, need('editor'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = str(b.name, 60).trim();
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(b.start_date || '')) ? String(b.start_date) : '';
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(b.end_date || '')) ? String(b.end_date) : '';
    const cnt = await db.execute('SELECT COUNT(*) c FROM sprints');
    const finalName = name || `Sprint ${Number(cnt.rows[0].c) + 1}`;
    const r = await db.execute({
      sql: 'INSERT INTO sprints (name, start_date, end_date, status) VALUES (?,?,?,?)',
      args: [finalName, start, end, 'future'],
    });
    await setActiveSprint(Number(r.lastInsertRowid));
    bump();
    res.status(201).json({ settings: await getSettings() });
  } catch (e) { next(e); }
});

app.patch('/api/sprints/:id', auth, need('editor'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const cur = (await db.execute({ sql: 'SELECT * FROM sprints WHERE id = ?', args: [id] })).rows[0];
    if (!cur) return res.status(404).json({ error: 'Sprint not found' });
    const sets = [];
    const args = [];
    const at = (col, val) => { sets.push(`${col} = ?`); args.push(val); };
    if (b.name !== undefined) {
      const n = str(b.name, 60).trim();
      if (!n) return res.status(400).json({ error: 'Sprint name is required' });
      at('name', n);
    }
    if (b.start_date !== undefined) at('start_date', /^\d{4}-\d{2}-\d{2}$/.test(String(b.start_date)) ? String(b.start_date) : '');
    if (b.end_date !== undefined) at('end_date', /^\d{4}-\d{2}-\d{2}$/.test(String(b.end_date)) ? String(b.end_date) : '');
    if (b.status !== undefined) {
      const status = ['future', 'active'].includes(b.status) ? b.status : null;
      if (status && status !== String(cur.status)) {
        if (status === 'active') {
          await db.execute("UPDATE sprints SET status = 'future' WHERE status = 'active'");
          sets.push("status = 'active'");
        } else if (String(cur.status) === 'active') {
          return res.status(400).json({ error: 'End the current sprint before changing its status' });
        } else {
          at('status', status);
        }
      }
    }
    if (b.status === 'active' || b.select) await setActiveSprint(id);
    if (sets.length) {
      await db.execute({ sql: `UPDATE sprints SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
    }
    bump();
    res.json({ settings: await getSettings() });
  } catch (e) { next(e); }
});

app.post('/api/sprints/:id/end', auth, need('editor'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = (await db.execute({ sql: 'SELECT * FROM sprints WHERE id = ?', args: [id] })).rows[0];
    if (!cur) return res.status(404).json({ error: 'Sprint not found' });
    if (String(cur.status) === 'complete') return res.status(400).json({ error: 'Sprint already ended' });
    if (String(cur.status) !== 'active') return res.status(400).json({ error: 'Start the sprint before ending it' });
    const mode = req.body?.unfinished === 'next' ? 'next' : 'backlog';
    await finalizeSprintById(id, mode);
    bump();
    res.json({ settings: await getSettings() });
  } catch (e) { next(e); }
});

app.delete('/api/sprints/:id', auth, need('editor'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = (await db.execute({ sql: 'SELECT * FROM sprints WHERE id = ?', args: [id] })).rows[0];
    if (!cur) return res.status(404).json({ error: 'Sprint not found' });
    if (String(cur.status) === 'complete') return res.status(400).json({ error: 'Ended sprints are kept for history' });
    if (String(cur.status) === 'active') return res.status(400).json({ error: 'End the sprint first' });
    await db.execute({ sql: 'UPDATE tasks SET sprint_id = 0 WHERE sprint_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM sprints WHERE id = ?', args: [id] });
    if ((await activeSprintId()) === id) await setActiveSprint(0);
    bump();
    res.json({ settings: await getSettings() });
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
    if (b.holidays !== undefined) {
      if (!Array.isArray(b.holidays)) return res.status(400).json({ error: 'holidays must be a list' });
      const h = b.holidays.map((x) => str(x, 20)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 200);
      sets.push('holidays = ?');
      args.push(JSON.stringify(h));
    }
    if (b.work_hours_per_day !== undefined) {
      const n = Math.max(1, Math.min(24, Math.round(Number(b.work_hours_per_day) || 6)));
      sets.push('work_hours_per_day = ?');
      args.push(String(n));
    }
    let finalizeAfter = 0;
    if (b.sprint_active !== undefined && b.sprint_active === false) {
      const aid = await activeSprintId();
      if (aid > 0) {
        const sp = (await db.execute({ sql: 'SELECT * FROM sprints WHERE id = ?', args: [aid] })).rows[0];
        if (sp && String(sp.status) === 'active') finalizeAfter = aid;
      }
    }
    if (sets.length) {
      await db.execute({ sql: `UPDATE settings SET ${sets.join(', ')} WHERE id = 1`, args });
    }
    if (finalizeAfter) await finalizeSprintById(finalizeAfter, 'backlog');
    bump();
    res.json({ settings: await getSettings() });
  } catch (e) { next(e); }
});

// ---------- members (admin) ----------
app.post('/api/settings/invite-code', auth, need('admin'), async (req, res, next) => {
  try {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await db.execute({ sql: 'UPDATE settings SET invite_code = ? WHERE id = 1', args: [code] });
    bump();
    res.json({ inviteCode: code });
  } catch (e) { next(e); }
});

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

app.patch('/api/members/:id/capacity', auth, need('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cap = Math.max(0, Math.min(1000, Math.round(Number(req.body?.capacity) || 0)));
    const r = await db.execute({ sql: 'UPDATE users SET capacity = ? WHERE id = ?', args: [cap, id] });
    if (!r.rowsAffected) return res.status(404).json({ error: 'Member not found' });
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.patch('/api/members/:id/department', auth, need('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const dep = str(req.body?.department, 60);
    const r = await db.execute({ sql: 'UPDATE users SET department = ? WHERE id = ?', args: [dep, id] });
    if (!r.rowsAffected) return res.status(404).json({ error: 'Member not found' });
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- employees (the team sheet) ----------
app.get('/api/employees', auth, async (req, res, next) => {
  try {
    const st = await getSettings();
    const wh = Number(st.work_hours_per_day) || 6;
    const [columns, users, tasks] = await Promise.all([
      db.execute('SELECT * FROM board_columns ORDER BY position, id'),
      db.execute('SELECT * FROM users ORDER BY department COLLATE NOCASE, username COLLATE NOCASE'),
      db.execute('SELECT * FROM tasks'),
    ]);
    const doneId = columns.rows.find((c) => c.stage === 'done');
    const doneColId = doneId ? Number(doneId.id) : -1;
    const thisWeek = mondayOf(dateKey(new Date()));
    const workDays = Math.max(0, 5 - holidaysInWeek(thisWeek, st.holidays || []).length);
    const rows = users.rows.map((u) => {
      const daily = dailyCapOf(u, wh);
      const weeklyCap = Math.round(daily * workDays * 10) / 10;
      const workload = Math.round(tasks.rows
        .filter((t) => t.assignee === u.username && (!doneId || Number(t.column_id) !== doneColId))
        .reduce((s, t) => s + hoursInt(t.hours), 0) * 10) / 10;
      const available = Math.round(Math.max(0, weeklyCap - workload) * 10) / 10;
      const utilization = weeklyCap > 0 ? Math.round((workload / weeklyCap) * 100) : 0;
      return {
        id: Number(u.id),
        employeeId: u.employee_id || '',
        name: u.username,
        department: u.department || '',
        title: u.title || '',
        manager: u.manager || '',
        dailyCap: Math.round(daily * 10) / 10,
        weeklyCap,
        workload,
        available,
        utilization,
        isActive: Number(u.is_active) === 1,
        over: utilization > 100,
      };
    });
    const totals = rows.reduce((acc, r) => {
      if (r.isActive) {
        acc.people++;
        acc.capacity += r.weeklyCap;
        acc.workload += r.workload;
        acc.available += r.available;
      }
      return acc;
    }, { people: 0, capacity: 0, workload: 0, available: 0 });
    totals.available = Math.round(totals.available * 10) / 10;
    totals.utilization = totals.capacity > 0 ? Math.round((totals.workload / totals.capacity) * 100) : 0;
    res.json({ rows, totals, departments: st.departments || [], workDays });
  } catch (e) { next(e); }
});

app.post('/api/employees', auth, need('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = str(b.name, 60).trim();
    if (name.length < 2) return res.status(400).json({ error: 'Employee name is required' });
    const exists = await db.execute({ sql: 'SELECT 1 FROM users WHERE username = ? COLLATE NOCASE', args: [name] });
    if (exists.rows.length) return res.status(400).json({ error: 'An account with this name already exists' });
    let password = String(b.password || '');
    let generated = false;
    if (password.length < 8) {
      password = `Emp@${Math.floor(1000 + Math.random() * 9000)}${name.length ? name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3) : ''}`;
      generated = true;
    }
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be 8+ characters with a letter and a number' });
    const hash = await bcrypt.hash(password, 10);
    const daily = Math.max(0, Math.min(24, Number(b.dailyCapacity) || 0));
    const r = await db.execute({
      sql: `INSERT INTO users (username, password_hash, role, department, capacity, employee_id, title, manager, daily_capacity, is_active)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [
        name, hash, 'editor', str(b.department, 60), 0,
        str(b.employeeId, 40), str(b.title, 60), str(b.manager, 60),
        daily, b.isActive === false ? 0 : 1,
      ],
    });
    bump();
    res.status(201).json({ id: Number(r.lastInsertRowid), password, generated });
  } catch (e) { next(e); }
});

app.patch('/api/employees/:id', auth, need('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] })).rows[0];
    if (!cur) return res.status(404).json({ error: 'Employee not found' });
    const b = req.body || {};
    const sets = [];
    const args = [];
    const put = (col, val) => { sets.push(`${col} = ?`); args.push(val); };
    if (b.employeeId !== undefined) put('employee_id', str(b.employeeId, 40));
    if (b.title !== undefined) put('title', str(b.title, 60));
    if (b.manager !== undefined) put('manager', str(b.manager, 60));
    if (b.department !== undefined) put('department', str(b.department, 60));
    if (b.daily_capacity !== undefined) put('daily_capacity', Math.max(0, Math.min(24, Number(b.daily_capacity) || 0)));
    if (b.is_active !== undefined) put('is_active', b.is_active ? 1 : 0);
    if (b.name !== undefined) {
      const nn = str(b.name, 60).trim();
      if (!nn) return res.status(400).json({ error: 'Name is required' });
      const dup = await db.execute({ sql: 'SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?', args: [nn, id] });
      if (dup.rows.length) return res.status(400).json({ error: 'Another account already uses this name' });
      const old = String(cur.username);
      if (nn !== old) {
        put('username', nn);
        await db.execute({ sql: 'UPDATE tasks SET assignee = ? WHERE assignee = ?', args: [nn, old] });
      }
    }
    if (sets.length) {
      await db.execute({ sql: `UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
    }
    bump();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- reports ----------
app.get('/api/reports', auth, async (req, res, next) => {
  try {
    const st = await getSettings();
    const members = (await db.execute('SELECT * FROM users ORDER BY username COLLATE NOCASE')).rows;
    const columns = (await db.execute('SELECT * FROM board_columns ORDER BY position, id')).rows;
    const tasks = (await db.execute('SELECT * FROM tasks')).rows.map(normTask);
    const sprints = (await db.execute('SELECT * FROM sprints ORDER BY id ASC')).rows;

    const holidays = st.holidays || [];
    const wh = st.work_hours_per_day || 6;
    const workDays = 5;
    const doneId = columns.find((c) => c.stage === 'done');
    const doneColId = doneId ? Number(doneId.id) : -1;

    const now = new Date();
    const today = dateKey(now);
    const thisMonday = mondayOf(today);
    const weeks = [];
    for (let w = -3; w <= 4; w++) {
      const mon = addDays(thisMonday, w * 7);
      const sun = addDays(mon, 6);
      weeks.push({
        key: dateKey(mon), start: dateKey(mon), end: dateKey(sun),
        holidaysInWeek: holidaysInWeek(mon, holidays),
      });
    }

    const memberCaps = new Map();
    const deptResCount = new Map();
    for (const m of members) {
      const cap = Number(m.capacity) || 0;
      const dep = (m.department || '').trim() || 'Unassigned';
      memberCaps.set(m.username, { id: Number(m.id), dept: dep, cap, daily: Number(m.daily_capacity) || 0 });
      deptResCount.set(dep, (deptResCount.get(dep) || 0) + 1);
    }

    const workloadBy = new Map();
    for (const t of tasks) {
      if (doneId && t.column_id === doneColId) continue;
      if (t.assignee) workloadBy.set(t.assignee, (workloadBy.get(t.assignee) || 0) + hoursInt(t.hours));
    }

    const weeklyCapOf = (m, key) => {
      const info = memberCaps.get(m.username);
      const h = holidaysInWeek(mondayOf(key), holidays).length;
      const days = Math.max(0, workDays - h);
      const daily = info && info.daily > 0 ? info.daily : (info && info.cap > 0 ? info.cap / workDays : wh);
      return Math.round(daily * days * 10) / 10;
    };

    const depts = new Map();
    for (const m of members) {
      const dep = (m.department || '').trim() || 'Unassigned';
      if (!depts.has(dep)) depts.set(dep, { name: dep, resCount: 0, weeklyCap: 0, workload: 0 });
      const d = depts.get(dep);
      d.resCount++;
      d.weeklyCap += weeklyCapOf(m, thisMonday);
      d.workload += workloadBy.get(m.username) || 0;
    }

    const deptTable = [...depts.values()].map((d) => {
      const avail = Math.max(0, d.weeklyCap - d.workload);
      const util = d.weeklyCap > 0 ? Math.round((d.workload / d.weeklyCap) * 100) : 0;
      const mult = d.weeklyCap > 0 ? d.weeklyCap / workDays : 0;
      return {
        ...d,
        dailyCap: Math.round(mult * 10) / 10,
        monthlyCap: Math.round(d.weeklyCap * 4.33 * 10) / 10,
        quarterlyCap: Math.round(d.weeklyCap * 13 * 10) / 10,
        halfCap: Math.round(d.weeklyCap * 26 * 10) / 10,
        yearlyCap: Math.round(d.weeklyCap * 52 * 10) / 10,
        available: Math.round(avail * 10) / 10,
        utilization: util,
        over: util > 100,
      };
    });

    const memberTable = members.map((m) => {
      const cap = weeklyCapOf(m, thisMonday);
      const wl = workloadBy.get(m.username) || 0;
      const avail = Math.max(0, cap - wl);
      const util = cap > 0 ? Math.round((wl / cap) * 100) : 0;
      return {
        id: Number(m.id), username: m.username, role: m.role,
        dept: (m.department || '').trim() || 'Unassigned',
        capacity: cap, workload: Math.round(wl * 10) / 10,
        available: Math.round(avail * 10) / 10, utilization: util,
        over: util > 100, override: (Number(m.capacity) || 0) > 0,
      };
    });

    const weekMatrix = weeks.map((w) => {
      let weeklyCap = 0;
      for (const m of members) weeklyCap += weeklyCapOf(m, w.key);
      weeklyCap = Math.round(weeklyCap * 10) / 10;
      const dueTasks = tasks.filter((t) => t.due && t.due >= w.start && t.due <= w.end);
      const workload = Math.round(dueTasks.reduce((s, t) => s + hoursInt(t.hours), 0) * 10) / 10;
      const colHours = {};
      for (const t of dueTasks) {
        const nm = columns.find((c) => Number(c.id) === t.column_id);
        const nm2 = nm ? nm.name : 'Other';
        colHours[nm2] = Math.round(((colHours[nm2] || 0) + hoursInt(t.hours)) * 10) / 10;
      }
      const available = Math.max(0, Math.round((weeklyCap - workload) * 10) / 10);
      const utilization = weeklyCap > 0 ? Math.round((workload / weeklyCap) * 100) : 0;
      return { ...w, weeklyCap, workload, available, utilization, colHours };
    });

    const recurringTasks = tasks
      .filter((t) => t.recur && !(doneId && t.column_id === doneColId))
      .map((t) => ({
        id: t.id, title: t.title, assignee: t.assignee, recur: t.recur,
        recurLabel: RECUR_LABELS[t.recur] || t.recur,
        due: t.due, nextDue: nextRecurDate(t.due || today, t.recur),
        completions: t.recurHistory.length,
      }));

    const sprintRows = sprints.map((s) => {
      const sid = Number(s.id);
      const inSprint = tasks.filter((t) => t.sprint_id === sid);
      const total = inSprint.length;
      const done = doneId ? inSprint.filter((t) => t.column_id === doneColId).length : 0;
      const usedHours = inSprint.reduce((acc, t) => acc + hoursInt(t.hours), 0);
      const wd = workingDaysBetween(s.start_date, s.end_date, holidays);
      const dailyRateOf = (m) => {
        return dailyCapOf(m, wh);
      };
      const capByName = new Map();
      let capacityHours = 0;
      for (const m of members) {
        const c = Math.round(dailyRateOf(m) * wd * 10) / 10;
        capByName.set(m.username, c);
        capacityHours += c;
      }
      capacityHours = Math.round(capacityHours * 10) / 10;
      const usedByName = new Map();
      const doneByName = new Map();
      const totalByName = new Map();
      for (const t of inSprint) {
        if (!t.assignee) continue;
        usedByName.set(t.assignee, (usedByName.get(t.assignee) || 0) + hoursInt(t.hours));
        totalByName.set(t.assignee, (totalByName.get(t.assignee) || 0) + 1);
        if (doneId && t.column_id === doneColId) doneByName.set(t.assignee, (doneByName.get(t.assignee) || 0) + 1);
      }
      const byAssignee = [...totalByName.entries()].map(([username, t]) => {
        const cap = capByName.get(username) || 0;
        const used = Math.round((usedByName.get(username) || 0) * 10) / 10;
        return {
          username, total: t,
          done: doneByName.get(username) || 0,
          hours: used,
          cap,
          utilization: cap > 0 ? Math.round((used / cap) * 100) : null,
        };
      }).sort((a, b) => b.hours - a.hours);
      const taskBrief = (t) => {
        const c = columns.find((x) => Number(x.id) === t.column_id);
        return { title: t.title, assignee: t.assignee, hours: Math.round(hoursInt(t.hours) * 10) / 10, column: c ? c.name : '' };
      };
      return {
        id: sid, name: s.name, status: s.status,
        start: s.start_date || '', end: s.end_date || '',
        plannedHours: Math.round((Number(s.planned_minutes) / 60) * 10) / 10,
        actualHours: Math.round((Number(s.actual_minutes) / 60) * 10) / 10,
        velocity: Number(s.planned_minutes) > 0
          ? Math.round((Number(s.actual_minutes) / Number(s.planned_minutes)) * 100) : null,
        spilled: Number(s.spilled_count),
        total, done, open: total - done,
        donePct: total > 0 ? Math.round((done / total) * 100) : null,
        usedHours: Math.round(usedHours * 10) / 10,
        capacityHours,
        utilization: capacityHours > 0 ? Math.round((usedHours / capacityHours) * 100) : null,
        byAssignee,
        doneTasks: inSprint.filter((t) => doneId && t.column_id === doneColId).map(taskBrief),
        openTasks: inSprint.filter((t) => !(doneId && t.column_id === doneColId)).map(taskBrief),
      };
    });

    res.json({
      settings: { holidays, work_hours_per_day: wh, departments: st.departments || [] },
      departments: deptTable,
      members: memberTable,
      weeks: weekMatrix,
      sprints: sprintRows,
      recurringTasks,
      columns: columns.map((c) => ({ id: Number(c.id), name: c.name, stage: c.stage })),
    });
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
