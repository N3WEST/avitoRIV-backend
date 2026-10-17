import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, PLANS } from './config.js';

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
export const db = new DatabaseSync(cfg.dbPath);

try { fs.chmodSync(cfg.dbPath, 0o600); } catch {}

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  telegram_id     TEXT PRIMARY KEY,
  username        TEXT,
  plan            TEXT NOT NULL DEFAULT 'free',
  plan_expires_at TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS searches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id      TEXT NOT NULL,
  title            TEXT NOT NULL,
  url              TEXT,
  query            TEXT NOT NULL,
  region           TEXT NOT NULL DEFAULT '',
  max_price        INTEGER,
  ref_price        INTEGER,
  source_avito_id  TEXT,
  category         TEXT,
  filters_json     TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  deleted          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  last_scan_at     TEXT,
  expired_notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_searches_user ON searches(telegram_id, created_at);
CREATE INDEX IF NOT EXISTS idx_searches_active ON searches(is_active, deleted, expires_at);

CREATE TABLE IF NOT EXISTS items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id        INTEGER,
  telegram_id      TEXT NOT NULL,
  avito_id         TEXT NOT NULL,
  title            TEXT NOT NULL,
  price            INTEGER NOT NULL,
  url              TEXT NOT NULL,
  image            TEXT,
  city             TEXT,
  discount_percent INTEGER NOT NULL DEFAULT 0,
  found_at         TEXT NOT NULL,
  UNIQUE (search_id, avito_id)
);
CREATE INDEX IF NOT EXISTS idx_items_search ON items(search_id, found_at);

CREATE TABLE IF NOT EXISTS favorites (
  telegram_id TEXT NOT NULL,
  item_id     INTEGER NOT NULL,
  title       TEXT, price INTEGER, url TEXT, image TEXT, city TEXT,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (telegram_id, item_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  plan        TEXT NOT NULL,
  duration    INTEGER NOT NULL,
  amount      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  applied     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`);

export const nowISO = () => new Date().toISOString();

export function upsertUser(tid, username) {
  db.prepare(`INSERT INTO users(telegram_id, username, created_at) VALUES(?,?,?)
    ON CONFLICT(telegram_id) DO UPDATE SET username = COALESCE(excluded.username, users.username)`)
    .run(String(tid), username || null, nowISO());
}

export const getUser = tid => db.prepare('SELECT * FROM users WHERE telegram_id=?').get(String(tid));

// Подписка закончилась → считаем пользователя Free, ничего вручную сбрасывать не нужно
export function effectivePlan(u) {
  if (u && u.plan !== 'free' && PLANS[u.plan] && u.plan_expires_at && u.plan_expires_at > nowISO()) return u.plan;
  return 'free';
}
