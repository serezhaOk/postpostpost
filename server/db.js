import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (
    platform TEXT PRIMARY KEY,
    name TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    extra TEXT
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    scheduled_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | running | processing | done | draft | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try_at INTEGER,
    state TEXT,          -- промежуточные данные платформы (id контейнера, publish_id и т.п.)
    remote_id TEXT,
    url TEXT,
    error TEXT,
    published_at INTEGER,
    stats TEXT,
    stats_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
  CREATE TABLE IF NOT EXISTS credentials (
    platform TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL
  );
`);

const DEFAULT_SETTINGS = { slots: ['18:00'], tz: 'Europe/Moscow' };

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) out[key] = JSON.parse(value);
  return out;
}

export function saveSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
}

export function getAccount(platform) {
  const row = db.prepare('SELECT * FROM accounts WHERE platform = ?').get(platform);
  if (!row) return null;
  return {
    ...row,
    access_token: decrypt(row.access_token),
    refresh_token: decrypt(row.refresh_token),
    extra: row.extra ? JSON.parse(row.extra) : {},
  };
}

export function saveAccount(platform, acc) {
  db.prepare(`INSERT INTO accounts(platform, name, access_token, refresh_token, expires_at, extra)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET name = excluded.name, access_token = excluded.access_token,
      refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, extra = excluded.extra`)
    .run(platform, acc.name ?? null, encrypt(acc.access_token), encrypt(acc.refresh_token),
      acc.expires_at ?? null, JSON.stringify(acc.extra || {}));
}

export function deleteAccount(platform) {
  db.prepare('DELETE FROM accounts WHERE platform = ?').run(platform);
}

// Ключи приложения разработчика: из интерфейса (база) важнее, чем из .env
export function getCredentials(platform) {
  const row = db.prepare('SELECT * FROM credentials WHERE platform = ?').get(platform);
  if (row) return { id: row.client_id, secret: decrypt(row.client_secret), source: 'app' };
  const env = config.envCredentials[platform] || {};
  return { id: env.id, secret: env.secret, source: env.id ? 'env' : null };
}

export function saveCredentials(platform, id, secret) {
  db.prepare(`INSERT INTO credentials(platform, client_id, client_secret) VALUES (?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET client_id = excluded.client_id, client_secret = excluded.client_secret`)
    .run(platform, id, encrypt(secret));
}

export function updateJob(id, fields) {
  const keys = Object.keys(fields);
  const values = keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]));
  db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
}

export function listPosts() {
  const posts = db.prepare('SELECT * FROM posts ORDER BY scheduled_at DESC LIMIT 200').all();
  const jobs = db.prepare('SELECT id, post_id, platform, status, error, url, published_at, stats FROM jobs').all();
  const byPost = new Map();
  for (const j of jobs) {
    if (!byPost.has(j.post_id)) byPost.set(j.post_id, []);
    byPost.get(j.post_id).push({ ...j, stats: j.stats ? JSON.parse(j.stats) : null });
  }
  return posts.map((p) => ({ ...p, jobs: byPost.get(p.id) || [] }));
}
