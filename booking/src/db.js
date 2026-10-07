// Database layer. Two drivers with the same SQLite dialect:
//  - local: a SQLite file via node:sqlite (your computer, tests)
//  - remote: Turso / libSQL over HTTPS (Vercel and other serverless hosts), when TURSO_DATABASE_URL is set
// All helpers are async so both drivers look the same to the rest of the app.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS google_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  refresh_token TEXT,          -- encrypted
  access_token TEXT,           -- encrypted
  access_expires INTEGER,
  scopes TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  summary TEXT,
  is_primary INTEGER DEFAULT 0,
  access_role TEXT,
  check_conflicts INTEGER DEFAULT 1,
  UNIQUE(account_id, calendar_id)
);

CREATE TABLE IF NOT EXISTS meeting_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  durations TEXT NOT NULL DEFAULT '[30]',          -- JSON array of minutes the client can choose from
  slot_mode TEXT NOT NULL DEFAULT 'interval',      -- 'interval' (fixed start times) | 'free' (client picks any start time)
  slot_interval INTEGER NOT NULL DEFAULT 30,       -- minutes between start times (interval mode)
  free_granularity INTEGER NOT NULL DEFAULT 5,     -- start time rounding in free mode
  buffer_before INTEGER NOT NULL DEFAULT 0,
  buffer_after INTEGER NOT NULL DEFAULT 0,
  min_notice INTEGER NOT NULL DEFAULT 240,         -- minutes
  max_days_ahead INTEGER NOT NULL DEFAULT 30,
  daily_limit INTEGER NOT NULL DEFAULT 0,          -- 0 = unlimited
  schedule TEXT NOT NULL,                          -- JSON {"0":[[540,1020]], ...} weekday (0=Sun) -> [[startMin,endMin]]
  calendar_ref INTEGER REFERENCES calendars(id) ON DELETE SET NULL, -- NULL = default calendar
  location_type TEXT NOT NULL DEFAULT 'google_meet', -- legacy, replaced by "locations"
  location_value TEXT DEFAULT '',                     -- legacy
  fields TEXT NOT NULL DEFAULT '[]',               -- JSON custom questions
  require_phone INTEGER NOT NULL DEFAULT 0,
  client_reminder_channels TEXT NOT NULL DEFAULT '["email"]',
  client_reminder_options TEXT NOT NULL DEFAULT '[60,1440]',
  client_reminder_defaults TEXT NOT NULL DEFAULT '[1440]',
  owner_reminders TEXT NOT NULL DEFAULT '[30]',
  owner_reminder_channels TEXT NOT NULL DEFAULT '["email"]',
  transcriber_enabled INTEGER NOT NULL DEFAULT 0,
  transcriber_email TEXT DEFAULT '',
  color TEXT DEFAULT '#4f46e5',
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  meeting_type_id INTEGER REFERENCES meeting_types(id) ON DELETE SET NULL,
  type_name TEXT,
  start_utc INTEGER NOT NULL,
  end_utc INTEGER NOT NULL,
  client_tz TEXT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  answers TEXT DEFAULT '[]',
  reminder_channels TEXT DEFAULT '[]',
  reminder_offsets TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | cancelled
  calendar_ref INTEGER,
  google_event_id TEXT,
  meet_link TEXT,
  location TEXT,
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_start ON bookings(start_utc);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,      -- client | owner
  channel TEXT NOT NULL,        -- email | whatsapp
  offset_min INTEGER NOT NULL,
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, send_at);

CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  external_id TEXT,
  title TEXT,
  meeting_start INTEGER,
  meeting_url TEXT,
  transcript TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review', -- pending_review | summarizing | summary_ready | sent | dismissed
  error TEXT,
  received_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE(source, external_id)
);
`;

function localDriver() {
  let dbp;
  const open = async () => {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    const db = new DatabaseSync(config.dbPath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    return db;
  };
  const conn = () => (dbp ??= open());
  return {
    async all(sql, p) { return (await conn()).prepare(sql).all(...p); },
    async get(sql, p) { return (await conn()).prepare(sql).get(...p); },
    async run(sql, p) {
      const r = (await conn()).prepare(sql).run(...p);
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async exec(sql) { (await conn()).exec(sql); },
  };
}

function remoteDriver(url, token) {
  const endpoint = `${url.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '')}/v2/pipeline`;
  const encode = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    return { type: 'text', value: String(v) };
  };
  const decode = (c) => (c.type === 'null' ? null : c.type === 'integer' ? Number(c.value) : c.type === 'blob' ? Buffer.from(c.base64, 'base64') : c.value);
  async function pipeline(stmts) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        requests: [
          { type: 'execute', stmt: { sql: 'PRAGMA foreign_keys = ON' } },
          ...stmts.map(([sql, args]) => ({ type: 'execute', stmt: { sql, args: (args || []).map(encode) } })),
          { type: 'close' },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Database HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.results.slice(1, stmts.length + 1).map((r) => {
      if (r.type !== 'ok') throw new Error(`Database: ${r.error?.message || JSON.stringify(r)}`);
      return r.response.result;
    });
  }
  const rows = (result) => result.rows.map((row) => Object.fromEntries(result.cols.map((c, i) => [c.name, decode(row[i])])));
  return {
    async all(sql, p) { return rows((await pipeline([[sql, p]]))[0]); },
    async get(sql, p) { return rows((await pipeline([[sql, p]]))[0])[0]; },
    async run(sql, p) {
      const [r] = await pipeline([[sql, p]]);
      return { lastInsertRowid: Number(r.last_insert_rowid ?? 0), changes: Number(r.affected_row_count ?? 0) };
    },
    async exec(sql) { await pipeline(splitSql(sql).map((q) => [q, []])); },
  };
}

const splitSql = (sql) => sql.split(/;\s*\n/).map((q) => q.trim()).filter(Boolean);

const driver = config.turso.url ? remoteDriver(config.turso.url, config.turso.token) : localDriver();
export const usingRemoteDb = Boolean(config.turso.url);

// ---- schema + migrations, once per process (cold start) ----
let ready;
async function migrate() {
  await driver.exec(SCHEMA);
  // Columns added after the first version. Adding an existing column fails harmlessly.
  for (const [table, col, def] of [
    ['meeting_types', 'locations', "TEXT NOT NULL DEFAULT '[]'"], // [{type, value}] google_meet|zoom|phone|in_person|custom
    ['bookings', 'location_type', 'TEXT'],
    ['bookings', 'zoom_meeting_id', 'TEXT'],
  ]) {
    try { await driver.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`, []); } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
  if (!(await driver.get("SELECT 1 AS x FROM settings WHERE key='_migration_locations'", []))) {
    // One-time: copy the old single location into the new list.
    await driver.run(`UPDATE meeting_types SET locations = json_array(json_object('type', location_type, 'value', COALESCE(location_value, '')))
                      WHERE locations = '[]' AND location_type <> 'none'`, []);
    await driver.run("INSERT OR IGNORE INTO settings(key, value) VALUES('_migration_locations', '1')", []);
  }
  await seed();
}
const ensureReady = () => (ready ??= migrate().catch((e) => { ready = null; throw e; }));
export const initDb = ensureReady;

// ---- helpers ----
export async function all(sql, ...p) { await ensureReady(); return driver.all(sql, p); }
export async function get(sql, ...p) { await ensureReady(); return driver.get(sql, p); }
export async function run(sql, ...p) { await ensureReady(); return driver.run(sql, p); }

const SETTING_DEFAULTS = {
  owner_name: '',
  owner_email: '',
  owner_phone: '',
  timezone: 'Asia/Jerusalem',
  language: 'he',              // public pages + client messages: he | en
  admin_language: 'he',        // dashboard + messages to the owner: he | en
  default_calendar: '',        // calendars.id
  brand_color: '#4f46e5',
  welcome_text: '',
};

export async function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of await all('SELECT key, value FROM settings')) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  return out;
}

export async function setSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in SETTING_DEFAULTS)) continue;
    await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v ?? ''));
  }
}

const JSON_COLS = {
  meeting_types: ['durations', 'schedule', 'fields', 'locations', 'client_reminder_channels', 'client_reminder_options',
    'client_reminder_defaults', 'owner_reminders', 'owner_reminder_channels'],
  bookings: ['answers', 'reminder_channels', 'reminder_offsets'],
};

export function parseRow(table, row) {
  if (!row) return row;
  const r = { ...row };
  for (const c of JSON_COLS[table] || []) if (typeof r[c] === 'string') r[c] = JSON.parse(r[c]);
  return r;
}


// Seed a first meeting type so the booking page isn't empty on first run.
async function seed() {
  if (await driver.get('SELECT 1 AS x FROM meeting_types LIMIT 1', [])) return;
  const weekdays = { 0: [[540, 1020]], 1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]], 4: [[540, 1020]], 5: [], 6: [] };
  const langRow = await driver.get("SELECT value FROM settings WHERE key='language'", []);
  const he = (langRow?.value || SETTING_DEFAULTS.language) === 'he';
  await driver.run(`INSERT INTO meeting_types(slug, name, description, durations, schedule, buffer_after, fields, created_at, locations)
       VALUES(?,?,?,?,?,?,?,?,'[{"type":"google_meet","value":""}]')`, ['intro',
    he ? 'שיחת היכרות' : 'Intro call',
    he ? 'שיחה קצרה כדי להכיר.' : 'A short call to get to know each other.', '[30]',
    JSON.stringify(weekdays), 15,
    JSON.stringify([{ id: 'topic', label: he ? 'על מה תרצו לדבר?' : 'What would you like to talk about?', type: 'textarea', required: false, placeholder: '', options: [] }]),
    Date.now()]);
}
