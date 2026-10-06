// Pure availability engine. No I/O — easy to test.
import { addDays, localParts, weekdayOf, zonedToUtc } from './time.js';

const MIN = 60_000;

/**
 * Subtract open interval (x, y) from a list of closed ranges [a, b].
 * A start exactly at x or y stays valid (touching edges is fine).
 */
function subtractOpen(ranges, x, y) {
  const out = [];
  for (const [a, b] of ranges) {
    if (y <= a || x >= b) { out.push([a, b]); continue; }
    if (a <= x) out.push([a, x]);
    if (y <= b) out.push([y, b]);
  }
  return out.filter(([a, b]) => b >= a);
}

/**
 * Compute when a meeting of `duration` minutes may START.
 *
 * @param {object} p
 * @param {object} p.type        meeting type (parsed): schedule, slot_mode, slot_interval, free_granularity,
 *                               buffer_before, buffer_after, min_notice, max_days_ahead, daily_limit
 * @param {number} p.duration    minutes
 * @param {string} p.fromDate    first local date (owner tz) "YYYY-MM-DD"
 * @param {string} p.toDate      last local date (owner tz), inclusive
 * @param {string} p.tz          owner timezone
 * @param {number} p.now         epoch ms
 * @param {Array<[number,number]>} p.busy   busy intervals [startMs, endMs) from all calendars + bookings
 * @param {Object<string,number>} [p.bookingsPerDay]  local date -> count of bookings of this type (for daily_limit)
 * @returns {Array<{date:string, slots:number[], ranges:Array<[number,number]>}>}
 *   slots: start instants (interval mode, or free mode rounded to granularity)
 *   ranges: [earliestStart, latestStart] windows in which any start is valid
 */
export function computeAvailability({ type, duration, fromDate, toDate, tz, now, busy, bookingsPerDay = {} }) {
  const dur = duration * MIN;
  const before = (type.buffer_before || 0) * MIN;
  const after = (type.buffer_after || 0) * MIN;
  const earliest = now + (type.min_notice || 0) * MIN;
  const horizonDate = addDays(localParts(now, tz).date, type.max_days_ahead ?? 30);
  const step = (type.slot_mode === 'free' ? (type.free_granularity || 5) : (type.slot_interval || 30)) * MIN;

  const days = [];
  for (let date = fromDate; date <= toDate && date <= horizonDate; date = addDays(date, 1)) {
    if (type.daily_limit > 0 && (bookingsPerDay[date] || 0) >= type.daily_limit) {
      days.push({ date, slots: [], ranges: [] });
      continue;
    }
    const windows = type.schedule?.[weekdayOf(date)] || [];
    const dayRanges = [];
    const slots = [];
    for (const [startMin, endMin] of windows) {
      const wStart = zonedToUtc(date, startMin, tz);
      const wEnd = zonedToUtc(date, endMin, tz);
      if (wEnd - wStart < dur) continue;
      let ranges = [[wStart, wEnd - dur]];
      for (const [b0, b1] of busy) {
        // A meeting starting at s blocks [s - before, s + dur + after); it conflicts with busy [b0, b1)
        // when s is inside (b0 - dur - after, b1 + before).
        ranges = subtractOpen(ranges, b0 - dur - after, b1 + before);
        if (!ranges.length) break;
      }
      ranges = ranges
        .map(([a, b]) => [Math.max(a, earliest), b])
        .filter(([a, b]) => b >= a);
      dayRanges.push(...ranges);
      // Start times aligned to the window start (e.g. 9:00, 9:30, 10:00 ...)
      for (const [a, b] of ranges) {
        let s = wStart + Math.ceil((a - wStart) / step) * step;
        for (; s <= b; s += step) slots.push(s);
      }
    }
    days.push({ date, slots: [...new Set(slots)].sort((x, y) => x - y), ranges: dayRanges });
  }
  return days;
}

/** True when a specific start is valid. Used to re-validate at booking time. */
export function isStartAvailable(params, start) {
  return computeAvailability(params).some((d) => d.slots.includes(start));
}

/** Validate & normalise a weekly schedule object. */
export function normalizeSchedule(s) {
  const out = {};
  for (let wd = 0; wd < 7; wd++) {
    const list = Array.isArray(s?.[wd]) ? s[wd] : [];
    out[wd] = list
      .map(([a, b]) => [Math.max(0, Math.min(1440, Math.round(+a))), Math.max(0, Math.min(1440, Math.round(+b)))])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .sort((x, y) => x[0] - y[0]);
  }
  return out;
}
