import fs from 'node:fs';
import { config } from '../config.js';
import { request, titleFrom } from './http.js';

const { clientId, clientSecret } = config.google;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export default {
  id: 'youtube',
  label: 'YouTube Shorts',
  short: 'YT',
  configured: () => Boolean(clientId && clientSecret),

  authUrl({ state, redirectUri }) {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },

  async connect({ code, redirectUri }) {
    const { data: t } = await request(TOKEN_URL, {
      form: { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' },
    });
    const { data: ch } = await request('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { token: t.access_token });
    return {
      name: ch.items?.[0]?.snippet?.title || 'YouTube',
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + t.expires_in * 1000,
    };
  },

  async refresh(acc) {
    const { data: t } = await request(TOKEN_URL, {
      form: { client_id: clientId, client_secret: clientSecret, refresh_token: acc.refresh_token, grant_type: 'refresh_token' },
    });
    return { access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 };
  },

  // Возобновляемая загрузка: сначала метаданные, потом байты файла.
  // Вертикальное видео до 3 минут YouTube сам относит к Shorts, #Shorts в описании — подсказка.
  async publish({ post, acc, filePath }) {
    const size = fs.statSync(filePath).size;
    const meta = {
      snippet: { title: titleFrom(post.caption), description: `${post.caption}\n\n#Shorts`.trim(), categoryId: '22' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    };
    const { res } = await request(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      { json: meta, token: acc.access_token, headers: { 'X-Upload-Content-Type': 'video/*', 'X-Upload-Content-Length': String(size) } },
    );
    const uploadUrl = res.headers.get('location');
    const blob = await fs.openAsBlob(filePath);
    const { data: video } = await request(uploadUrl, { method: 'PUT', body: blob, token: acc.access_token, headers: { 'Content-Type': 'video/*' } });
    return { status: 'done', remote_id: video.id, url: `https://youtube.com/shorts/${video.id}` };
  },

  async stats({ ids, acc }) {
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const q = new URLSearchParams({ part: 'statistics', id: ids.slice(i, i + 50).join(',') });
      const { data } = await request(`https://www.googleapis.com/youtube/v3/videos?${q}`, { token: acc.access_token });
      for (const v of data.items || []) {
        const s = v.statistics;
        out[v.id] = { views: +s.viewCount || 0, likes: +s.likeCount || 0, comments: +s.commentCount || 0 };
      }
    }
    return out;
  },
};
