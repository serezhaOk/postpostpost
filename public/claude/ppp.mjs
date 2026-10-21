#!/usr/bin/env node
// postpostpost CLI — даёт Claude (и вам) управлять очередью публикаций из терминала.
// Без зависимостей, нужен Node.js 20+. Все ответы — JSON, чтобы их было удобно разбирать.
//
//   node ppp.mjs login <url> <ключ>
//   node ppp.mjs status
//   node ppp.mjs settings [--slots 15:00,18:00] [--tz Europe/Lisbon]
//   node ppp.mjs post <файл> [--caption "текст" | --caption-file путь] [--at slot|now|"2026-10-22 15:00"] [--tz Europe/Lisbon] [--platforms youtube,instagram]
//   node ppp.mjs now|retry|delete <id поста>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = path.join(os.homedir(), '.config', 'postpostpost', 'config.json');

function fail(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}
const out = (data) => console.log(JSON.stringify({ ok: true, ...data }, null, 2));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else args._.push(a);
  }
  return args;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return fail(`Нет настроек. Выполните: node ppp.mjs login <url> <ключ>`); }
}

async function api(cfg, method, route, body, headers = {}) {
  const res = await fetch(`${cfg.url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error || `HTTP ${res.status}`, { status: res.status });
  return data;
}

// Время «2026-10-22 15:00» в часовом поясе tz → миллисекунды UTC
function zonedToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(local.trim());
  if (!m) fail(`Не понимаю время «${local}». Формат: 2026-10-22 15:00`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offset = (ts) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(ts).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
  };
  return guess - offset(guess - offset(guess));
}

const fmt = (ts, tz) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(ts);

function summary(state) {
  const tz = state.settings.tz;
  return {
    timezone: tz,
    dailySlots: state.settings.slots,
    nextFreeSlot: fmt(state.nextSlot, tz),
    platforms: state.platforms.map((p) => ({ id: p.id, connected: p.connected && !p.reconnect, account: p.account })),
    posts: state.posts.map((p) => ({
      id: p.id,
      at: fmt(p.scheduled_at, tz),
      caption: p.caption.length > 80 ? `${p.caption.slice(0, 80)}…` : p.caption,
      jobs: Object.fromEntries(p.jobs.map((j) => [j.platform, j.error ? `${j.status}: ${j.error}` : j.status])),
    })),
  };
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (cmd) {
  case 'login': {
    const [url, token] = args._;
    if (!url || !token) fail('Использование: node ppp.mjs login <url> <ключ>');
    const cfg = { url: url.replace(/\/$/, ''), token };
    await api(cfg, 'GET', '/api/state');
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    out({ message: `Подключено к ${cfg.url}` });
    break;
  }

  case 'status': {
    const cfg = loadConfig();
    out(summary(await api(cfg, 'GET', '/api/state')));
    break;
  }

  case 'settings': {
    const cfg = loadConfig();
    const patch = {};
    if (typeof args.slots === 'string') patch.slots = args.slots.split(',').map((s) => s.trim().padStart(5, '0'));
    if (typeof args.tz === 'string') patch.tz = args.tz;
    const state = Object.keys(patch).length ? await api(cfg, 'PUT', '/api/settings', patch) : await api(cfg, 'GET', '/api/state');
    if (patch.tz && state.settings.tz !== patch.tz) fail(`Неизвестный часовой пояс: ${patch.tz}`);
    const { posts, ...s } = summary(state);
    out(s);
    break;
  }

  case 'post': {
    const cfg = loadConfig();
    const file = args._[0];
    if (!file || !fs.existsSync(file)) fail(`Файл не найден: ${file}`);
    const state = await api(cfg, 'GET', '/api/state');
    const tz = typeof args.tz === 'string' ? args.tz : state.settings.tz;

    const caption = typeof args['caption-file'] === 'string'
      ? fs.readFileSync(args['caption-file'], 'utf8').trim()
      : typeof args.caption === 'string' ? args.caption : '';

    const connected = state.platforms.filter((p) => p.connected && !p.reconnect).map((p) => p.id);
    const platforms = typeof args.platforms === 'string' ? args.platforms.split(',').map((s) => s.trim()) : connected;
    const unknown = platforms.filter((p) => !connected.includes(p));
    if (unknown.length) fail(`Не подключены: ${unknown.join(', ')}. Подключены: ${connected.join(', ') || 'ничего'}`);

    const at = args.at === undefined || args.at === 'slot' ? 'slot' : args.at === 'now' ? 'now' : zonedToUtc(String(args.at), tz);
    if (typeof at === 'number' && at < Date.now() - 60_000) fail(`Время ${args.at} (${tz}) уже прошло`);

    const blob = await fs.openAsBlob(file);
    const { file: uploaded } = await api(cfg, 'PUT', `/api/upload?name=${encodeURIComponent(path.basename(file))}`, blob,
      { 'Content-Type': 'application/octet-stream' });
    const post = await api(cfg, 'POST', '/api/posts', { file: uploaded, caption, platforms, when: at });
    out({ id: post.id, file: path.basename(file), at: fmt(post.scheduled_at, tz), timezone: tz, platforms });
    break;
  }

  case 'now':
  case 'retry':
  case 'delete': {
    const cfg = loadConfig();
    const id = Number(args._[0]);
    if (!id) fail(`Использование: node ppp.mjs ${cmd} <id поста>`);
    if (cmd === 'delete') await api(cfg, 'DELETE', `/api/posts/${id}`);
    else await api(cfg, 'POST', `/api/posts/${id}/${cmd}`);
    out({ id, done: cmd });
    break;
  }

  default:
    fail('Команды: login, status, settings, post, now, retry, delete');
}
