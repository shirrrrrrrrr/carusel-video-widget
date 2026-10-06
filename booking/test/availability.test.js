import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAvailability, isStartAvailable, normalizeSchedule } from '../src/availability.js';
import { zonedToUtc, localParts, addDays } from '../src/time.js';

const TZ = 'Asia/Jerusalem';
const H = 3600_000, M = 60_000;
const allWeek = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [[540, 720]]])); // 09:00-12:00 every day

const baseType = (over = {}) => ({
  id: 1, schedule: allWeek, slot_mode: 'interval', slot_interval: 30, free_granularity: 5,
  buffer_before: 0, buffer_after: 0, min_notice: 0, max_days_ahead: 30, daily_limit: 0, ...over,
});

const DATE = '2030-03-05';            // a Tuesday, far in the future
const NOW = zonedToUtc('2030-03-01', 0, TZ);
const at = (hhmm, date = DATE) => { const [h, m] = hhmm.split(':').map(Number); return zonedToUtc(date, h * 60 + m, TZ); };
const times = (slots) => slots.map((s) => { const p = localParts(s, TZ); return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`; });

const run = (type, opts = {}) => computeAvailability({ type, duration: 30, fromDate: DATE, toDate: DATE, tz: TZ, now: NOW, busy: [], ...opts })[0];

test('zonedToUtc handles Israel DST', () => {
  assert.equal(new Date(zonedToUtc('2030-01-15', 540, TZ)).toISOString(), '2030-01-15T07:00:00.000Z'); // UTC+2
  assert.equal(new Date(zonedToUtc('2030-07-15', 540, TZ)).toISOString(), '2030-07-15T06:00:00.000Z'); // UTC+3
});

test('fixed 30-minute start times inside working hours', () => {
  assert.deepEqual(times(run(baseType()).slots), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
});

test('hourly start times', () => {
  assert.deepEqual(times(run(baseType({ slot_interval: 60 })).slots), ['09:00', '10:00', '11:00']);
});

test('busy event removes overlapping slots', () => {
  const day = run(baseType(), { busy: [[at('10:00'), at('10:45')]] });
  assert.deepEqual(times(day.slots), ['09:00', '09:30', '11:00', '11:30']);
});

test('15-minute gap after an existing meeting', () => {
  const day = run(baseType({ slot_interval: 15, buffer_after: 15, buffer_before: 15 }), { busy: [[at('10:00'), at('10:30')]] });
  // A new meeting must end 15 min before 10:00 and may start 15 min after 10:30.
  assert.ok(times(day.slots).includes('09:15'));
  assert.ok(!times(day.slots).includes('09:30'));
  assert.ok(!times(day.slots).includes('10:30'));
  assert.ok(times(day.slots).includes('10:45'));
});

test('free mode exposes ranges and 5-minute starts', () => {
  const day = run(baseType({ slot_mode: 'free' }), { busy: [[at('10:00'), at('10:50')]] });
  assert.equal(day.ranges.length, 2);
  assert.deepEqual(times(day.ranges[0]), ['09:00', '09:30']);
  assert.deepEqual(times(day.ranges[1]), ['10:50', '11:30']);
  assert.ok(times(day.slots).includes('10:55'));
  assert.ok(!times(day.slots).includes('10:45'));
});

test('minimum notice hides near-term slots', () => {
  const now = at('09:10');
  const day = computeAvailability({ type: baseType({ min_notice: 60 }), duration: 30, fromDate: DATE, toDate: DATE, tz: TZ, now, busy: [] })[0];
  assert.deepEqual(times(day.slots), ['10:30', '11:00', '11:30']);
});

test('booking horizon', () => {
  const days = computeAvailability({ type: baseType({ max_days_ahead: 2 }), duration: 30, fromDate: '2030-03-01', toDate: '2030-03-10', tz: TZ, now: NOW, busy: [] });
  assert.equal(days.length, 3);
  assert.equal(days.at(-1).date, addDays('2030-03-01', 2));
});

test('daily limit', () => {
  const day = run(baseType({ daily_limit: 2 }), { bookingsPerDay: { [DATE]: 2 } });
  assert.equal(day.slots.length, 0);
});

test('isStartAvailable validates exact starts', () => {
  const p = { type: baseType(), duration: 30, fromDate: DATE, toDate: DATE, tz: TZ, now: NOW, busy: [] };
  assert.equal(isStartAvailable(p, at('09:30')), true);
  assert.equal(isStartAvailable(p, at('09:40')), false);
  assert.equal(isStartAvailable(p, at('12:00')), false);
});

test('normalizeSchedule drops invalid ranges', () => {
  assert.deepEqual(normalizeSchedule({ 1: [[600, 540], [540, 600]], 2: 'x' })[1], [[540, 600]]);
});
