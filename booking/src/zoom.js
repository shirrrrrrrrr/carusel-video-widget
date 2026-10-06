// Zoom meeting creation via Server-to-Server OAuth (optional).
import { config } from './config.js';

let cached = null;
export const zoomConfigured = () => Boolean(config.zoom.accountId && config.zoom.clientId && config.zoom.clientSecret);

async function token() {
  if (cached && cached.exp > Date.now()) return cached.token;
  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(config.zoom.accountId)}`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${config.zoom.clientId}:${config.zoom.clientSecret}`).toString('base64')}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Zoom auth: ${data.reason || data.error || res.status}`);
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

export async function createZoomMeeting({ topic, start, duration, timezone, agenda }) {
  const res = await fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      topic: topic.slice(0, 200), type: 2, start_time: new Date(start).toISOString(), duration, timezone,
      agenda: (agenda || '').slice(0, 2000),
      settings: { join_before_host: false, waiting_room: true },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Zoom: ${data.message || res.status}`);
  return { id: String(data.id), joinUrl: data.join_url };
}

export async function deleteZoomMeeting(id) {
  const res = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${await token()}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Zoom delete: ${res.status}`);
}
