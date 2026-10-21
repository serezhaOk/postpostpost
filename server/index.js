import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { db, getSettings, saveSettings, saveAccount, deleteAccount, getAccount, listPosts, getCredentials, saveCredentials } from './db.js';
import { platforms, byId } from './platforms/index.js';
import { startScheduler, tick } from './scheduler.js';
import { sign, safeEqual, randomId, pkcePair } from './crypto.js';
import { nextFreeSlot } from './time.js';

const PUBLIC_DIR = path.join(config.root, 'public');
const SESSION_COOKIE = 'ppp';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.mjs': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
};

// ---------- сессия ----------

function sessionToken() {
  const exp = Date.now() + 365 * 86_400_000;
  return `${exp}.${sign(`session:${exp}`)}`;
}

// Ключ API для Claude и других программ: хранится только хэш, сам ключ показывается один раз
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function isAuthed(req) {
  if (!config.appPassword) return true;
  const bearer = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '')?.[1];
  if (bearer) {
    const { apiTokenHash } = getSettings();
    return Boolean(apiTokenHash) && safeEqual(hashToken(bearer), apiTokenHash);
  }
  const cookie = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')));
  const [exp, sig] = (cookie[SESSION_COOKIE] || '').split('.');
  return Number(exp) > Date.now() && safeEqual(sig, sign(`session:${exp}`));
}

// ---------- ответы ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

// Отдача файла с поддержкой Range — без неё видео не проигрывается в Safari на iPhone
function sendFile(req, res, file, cacheControl = 'no-cache') {
  let stat;
  try { stat = fs.statSync(file); } catch { return send(res, 404, 'Not found'); }
  if (!stat.isFile()) return send(res, 404, 'Not found');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) return send(res, 416, '', { 'Content-Range': `bytes */${stat.size}` });
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Cache-Control': cacheControl,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl });
  fs.createReadStream(file).pipe(res);
}

const uploadPath = (file) => {
  if (!/^[\w-]+\.(mp4|mov|webm|m4v)$/i.test(file)) return null;
  return path.join(config.uploadsDir, file);
};

// ---------- состояние для клиента ----------

function takenSlots() {
  return new Set(db.prepare('SELECT scheduled_at FROM posts WHERE scheduled_at > ?').all(Date.now()).map((r) => r.scheduled_at));
}

function state() {
  const { apiTokenHash, ...settings } = getSettings();
  return {
    demo: config.demo,
    publicUrl: config.publicUrl,
    apiToken: Boolean(apiTokenHash),
    settings,
    nextSlot: nextFreeSlot(settings, takenSlots()),
    https: config.publicUrl.startsWith('https://'),
    platforms: platforms.map((p) => {
      const acc = getAccount(p.id);
      const creds = getCredentials(p.id);
      return {
        id: p.id, label: p.label, short: p.short, configured: p.configured(),
        connected: Boolean(acc), account: acc?.name || null, note: p.note?.() || null,
        reconnect: Boolean(acc?.extra?.reconnect),
        redirectUri: redirectUri(p.id),
        clientId: creds.id || '',
        keysFrom: creds.source,
      };
    }),
    posts: listPosts(),
  };
}

function stats() {
  const rows = db.prepare(`SELECT j.platform, j.stats, j.post_id, p.caption, p.file FROM jobs j JOIN posts p ON p.id = j.post_id
    WHERE j.stats IS NOT NULL`).all();
  const zero = () => ({ views: 0, likes: 0, comments: 0, shares: 0 });
  const totals = zero();
  const byPlatform = {};
  const byPost = new Map();
  for (const r of rows) {
    const s = JSON.parse(r.stats);
    byPlatform[r.platform] ??= zero();
    if (!byPost.has(r.post_id)) byPost.set(r.post_id, { id: r.post_id, caption: r.caption, file: r.file, ...zero() });
    for (const k of Object.keys(totals)) {
      const v = s[k] || 0;
      totals[k] += v;
      byPlatform[r.platform][k] += v;
      byPost.get(r.post_id)[k] += v;
    }
  }
  const top = [...byPost.values()].sort((a, b) => b.views - a.views).slice(0, 10);
  return { totals, byPlatform, top };
}

// ---------- OAuth ----------

const oauthStates = new Map();
const redirectUri = (id) => `${config.publicUrl}/auth/${id}/callback`;

function startAuth(res, id) {
  const p = byId[id];
  if (!p?.configured()) return send(res, 400, 'Площадка не настроена: добавьте ключи в .env');
  const state = randomId();
  const pkce = p.pkce ? pkcePair() : {};
  oauthStates.set(state, { id, verifier: pkce.verifier, at: Date.now() });
  redirect(res, p.authUrl({ state, redirectUri: redirectUri(id), challenge: pkce.challenge }));
}

async function finishAuth(res, id, query) {
  const saved = oauthStates.get(query.get('state'));
  oauthStates.delete(query.get('state'));
  if (!saved || saved.id !== id || Date.now() - saved.at > 15 * 60_000) return redirect(res, '/#settings?error=state');
  if (query.get('error')) return redirect(res, `/#settings?error=${encodeURIComponent(query.get('error'))}`);
  try {
    const acc = await byId[id].connect({ code: query.get('code'), redirectUri: redirectUri(id), verifier: saved.verifier });
    saveAccount(id, acc);
    redirect(res, '/#settings');
  } catch (err) {
    console.error(`[${id}] connect: ${err.message}`);
    redirect(res, `/#settings?error=${encodeURIComponent(err.message.slice(0, 200))}`);
  }
}

// ---------- API ----------

async function api(req, res, url) {
  const { pathname } = url;
  const m = (re) => pathname.match(re);

  if (req.method === 'POST' && pathname === '/api/login') {
    const { password } = await readJson(req);
    if (!config.appPassword || safeEqual(password || '', config.appPassword)) {
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `${SESSION_COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${config.publicUrl.startsWith('https') ? '; Secure' : ''}`,
      });
    }
    return send(res, 401, { error: 'Неверный пароль' });
  }

  if (!isAuthed(req)) return send(res, 401, { error: 'Нужен вход' });

  if (req.method === 'POST' && pathname === '/api/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0` });
  }

  if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, state());
  if (req.method === 'GET' && pathname === '/api/stats') return send(res, 200, stats());

  // Загрузка видео сырым телом запроса — без multipart и без зависимостей
  if (req.method === 'PUT' && pathname === '/api/upload') {
    const ext = (path.extname(url.searchParams.get('name') || '').toLowerCase().match(/^\.(mp4|mov|webm|m4v)$/) || ['.mp4'])[0];
    const file = `${Date.now()}-${randomId(6)}${ext}`;
    const target = path.join(config.uploadsDir, file);
    try {
      await pipeline(req, fs.createWriteStream(target));
    } catch (err) {
      fs.rmSync(target, { force: true });
      throw err;
    }
    return send(res, 200, { file });
  }

  if (req.method === 'POST' && pathname === '/api/posts') {
    const { file, caption = '', platforms: chosen = [], when = 'slot' } = await readJson(req);
    if (!uploadPath(file) || !fs.existsSync(uploadPath(file))) return send(res, 400, { error: 'Видео не найдено' });
    const targets = chosen.filter((id) => byId[id] && getAccount(id));
    if (!targets.length) return send(res, 400, { error: 'Выберите хотя бы одну подключённую площадку' });
    const at = when === 'now' ? Date.now() : when === 'slot' ? nextFreeSlot(getSettings(), takenSlots()) : Number(when);
    if (!Number.isFinite(at)) return send(res, 400, { error: 'Неверное время' });
    const { lastInsertRowid: postId } = db.prepare('INSERT INTO posts(file, caption, scheduled_at, created_at) VALUES (?, ?, ?, ?)')
      .run(file, String(caption).slice(0, 2200), at, Date.now());
    const ins = db.prepare('INSERT INTO jobs(post_id, platform) VALUES (?, ?)');
    for (const id of targets) ins.run(postId, id);
    if (when === 'now') setImmediate(() => tick());
    return send(res, 200, { id: Number(postId), scheduled_at: at });
  }

  let mm;
  if ((mm = m(/^\/api\/posts\/(\d+)\/now$/)) && req.method === 'POST') {
    db.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?').run(Date.now(), mm[1]);
    setImmediate(() => tick());
    return send(res, 200, { ok: true });
  }
  if ((mm = m(/^\/api\/posts\/(\d+)\/retry$/)) && req.method === 'POST') {
    db.prepare(`UPDATE jobs SET status = 'pending', attempts = 0, next_try_at = NULL, error = NULL WHERE post_id = ? AND status = 'failed'`).run(mm[1]);
    setImmediate(() => tick());
    return send(res, 200, { ok: true });
  }
  if ((mm = m(/^\/api\/posts\/(\d+)$/)) && req.method === 'PATCH') {
    const { caption, scheduled_at } = await readJson(req);
    if (caption !== undefined) db.prepare('UPDATE posts SET caption = ? WHERE id = ?').run(String(caption).slice(0, 2200), mm[1]);
    if (scheduled_at !== undefined) db.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?').run(Number(scheduled_at), mm[1]);
    return send(res, 200, { ok: true });
  }
  if ((mm = m(/^\/api\/posts\/(\d+)$/)) && req.method === 'DELETE') {
    const post = db.prepare('SELECT file FROM posts WHERE id = ?').get(mm[1]);
    if (!post) return send(res, 404, { error: 'Нет такого поста' });
    db.prepare('DELETE FROM posts WHERE id = ?').run(mm[1]);
    const stillUsed = db.prepare('SELECT 1 FROM posts WHERE file = ?').get(post.file);
    if (!stillUsed) fs.rmSync(path.join(config.uploadsDir, post.file), { force: true });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'PUT' && pathname === '/api/settings') {
    const body = await readJson(req);
    const patch = {};
    if (Array.isArray(body.slots)) patch.slots = [...new Set(body.slots.filter((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)))].sort();
    if (typeof body.tz === 'string') {
      try { new Intl.DateTimeFormat('en', { timeZone: body.tz }); patch.tz = body.tz; } catch { /* неизвестный пояс — игнорируем */ }
    }
    saveSettings(patch);
    return send(res, 200, state());
  }

  // Ключи приложения разработчика вводятся прямо в интерфейсе
  if ((mm = m(/^\/api\/credentials\/(\w+)$/)) && req.method === 'PUT') {
    if (!byId[mm[1]]) return send(res, 404, { error: 'Нет такой площадки' });
    const { id, secret } = await readJson(req);
    const cleanId = String(id || '').trim();
    // Пустой секрет при уже сохранённых ключах — значит, меняют только ID
    const cleanSecret = String(secret || '').trim() || getCredentials(mm[1]).secret;
    if (!cleanId || !cleanSecret) return send(res, 400, { error: 'Заполните оба поля' });
    saveCredentials(mm[1], cleanId, cleanSecret);
    return send(res, 200, state());
  }

  if (pathname === '/api/token' && req.method === 'POST') {
    const token = `ppp_${randomId(24)}`;
    saveSettings({ apiTokenHash: hashToken(token) });
    return send(res, 200, { token, state: state() });
  }
  if (pathname === '/api/token' && req.method === 'DELETE') {
    saveSettings({ apiTokenHash: null });
    return send(res, 200, state());
  }

  if ((mm = m(/^\/api\/accounts\/(\w+)$/)) && req.method === 'DELETE') {
    deleteAccount(mm[1]);
    return send(res, 200, state());
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------- роутинг ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;
  try {
    if (pathname.startsWith('/api/')) return await api(req, res, url);

    let mm;
    if ((mm = pathname.match(/^\/auth\/(\w+)\/(start|callback)$/))) {
      if (!isAuthed(req)) return redirect(res, '/');
      return mm[2] === 'start' ? startAuth(res, mm[1]) : await finishAuth(res, mm[1], url.searchParams);
    }

    // Превью видео в интерфейсе — только после входа
    if ((mm = pathname.match(/^\/files\/([^/]+)$/))) {
      if (!isAuthed(req)) return send(res, 401, 'Нужен вход');
      const file = uploadPath(mm[1]);
      return file ? sendFile(req, res, file, 'private, max-age=31536000, immutable') : send(res, 404, 'Not found');
    }

    // Публичная временная ссылка для платформ, которые сами скачивают видео (Instagram)
    if ((mm = pathname.match(/^\/media\/([^/]+)$/))) {
      const exp = Number(url.searchParams.get('exp'));
      const ok = exp > Date.now() && safeEqual(url.searchParams.get('sig') || '', sign(`${mm[1]}:${exp}`));
      const file = uploadPath(mm[1]);
      return ok && file ? sendFile(req, res, file) : send(res, 403, 'Forbidden');
    }

    // Статика интерфейса. Share Target (POST /share) обрабатывает service worker, сюда он не доходит.
    const rel = pathname === '/' || pathname === '/share' ? '/index.html' : pathname;
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
    return sendFile(req, res, file);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
  }
});

server.requestTimeout = 0; // большие видео грузятся долго
server.listen(config.port, () => {
  console.log(`postpostpost: ${config.publicUrl} (порт ${config.port})${config.demo ? ' — ДЕМО-РЕЖИМ' : ''}`);
  if (!config.appPassword) console.warn('⚠️  APP_PASSWORD не задан — вход без пароля. Не выставляйте так сервер в интернет.');
  startScheduler();
});
