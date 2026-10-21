// Обёртка над fetch: JSON-ответ или понятная ошибка с текстом от платформы
export async function request(url, { json, form, token, headers = {}, ...opts } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let body = opts.body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json; charset=UTF-8';
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(Object.entries(form).filter(([, v]) => v != null)).toString();
  }
  const res = await fetch(url, { ...opts, method: opts.method || (body ? 'POST' : 'GET'), headers: h, body });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error_description || data?.detail || data?.error?.code
      || (typeof data?.error === 'string' ? data.error : null) || text.slice(0, 300) || res.statusText;
    const err = new Error(`${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { data, res };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Первая строка подписи — заголовок (нужен YouTube)
export function titleFrom(caption, max = 100) {
  const first = (caption || '').split('\n')[0].trim();
  return (first || 'Новое видео').slice(0, max);
}
