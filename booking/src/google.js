// Google OAuth + Calendar + Gmail over plain REST (fetch).
import { config } from './config.js';
import { all, get, run } from './db.js';
import { decrypt, encrypt, randomToken, sign } from './crypto.js';

const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.send',
];
const CAL = 'https://www.googleapis.com/calendar/v3';

export const redirectUri = () => `${config.baseUrl}/admin/google/callback`;
export const googleConfigured = () => Boolean(config.google.clientId && config.google.clientSecret);

export function authUrl() {
  const state = sign(`${Date.now()}:${randomToken(8)}`);
  const q = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, state };
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token error: ${data.error_description || data.error || res.status}`);
  return data;
}

/** Finish the OAuth flow: store/refresh the account and import its calendars. */
export async function handleCallback(code) {
  const tok = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tok.access_token}` },
  })).json();
  if (!info.email) throw new Error('Could not read the Google account email');
  const existing = await get('SELECT id, refresh_token FROM google_accounts WHERE email = ?', info.email);
  const refresh = tok.refresh_token ? encrypt(tok.refresh_token) : existing?.refresh_token;
  if (!refresh) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  const expires = Date.now() + (tok.expires_in - 60) * 1000;
  let id;
  if (existing) {
    await run('UPDATE google_accounts SET name=?, refresh_token=?, access_token=?, access_expires=?, scopes=?, last_error=NULL WHERE id=?',
      info.name || '', refresh, encrypt(tok.access_token), expires, tok.scope || '', existing.id);
    id = existing.id;
  } else {
    id = Number((await run('INSERT INTO google_accounts(email,name,refresh_token,access_token,access_expires,scopes,created_at) VALUES(?,?,?,?,?,?,?)',
      info.email, info.name || '', refresh, encrypt(tok.access_token), expires, tok.scope || '', Date.now())).lastInsertRowid);
  }
  await syncCalendars(id);
  return id;
}

export async function accessToken(accountId) {
  const acc = await get('SELECT * FROM google_accounts WHERE id = ?', accountId);
  if (!acc) throw new Error(`Google account ${accountId} not found`);
  if (acc.access_token && acc.access_expires > Date.now()) return decrypt(acc.access_token);
  try {
    const tok = await tokenRequest({ refresh_token: decrypt(acc.refresh_token), grant_type: 'refresh_token' });
    await run('UPDATE google_accounts SET access_token=?, access_expires=?, last_error=NULL WHERE id=?',
      encrypt(tok.access_token), Date.now() + (tok.expires_in - 60) * 1000, accountId);
    return tok.access_token;
  } catch (e) {
    await run('UPDATE google_accounts SET last_error=? WHERE id=?', e.message, accountId);
    throw new Error(`${acc.email}: ${e.message}`);
  }
}

async function gfetch(accountId, url, opts = {}) {
  const token = await accessToken(accountId);
  const res = await fetch(url, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 204 || res.status === 410) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

export async function syncCalendars(accountId) {
  const data = await gfetch(accountId, `${CAL}/users/me/calendarList?maxResults=250`);
  const seen = [];
  for (const c of data.items || []) {
    seen.push(c.id);
    const isNew = !await get('SELECT 1 FROM calendars WHERE account_id=? AND calendar_id=?', accountId, c.id);
    await run(`INSERT INTO calendars(account_id, calendar_id, summary, is_primary, access_role, check_conflicts)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(account_id, calendar_id) DO UPDATE SET summary=excluded.summary, is_primary=excluded.is_primary, access_role=excluded.access_role`,
      accountId, c.id, c.summaryOverride || c.summary || c.id, c.primary ? 1 : 0, c.accessRole || '',
      // By default check conflicts on calendars you own/write; skip read-only subscribed ones (holidays etc.)
      isNew ? (['owner', 'writer'].includes(c.accessRole) ? 1 : 0) : 0);
  }
  // Drop calendars that disappeared from the account
  for (const c of await all('SELECT id, calendar_id FROM calendars WHERE account_id=?', accountId)) {
    if (!seen.includes(c.calendar_id)) await run('DELETE FROM calendars WHERE id=?', c.id);
  }
}

/**
 * Busy intervals across ALL calendars marked check_conflicts, across ALL connected accounts.
 * Throws if any account fails — we prefer to show no times over risking a double booking.
 */
export async function getBusy(timeMinMs, timeMaxMs) {
  const cals = await all('SELECT * FROM calendars WHERE check_conflicts = 1');
  const byAccount = new Map();
  for (const c of cals) {
    if (!byAccount.has(c.account_id)) byAccount.set(c.account_id, []);
    byAccount.get(c.account_id).push(c.calendar_id);
  }
  const results = await Promise.all([...byAccount].map(async ([accountId, ids]) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const data = await gfetch(accountId, `${CAL}/freeBusy`, {
        method: 'POST',
        body: JSON.stringify({
          timeMin: new Date(timeMinMs).toISOString(),
          timeMax: new Date(timeMaxMs).toISOString(),
          items: ids.slice(i, i + 50).map((id) => ({ id })),
        }),
      });
      for (const [calId, v] of Object.entries(data.calendars || {})) {
        if (v.errors?.length) throw new Error(`Calendar ${calId}: ${v.errors[0].reason}`);
        for (const b of v.busy || []) out.push([Date.parse(b.start), Date.parse(b.end)]);
      }
    }
    return out;
  }));
  return results.flat();
}

export async function createEvent(calendarRow, event, { meet = false } = {}) {
  const body = { ...event };
  if (meet) body.conferenceData = { createRequest: { requestId: randomToken(12), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  const q = new URLSearchParams({ sendUpdates: 'all', conferenceDataVersion: meet ? '1' : '0' });
  return gfetch(calendarRow.account_id, `${CAL}/calendars/${encodeURIComponent(calendarRow.calendar_id)}/events?${q}`, {
    method: 'POST', body: JSON.stringify(body),
  });
}

export async function deleteEvent(calendarRow, eventId) {
  return gfetch(calendarRow.account_id,
    `${CAL}/calendars/${encodeURIComponent(calendarRow.calendar_id)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: 'DELETE' });
}

/** Send an email through the Gmail API of a connected account. */
export async function gmailSend(accountId, { to, subject, html, text, replyTo }) {
  const acc = await get('SELECT email, name FROM google_accounts WHERE id=?', accountId);
  const boundary = `b_${randomToken(8)}`;
  const enc = (s) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  const mime = [
    `From: ${enc(acc.name || acc.email)} <${acc.email}>`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${enc(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(text || '').toString('base64'),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(html || '').toString('base64'),
    `--${boundary}--`,
  ].filter((l) => l !== null).join('\r\n');
  return gfetch(accountId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }),
  });
}
