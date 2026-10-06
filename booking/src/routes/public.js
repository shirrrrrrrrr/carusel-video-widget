import { all, getSettings, parseRow } from '../db.js';
import { json, rateLimit } from '../http.js';
import { availability, cancelBooking, createBooking, getBooking, getType, typeLocations, userError } from '../bookings.js';
import { addDays, localParts } from '../time.js';
import { clientStrings } from '../i18n.js';

const bookLimiter = rateLimit({ windowMs: 10 * 60_000, max: 10 });
const readLimiter = rateLimit({ windowMs: 60_000, max: 120 });

export function publicType(t) {
  return {
    slug: t.slug, name: t.name, description: t.description, durations: t.durations, slot_mode: t.slot_mode,
    // Only addresses are public; links are sent after booking.
    locations: typeLocations(t).map((l) => ({ type: l.type, value: l.type === 'in_person' ? l.value : '' })),
    fields: t.fields, require_phone: Boolean(t.require_phone), color: t.color, max_days_ahead: t.max_days_ahead,
    client_reminder_channels: t.client_reminder_channels, client_reminder_options: t.client_reminder_options,
    client_reminder_defaults: t.client_reminder_defaults,
  };
}

function activeType(slug) {
  const t = getType('slug', slug);
  if (!t || !t.active) throw userError('Meeting type not found', 404);
  return t;
}

export function mountPublic(r) {
  r.get('/api/public/profile', (req, res) => {
    const s = getSettings();
    const types = all('SELECT * FROM meeting_types WHERE active=1 ORDER BY position, id').map((t) => publicType(parseRow('meeting_types', t)));
    json(res, 200, {
      owner_name: s.owner_name, welcome_text: s.welcome_text, language: s.language, brand_color: s.brand_color,
      timezone: s.timezone, strings: clientStrings(s.language), types,
    });
  });

  r.get('/api/public/types/:slug', (req, res) => json(res, 200, publicType(activeType(req.params.slug))));

  r.get('/api/public/types/:slug/availability', async (req, res) => {
    if (!readLimiter(req)) throw userError('Too many requests', 429);
    const t = activeType(req.params.slug);
    const tz = getSettings().timezone;
    const today = localParts(Date.now(), tz).date;
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    let from = isDate(req.query.get('from')) ? req.query.get('from') : today;
    let to = isDate(req.query.get('to')) ? req.query.get('to') : addDays(from, 34);
    if (from < today) from = today;
    if (to > addDays(from, 45)) to = addDays(from, 45);
    const duration = Number(req.query.get('duration')) || t.durations[0];
    if (!t.durations.includes(duration)) throw userError('Invalid duration');
    try {
      const days = await availability(t, duration, from, to);
      json(res, 200, { timezone: tz, slot_mode: t.slot_mode, duration, days });
    } catch (e) {
      console.error('[availability]', e.message);
      throw userError('Availability is temporarily unavailable', 503);
    }
  });

  r.post('/api/public/types/:slug/book', async (req, res) => {
    if (!bookLimiter(req)) throw userError('Too many requests', 429);
    const t = activeType(req.params.slug);
    const b = await createBooking(t, req.body || {});
    json(res, 201, { token: b.token });
  });

  r.get('/api/public/bookings/:token', (req, res) => {
    const b = getBooking('token', req.params.token);
    if (!b) throw userError('Booking not found', 404);
    json(res, 200, {
      type_name: b.type_name, start_utc: b.start_utc, end_utc: b.end_utc, client_tz: b.client_tz, name: b.name,
      status: b.status, location: b.location, location_type: b.location_type, meet_link: b.meet_link, owner_name: getSettings().owner_name,
      can_cancel: b.status === 'confirmed' && b.start_utc > Date.now(),
    });
  });

  r.post('/api/public/bookings/:token/cancel', async (req, res) => {
    if (!bookLimiter(req)) throw userError('Too many requests', 429);
    const b = getBooking('token', req.params.token);
    if (!b) throw userError('Booking not found', 404);
    if (b.start_utc <= Date.now()) throw userError('This meeting has already started');
    await cancelBooking(b, { reason: req.body?.reason, by: 'client' });
    json(res, 200, { ok: true });
  });
}
