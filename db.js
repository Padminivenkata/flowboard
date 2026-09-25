import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

const dbFileUrl = process.env.TURSO_DATABASE_URL
  || process.env.DATABASE_URL
  || (() => { fs.mkdirSync(path.resolve(process.cwd(), 'data'), { recursive: true }); return 'file:./data/flowboard.db'; })();

export const db = createClient({
  url: dbFileUrl,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  capacity INTEGER NOT NULL DEFAULT 0,
  department TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_name TEXT NOT NULL DEFAULT 'APPX Delivery',
  board_name TEXT NOT NULL DEFAULT 'Task Board',
  sprint_name TEXT NOT NULL DEFAULT 'Sep 28 - Oct 2',
  sprint_start TEXT NOT NULL DEFAULT '',
  sprint_end TEXT NOT NULL DEFAULT '',
  sprint_active INTEGER NOT NULL DEFAULT 0,
  active_sprint_id INTEGER NOT NULL DEFAULT 0,
  departments TEXT NOT NULL DEFAULT '["Development","QA","Product","Operations"]',
  priorities TEXT NOT NULL DEFAULT '["High","Medium","Low"]',
  invite_code TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'Sprint',
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'future',
  planned_minutes REAL NOT NULL DEFAULT 0,
  actual_minutes REAL NOT NULL DEFAULT 0,
  spilled_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS board_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#9ba0ae',
  position INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'normal'
);

CREATE TABLE IF NOT EXISTS task_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  column_id INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_moves_task ON task_moves (task_id, at);

CREATE TABLE IF NOT EXISTS sprint_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  planned_minutes REAL NOT NULL DEFAULT 0,
  actual_minutes REAL NOT NULL DEFAULT 0,
  spilled_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5f6471'
);

CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  options TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  column_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  assignee TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'Medium',
  due TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  custom_values TEXT NOT NULL DEFAULT '{}',
  sprint_id INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  recur TEXT NOT NULL DEFAULT '',
  recur_history TEXT NOT NULL DEFAULT '[]',
  logged_minutes INTEGER NOT NULL DEFAULT 0,
  spilled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks (column_id, position);

CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id INTEGER,
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id, created_at);

CREATE TABLE IF NOT EXISTS task_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id INTEGER,
  uploader TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments (task_id, created_at);
`;

const SEED_COLUMNS = [
  [1, 'Backlog', '#9ba0ae', 0, 'normal'],
  [2, 'To Do', '#8b7cff', 1, 'normal'],
  [3, 'Refinement', '#7ec8e3', 2, 'normal'],
  [4, 'In Progress', '#f0a848', 3, 'start'],
  [5, 'Done', '#3fb27f', 4, 'done'],
];

const SEED_TASKS = [
  [1, 1, 'Finalize release readiness matrix', 'Padmini', 'Operations', 'High', '2026-09-25', '4h',
    'All readiness items have an owner and evidence.', 'Configuration, testing and approvals are traceable.', 0],
  [2, 2, 'Validate authentication test scenarios', 'Vishnu', 'Development', 'High', '2026-09-24', '3h',
    'Authentication flows are validated.', 'Login, refresh and token scenarios pass.', 1],
  [3, 3, 'Prepare 100-user performance test data', 'Naresh', 'QA', 'High', '2026-09-25', '6h',
    'Stable test data is ready for performance testing.', 'Data supports 100 concurrent users.', 2],
  [4, 4, 'Review sprint capacity and planned work', 'Padmini', 'Operations', 'Medium', '2026-09-23', '2h',
    'Capacity baseline is visible.', 'Planned and ad-hoc work are separated.', 3],
  [5, 1, 'Document deployment rollback checklist', 'Srini', 'Product', 'Medium', '2026-09-26', '2h',
    'Rollback steps are documented.', 'Backup, rollback and post-release checks included.', 4],
];

export async function initDb() {
  await db.executeMultiple(SCHEMA);

  const pcols = await db.execute('PRAGMA table_info(settings)');
  if (!pcols.rows.some((r) => r.name === 'invite_code')) {
    await db.execute("ALTER TABLE settings ADD COLUMN invite_code TEXT NOT NULL DEFAULT ''");
  }
  if (!pcols.rows.some((r) => r.name === 'holidays')) {
    await db.execute("ALTER TABLE settings ADD COLUMN holidays TEXT NOT NULL DEFAULT '[]'");
  }
  if (!pcols.rows.some((r) => r.name === 'work_hours_per_day')) {
    await db.execute("ALTER TABLE settings ADD COLUMN work_hours_per_day TEXT NOT NULL DEFAULT '6'");
  }
  if (!pcols.rows.some((r) => r.name === 'active_sprint_id')) {
    await db.execute('ALTER TABLE settings ADD COLUMN active_sprint_id INTEGER NOT NULL DEFAULT 0');
  }

  const ucols = await db.execute('PRAGMA table_info(users)');
  if (!ucols.rows.some((r) => r.name === 'capacity')) {
    await db.execute('ALTER TABLE users ADD COLUMN capacity INTEGER NOT NULL DEFAULT 0');
  }
  if (!ucols.rows.some((r) => r.name === 'department')) {
    await db.execute("ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT ''");
  }
  const eucols = await db.execute('PRAGMA table_info(users)');
  const addU = async (col, def) => {
    if (!eucols.rows.some((r) => r.name === col)) await db.execute(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
  };
  await addU('employee_id', "TEXT NOT NULL DEFAULT ''");
  await addU('title', "TEXT NOT NULL DEFAULT ''");
  await addU('manager', "TEXT NOT NULL DEFAULT ''");
  await addU('daily_capacity', 'REAL NOT NULL DEFAULT 0');
  await addU('is_active', 'INTEGER NOT NULL DEFAULT 1');
  const ccols = await db.execute('PRAGMA table_info(board_columns)');
  if (!ccols.rows.some((r) => r.name === 'stage')) {
    await db.execute("ALTER TABLE board_columns ADD COLUMN stage TEXT NOT NULL DEFAULT 'normal'");
    const inprog = await db.execute("SELECT id FROM board_columns WHERE lower(name) = 'in progress' LIMIT 1");
    if (inprog.rows[0]) await db.execute({ sql: "UPDATE board_columns SET stage = 'start' WHERE id = ?", args: [Number(inprog.rows[0].id)] });
    const done = await db.execute("SELECT id FROM board_columns WHERE lower(name) = 'done' LIMIT 1");
    if (done.rows[0]) await db.execute({ sql: "UPDATE board_columns SET stage = 'done' WHERE id = ?", args: [Number(done.rows[0].id)] });
  }
  const refchk = await db.execute("SELECT COUNT(*) c FROM board_columns WHERE lower(name) = 'refinement'");
  if (Number(refchk.rows[0].c) === 0) {
    const td = await db.execute("SELECT position FROM board_columns WHERE lower(name) = 'to do' LIMIT 1");
    const ip = await db.execute("SELECT position FROM board_columns WHERE lower(name) = 'in progress' LIMIT 1");
    if (td.rows[0] && ip.rows[0]) {
      const tp = Number(td.rows[0].position);
      const pp = Number(ip.rows[0].position);
      await db.execute({ sql: 'UPDATE board_columns SET position = position + 1 WHERE position >= ?', args: [pp] });
      await db.execute({
        sql: 'INSERT INTO board_columns (name, color, position, stage) VALUES (?,?,?,?)',
        args: ['Refinement', '#7ec8e3', Math.max(tp + 1, pp), 'normal'],
      });
    }
  }

  const tcols = await db.execute('PRAGMA table_info(tasks)');
  if (!tcols.rows.some((r) => r.name === 'recur')) {
    await db.execute("ALTER TABLE tasks ADD COLUMN recur TEXT NOT NULL DEFAULT ''");
  }
  if (!tcols.rows.some((r) => r.name === 'recur_history')) {
    await db.execute("ALTER TABLE tasks ADD COLUMN recur_history TEXT NOT NULL DEFAULT '[]'");
  }
  if (!tcols.rows.some((r) => r.name === 'logged_minutes')) {
    await db.execute('ALTER TABLE tasks ADD COLUMN logged_minutes INTEGER NOT NULL DEFAULT 0');
  }
  if (!tcols.rows.some((r) => r.name === 'spilled')) {
    await db.execute('ALTER TABLE tasks ADD COLUMN spilled INTEGER NOT NULL DEFAULT 0');
  }
  if (!tcols.rows.some((r) => r.name === 'sprint_id')) {
    await db.execute('ALTER TABLE tasks ADD COLUMN sprint_id INTEGER NOT NULL DEFAULT 0');
  }

  const settings = await db.execute('SELECT id FROM settings WHERE id = 1');
  if (!settings.rows.length) {
    await db.execute(`INSERT INTO settings (id) VALUES (1) ON CONFLICT(id) DO NOTHING`);
  }
  const settingsRow = (await db.execute('SELECT * FROM settings WHERE id = 1')).rows[0];

  const scount = await db.execute('SELECT COUNT(*) c FROM sprints');
  if (Number(scount.rows[0].c) === 0 && settingsRow) {
    const legacyActive = Number(settingsRow.sprint_active) === 1;
    await db.execute({
      sql: 'INSERT INTO sprints (id, name, start_date, end_date, status) VALUES (1,?,?,?,?)',
      args: [
        settingsRow.sprint_name || 'Sprint 1',
        settingsRow.sprint_start || '',
        settingsRow.sprint_end || '',
        legacyActive ? 'active' : 'future',
      ],
    });
    await db.execute({ sql: 'UPDATE settings SET active_sprint_id = 1 WHERE id = 1', args: [] });
  }

  const cols = await db.execute('SELECT COUNT(*) c FROM board_columns');
  if (Number(cols.rows[0].c) === 0) {
    for (const [id, name, color, pos, stage] of SEED_COLUMNS) {
      await db.execute({
        sql: 'INSERT INTO board_columns (id, name, color, position, stage) VALUES (?,?,?,?,?)',
        args: [id, name, color, pos, stage],
      });
    }
    for (const [id, col, title, assignee, dept, priority, due, hours, outcome, ac, pos] of SEED_TASKS) {
      await db.execute({
        sql: `INSERT INTO tasks (id, column_id, title, assignee, department, priority, due, hours, outcome, acceptance, tags, custom_values, position)
              VALUES (?,?,?,?,?,?,?,?,?,?,'[]','{}',?)`,
        args: [id, col, title, assignee, dept, priority, due, hours, outcome, ac, pos],
      });
    }
  }

  const setb = await db.execute('PRAGMA table_info(settings)');
  const hadCycleStart = setb.rows.some((r) => r.name === 'cycle_start_col');
  if (!hadCycleStart) {
    await db.execute('ALTER TABLE settings ADD COLUMN cycle_start_col INTEGER NOT NULL DEFAULT 0');
    const inProg = (await db.execute("SELECT id FROM board_columns WHERE lower(name) = 'in progress' ORDER BY position, id LIMIT 1")).rows[0];
    const startC = (await db.execute("SELECT id FROM board_columns WHERE stage = 'start' ORDER BY position, id LIMIT 1")).rows[0];
    const def = inProg || startC;
    if (def) await db.execute({ sql: 'UPDATE settings SET cycle_start_col = ? WHERE id = 1', args: [Number(def.id)] });
  }

  const current = (await db.execute('SELECT active_sprint_id FROM settings WHERE id = 1')).rows[0];
  const activeId = Number(current?.active_sprint_id) || 0;
  if (activeId > 0) {
    const leftmost = (await db.execute('SELECT id FROM board_columns ORDER BY position, id LIMIT 1')).rows[0];
    if (leftmost) {
      await db.execute({
        sql: 'UPDATE tasks SET sprint_id = ? WHERE sprint_id = 0 AND column_id != ?',
        args: [activeId, Number(leftmost.id)],
      });
    }
  }
}
