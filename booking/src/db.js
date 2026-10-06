import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
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
  location_type TEXT NOT NULL DEFAULT 'google_meet', -- google_meet | phone | in_person | custom | none
  location_value TEXT DEFAULT '',
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
`);

// ---- helpers ----
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const SETTING_DEFAULTS = {
  owner_name: 'Me',
  owner_email: '',
  owner_phone: '',
  timezone: 'Asia/Jerusalem',
  language: 'en',              // public pages + client messages: en | he
  default_calendar: '',        // calendars.id
  brand_color: '#4f46e5',
  welcome_text: '',
};

export function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

export function setSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in SETTING_DEFAULTS)) continue;
    run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v ?? ''));
  }
}

const JSON_COLS = {
  meeting_types: ['durations', 'schedule', 'fields', 'client_reminder_channels', 'client_reminder_options',
    'client_reminder_defaults', 'owner_reminders', 'owner_reminder_channels'],
  bookings: ['answers', 'reminder_channels', 'reminder_offsets'],
};

export function parseRow(table, row) {
  if (!row) return row;
  const r = { ...row };
  for (const c of JSON_COLS[table] || []) if (typeof r[c] === 'string') r[c] = JSON.parse(r[c]);
  return r;
}
