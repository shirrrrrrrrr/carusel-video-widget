// Booking service: availability lookup, create, cancel, and client/owner messages.
import { all, get, getSettings, parseRow, run } from './db.js';
import { computeAvailability, isStartAvailable } from './availability.js';
import { createEvent, deleteEvent, getBusy } from './google.js';
import { addDays, formatInTz, isValidTz, localParts, zonedToUtc } from './time.js';
import { emailEnabled, emailLayout, normalizePhone, sendEmail } from './notify.js';
import { randomToken } from './crypto.js';
import { scheduleReminders, cancelReminders } from './reminders.js';
import { config } from './config.js';
import { createZoomMeeting, deleteZoomMeeting, zoomConfigured } from './zoom.js';
import { OWNER_STRINGS, t } from './i18n.js';

const DAY = 86_400_000;

export const getType = async (where, v) => parseRow('meeting_types', await get(`SELECT * FROM meeting_types WHERE ${where} = ?`, v));
export const getBooking = async (where, v) => parseRow('bookings', await get(`SELECT * FROM bookings WHERE ${where} = ?`, v));

export async function calendarFor(type) {
  const ref = type.calendar_ref || Number((await getSettings()).default_calendar) || null;
  return ref ? await get('SELECT * FROM calendars WHERE id = ?', ref) : null;
}

// Short cache so a client clicking around the calendar doesn't hammer Google.
const busyCache = new Map();
async function busyBetween(fromMs, toMs, { fresh = false } = {}) {
  const key = `${fromMs}:${toMs}`;
  const hit = busyCache.get(key);
  if (!fresh && hit && hit.at > Date.now() - 30_000) return hit.busy;
  const google = (await getBusy(fromMs, toMs));
  // Also block our own confirmed bookings (covers calendars not marked for conflict checks).
  // Each booking keeps the gaps of its own meeting type around it, so a 15-min "gap after" protects that meeting
  // no matter which meeting type is booked next.
  const own = (await all(`SELECT b.start_utc, b.end_utc, COALESCE(t.buffer_before, 0) AS bb, COALESCE(t.buffer_after, 0) AS ba
      FROM bookings b LEFT JOIN meeting_types t ON t.id = b.meeting_type_id
      WHERE b.status='confirmed' AND b.end_utc > ? AND b.start_utc < ?`, fromMs - DAY, toMs + DAY))
    .map((b) => [b.start_utc - b.bb * 60_000, b.end_utc + b.ba * 60_000]);
  const busy = [...google, ...own];
  busyCache.set(key, { at: Date.now(), busy });
  if (busyCache.size > 200) busyCache.delete(busyCache.keys().next().value);
  return busy;
}
export const clearBusyCache = () => busyCache.clear();

async function bookingsPerDay(typeId, tz, fromMs, toMs) {
  const counts = {};
  for (const b of await all("SELECT start_utc FROM bookings WHERE meeting_type_id=? AND status='confirmed' AND start_utc >= ? AND start_utc < ?", typeId, fromMs, toMs)) {
    const d = localParts(b.start_utc, tz).date;
    counts[d] = (counts[d] || 0) + 1;
  }
  return counts;
}

async function availabilityParams(type, duration, fromDate, toDate, opts) {
  const tz = (await getSettings()).timezone;
  const fromMs = zonedToUtc(fromDate, 0, tz) - DAY;
  const toMs = zonedToUtc(addDays(toDate, 1), 0, tz) + DAY;
  return {
    type, duration, fromDate, toDate, tz, now: Date.now(),
    busy: await busyBetween(fromMs, toMs, opts),
    bookingsPerDay: await bookingsPerDay(type.id, tz, fromMs, toMs),
  };
}

export async function availability(type, duration, fromDate, toDate) {
  return computeAvailability(await availabilityParams(type, duration, fromDate, toDate));
}

export const LOCATION_TYPES = ['google_meet', 'zoom', 'phone', 'in_person', 'custom'];

/** Locations a meeting type offers (first = default). */
export function typeLocations(type) {
  return (Array.isArray(type.locations) ? type.locations : []).filter((l) => LOCATION_TYPES.includes(l?.type));
}

/** Human-readable "where" for messages, in the booking page language. */
export async function locationText(booking, loc) {
  const L = t((await getSettings()).language);
  switch (booking.location_type) {
    case 'google_meet': return booking.meet_link || 'Google Meet';
    case 'zoom': return booking.meet_link || loc?.value || 'Zoom';
    case 'phone': return booking.phone ? L.phoneCallTo(booking.phone) : L.locPhone;
    case 'in_person':
    case 'custom': return loc?.value || '';
    default: return '';
  }
}

export const manageUrl = (b) => `${config.baseUrl}/manage/${b.token}`;

/**
 * Validate the client's answers against the meeting type's custom fields.
 * Returns [{id,label,value}] or throws with a user-facing message.
 */
function validateAnswers(fields, answers = {}) {
  const out = [];
  for (const f of fields) {
    let v = answers[f.id];
    if (f.type === 'checkbox') v = Boolean(v);
    else v = v == null ? '' : String(v).trim().slice(0, 5000);
    if (f.required && (v === '' || v === false)) throw userError(`"${f.label}" is required`);
    if (f.type === 'select' && v && !(f.options || []).includes(v)) throw userError(`Invalid choice for "${f.label}"`);
    out.push({ id: f.id, label: f.label, value: v });
  }
  return out;
}

export function userError(msg, status = 400) {
  const e = new Error(msg); e.status = status; e.expose = true; return e;
}

export async function createBooking(type, input) {
  const settings = await getSettings();
  const duration = Number(input.duration) || type.durations[0];
  if (!type.durations.includes(duration)) throw userError('Invalid duration');
  const start = Number(input.start);
  if (!Number.isFinite(start)) throw userError('Invalid start time');
  const name = String(input.name || '').trim().slice(0, 200);
  const email = String(input.email || '').trim().toLowerCase().slice(0, 200);
  if (!name) throw userError('Name is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw userError('A valid email is required');
  const clientTz = isValidTz(input.timezone) ? input.timezone : settings.timezone;

  const channels = (input.reminder_channels || []).filter((c) => type.client_reminder_channels.includes(c));
  const offsets = (input.reminder_offsets || []).map(Number).filter((m) => type.client_reminder_options.includes(m));
  const phone = normalizePhone(input.phone);
  const locations = typeLocations(type);
  const loc = locations.find((l) => l.type === input.location_type) || locations[0] || null;
  if (input.location_type && loc?.type !== input.location_type) throw userError('Invalid meeting location');
  if ((type.require_phone || channels.includes('whatsapp') || loc?.type === 'phone') && !phone) throw userError('A valid phone number with country code is required (e.g. +972501234567)');
  const answers = validateAnswers(type.fields, input.answers);

  // Re-check availability against fresh calendar data.
  const date = localParts(start, settings.timezone).date;
  const params = await availabilityParams(type, duration, date, date, { fresh: true });
  if (!isStartAvailable(params, start)) throw userError('taken', 409);

  const end = start + duration * 60_000;
  const token = randomToken(18);
  const calendar = await calendarFor(type);

  // Insert only if nothing overlaps — a single statement, so two simultaneous requests can't both win.
  const ins = await run(`INSERT INTO bookings(token, meeting_type_id, type_name, start_utc, end_utc, client_tz, name, email, phone, answers,
      reminder_channels, reminder_offsets, calendar_ref, location_type, created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE status='confirmed' AND start_utc < ? AND end_utc > ?)`,
  token, type.id, type.name, start, end, clientTz, name, email, phone, JSON.stringify(answers),
  JSON.stringify(channels), JSON.stringify(offsets.length && channels.length ? offsets : []), calendar?.id ?? null,
  loc?.type ?? null, Date.now(), end, start);
  if (!ins.changes) throw userError('taken', 409);
  const id = ins.lastInsertRowid;
  let booking = await getBooking('id', id);

  // Zoom: create a dedicated meeting when the Zoom API is configured, otherwise use the personal link.
  if (loc?.type === 'zoom') {
    if (zoomConfigured()) {
      try {
        const z = await createZoomMeeting({ topic: `${type.name} — ${name}`, start, duration, timezone: settings.timezone, agenda: type.description });
        await run('UPDATE bookings SET meet_link=?, zoom_meeting_id=? WHERE id=?', z.joinUrl, z.id, id);
      } catch (e) {
        await run('DELETE FROM bookings WHERE id=?', id);
        console.error('[booking] zoom failed:', e.message);
        throw userError('Could not create the Zoom meeting. Please try again later.', 502);
      }
    } else if (loc.value) {
      await run('UPDATE bookings SET meet_link=? WHERE id=?', loc.value, id);
    }
    booking = await getBooking('id', id);
  }
  const where = await locationText(booking, loc);
  await run('UPDATE bookings SET location=? WHERE id=?', where, id);
  booking = await getBooking('id', id);

  if (calendar) {
    try {
      const attendees = [{ email, displayName: name }];
      if (type.transcriber_enabled && type.transcriber_email) attendees.push({ email: type.transcriber_email });
      const descLines = [
        type.description,
        '',
        ...answers.filter((a) => a.value !== '' && a.value !== false).map((a) => `${a.label}: ${a.value === true ? '✓' : a.value}`),
        phone ? `Phone: ${phone}` : '',
        loc && loc.type !== 'google_meet' && where ? `${t(settings.language).where}: ${where}` : '',
        '',
        `${t(settings.language).manageLine} ${manageUrl(booking)}`,
      ].filter((l, i, arr) => l !== '' || (arr[i - 1] ?? '') !== '');
      const ev = await createEvent(calendar, {
        summary: `${type.name} — ${name}`,
        description: descLines.join('\n').trim(),
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(end).toISOString() },
        attendees,
        location: loc && loc.type !== 'google_meet' ? (where || undefined) : undefined,
        reminders: { useDefault: true },
        extendedProperties: { private: { bookingToken: token } },
      }, { meet: loc?.type === 'google_meet' });
      if (loc?.type === 'google_meet') {
        const meet = ev.hangoutLink || ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri || null;
        await run('UPDATE bookings SET meet_link=?, location=? WHERE id=?', meet, meet || 'Google Meet', id);
      }
      await run('UPDATE bookings SET google_event_id=? WHERE id=?', ev.id, id);
    } catch (e) {
      if (booking.zoom_meeting_id) await deleteZoomMeeting(booking.zoom_meeting_id).catch(() => {});
      await run('DELETE FROM bookings WHERE id=?', id);
      console.error('[booking] calendar event failed:', e.message);
      throw userError('Could not create the calendar event. Please try again later.', 502);
    }
  }
  booking = await getBooking('id', id);
  clearBusyCache();
  await scheduleReminders(booking, type);

  // Awaited (not fire-and-forget): serverless hosts may freeze the process right after the response.
  await notifyBooked(booking, type).catch((e) => console.error('[booking] notify failed:', e.message));
  return booking;
}

export function whenText(b, tz, lang) {
  return `${formatInTz(b.start_utc, tz, lang)} (${tz})`;
}

export async function clientMessage(kind, b, type) {
  const s = await getSettings();
  const L = t(s.language);
  const when = whenText(b, b.client_tz || s.timezone, s.language);
  const title = b.type_name || type?.name || '';
  const subject = { confirm: L.subjConfirm, reminder: L.subjReminder, cancel: L.subjCancel }[kind](title);
  const main = { confirm: L.msgConfirm, reminder: L.msgReminder, cancel: L.msgCancel }[kind](title, when);
  const lines = [L.hi(b.name), main];
  if (kind !== 'cancel' && b.location) lines.push(`${L.where}: ${b.location}`);
  if (kind !== 'cancel') lines.push(`${L.manageLine} ${manageUrl(b)}`);
  const text = lines.join('\n\n');
  const button = kind !== 'cancel' && b.meet_link ? { url: b.meet_link, label: L.joinLine.replace(':', '') } : null;
  return {
    subject, text,
    html: await emailLayout({ lines, dir: L.dir, button }),
    vars: [b.name, title, when, b.meet_link || manageUrl(b)],
  };
}

export async function ownerMessage(kind, b) {
  const s = await getSettings();
  const lang = s.admin_language === 'en' ? 'en' : 'he';
  const O = OWNER_STRINGS[lang];
  const when = whenText(b, s.timezone, lang);
  const head = { booked: O.booked, reminder: O.reminder, cancel: O.cancel }[kind];
  const lines = [
    `${head}: ${b.type_name} ${O.with} ${b.name}`,
    `${O.when}: ${when}`,
    `${O.client}: ${b.name} <${b.email}>${b.phone ? ` · ${b.phone}` : ''}`,
    ...(b.location ? [`${O.where}: ${b.location}`] : []),
    ...b.answers.filter((a) => a.value !== '' && a.value !== false).map((a) => `${a.label}: ${a.value === true ? '✓' : a.value}`),
    ...(kind === 'cancel' && b.cancel_reason ? [`${O.reason}: ${b.cancel_reason}`] : []),
  ];
  return {
    subject: `${head}: ${b.type_name} — ${b.name} (${formatInTz(b.start_utc, s.timezone, lang, { weekday: 'short', year: undefined })})`,
    text: lines.join('\n'),
    html: await emailLayout({ lines, dir: lang === 'he' ? 'rtl' : 'ltr', button: { url: `${config.baseUrl}/admin#bookings`, label: O.openDashboard } }),
    vars: [s.owner_name, `${b.type_name} — ${b.name}`, when, b.meet_link || `${config.baseUrl}/admin`],
  };
}

async function notifyBooked(b, type) {
  if (!(await emailEnabled())) return;
  const s = await getSettings();
  // Google already emails the client a calendar invite; this adds a branded confirmation with the manage link.
  const m = await clientMessage('confirm', b, type);
  await sendEmail({ to: b.email, subject: m.subject, text: m.text, html: m.html, replyTo: s.owner_email || undefined });
  if (s.owner_email) {
    const o = await ownerMessage('booked', b);
    await sendEmail({ to: s.owner_email, subject: o.subject, text: o.text, html: o.html, replyTo: b.email });
  }
}

export async function cancelBooking(b, { reason = '', by = 'client' } = {}) {
  if (b.status === 'cancelled') return b;
  await run("UPDATE bookings SET status='cancelled', cancelled_at=?, cancel_reason=? WHERE id=?", Date.now(), String(reason).slice(0, 1000), b.id);
  await cancelReminders(b.id);
  clearBusyCache();
  if (b.google_event_id && b.calendar_ref) {
    const cal = await get('SELECT * FROM calendars WHERE id=?', b.calendar_ref);
    if (cal) await deleteEvent(cal, b.google_event_id).catch((e) => console.error('[cancel] delete event failed:', e.message));
  }
  if (b.zoom_meeting_id && zoomConfigured()) await deleteZoomMeeting(b.zoom_meeting_id).catch((e) => console.error('[cancel] zoom delete failed:', e.message));
  const updated = await getBooking('id', b.id);
  if (await emailEnabled()) {
    const s = await getSettings();
    try {
      const m = await clientMessage('cancel', updated);
      await sendEmail({ to: updated.email, subject: m.subject, text: m.text, html: m.html, replyTo: s.owner_email || undefined });
      if (s.owner_email && by === 'client') {
        const o = await ownerMessage('cancel', updated);
        await sendEmail({ to: s.owner_email, subject: o.subject, text: o.text, html: o.html });
      }
    } catch (e) { console.error('[cancel] notify failed:', e.message); }
  }
  return updated;
}
