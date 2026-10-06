export async function api(path, { method = 'GET', body } = {}) {
  if (method !== 'GET' && body === undefined) body = {};
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Error ${res.status}`); e.status = res.status; throw e; }
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function durationLabel(m, lang = 'en') {
  if (lang === 'he') {
    if (m % 10080 === 0) return m === 10080 ? 'שבוע' : `${m / 10080} שבועות`;
    if (m % 1440 === 0) return m === 1440 ? 'יום' : m === 2880 ? 'יומיים' : `${m / 1440} ימים`;
    if (m % 60 === 0) return m === 60 ? 'שעה' : m === 120 ? 'שעתיים' : `${m / 60} שעות`;
    return `${m} דקות`;
  }
  if (m % 10080 === 0) return `${m / 10080} week${m === 10080 ? '' : 's'}`;
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m} min`;
}

const locale = (lang) => (lang === 'he' ? 'he-IL' : 'en-GB');

export function fmtTime(ms, tz, lang) {
  return new Intl.DateTimeFormat(locale(lang), { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}
export function fmtDate(ms, tz, lang, opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) {
  return new Intl.DateTimeFormat(locale(lang), { timeZone: tz, ...opts }).format(ms);
}
/** YYYY-MM-DD of an instant in a timezone */
export function dateKey(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function applyBranding(profile) {
  document.documentElement.style.setProperty('--brand', profile.brand_color || '#4f46e5');
  document.documentElement.lang = profile.language || 'en';
  document.documentElement.dir = profile.strings?.dir || 'ltr';
}

export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
