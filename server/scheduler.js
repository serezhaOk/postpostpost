import path from 'node:path';
import { config } from './config.js';
import { db, updateJob } from './db.js';
import { byId, accountFor } from './platforms/index.js';
import { notify } from './notify.js';
import { sign } from './crypto.js';

const TICK = 15_000;
const MAX_ATTEMPTS = 3;
const STATS_EVERY = config.demo ? 0 : 30 * 60_000;
const STATS_WINDOW = 30 * 86_400_000;

// Подписанная временная ссылка на файл — её скачивает Instagram
export function mediaUrl(file, ttl = 6 * 3600_000) {
  const exp = Date.now() + ttl;
  return `${config.publicUrl}/media/${file}?exp=${exp}&sig=${sign(`${file}:${exp}`)}`;
}

const parse = (j) => ({ ...j, state: j.state ? JSON.parse(j.state) : {}, stats: j.stats ? JSON.parse(j.stats) : null });

async function apply(job, platform, result) {
  const fields = { status: result.status, error: null };
  if (result.state) fields.state = { ...job.state, ...result.state };
  if (result.remote_id !== undefined) fields.remote_id = result.remote_id;
  if (result.url !== undefined) fields.url = result.url;
  if (result.status === 'done') fields.published_at = Date.now();
  if (result.status === 'processing') fields.next_try_at = Date.now() + 10_000;
  updateJob(job.id, fields);
  if (result.status === 'draft' && job.status !== 'draft') {
    await notify(`${platform.label}: видео во «Входящих». Откройте TikTok и опубликуйте его.`);
  }
}

async function fail(job, platform, err) {
  const attempts = job.attempts + 1;
  const final = attempts >= MAX_ATTEMPTS;
  console.error(`[${platform.id}] job ${job.id}: ${err.message}`);
  updateJob(job.id, {
    status: final ? 'failed' : 'pending',
    attempts,
    error: err.message.slice(0, 500),
    next_try_at: final ? null : Date.now() + attempts * 5 * 60_000,
    state: null,
  });
  if (final) await notify(`❌ ${platform.label}: не удалось опубликовать. ${err.message}`);
}

async function runJob(row) {
  const job = parse(row);
  const platform = byId[job.platform];
  try {
    const acc = await accountFor(job.platform);
    if (job.status === 'pending') {
      updateJob(job.id, { status: 'running' });
      const post = { id: job.post_id, caption: row.caption, file: row.file };
      const result = await platform.publish({
        post, acc, job,
        filePath: path.join(config.uploadsDir, row.file),
        mediaUrl: mediaUrl(row.file),
      });
      await apply(job, platform, result);
    } else {
      await apply(job, platform, await platform.check({ job, acc }));
    }
  } catch (err) {
    await fail(job, platform, err);
  }
}

let lastStats = 0;
async function refreshStats() {
  lastStats = Date.now();
  const rows = db.prepare(`SELECT * FROM jobs WHERE status = 'done' AND remote_id IS NOT NULL AND published_at > ?`)
    .all(Date.now() - STATS_WINDOW).map(parse);
  const groups = Object.groupBy(rows, (j) => j.platform);
  for (const [id, jobs] of Object.entries(groups)) {
    try {
      const acc = await accountFor(id);
      const stats = await byId[id].stats({ ids: jobs.map((j) => j.remote_id), jobs, acc });
      for (const j of jobs) if (stats[j.remote_id]) updateJob(j.id, { stats: stats[j.remote_id], stats_at: Date.now() });
    } catch (err) {
      console.warn(`[${id}] stats: ${err.message}`);
    }
  }
}

let busy = false;
export async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const due = db.prepare(`
      SELECT j.*, p.caption, p.file FROM jobs j JOIN posts p ON p.id = j.post_id
      WHERE (j.status = 'pending' AND p.scheduled_at <= ?) OR j.status IN ('processing', 'draft')
    `).all(now).filter((j) => !j.next_try_at || j.next_try_at <= now);
    // Черновики TikTok проверяем редко: ждём, пока человек нажмёт «Опубликовать»
    for (const j of due) if (j.status === 'draft') updateJob(j.id, { next_try_at: now + 5 * 60_000 });
    await Promise.allSettled(due.map(runJob));
    if (now - lastStats > STATS_EVERY) await refreshStats();
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  // Задачи, прерванные перезапуском сервера, возвращаем в очередь
  db.prepare(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`).run();
  setInterval(() => tick().catch((err) => console.error('tick', err)), TICK);
  tick().catch((err) => console.error('tick', err));
}

export { refreshStats };
