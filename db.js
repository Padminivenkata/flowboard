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
  departments TEXT NOT NULL DEFAULT '["Development","QA","Product","Operations"]',
  priorities TEXT NOT NULL DEFAULT '["High","Medium","Low"]'
);

CREATE TABLE IF NOT EXISTS board_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#9ba0ae',
  position INTEGER NOT NULL DEFAULT 0
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
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks (column_id, position);
`;

const SEED_COLUMNS = [
  [1, 'Backlog', '#9ba0ae', 0],
  [2, 'To Do', '#8b7cff', 1],
  [3, 'In Progress', '#f0a848', 2],
  [4, 'Done', '#3fb27f', 3],
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

  const settings = await db.execute('SELECT id FROM settings WHERE id = 1');
  if (!settings.rows.length) {
    await db.execute(`INSERT INTO settings (id) VALUES (1) ON CONFLICT(id) DO NOTHING`);
  }

  const cols = await db.execute('SELECT COUNT(*) c FROM board_columns');
  if (Number(cols.rows[0].c) === 0) {
    for (const [id, name, color, pos] of SEED_COLUMNS) {
      await db.execute({
        sql: 'INSERT INTO board_columns (id, name, color, position) VALUES (?,?,?,?)',
        args: [id, name, color, pos],
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
}
