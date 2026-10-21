'use strict';

// Демо-бэкенд для GitHub Pages: тот же API, что у сервера, но всё живёт в памяти браузера.
// Публикация имитируется за несколько секунд, статистика растёт сама.
(() => {
  const MIN = 60_000;
  const H = 60 * MIN;
  const D = 24 * H;
  const PLATFORMS = [
    { id: 'youtube', label: 'YouTube Shorts', short: 'YT' },
    { id: 'instagram', label: 'Instagram Reels', short: 'IG' },
    { id: 'tiktok', label: 'TikTok', short: 'TT', note: 'Видео придёт во «Входящие» TikTok — опубликуйте его одним нажатием' },
    { id: 'x', label: 'X (Twitter)', short: 'X' },
  ];

  const db = {
    settings: { slots: ['12:00', '18:00'], tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
    accounts: { youtube: '@my_channel', instagram: '@my.reels', tiktok: 'my_tiktok' }, // X не подключён — можно «подключить»
    posts: [],
    files: new Map(),
    seq: 1,
  };

  // Слоты считаем в часовом поясе устройства — в демо он и есть пояс пользователя
  function slotTimes(fromDay, days) {
    const out = [];
    for (let d = fromDay; d < fromDay + days; d++) {
      for (const hm of [...db.settings.slots].sort()) {
        const [h, m] = hm.split(':').map(Number);
        const t = new Date();
        t.setDate(t.getDate() + d);
        t.setHours(h, m, 0, 0);
        out.push(t.getTime());
      }
    }
    return out;
  }

  function nextSlot() {
    const taken = new Set(db.posts.map((p) => p.scheduled_at));
    return slotTimes(0, 400).find((t) => t > Date.now() && !taken.has(t)) ?? Date.now();
  }

  const stats = (views) => ({ views, likes: Math.round(views / 11), comments: Math.round(views / 140), shares: Math.round(views / 90) });

  function addPost({ file, caption, scheduled_at, platforms, status = 'pending', views = 0 }) {
    const id = db.seq++;
    db.posts.push({
      id, file, caption, scheduled_at, created_at: Date.now(),
      jobs: platforms.map((platform, i) => {
        const s = typeof status === 'function' ? status(platform) : status;
        return {
          id: id * 10 + i, post_id: id, platform, status: s, error: null, url: null,
          published_at: s === 'done' ? scheduled_at : null,
          stats: s === 'done' ? stats(Math.round(views * (0.6 + Math.random() * 0.8))) : null,
          readyAt: 0,
        };
      }),
    });
  }

  // Стартовые данные: история публикаций, видео во «Входящих» TikTok и очередь
  const past = slotTimes(-3, 3).filter((t) => t < Date.now() - H);
  const connected = ['youtube', 'instagram', 'tiktok'];
  const seeds = [
    ['sample1.webm', 'Утренняя рутина за 30 секунд ☕️ #morning #routine', 4200],
    ['sample2.webm', 'Как я монтирую шортсы прямо на телефоне', 12800],
    ['sample3.webm', '3 ошибки новичков в рилсах', 2300],
    ['sample4.webm', 'Мой сетап за $300', 0],
  ];
  past.slice(-3).forEach((t, i) => {
    const [file, caption, views] = seeds[i];
    const last = i === 2;
    addPost({
      file, caption, scheduled_at: t, platforms: connected, views,
      status: (p) => (last && p === 'tiktok' ? 'draft' : 'done'),
    });
  });
  addPost({ file: 'sample4.webm', caption: seeds[3][1], scheduled_at: nextSlot(), platforms: connected });

  // Имитация планировщика
  setInterval(() => {
    const now = Date.now();
    for (const p of db.posts) {
      if (p.scheduled_at > now) continue;
      for (const j of p.jobs) {
        if (j.status === 'pending') { j.status = 'processing'; j.readyAt = now + 3000; }
        else if (j.status === 'processing' && now >= j.readyAt) {
          j.status = j.platform === 'tiktok' ? 'draft' : 'done';
          if (j.status === 'done') { j.published_at = now; j.stats = stats(0); }
        } else if (j.status === 'done' && j.stats) {
          const grow = Math.floor(Math.random() * 40);
          j.stats.views += grow;
          j.stats.likes += Math.floor(grow / 10);
        }
      }
    }
  }, 1500);

  function state() {
    return {
      demo: true,
      settings: { ...db.settings },
      nextSlot: nextSlot(),
      platforms: PLATFORMS.map((p) => ({
        ...p, note: p.note || null, configured: true, connected: Boolean(db.accounts[p.id]), account: db.accounts[p.id] || null,
      })),
      posts: [...db.posts]
        .filter((p) => p.jobs.length)
        .sort((a, b) => b.scheduled_at - a.scheduled_at)
        .map((p) => ({ ...p, jobs: p.jobs.map(({ readyAt, ...j }) => ({ ...j, stats: j.stats && { ...j.stats } })) })),
    };
  }

  function statsView() {
    const zero = () => ({ views: 0, likes: 0, comments: 0, shares: 0 });
    const totals = zero();
    const byPlatform = {};
    const top = [];
    for (const p of db.posts) {
      const row = { id: p.id, caption: p.caption, file: p.file, ...zero() };
      for (const j of p.jobs) {
        if (!j.stats) continue;
        byPlatform[j.platform] ??= zero();
        for (const k of Object.keys(totals)) {
          totals[k] += j.stats[k];
          byPlatform[j.platform][k] += j.stats[k];
          row[k] += j.stats[k];
        }
      }
      if (row.views) top.push(row);
    }
    return { totals, byPlatform, top: top.sort((a, b) => b.views - a.views).slice(0, 10) };
  }

  const fail = (msg) => { throw new Error(msg); };

  window.PPP_DEMO = {
    async call(method, path, body) {
      await new Promise((r) => setTimeout(r, 120));
      let m;
      if (method === 'GET' && path === '/api/state') return state();
      if (method === 'GET' && path === '/api/stats') return statsView();
      if (method === 'POST' && path === '/api/posts') {
        const targets = body.platforms.filter((id) => db.accounts[id]);
        if (!targets.length) fail('Выберите хотя бы одну подключённую площадку');
        const at = body.when === 'now' ? Date.now() : body.when === 'slot' ? nextSlot() : Number(body.when);
        addPost({ file: body.file, caption: body.caption, scheduled_at: at, platforms: targets });
        return { id: db.seq - 1, scheduled_at: at };
      }
      if ((m = path.match(/^\/api\/posts\/(\d+)\/(now|retry)$/))) {
        const p = db.posts.find((x) => x.id === Number(m[1]));
        if (m[2] === 'now') p.scheduled_at = Date.now();
        else p.jobs.forEach((j) => { if (j.status === 'failed') j.status = 'pending'; });
        return { ok: true };
      }
      if ((m = path.match(/^\/api\/posts\/(\d+)$/)) && method === 'DELETE') {
        db.posts = db.posts.filter((x) => x.id !== Number(m[1]));
        return { ok: true };
      }
      if (method === 'PUT' && path === '/api/settings') {
        if (body.slots) db.settings.slots = [...new Set(body.slots)].sort();
        if (body.tz) db.settings.tz = body.tz;
        return state();
      }
      if ((m = path.match(/^\/api\/accounts\/(\w+)$/)) && method === 'DELETE') {
        delete db.accounts[m[1]];
        return state();
      }
      return { ok: true };
    },

    upload(file, onProgress) {
      return new Promise((resolve) => {
        let p = 0;
        const timer = setInterval(() => {
          p = Math.min(1, p + 0.08 + Math.random() * 0.1);
          onProgress(p);
          if (p >= 1) {
            clearInterval(timer);
            const id = `upload-${Date.now()}`;
            db.files.set(id, URL.createObjectURL(file));
            resolve({ file: id });
          }
        }, 120);
      });
    },

    fileUrl: (file) => db.files.get(file) || `media/${file}`,
    authUrl: (id) => `#connect-${id}`,
  };

  // «Подключение» соцсети в демо — без перехода на сайт платформы
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#connect-"]');
    if (!a) return;
    e.preventDefault();
    const id = a.getAttribute('href').slice('#connect-'.length);
    db.accounts[id] = id === 'x' ? '@my_x' : `my_${id}`;
    window.pppRefresh?.();
  }, true);
})();
