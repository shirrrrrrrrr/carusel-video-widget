import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { assertConfig, config, ROOT } from './config.js';
import { Router, html, json, readBody, serveStatic } from './http.js';
import { mountPublic } from './routes/public.js';
import { mountAdmin } from './routes/admin.js';
import { mountWebhooks } from './routes/webhooks.js';
import { startReminderWorker } from './reminders.js';
import { get, run } from './db.js';

const problems = assertConfig();
if (problems.length) {
  console.error(`\n⚠️  Configuration problems:\n - ${problems.join('\n - ')}\nCopy .env.example to .env and fill it in.\n`);
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

// Seed a first meeting type so the booking page isn't empty on first run.
if (!get('SELECT 1 FROM meeting_types LIMIT 1')) {
  const weekdays = { 0: [[540, 1020]], 1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]], 4: [[540, 1020]], 5: [], 6: [] };
  run(`INSERT INTO meeting_types(slug, name, description, durations, schedule, buffer_after, fields, created_at, locations)
       VALUES(?,?,?,?,?,?,?,?,'[{"type":"google_meet","value":""}]')`, 'intro', 'Intro call', 'A short call to get to know each other.', '[30]',
  JSON.stringify(weekdays), 15,
  JSON.stringify([{ id: 'topic', label: 'What would you like to talk about?', type: 'textarea', required: false, placeholder: '', options: [] }]),
  Date.now());
}

const router = new Router();
mountPublic(router);
mountAdmin(router);
mountWebhooks(router);

const PUBLIC = path.join(ROOT, 'public');
const staticFiles = serveStatic(PUBLIC);
const page = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

const PAGES = [
  [/^\/$/, 'index.html'],
  [/^\/book\/[^/]+\/?$/, 'book.html'],
  [/^\/manage\/[^/]+\/?$/, 'manage.html'],
  [/^\/admin\/?$/, 'admin.html'],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  try {
    const m = router.match(req.method, url.pathname);
    if (m) {
      req.params = m.params;
      req.query = url.searchParams;
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        req.rawBody = await readBody(req);
        const ct = String(req.headers['content-type'] || '');
        if (req.rawBody.length && ct.includes('json')) {
          try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
        } else if (req.rawBody.length && ct.includes('x-www-form-urlencoded')) {
          req.body = Object.fromEntries(new URLSearchParams(req.rawBody.toString('utf8')));
        } else req.body = {};
      }
      for (const h of m.handlers) await h(req, res);
      return;
    }
    if (req.method === 'GET') {
      const p = PAGES.find(([re]) => re.test(url.pathname));
      if (p) return html(res, 200, page(p[1]));
      if (staticFiles(req, res, url.pathname)) return;
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && !e.expose) console.error(e);
    if (!res.headersSent) json(res, status, { error: e.expose ? e.message : 'Something went wrong' });
    else res.end();
  }
});

server.listen(config.port, () => {
  console.log(`Booking system running at ${config.baseUrl} (port ${config.port})`);
  console.log(`  Booking page: ${config.baseUrl}/`);
  console.log(`  Dashboard:    ${config.baseUrl}/admin`);
});
startReminderWorker();
