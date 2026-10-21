import { config } from '../config.js';
import { getAccount, saveAccount } from '../db.js';
import youtube from './youtube.js';
import instagram from './instagram.js';
import tiktok from './tiktok.js';
import x from './x.js';

// Демо-режим: все площадки «подключаются» в один клик, публикация и статистика имитируются.
// Нужен, чтобы посмотреть интерфейс и логику без ключей API.
function demo(real) {
  return {
    id: real.id,
    label: real.label,
    short: real.short,
    note: real.note,
    configured: () => true,
    authUrl: ({ state, redirectUri }) => `${redirectUri}?code=demo&state=${state}`,
    connect: async () => ({ name: `demo_${real.id}`, access_token: 'demo' }),
    publish: async () => ({ status: 'processing', state: { at: Date.now() } }),
    check: async ({ job }) => {
      if (real.id === 'tiktok' && config.tiktok.mode !== 'direct') return { status: 'draft' };
      const id = String(job.id);
      return { status: 'done', remote_id: id, url: null };
    },
    stats: async ({ ids, jobs }) => Object.fromEntries(ids.map((id) => {
      const prev = jobs.find((j) => j.remote_id === id)?.stats || { views: 0, likes: 0, comments: 0, shares: 0 };
      const grow = Math.floor(Math.random() * 400);
      return [id, {
        views: prev.views + grow,
        likes: prev.likes + Math.floor(grow / 9),
        comments: prev.comments + Math.floor(grow / 60),
        shares: prev.shares + Math.floor(grow / 80),
      }];
    })),
  };
}

const real = [youtube, instagram, tiktok, x];
export const platforms = real.map((p) => (config.demo ? demo(p) : p));
export const byId = Object.fromEntries(platforms.map((p) => [p.id, p]));

// Аккаунт со свежим токеном: обновляем заранее, за 5 минут до истечения
export async function accountFor(id) {
  const acc = getAccount(id);
  if (!acc) throw new Error('Аккаунт не подключён');
  const p = byId[id];
  if (p.refresh && acc.expires_at && acc.expires_at < Date.now() + 5 * 60_000) {
    Object.assign(acc, await p.refresh(acc));
    saveAccount(id, acc);
  }
  return acc;
}
