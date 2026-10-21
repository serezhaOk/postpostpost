import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');

// Минимальный загрузчик .env, чтобы не тянуть зависимость dotenv
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}

const e = process.env;
const port = Number(e.PORT || 3000);
const dataDir = path.resolve(root, e.DATA_DIR || 'data');
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

// Секрет для подписи сессий и шифрования токенов. Если не задан — генерируем и храним рядом с базой.
function loadSecret() {
  if (e.SESSION_SECRET) return e.SESSION_SECRET;
  const file = path.join(dataDir, 'secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

export const config = {
  root,
  port,
  publicUrl: (e.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  appPassword: e.APP_PASSWORD || '',
  secret: loadSecret(),
  demo: e.DEMO_MODE === '1',
  google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET },
  instagram: { appId: e.INSTAGRAM_APP_ID, appSecret: e.INSTAGRAM_APP_SECRET },
  tiktok: { clientKey: e.TIKTOK_CLIENT_KEY, clientSecret: e.TIKTOK_CLIENT_SECRET, mode: e.TIKTOK_MODE || 'inbox' },
  x: { clientId: e.X_CLIENT_ID, clientSecret: e.X_CLIENT_SECRET },
  telegram: { token: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID },
};
