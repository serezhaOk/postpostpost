import fs from 'node:fs';
import { getCredentials } from '../db.js';
import { request } from './http.js';

// X API v2, OAuth 2.0 с PKCE. Загрузка видео кусками через /2/media/upload.
const creds = () => getCredentials('x');
const API = 'https://api.x.com/2';
const CHUNK = 4 * 1024 * 1024;

const basic = () => `Basic ${Buffer.from(`${creds().id}:${creds().secret}`).toString('base64')}`;

async function token(form) {
  const { data } = await request(`${API}/oauth2/token`, { form, headers: { Authorization: basic() } });
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 };
}

async function tweet(text, mediaId, acc) {
  const { data } = await request(`${API}/tweets`, { token: acc.access_token, json: { ...(text ? { text } : {}), media: { media_ids: [mediaId] } } });
  const id = data.data.id;
  return { status: 'done', remote_id: id, url: `https://x.com/i/status/${id}` };
}

export default {
  id: 'x',
  label: 'X (Twitter)',
  short: 'X',
  pkce: true,
  configured: () => Boolean(creds().id && creds().secret),

  authUrl({ state, redirectUri, challenge }) {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: creds().id,
      redirect_uri: redirectUri,
      scope: 'tweet.read tweet.write users.read media.write offline.access',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `https://x.com/i/oauth2/authorize?${q}`;
  },

  async connect({ code, redirectUri, verifier }) {
    const t = await token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier });
    const { data } = await request(`${API}/users/me`, { token: t.access_token });
    return { ...t, name: `@${data.data.username}` };
  },

  refresh: (acc) => token({ grant_type: 'refresh_token', refresh_token: acc.refresh_token }),

  async publish({ post, acc, filePath }) {
    const size = fs.statSync(filePath).size;
    const { data: init } = await request(`${API}/media/upload/initialize`, {
      token: acc.access_token, json: { media_type: 'video/mp4', total_bytes: size, media_category: 'tweet_video' },
    });
    const mediaId = init.data.id;
    const blob = await fs.openAsBlob(filePath);
    for (let i = 0, seg = 0; i < size; i += CHUNK, seg++) {
      const form = new FormData();
      form.append('segment_index', String(seg));
      form.append('media', blob.slice(i, i + CHUNK), 'chunk.mp4');
      await request(`${API}/media/upload/${mediaId}/append`, { method: 'POST', token: acc.access_token, body: form });
    }
    const { data: fin } = await request(`${API}/media/upload/${mediaId}/finalize`, { method: 'POST', token: acc.access_token });
    const text = post.caption.slice(0, 280);
    if (!fin.data?.processing_info || fin.data.processing_info.state === 'succeeded') return tweet(text, mediaId, acc);
    return { status: 'processing', state: { mediaId, text } };
  },

  async check({ job, acc }) {
    const { mediaId, text } = job.state;
    const { data } = await request(`${API}/media/upload?command=STATUS&media_id=${mediaId}`, { token: acc.access_token });
    const p = data.data?.processing_info;
    if (p?.state === 'failed') throw new Error(`X: ${p.error?.message || 'обработка видео не удалась'}`);
    if (p && p.state !== 'succeeded') return { status: 'processing' };
    return tweet(text, mediaId, acc);
  },

  async stats({ ids, acc }) {
    const out = {};
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await request(`${API}/tweets?ids=${ids.slice(i, i + 100).join(',')}&tweet.fields=public_metrics`, { token: acc.access_token });
      for (const t of data.data || []) {
        const m = t.public_metrics;
        out[t.id] = { views: m.impression_count || 0, likes: m.like_count || 0, comments: m.reply_count || 0, shares: m.retweet_count || 0 };
      }
    }
    return out;
  },
};
