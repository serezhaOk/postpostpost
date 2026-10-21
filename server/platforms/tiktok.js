import fs from 'node:fs';
import { config } from '../config.js';
import { getCredentials } from '../db.js';
import { request } from './http.js';

// TikTok Content Posting API.
// mode=inbox  — видео уходит во «Входящие» TikTok, пользователь публикует его одним нажатием в приложении.
//               Работает без аудита приложения.
// mode=direct — сразу публичный пост. Требует пройденного аудита TikTok, иначе доступно только SELF_ONLY.
const creds = () => getCredentials('tiktok');
const mode = config.tiktokMode;
const API = 'https://open.tiktokapis.com/v2';
const MB = 1024 * 1024;

function chunking(size) {
  // Правила TikTok: куски от 5 до 64 МБ (последний — до 128 МБ), файл до 64 МБ можно одним куском
  if (size <= 64 * MB) return { chunk_size: size, total_chunk_count: 1 };
  const chunk = 10 * MB;
  return { chunk_size: chunk, total_chunk_count: Math.floor(size / chunk) };
}

async function token(form) {
  const { data } = await request(`${API}/oauth/token/`, { form: { client_key: creds().id, client_secret: creds().secret, ...form } });
  if (data.error) throw new Error(`TikTok: ${data.error_description || data.error}`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export default {
  id: 'tiktok',
  label: 'TikTok',
  short: 'TT',
  configured: () => Boolean(creds().id && creds().secret),
  note: () => (mode === 'direct' ? null : 'Видео придёт во «Входящие» TikTok — опубликуйте его одним нажатием'),

  authUrl({ state, redirectUri }) {
    const q = new URLSearchParams({
      client_key: creds().id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'user.info.basic,video.upload,video.publish,video.list',
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
  },

  async connect({ code, redirectUri }) {
    const t = await token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
    const { data } = await request(`${API}/user/info/?fields=display_name`, { token: t.access_token });
    return { ...t, name: data.data?.user?.display_name || 'TikTok' };
  },

  refresh: (acc) => token({ grant_type: 'refresh_token', refresh_token: acc.refresh_token }),

  async publish({ post, acc, filePath }) {
    const size = fs.statSync(filePath).size;
    const source_info = { source: 'FILE_UPLOAD', video_size: size, ...chunking(size) };
    const endpoint = mode === 'direct' ? `${API}/post/publish/video/init/` : `${API}/post/publish/inbox/video/init/`;
    const body = mode === 'direct'
      ? { source_info, post_info: { title: post.caption.slice(0, 2200), privacy_level: 'PUBLIC_TO_EVERYONE' } }
      : { source_info };
    const { data } = await request(endpoint, { token: acc.access_token, json: body });
    const { upload_url, publish_id } = data.data;

    const blob = await fs.openAsBlob(filePath);
    const { chunk_size, total_chunk_count } = source_info;
    for (let i = 0; i < total_chunk_count; i++) {
      const start = i * chunk_size;
      const end = i === total_chunk_count - 1 ? size : start + chunk_size;
      await request(upload_url, {
        method: 'PUT',
        body: blob.slice(start, end),
        headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end - 1}/${size}` },
      });
    }
    return { status: 'processing', state: { publishId: publish_id } };
  },

  async check({ job, acc }) {
    const { data } = await request(`${API}/post/publish/status/fetch/`, { token: acc.access_token, json: { publish_id: job.state.publishId } });
    const s = data.data;
    if (s.status === 'FAILED') throw new Error(`TikTok: ${s.fail_reason}`);
    if (s.status === 'SEND_TO_USER_INBOX') return { status: 'draft' };
    if (s.status === 'PUBLISH_COMPLETE') {
      const id = s.publicaly_available_post_id?.[0];
      return { status: 'done', remote_id: id ? String(id) : null, url: id ? `https://www.tiktok.com/video/${id}` : null };
    }
    return { status: 'processing' };
  },

  async stats({ ids, acc }) {
    const out = {};
    for (let i = 0; i < ids.length; i += 20) {
      const { data } = await request(`${API}/video/query/?fields=id,view_count,like_count,comment_count,share_count`, {
        token: acc.access_token, json: { filters: { video_ids: ids.slice(i, i + 20) } },
      });
      for (const v of data.data?.videos || []) {
        out[v.id] = { views: v.view_count || 0, likes: v.like_count || 0, comments: v.comment_count || 0, shares: v.share_count || 0 };
      }
    }
    return out;
  },
};
