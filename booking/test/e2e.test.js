// Boots the real server against a temp database (no Google / email configured) and exercises the main flows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-'));
let server, summaryServer, summaryRequests = [];
let cookie = '';

async function call(p, { method = 'GET', body, auth = false } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  summaryServer = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => { summaryRequests.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ summary: 'SUMMARY: we agreed on next steps.' })); });
  }).listen(PORT + 100);
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), BASE_URL: BASE, ADMIN_PASSWORD: 'secret-pass', APP_SECRET: 'x'.repeat(40),
      DB_PATH: path.join(tmp, 'test.db'), EMAIL_PROVIDER: 'none', WHATSAPP_PROVIDER: 'none',
      TRANSCRIPT_WEBHOOK_SECRET: 'hook-key', SUMMARY_API_URL: `http://127.0.0.1:${PORT + 100}/summarize`,
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); });
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => { server?.kill(); summaryServer?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('pages render', async () => {
  for (const p of ['/', '/book/intro', '/admin', '/manage/abc']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await fetch(`${BASE}/../src/config.js`)).status, 404);
});

test('admin auth required', async () => {
  assert.equal((await call('/api/admin/state')).status, 401);
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const r = await call('/api/admin/login', { method: 'POST', body: { password: 'secret-pass' } });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  const st = await call('/api/admin/state', { auth: true });
  assert.equal(st.status, 200);
  assert.equal(st.data.types[0].slug, 'intro');
});

let typeSlug = 'consult';
test('create meeting type with fields and reminders', async () => {
  const all = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [[0, 1440]]]));
  const r = await call('/api/admin/types', {
    method: 'POST', auth: true, body: {
      name: 'Consultation', slug: typeSlug, durations: [30, 60], slot_mode: 'interval', slot_interval: 60,
      buffer_after: 15, min_notice: 60, max_days_ahead: 14, schedule: all,
      fields: [{ id: 'company', label: 'Company', type: 'text', required: true }, { id: 'plan', label: 'Plan', type: 'select', options: ['A', 'B'] }],
      client_reminder_channels: ['email', 'whatsapp'], client_reminder_options: [60, 1440], client_reminder_defaults: [60],
      owner_reminders: [30], owner_reminder_channels: ['email'],
    },
  });
  assert.equal(r.status, 201);
  const pub = await call(`/api/public/types/${typeSlug}`);
  assert.deepEqual(pub.data.durations, [30, 60]);
  assert.equal(pub.data.fields.length, 2);
});

let token, firstSlot;
test('availability + booking + double-booking protection', async () => {
  const av = await call(`/api/public/types/${typeSlug}/availability?duration=60`);
  assert.equal(av.status, 200);
  const slots = av.data.days.flatMap((d) => d.slots);
  assert.ok(slots.length > 20);
  firstSlot = slots[5];

  const bad = await call(`/api/public/types/${typeSlug}/book`, { method: 'POST', body: { start: firstSlot, duration: 60, name: 'Dana', email: 'dana@example.com', answers: {} } });
  assert.equal(bad.status, 400); // Company is required

  const waNoPhone = await call(`/api/public/types/${typeSlug}/book`, { method: 'POST', body: { start: firstSlot, duration: 60, name: 'Dana', email: 'dana@example.com', answers: { company: 'X' }, reminder_channels: ['whatsapp'], reminder_offsets: [60] } });
  assert.equal(waNoPhone.status, 400);

  const ok = await call(`/api/public/types/${typeSlug}/book`, {
    method: 'POST', body: { start: firstSlot, duration: 60, timezone: 'Europe/London', name: 'Dana', email: 'dana@example.com', phone: '+972 50-123-4567',
      answers: { company: 'Acme', plan: 'B' }, reminder_channels: ['email', 'whatsapp'], reminder_offsets: [60, 1440] },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  token = ok.data.token;

  const again = await call(`/api/public/types/${typeSlug}/book`, { method: 'POST', body: { start: firstSlot, duration: 60, name: 'Eve', email: 'eve@example.com', answers: { company: 'E' } } });
  assert.equal(again.status, 409);

  // Slot and the 15-minute buffer after it are gone; the next hourly slot (ends +60, +15 buffer) is also gone
  const av2 = await call(`/api/public/types/${typeSlug}/availability?duration=60`);
  const slots2 = av2.data.days.flatMap((d) => d.slots);
  assert.ok(!slots2.includes(firstSlot));
  assert.ok(!slots2.includes(firstSlot + 3600_000));
});

test('booking details, reminders scheduled, admin list', async () => {
  const b = await call(`/api/public/bookings/${token}`);
  assert.equal(b.data.status, 'confirmed');
  assert.equal(b.data.client_tz, 'Europe/London');
  const list = await call('/api/admin/bookings?scope=upcoming', { auth: true });
  const row = list.data.find((x) => x.token === token);
  assert.equal(row.phone, '+972501234567');
  assert.equal(row.answers.find((a) => a.id === 'company').value, 'Acme');
  const detail = await call(`/api/admin/bookings/${row.id}`, { auth: true });
  const kinds = detail.data.reminders.map((r) => `${r.recipient}:${r.channel}:${r.offset_min}`).sort();
  // 2 channels x 2 offsets for the client (24h one only if far enough ahead) + owner email 30
  assert.ok(kinds.includes('client:email:60'));
  assert.ok(kinds.includes('client:whatsapp:60'));
  assert.ok(kinds.includes('owner:email:30'));
});

test('transcript webhook -> summary -> approval required', async () => {
  assert.equal((await call('/api/webhooks/transcript?key=wrong', { method: 'POST', body: { transcript: 'x' } })).status, 401);
  const r = await call('/api/webhooks/transcript?key=hook-key', {
    method: 'POST', body: { source: 'test', external_id: 'm1', title: 'Call', booking_token: token, transcript: [{ speaker: 'Dana', text: 'Hello' }, { speaker: 'Me', text: 'Hi!' }] },
  });
  assert.equal(r.status, 200);
  const tr = await call(`/api/admin/transcripts/${r.data.id}`, { auth: true });
  assert.equal(tr.data.status, 'pending_review');
  assert.equal(tr.data.booking.email, 'dana@example.com');
  assert.match(tr.data.transcript, /Dana: Hello/);

  const s = await call(`/api/admin/transcripts/${r.data.id}/summarize`, { method: 'POST', auth: true, body: {} });
  assert.equal(s.status, 200);
  assert.equal(s.data.status, 'summary_ready');
  assert.equal(s.data.summary, 'SUMMARY: we agreed on next steps.');
  assert.equal(summaryRequests[0].client_name, 'Dana');

  // Sending needs an email provider; with EMAIL_PROVIDER=none it must fail and NOT mark as sent.
  const send = await call(`/api/admin/transcripts/${r.data.id}/send`, { method: 'POST', auth: true, body: {} });
  assert.equal(send.status, 400);
  const after = await call(`/api/admin/transcripts/${r.data.id}`, { auth: true });
  assert.equal(after.data.status, 'summary_ready');

  // Async summary callback
  assert.equal((await call('/api/webhooks/summary?key=hook-key', { method: 'POST', body: { transcript_id: r.data.id, summary: 'v2' } })).status, 200);
  assert.equal((await call(`/api/admin/transcripts/${r.data.id}`, { auth: true })).data.summary, 'v2');
});

test('client cancels; slot frees up and reminders cancelled', async () => {
  const c = await call(`/api/public/bookings/${token}/cancel`, { method: 'POST', body: { reason: 'sick' } });
  assert.equal(c.status, 200);
  assert.equal((await call(`/api/public/bookings/${token}`)).data.status, 'cancelled');
  const av = await call(`/api/public/types/${typeSlug}/availability?duration=60`);
  assert.ok(av.data.days.flatMap((d) => d.slots).includes(firstSlot));
  const list = await call('/api/admin/bookings?scope=cancelled', { auth: true });
  const detail = await call(`/api/admin/bookings/${list.data[0].id}`, { auth: true });
  assert.ok(detail.data.reminders.every((r) => r.status === 'cancelled'));
});

test('admin CSRF guard rejects non-JSON writes', async () => {
  const r = await fetch(`${BASE}/api/admin/settings`, { method: 'PUT', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'owner_name=x' });
  assert.equal(r.status, 400);
});

test('paste a Contreal summary without transcript', async () => {
  assert.equal((await call('/api/admin/transcripts', { method: 'POST', auth: true, body: { source: 'contreal' } })).status, 400);
  const r = await call('/api/admin/transcripts', { method: 'POST', auth: true, body: { source: 'contreal', title: 'Call', summary: 'Summary from Contreal' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'summary_ready');
  assert.equal(r.data.source, 'contreal');
});

test('Contreal webhook with transcript + summary + tasks lands ready for approval', async () => {
  const r = await call('/api/webhooks/contreal?key=hook-key', {
    method: 'POST', body: { id: 'c-1', title: 'Consult', transcription: 'Dana: hi', summary: 'We discussed X.', action_items: ['Send proposal', 'Book follow-up'] },
  });
  assert.equal(r.status, 200);
  const tr = await call(`/api/admin/transcripts/${r.data.id}`, { auth: true });
  assert.equal(tr.data.source, 'contreal');
  assert.equal(tr.data.status, 'summary_ready');
  assert.match(tr.data.summary, /We discussed X\.[\s\S]*• Send proposal/);
  assert.equal(tr.data.sent_at, null);
});
