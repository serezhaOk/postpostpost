import { getCredentials } from '../db.js';
import { request } from './http.js';

// Instagram API with Instagram Login: нужен профессиональный аккаунт (Business или Creator)
const creds = () => getCredentials('instagram');
const GRAPH = 'https://graph.instagram.com/v23.0';

export default {
  id: 'instagram',
  label: 'Instagram Reels',
  short: 'IG',
  configured: () => Boolean(creds().id && creds().secret),

  authUrl({ state, redirectUri }) {
    const q = new URLSearchParams({
      client_id: creds().id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'instagram_business_basic,instagram_business_content_publish',
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${q}`;
  },

  async connect({ code, redirectUri }) {
    const { data: short } = await request('https://api.instagram.com/oauth/access_token', {
      form: { client_id: creds().id, client_secret: creds().secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code },
    });
    // Обмениваем короткий токен (1 час) на долгий (60 дней)
    const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: creds().secret, access_token: short.access_token });
    const { data: long } = await request(`https://graph.instagram.com/access_token?${q}`);
    const { data: me } = await request(`${GRAPH}/me?fields=user_id,username`, { token: long.access_token });
    return {
      name: `@${me.username}`,
      access_token: long.access_token,
      expires_at: Date.now() + long.expires_in * 1000,
      extra: { userId: me.user_id || short.user_id },
    };
  },

  async refresh(acc) {
    const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: acc.access_token });
    const { data } = await request(`https://graph.instagram.com/refresh_access_token?${q}`);
    return { access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 };
  },

  // Instagram сам скачивает видео по публичной ссылке, поэтому сервер должен быть доступен из интернета
  async publish({ post, acc, mediaUrl }) {
    const { data } = await request(`${GRAPH}/${acc.extra.userId}/media`, {
      token: acc.access_token,
      json: { media_type: 'REELS', video_url: mediaUrl, caption: post.caption, share_to_feed: true },
    });
    return { status: 'processing', state: { containerId: data.id } };
  },

  async check({ job, acc }) {
    const { containerId } = job.state;
    const { data } = await request(`${GRAPH}/${containerId}?fields=status_code,status`, { token: acc.access_token });
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') throw new Error(`Instagram: ${data.status || data.status_code}`);
    if (data.status_code !== 'FINISHED') return { status: 'processing' };
    const { data: pub } = await request(`${GRAPH}/${acc.extra.userId}/media_publish`, {
      token: acc.access_token, json: { creation_id: containerId },
    });
    const { data: media } = await request(`${GRAPH}/${pub.id}?fields=permalink`, { token: acc.access_token });
    return { status: 'done', remote_id: pub.id, url: media.permalink };
  },

  async stats({ ids, acc }) {
    const out = {};
    for (const id of ids) {
      try {
        const { data } = await request(`${GRAPH}/${id}/insights?metric=views,likes,comments,shares,saved`, { token: acc.access_token });
        const v = Object.fromEntries((data.data || []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value ?? 0]));
        out[id] = { views: v.views || 0, likes: v.likes || 0, comments: v.comments || 0, shares: v.shares || 0 };
      } catch (err) {
        console.warn(`instagram stats ${id}: ${err.message}`);
      }
    }
    return out;
  },
};
