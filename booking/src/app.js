import path from 'node:path';
import fs from 'node:fs';
import { assertConfig, config, ROOT } from './config.js';
import { Router, html, json, readBody, serveStatic } from './http.js';
import { mountPublic } from './routes/public.js';
import { mountAdmin } from './routes/admin.js';
import { mountWebhooks } from './routes/webhooks.js';
import { processDueReminders } from './reminders.js';
import { getSettings } from './db.js';
import { translateError } from './i18n.js';
import { safeEqual } from './crypto.js';

export const configProblems = assertConfig();

// Some hosts (Vercel) pre-define request properties with getters; define ours explicitly.
function setProp(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: true });
}

const router = new Router();

// Sends due reminders. Called every minute by Vercel Cron (or any scheduler) with the CRON_SECRET.
router.get('/api/cron/reminders', async (req, res) => {
  const auth = String(req.headers.authorization || '');
  const ok = config.cronSecret ? safeEqual(auth, `Bearer ${config.cronSecret}`) : !config.serverless;
  if (!ok) return json(res, 401, { error: 'Unauthorized' });
  await processDueReminders();
  json(res, 200, { ok: true });
});
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

// Works as a plain Node http handler (local server) and as a Vercel function.
export async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // Vercel rewrites every path to /api?__path=/original — restore the original path.
  if (url.searchParams.has('__path')) {
    const original = url.searchParams.get('__path');
    url.searchParams.delete('__path');
    url.pathname = original.startsWith('/') ? original : `/${original}`;
  }
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  try {
    if (configProblems.length && config.serverless) {
      // Missing settings on the host: say which (names only, never values).
      return html(res, 500, `<h1>Setup needed</h1><p>Add these Environment Variables in Vercel → Settings → Environment Variables, then redeploy:</p><ul>${configProblems.map((p) => `<li>${p}</li>`).join('')}</ul>`);
    }
    const m = router.match(req.method, url.pathname);
    if (m) {
      setProp(req, 'params', m.params);
      setProp(req, 'query', url.searchParams);
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        setProp(req, 'rawBody', await readBody(req));
        const ct = String(req.headers['content-type'] || '');
        if (req.rawBody.length && ct.includes('json')) {
          try { setProp(req, 'body', JSON.parse(req.rawBody.toString('utf8'))); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400, expose: true }); }
        } else if (req.rawBody.length && ct.includes('x-www-form-urlencoded')) {
          setProp(req, 'body', Object.fromEntries(new URLSearchParams(req.rawBody.toString('utf8'))));
        } else setProp(req, 'body', {});
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
    if (!res.headersSent) {
      const settings = await getSettings().catch(() => ({ admin_language: 'he', language: 'he' }));
      const lang = url.pathname.startsWith('/api/admin') ? settings.admin_language
        : url.pathname.startsWith('/api/public') ? settings.language : 'en';
      json(res, status, { error: translateError(e.expose ? e.message : 'Something went wrong', lang) });
    }
    else res.end();
  }
}

