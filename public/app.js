'use strict';

// ---------- связь с сервером (в демо подменяется window.PPP_DEMO) ----------

const backend = window.PPP_DEMO || {
  async call(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw Object.assign(new Error(data.error || 'Нужен вход'), { auth: true });
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
  upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/upload?name=${encodeURIComponent(file.name || 'video.mp4')}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status === 200 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(`Загрузка не удалась (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Нет связи с сервером'));
      xhr.send(file);
    });
  },
  fileUrl: (file) => `/files/${file}`,
  authUrl: (id) => `/auth/${id}/start`,
};

// ---------- состояние ----------

const store = { state: null, stats: null, view: 'queue', error: null, rendered: '' };
const $app = document.getElementById('app');
const picker = document.getElementById('picker');

const STATUS = {
  pending: 'В очереди', running: 'Загружается', processing: 'Обрабатывается',
  done: 'Опубликовано', draft: 'Во «Входящих» TikTok', failed: 'Ошибка',
};

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 20V11M12 20V4M19 20v-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const platformById = (id) => store.state.platforms.find((p) => p.id === id) || { short: id, label: id };
const connected = () => store.state.platforms.filter((p) => p.connected);

// ---------- даты ----------

const tz = () => store.state?.settings.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayKey = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

function fmtWhen(ts) {
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: tz(), hour: '2-digit', minute: '2-digit' }).format(ts);
  const d = dayKey(ts);
  const now = Date.now();
  if (d === dayKey(now)) return `Сегодня, ${time}`;
  if (d === dayKey(now + 86_400_000)) return `Завтра, ${time}`;
  if (d === dayKey(now - 86_400_000)) return `Вчера, ${time}`;
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: tz(), weekday: 'short', day: 'numeric', month: 'long' }).format(ts);
  return `${date}, ${time}`;
}

const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.0', '')}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n.toLocaleString('ru-RU'));

// ---------- загрузка данных ----------

async function refresh() {
  try {
    store.state = await backend.call('GET', '/api/state');
    if (store.view === 'stats') store.stats = await backend.call('GET', '/api/stats');
    render();
  } catch (err) {
    if (err.auth) return renderLogin();
    toast(err.message);
  }
}

function go(view) {
  store.view = view;
  history.replaceState(null, '', view === 'queue' ? location.pathname : `${location.pathname}#${view}`);
  window.scrollTo(0, 0);
  if (view === 'stats') store.stats = null;
  render();
  refresh();
}

// ---------- экраны ----------

function render() {
  if (!store.state) return;
  const html = store.view === 'settings' ? viewSettings() : store.view === 'stats' ? viewStats() : viewQueue();
  // Не трогаем DOM без изменений — иначе превью видео перезагружаются при каждом опросе
  if (html === store.rendered) return;
  store.rendered = html;
  $app.innerHTML = html;
}

function header(title) {
  if (title) {
    return `<header class="top">
      <button class="icon-btn" data-go="queue" aria-label="Назад">${ICONS.back}</button>
      <div class="logo">${title}</div><div style="width:40px"></div></header>`;
  }
  return `<header class="top">
    <div class="logo">postpostpost</div>
    <div class="top-actions"><button class="icon-btn" data-go="stats" aria-label="Статистика">${ICONS.chart}</button><button class="icon-btn" data-go="settings" aria-label="Настройки">${ICONS.gear}</button></div>
  </header>`;
}

function postStatus(p) {
  const s = p.jobs.map((j) => j.status);
  if (s.includes('failed') || s.includes('draft')) return 'attention';
  if (s.length && s.every((x) => x === 'done')) return 'done';
  return 'queued';
}

function card(p) {
  const pills = p.jobs.map((j) => `<span class="pill" title="${esc(STATUS[j.status])}"><span class="dot ${j.status}"></span>${esc(platformById(j.platform).short)}</span>`).join('');
  return `<button class="card" data-post="${p.id}">
    <video class="thumb" src="${backend.fileUrl(p.file)}#t=0.1" preload="metadata" muted playsinline></video>
    <div class="card-body">
      <div class="when">${fmtWhen(p.scheduled_at)}</div>
      ${p.caption ? `<div class="caption">${esc(p.caption)}</div>` : ''}
      <div class="pills">${pills}</div>
    </div>
  </button>`;
}

function viewQueue() {
  const { posts, nextSlot, demo } = store.state;
  const groups = Object.groupBy(posts, postStatus);
  const queued = (groups.queued || []).sort((a, b) => a.scheduled_at - b.scheduled_at);
  const attention = groups.attention || [];
  const done = (groups.done || []).slice(0, 30);
  const noAccounts = !connected().length;

  let body = '';
  if (demo) body += '<div class="banner">Демо-режим: публикация имитируется, соцсети не трогаем.</div>';
  if (noAccounts) {
    body += `<div class="empty"><div class="empty-title">Подключите соцсети</div>
      Один раз — и дальше только кидаете видео.<br><br>
      <button class="btn-sm dark" data-go="settings">Подключить</button></div>`;
  } else if (!posts.length) {
    body += `<div class="empty"><div class="empty-title">Очередь пуста</div>
      Нажмите «Видео» — оно выйдет в ближайший слот:<br><b>${esc(fmtWhen(nextSlot))}</b></div>`;
  } else {
    body += `<p class="hint">Следующий свободный слот: <b>${esc(fmtWhen(nextSlot))}</b></p>`;
  }
  if (attention.length) body += `<h2>Нужно ваше действие</h2><div class="list">${attention.map(card).join('')}</div>`;
  if (queued.length) body += `<h2>В очереди · ${queued.length}</h2><div class="list">${queued.map(card).join('')}</div>`;
  if (done.length) body += `<h2>Опубликовано</h2><div class="list">${done.map(card).join('')}</div>`;

  return `<div class="wrap">${header()}${body}</div>
    <div class="dock"><button class="fab" data-action="pick">${ICONS.plus}Видео</button></div>`;
}

function viewSettings() {
  const { platforms, settings, demo } = store.state;
  const err = new URLSearchParams(location.hash.split('?')[1] || '').get('error');
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const accounts = platforms.map((p) => {
    let action;
    if (p.connected) action = `<button class="btn-sm" data-disconnect="${p.id}">Отключить</button>`;
    else if (p.configured) action = `<a class="btn-sm dark" href="${backend.authUrl(p.id)}">Подключить</a>`;
    else action = '<span class="row-sub">нет ключей API</span>';
    const sub = p.connected ? esc(p.account) : 'Не подключено';
    return `<div class="row">
      <div class="badge ${p.connected ? 'on' : ''}">${esc(p.short)}</div>
      <div class="row-main"><div class="row-title">${esc(p.label)}</div><div class="row-sub">${sub}${p.note && p.connected ? `<br>${esc(p.note)}` : ''}</div></div>
      ${action}</div>`;
  }).join('');

  const slots = settings.slots.map((s) => `<button class="chip on" data-slot-remove="${s}">${s}<span class="x">✕</span></button>`).join('');

  return `<div class="wrap">${header('Настройки')}
    ${err ? `<div class="banner error-banner">Не удалось подключить: ${esc(err)}</div>` : ''}
    <h2>Соцсети</h2>
    <div class="rows">${accounts}
      <div class="row"><div class="badge">R</div><div class="row-main"><div class="row-title">Reddit</div><div class="row-sub">Скоро</div></div></div>
    </div>
    <h2>Публиковать каждый день в</h2>
    <div class="rows">
      <div class="slots">${slots}<input class="time-input" type="time" data-slot-add aria-label="Добавить время"></div>
      <div class="row"><div class="row-main"><div class="row-title">Часовой пояс</div><div class="row-sub">${esc(settings.tz)}</div></div>
        ${deviceTz !== settings.tz ? `<button class="btn-sm" data-tz="${esc(deviceTz)}">Как на телефоне</button>` : ''}</div>
    </div>
    <p class="hint">Новое видео встаёт в ближайший свободный слот. ${settings.slots.length} ${plural(settings.slots.length, 'видео', 'видео', 'видео')} в день.</p>
    ${demo ? '' : '<h2>Аккаунт</h2><div class="rows"><div class="row"><div class="row-main row-title">Выйти</div><button class="btn-sm" data-action="logout">Выйти</button></div></div>'}
  </div>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function viewStats() {
  const s = store.stats;
  if (!s) return `<div class="wrap">${header('Статистика')}<p class="hint">Загружаем…</p></div>`;
  const kpi = (v, label) => `<div class="kpi"><div class="kpi-value">${fmtNum(v)}</div><div class="kpi-label">${label}</div></div>`;
  const rows = Object.entries(s.byPlatform).sort((a, b) => b[1].views - a[1].views).map(([id, v]) => {
    const p = platformById(id);
    return `<div class="row"><div class="badge on">${esc(p.short)}</div><div class="row-main row-title">${esc(p.label)}</div>
      <div class="num">${fmtNum(v.views)}<small>${fmtNum(v.likes)} ♥</small></div></div>`;
  }).join('');
  const top = s.top.map((t) => `<button class="row" data-post="${t.id}" style="width:100%;text-align:left">
    <video class="thumb" style="width:36px;height:64px" src="${backend.fileUrl(t.file)}#t=0.1" preload="metadata" muted playsinline></video>
    <div class="row-main"><div class="caption" style="color:var(--text)">${esc(t.caption || 'Без подписи')}</div></div>
    <div class="num">${fmtNum(t.views)}<small>просм.</small></div></button>`).join('');
  const empty = !rows;
  return `<div class="wrap">${header('Статистика')}
    <div class="kpis">${kpi(s.totals.views, 'просмотров')}${kpi(s.totals.likes, 'лайков')}${kpi(s.totals.comments, 'комментариев')}${kpi(s.totals.shares, 'репостов')}</div>
    ${empty ? '<p class="hint" style="margin-top:20px">Цифры появятся после первых публикаций. Обновляются раз в 30 минут.</p>' : `
      <h2>По площадкам</h2><div class="rows">${rows}</div>
      <h2>Лучшие видео</h2><div class="rows">${top}</div>
      <p class="hint">За последние 30 дней, обновляется раз в 30 минут.</p>`}
  </div>`;
}

function renderLogin() {
  store.rendered = '';
  $app.innerHTML = `<form class="login" data-form="login">
    <div class="logo">postpostpost</div>
    <input class="field" type="password" name="password" placeholder="Пароль" autocomplete="current-password" autofocus>
    <button class="btn">Войти</button>
  </form>`;
}

// ---------- нижние листы ----------

let sheetEl = null;
function openSheet(html, onClick) {
  closeSheet();
  sheetEl = document.createElement('div');
  sheetEl.innerHTML = `<div class="sheet-bg"></div><div class="sheet" role="dialog"><div class="grip"></div>${html}</div>`;
  sheetEl.querySelector('.sheet-bg').onclick = closeSheet;
  sheetEl.querySelector('.sheet').addEventListener('click', onClick);
  document.body.append(sheetEl);
  return sheetEl.querySelector('.sheet');
}
function closeSheet() {
  sheetEl?.querySelectorAll('video').forEach((v) => v.pause());
  sheetEl?.remove();
  sheetEl = null;
}

// Главный сценарий: выбрали видео → (подпись) → «Запланировать». Загрузка идёт сразу, пока вы пишете подпись.
function openCompose(file) {
  const accs = connected();
  if (!accs.length) { toast('Сначала подключите соцсети'); return go('settings'); }
  let remembered = null;
  try { remembered = JSON.parse(localStorage.getItem('ppp.platforms')); } catch { /* приватный режим */ }
  const chosen = new Set((remembered || []).filter((id) => accs.some((a) => a.id === id)));
  if (!chosen.size) accs.forEach((a) => chosen.add(a.id));

  const c = { uploaded: null, progress: 0, error: null, when: 'slot', custom: null, waiting: false, busy: false };
  const previewUrl = URL.createObjectURL(file);

  const sheet = openSheet(`
    <div class="compose">
      <div class="preview"><video src="${previewUrl}" muted playsinline autoplay loop></video>
        <div class="progress" style="width:0"></div><div class="progress-label">0%</div></div>
      <textarea rows="6" placeholder="Подпись и хэштеги — необязательно"></textarea>
    </div>
    <div class="chips">${accs.map((a) => `<button class="chip ${chosen.has(a.id) ? 'on' : ''}" data-platform="${a.id}">${esc(a.label)}</button>`).join('')}</div>
    <div class="seg">
      <button class="on" data-when="slot">В очередь</button>
      <button data-when="now">Сейчас</button>
      <button data-when="custom">Время…</button>
    </div>
    <input class="field" type="datetime-local" hidden>
    <button class="btn" data-action="submit"></button>`, onClick);

  const $ = (sel) => sheet.querySelector(sel);
  const dt = $('input[type=datetime-local]');
  dt.onchange = () => { c.custom = dt.value ? new Date(dt.value).getTime() : null; update(); };

  function label() {
    if (c.error) return 'Повторить загрузку';
    if (c.waiting) return `Отправим после загрузки · ${Math.round(c.progress * 100)}%`;
    if (c.when === 'now') return 'Опубликовать сейчас';
    if (c.when === 'custom') return c.custom ? `Запланировать · ${fmtWhen(c.custom)}` : 'Выберите время';
    return `Запланировать · ${fmtWhen(store.state.nextSlot)}`;
  }

  function update() {
    const pct = Math.round(c.progress * 100);
    $('.progress').style.width = `${pct}%`;
    $('.progress-label').textContent = c.error ? 'Ошибка' : c.uploaded ? '✓' : `${pct}%`;
    $('[data-action=submit]').textContent = label();
    $('[data-action=submit]').disabled = c.busy || !chosen.size || (c.when === 'custom' && !c.custom);
    sheet.querySelectorAll('[data-platform]').forEach((b) => b.classList.toggle('on', chosen.has(b.dataset.platform)));
    sheet.querySelectorAll('[data-when]').forEach((b) => b.classList.toggle('on', b.dataset.when === c.when));
    dt.hidden = c.when !== 'custom';
  }

  function startUpload() {
    c.error = null;
    backend.upload(file, (p) => { c.progress = p; update(); })
      .then((r) => { c.uploaded = r.file; c.progress = 1; update(); if (c.waiting) submit(); })
      .catch((err) => { c.error = err.message; c.waiting = false; update(); toast(err.message); });
  }

  async function submit() {
    if (c.error) { startUpload(); return update(); }
    if (!c.uploaded) { c.waiting = true; return update(); }
    c.busy = true;
    update();
    try {
      const when = c.when === 'custom' ? c.custom : c.when;
      const res = await backend.call('POST', '/api/posts', { file: c.uploaded, caption: $('textarea').value.trim(), platforms: [...chosen], when });
      try { localStorage.setItem('ppp.platforms', JSON.stringify([...chosen])); } catch { /* не страшно */ }
      closeSheet();
      URL.revokeObjectURL(previewUrl);
      toast(when === 'now' ? 'Публикуем…' : `В очереди: ${fmtWhen(res.scheduled_at)}`);
      refresh();
    } catch (err) {
      c.busy = false;
      c.waiting = false;
      update();
      toast(err.message);
    }
  }

  function onClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.platform) {
      chosen.has(t.dataset.platform) ? chosen.delete(t.dataset.platform) : chosen.add(t.dataset.platform);
    } else if (t.dataset.when) {
      c.when = t.dataset.when;
      if (c.when === 'custom' && !dt.value) {
        const d = new Date(store.state.nextSlot);
        dt.value = new Date(d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        c.custom = store.state.nextSlot;
      }
    } else if (t.dataset.action === 'submit') {
      return submit();
    }
    update();
  }

  update();
  startUpload();
}

function openPost(id) {
  const p = store.state.posts.find((x) => x.id === id);
  if (!p) return;
  const rows = p.jobs.map((j) => {
    const pl = platformById(j.platform);
    let sub = STATUS[j.status];
    if (j.status === 'draft') sub = 'Откройте TikTok → Входящие → Опубликовать';
    if (j.status === 'pending' && j.error) sub = 'Повторим через несколько минут';
    const stats = j.stats ? ` · ${fmtNum(j.stats.views)} просм.` : '';
    return `<div class="link-row"><div><div class="row-title"><span class="dot ${j.status}" style="display:inline-block;margin-right:6px"></span>${esc(pl.label)}</div>
      <div class="sub">${esc(sub)}${stats}</div>${j.error ? `<div class="err">${esc(j.error)}</div>` : ''}</div>
      ${j.url ? `<a class="btn-sm" href="${esc(j.url)}" target="_blank" rel="noopener">Открыть</a>` : ''}</div>`;
  }).join('');
  const status = postStatus(p);
  const canNow = p.jobs.some((j) => j.status === 'pending') && p.scheduled_at > Date.now();
  const hasFailed = p.jobs.some((j) => j.status === 'failed');

  openSheet(`
    <div class="compose">
      <div class="preview"><video src="${backend.fileUrl(p.file)}" playsinline controls preload="metadata"></video></div>
      <div style="flex:1;min-width:0"><div class="sheet-title">${esc(fmtWhen(p.scheduled_at))}</div>
        <div class="caption" style="-webkit-line-clamp:8">${esc(p.caption || 'Без подписи')}</div></div>
    </div>
    <div class="links">${rows}</div>
    <div class="actions">
      ${hasFailed ? '<button class="btn" data-action="retry">Повторить</button>' : ''}
      ${canNow ? `<button class="btn ${hasFailed ? 'secondary' : ''}" data-action="now">Опубликовать сейчас</button>` : ''}
      ${status !== 'done' ? '<button class="btn danger" data-action="delete">Удалить</button>' : ''}
    </div>`, async (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (!a) return;
    if (a === 'delete' && !confirm('Удалить видео из очереди?')) return;
    try {
      if (a === 'delete') await backend.call('DELETE', `/api/posts/${p.id}`);
      else await backend.call('POST', `/api/posts/${p.id}/${a}`);
      closeSheet();
      toast({ delete: 'Удалено', now: 'Публикуем…', retry: 'Пробуем ещё раз' }[a]);
      refresh();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- мелочи ----------

let toastTimer;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

async function saveSettings(patch) {
  try {
    store.state = await backend.call('PUT', '/api/settings', patch);
    render();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- события ----------

document.addEventListener('click', async (e) => {
  if (e.target.closest('.sheet')) return;
  const t = e.target.closest('[data-go],[data-action],[data-post],[data-disconnect],[data-slot-remove],[data-tz]');
  if (!t) return;
  const d = t.dataset;
  if (d.go) return go(d.go);
  if (d.post) return openPost(Number(d.post));
  if (d.action === 'pick') { picker.value = ''; return picker.click(); }
  if (d.action === 'logout') { await backend.call('POST', '/api/logout'); return renderLogin(); }
  if (d.disconnect) {
    if (!confirm('Отключить аккаунт? Запланированные посты на эту площадку не выйдут.')) return;
    store.state = await backend.call('DELETE', `/api/accounts/${d.disconnect}`);
    return render();
  }
  if (d.slotRemove) return saveSettings({ slots: store.state.settings.slots.filter((s) => s !== d.slotRemove) });
  if (d.tz) return saveSettings({ tz: d.tz });
});

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-slot-add]') && e.target.value) {
    saveSettings({ slots: [...store.state.settings.slots, e.target.value] });
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.dataset.form !== 'login') return;
  e.preventDefault();
  try {
    await backend.call('POST', '/api/login', { password: e.target.password.value });
    await refresh();
  } catch (err) {
    toast(err.message);
  }
});

picker.addEventListener('change', () => picker.files[0] && openCompose(picker.files[0]));

// Видео, присланное через «Поделиться» из галереи (Android): сразу открываем публикацию
async function takeSharedVideo() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  const cache = await caches.open('share');
  const res = await cache.match('/shared-video');
  if (!res) return;
  await cache.delete('/shared-video');
  const name = decodeURIComponent(res.headers.get('X-Name') || 'video.mp4');
  openCompose(new File([await res.blob()], name, { type: res.headers.get('Content-Type') || 'video/mp4' }));
}

// ---------- старт ----------

(async () => {
  const hash = location.hash.slice(1).split('?')[0];
  if (hash === 'settings' || hash === 'stats') store.view = hash;
  if (!window.PPP_DEMO && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await refresh();
  if (store.state) takeSharedVideo().catch((err) => toast(err.message));
  window.pppRefresh = refresh;
  setInterval(() => document.visibilityState === 'visible' && store.state && refresh(), 10_000);
})();
