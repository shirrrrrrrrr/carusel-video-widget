import { config } from '../config.js';
import { all, get, getSettings, parseRow, run, setSettings } from '../db.js';
import { parseCookies, json, redirect, setCookie, rateLimit } from '../http.js';
import { safeEqual, sign, unsign } from '../crypto.js';
import { authUrl, googleConfigured, handleCallback, syncCalendars } from '../google.js';
import { LOCATION_TYPES, cancelBooking, clearBusyCache, getBooking, userError } from '../bookings.js';
import { zoomConfigured } from '../zoom.js';
import { normalizeSchedule } from '../availability.js';
import { emailEnabled, emailLayout, sendEmail, sendWhatsApp, whatsappEnabled } from '../notify.js';
import { getTranscript, ingestTranscript, listTranscripts, requestSummary, sendSummary, storeSummary } from '../transcripts.js';
import { isValidTz } from '../time.js';

const SESSION_DAYS = 30;
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10 });
const secure = () => config.baseUrl.startsWith('https://');

export function isAdmin(req) {
  const v = unsign(parseCookies(req).admin);
  if (!v) return false;
  const [kind, exp] = v.split(':');
  return kind === 'admin' && Number(exp) > Date.now();
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw userError('Unauthorized', 401);
  // CSRF: state-changing admin calls must be same-origin JSON requests.
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) throw userError('Bad request', 400);
}

// ---------- meeting type validation ----------
const intIn = (v, min, max, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const minutesList = (v, d) => {
  const arr = (Array.isArray(v) ? v : []).map((x) => intIn(x, 1, 60 * 24 * 14, null)).filter(Boolean);
  return arr.length ? [...new Set(arr)].sort((a, b) => a - b) : d;
};
const channelList = (v) => (Array.isArray(v) ? v : []).filter((c) => ['email', 'whatsapp'].includes(c));
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9֐-׿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function sanitizeFields(fields) {
  return (Array.isArray(fields) ? fields : []).slice(0, 30).map((f, i) => ({
    id: String(f.id || `f${i + 1}`).replace(/[^\w-]/g, '').slice(0, 40) || `f${i + 1}`,
    label: String(f.label || '').slice(0, 200),
    type: ['text', 'textarea', 'email', 'phone', 'number', 'url', 'select', 'radio', 'checkbox', 'date'].includes(f.type) ? f.type : 'text',
    required: Boolean(f.required),
    placeholder: String(f.placeholder || '').slice(0, 200),
    options: ['select', 'radio'].includes(f.type) ? (Array.isArray(f.options) ? f.options : String(f.options || '').split('\n'))
      .map((o) => String(o).trim()).filter(Boolean).slice(0, 50) : [],
  })).filter((f) => f.label);
}

function sanitizeLocations(list) {
  const seen = new Set();
  const out = [];
  for (const l of Array.isArray(list) ? list : []) {
    if (!LOCATION_TYPES.includes(l?.type) || seen.has(l.type)) continue;
    seen.add(l.type);
    const value = String(l.value ?? '').trim().slice(0, 500);
    if (l.type === 'zoom' && !value && !zoomConfigured()) throw userError('Zoom: enter your personal Zoom link (or set up the Zoom API in .env so a meeting is created per booking)');
    if (l.type === 'zoom' && value && !/^https:\/\//.test(value)) throw userError('Zoom link must start with https://');
    if (l.type === 'in_person' && !value) throw userError('In person: enter the address');
    if (l.type === 'custom' && !value) throw userError('Custom location: enter the link or details');
    out.push({ type: l.type, value: l.type === 'google_meet' || l.type === 'phone' ? '' : value });
  }
  return out;
}

function sanitizeType(b, existing = {}) {
  const name = String(b.name ?? existing.name ?? '').trim().slice(0, 120);
  if (!name) throw userError('Name is required');
  const slug = slugify(b.slug || existing.slug || name);
  if (!slug) throw userError('Invalid URL slug');
  const clash = get('SELECT id FROM meeting_types WHERE slug=?', slug);
  if (clash && clash.id !== existing.id) throw userError(`The link "/book/${slug}" is already used`);
  const calendarRef = b.calendar_ref ? Number(b.calendar_ref) : null;
  if (calendarRef && !get('SELECT 1 FROM calendars WHERE id=?', calendarRef)) throw userError('Unknown calendar');
  const options = minutesList(b.client_reminder_options, []);
  return {
    slug, name,
    description: String(b.description ?? '').slice(0, 5000),
    durations: JSON.stringify(minutesList(b.durations, [30])),
    slot_mode: b.slot_mode === 'free' ? 'free' : 'interval',
    slot_interval: intIn(b.slot_interval, 5, 240, 30),
    free_granularity: intIn(b.free_granularity, 1, 60, 5),
    buffer_before: intIn(b.buffer_before, 0, 480, 0),
    buffer_after: intIn(b.buffer_after, 0, 480, 0),
    min_notice: intIn(b.min_notice, 0, 60 * 24 * 60, 240),
    max_days_ahead: intIn(b.max_days_ahead, 1, 365, 30),
    daily_limit: intIn(b.daily_limit, 0, 100, 0),
    schedule: JSON.stringify(normalizeSchedule(b.schedule)),
    calendar_ref: calendarRef,
    locations: JSON.stringify(sanitizeLocations(b.locations)),
    fields: JSON.stringify(sanitizeFields(b.fields)),
    require_phone: b.require_phone ? 1 : 0,
    client_reminder_channels: JSON.stringify(channelList(b.client_reminder_channels)),
    client_reminder_options: JSON.stringify(options),
    client_reminder_defaults: JSON.stringify(minutesList(b.client_reminder_defaults, []).filter((m) => options.includes(m))),
    owner_reminders: JSON.stringify(minutesList(b.owner_reminders, [])),
    owner_reminder_channels: JSON.stringify(channelList(b.owner_reminder_channels)),
    transcriber_enabled: b.transcriber_enabled ? 1 : 0,
    transcriber_email: String(b.transcriber_email ?? '').trim().slice(0, 200),
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#4f46e5',
    active: b.active === false || b.active === 0 ? 0 : 1,
    position: intIn(b.position, 0, 10_000, 0),
  };
}

function adminState() {
  const s = getSettings();
  return {
    settings: s,
    accounts: all('SELECT id, email, name, last_error, created_at FROM google_accounts ORDER BY id'),
    calendars: all('SELECT c.*, a.email AS account_email FROM calendars c JOIN google_accounts a ON a.id=c.account_id ORDER BY a.id, c.is_primary DESC, c.summary'),
    types: all('SELECT * FROM meeting_types ORDER BY position, id').map((t) => parseRow('meeting_types', t)),
    status: {
      googleConfigured: googleConfigured(),
      redirectUri: `${config.baseUrl}/admin/google/callback`,
      emailProvider: config.email.provider, emailEnabled: emailEnabled(),
      whatsappProvider: config.whatsapp.provider, whatsappEnabled: whatsappEnabled(),
      summaryConfigured: Boolean(config.transcripts.summaryUrl),
      zoomConfigured: zoomConfigured(),
      webhookConfigured: Boolean(config.transcripts.webhookSecret),
      firefliesConfigured: Boolean(config.transcripts.firefliesKey),
      baseUrl: config.baseUrl,
      webhooks: {
        transcript: `${config.baseUrl}/api/webhooks/transcript?key=…`,
        contreal: `${config.baseUrl}/api/webhooks/contreal?key=…`,
        fireflies: `${config.baseUrl}/api/webhooks/fireflies`,
        summary: `${config.baseUrl}/api/webhooks/summary?key=…`,
      },
    },
  };
}

export function mountAdmin(r) {
  // ---------- auth ----------
  r.post('/api/admin/login', (req, res) => {
    if (!loginLimiter(req)) throw userError('Too many attempts, try again later', 429);
    if (!config.adminPassword || !safeEqual(String(req.body?.password || ''), config.adminPassword)) throw userError('Wrong password', 401);
    setCookie(res, 'admin', sign(`admin:${Date.now() + SESSION_DAYS * 86_400_000}`), { maxAge: SESSION_DAYS * 86_400, secure: secure(), sameSite: 'Lax' });
    json(res, 200, { ok: true });
  });
  r.post('/api/admin/logout', (req, res) => { setCookie(res, 'admin', '', { maxAge: 0 }); json(res, 200, { ok: true }); });

  r.get('/api/admin/state', (req, res) => { requireAdmin(req); json(res, 200, adminState()); });

  r.put('/api/admin/settings', (req, res) => {
    requireAdmin(req);
    const b = req.body || {};
    if (b.timezone && !isValidTz(b.timezone)) throw userError('Unknown timezone');
    if (b.default_calendar && !get('SELECT 1 FROM calendars WHERE id=?', Number(b.default_calendar))) throw userError('Unknown calendar');
    setSettings(b);
    clearBusyCache();
    json(res, 200, adminState());
  });

  // ---------- Google ----------
  r.get('/admin/google/connect', (req, res) => {
    if (!isAdmin(req)) return redirect(res, '/admin');
    if (!googleConfigured()) throw userError('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first');
    const { url, state } = authUrl();
    setCookie(res, 'oauth_state', state, { maxAge: 600, secure: secure() });
    redirect(res, url);
  });

  r.get('/admin/google/callback', async (req, res) => {
    if (!isAdmin(req)) return redirect(res, '/admin');
    const state = req.query.get('state');
    const stateVal = unsign(state);
    if (!stateVal || state !== parseCookies(req).oauth_state || Number(stateVal.split(':')[0]) < Date.now() - 600_000) {
      return redirect(res, '/admin#calendars?error=state');
    }
    setCookie(res, 'oauth_state', '', { maxAge: 0 });
    if (req.query.get('error')) return redirect(res, `/admin#calendars?error=${encodeURIComponent(req.query.get('error'))}`);
    try {
      await handleCallback(req.query.get('code'));
      // First connected calendar becomes the default automatically.
      if (!getSettings().default_calendar) {
        const primary = get('SELECT id FROM calendars WHERE is_primary=1 ORDER BY id LIMIT 1');
        if (primary) setSettings({ default_calendar: primary.id });
      }
      clearBusyCache();
      redirect(res, '/admin#calendars');
    } catch (e) {
      console.error('[google]', e.message);
      redirect(res, `/admin#calendars?error=${encodeURIComponent(e.message)}`);
    }
  });

  r.post('/api/admin/accounts/:id/sync', async (req, res) => {
    requireAdmin(req);
    await syncCalendars(Number(req.params.id));
    clearBusyCache();
    json(res, 200, adminState());
  });

  r.delete('/api/admin/accounts/:id', (req, res) => {
    requireAdmin(req);
    run('DELETE FROM google_accounts WHERE id=?', Number(req.params.id));
    const s = getSettings();
    if (s.default_calendar && !get('SELECT 1 FROM calendars WHERE id=?', Number(s.default_calendar))) setSettings({ default_calendar: '' });
    clearBusyCache();
    json(res, 200, adminState());
  });

  r.put('/api/admin/calendars/:id', (req, res) => {
    requireAdmin(req);
    run('UPDATE calendars SET check_conflicts=? WHERE id=?', req.body?.check_conflicts ? 1 : 0, Number(req.params.id));
    clearBusyCache();
    json(res, 200, adminState());
  });

  // ---------- meeting types ----------
  r.post('/api/admin/types', (req, res) => {
    requireAdmin(req);
    const t = sanitizeType(req.body || {});
    const cols = Object.keys(t);
    run(`INSERT INTO meeting_types(${cols.join(',')}, created_at) VALUES(${cols.map(() => '?').join(',')}, ?)`, ...Object.values(t), Date.now());
    json(res, 201, adminState());
  });

  r.put('/api/admin/types/:id', (req, res) => {
    requireAdmin(req);
    const existing = get('SELECT * FROM meeting_types WHERE id=?', Number(req.params.id));
    if (!existing) throw userError('Not found', 404);
    const t = sanitizeType(req.body || {}, existing);
    run(`UPDATE meeting_types SET ${Object.keys(t).map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(t), existing.id);
    json(res, 200, adminState());
  });

  r.delete('/api/admin/types/:id', (req, res) => {
    requireAdmin(req);
    run('DELETE FROM meeting_types WHERE id=?', Number(req.params.id));
    json(res, 200, adminState());
  });

  // ---------- bookings ----------
  r.get('/api/admin/bookings', (req, res) => {
    requireAdmin(req);
    const scope = req.query.get('scope') || 'upcoming';
    const now = Date.now();
    const sql = {
      upcoming: ["SELECT * FROM bookings WHERE status='confirmed' AND end_utc >= ? ORDER BY start_utc LIMIT 300", now],
      past: ["SELECT * FROM bookings WHERE status='confirmed' AND end_utc < ? ORDER BY start_utc DESC LIMIT 300", now],
      cancelled: ["SELECT * FROM bookings WHERE status='cancelled' AND ? > 0 ORDER BY cancelled_at DESC LIMIT 300", 1],
    }[scope];
    if (!sql) throw userError('Bad scope');
    json(res, 200, all(sql[0], sql[1]).map((b) => parseRow('bookings', b)));
  });

  r.get('/api/admin/bookings/:id', (req, res) => {
    requireAdmin(req);
    const b = getBooking('id', Number(req.params.id));
    if (!b) throw userError('Not found', 404);
    b.reminders = all('SELECT * FROM reminders WHERE booking_id=? ORDER BY send_at', b.id);
    json(res, 200, b);
  });

  r.post('/api/admin/bookings/:id/cancel', async (req, res) => {
    requireAdmin(req);
    const b = getBooking('id', Number(req.params.id));
    if (!b) throw userError('Not found', 404);
    json(res, 200, await cancelBooking(b, { reason: req.body?.reason, by: 'owner' }));
  });

  // ---------- transcripts ----------
  r.get('/api/admin/transcripts', (req, res) => { requireAdmin(req); json(res, 200, listTranscripts()); });

  r.post('/api/admin/transcripts', (req, res) => {
    requireAdmin(req);
    const b = req.body || {};
    const summary = String(b.summary || '').trim();
    if (!String(b.transcript || '').trim() && !summary) throw userError('Paste a transcript or a summary');
    const id = ingestTranscript({ source: String(b.source || 'manual').slice(0, 50), title: b.title,
      transcript: String(b.transcript || '').trim() || '(no transcript — summary only)', bookingToken: null,
      start: b.booking_id ? get('SELECT start_utc FROM bookings WHERE id=?', Number(b.booking_id))?.start_utc : null });
    if (b.booking_id) run('UPDATE transcripts SET booking_id=? WHERE id=?', Number(b.booking_id), id);
    if (summary) storeSummary(id, summary);
    json(res, 201, getTranscript(id));
  });

  r.get('/api/admin/transcripts/:id', (req, res) => {
    requireAdmin(req);
    const tr = getTranscript(Number(req.params.id));
    if (!tr) throw userError('Not found', 404);
    json(res, 200, tr);
  });

  r.put('/api/admin/transcripts/:id', (req, res) => {
    requireAdmin(req);
    const id = Number(req.params.id);
    const b = req.body || {};
    if ('booking_id' in b) run('UPDATE transcripts SET booking_id=? WHERE id=?', b.booking_id ? Number(b.booking_id) : null, id);
    if (typeof b.summary === 'string') storeSummary(id, b.summary);
    json(res, 200, getTranscript(id));
  });

  r.post('/api/admin/transcripts/:id/summarize', async (req, res) => {
    requireAdmin(req);
    try { json(res, 200, await requestSummary(Number(req.params.id))); } catch (e) { throw userError(e.message, 502); }
  });

  r.post('/api/admin/transcripts/:id/send', async (req, res) => {
    requireAdmin(req);
    try { json(res, 200, await sendSummary(Number(req.params.id), req.body || {})); } catch (e) { throw userError(e.message, 400); }
  });

  r.post('/api/admin/transcripts/:id/dismiss', (req, res) => {
    requireAdmin(req);
    run("UPDATE transcripts SET status='dismissed' WHERE id=?", Number(req.params.id));
    json(res, 200, getTranscript(Number(req.params.id)));
  });

  // ---------- tests ----------
  r.post('/api/admin/test/email', async (req, res) => {
    requireAdmin(req);
    const to = req.body?.to || getSettings().owner_email;
    try {
      await sendEmail({ to, subject: 'Test email from your booking system', text: 'It works!', html: emailLayout({ lines: ['It works! 🎉'] }) });
    } catch (e) { throw userError(e.message, 502); }
    json(res, 200, { ok: true });
  });

  r.post('/api/admin/test/whatsapp', async (req, res) => {
    requireAdmin(req);
    const to = req.body?.to || getSettings().owner_phone;
    try {
      await sendWhatsApp({ to, text: 'Test message from your booking system ✅', vars: ['Test', 'Test meeting', new Date().toLocaleString(), config.baseUrl] });
    } catch (e) { throw userError(e.message, 502); }
    json(res, 200, { ok: true });
  });
}
