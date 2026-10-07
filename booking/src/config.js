import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependencies). Real environment variables win.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
// First run: create .env from the example with a random secret and admin password, so it starts with zero setup.
function ensureEnvFile(file) {
  if (fs.existsSync(file) || process.env.ADMIN_PASSWORD) return;
  const example = path.join(ROOT, '.env.example');
  if (!fs.existsSync(example)) return;
  const password = crypto.randomBytes(6).toString('base64url');
  const content = fs.readFileSync(example, 'utf8')
    .replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${password}`)
    .replace(/^APP_SECRET=.*$/m, `APP_SECRET=${crypto.randomBytes(32).toString('hex')}`);
  fs.writeFileSync(file, content, { mode: 0o600 });
  console.log(`\n✅ Created ${file}\n   Dashboard password: ${password}\n   (you can change it in the .env file)\n`);
}
if (!process.env.VERCEL) ensureEnvFile(path.join(ROOT, '.env'));
loadEnvFile(path.join(ROOT, '.env'));

const env = (k, d = '') => process.env[k] ?? d;

// On your own computer the address always follows PORT, so changing the port never breaks links.
function localBaseUrl(base, port) {
  // On Vercel the production domain is known automatically.
  if (!base && process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (!base) return `http://localhost:${port}`;
  const u = base.replace(/\/$/, '');
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u) ? u.replace(/(:\d+)?$/, `:${port}`) : u;
}

export const config = {
  port: Number(env('PORT', '5050')),
  baseUrl: localBaseUrl(env('BASE_URL', ''), env('PORT', '5050')),
  adminPassword: env('ADMIN_PASSWORD'),
  appSecret: env('APP_SECRET'),
  dbPath: path.resolve(ROOT, env('DB_PATH', './data/booking.db')),
  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
  },
  email: {
    provider: env('EMAIL_PROVIDER', 'gmail'),
    fromGoogleAccount: env('EMAIL_FROM_GOOGLE_ACCOUNT'),
    resendKey: env('RESEND_API_KEY'),
    resendFrom: env('RESEND_FROM'),
  },
  whatsapp: {
    provider: env('WHATSAPP_PROVIDER', 'none'),
    twilioSid: env('TWILIO_ACCOUNT_SID'),
    twilioToken: env('TWILIO_AUTH_TOKEN'),
    twilioFrom: env('TWILIO_WHATSAPP_FROM'),
    twilioContentSid: env('TWILIO_CONTENT_SID'),
    metaToken: env('META_WA_TOKEN'),
    metaPhoneId: env('META_WA_PHONE_NUMBER_ID'),
    metaTemplate: env('META_WA_TEMPLATE'),
    metaTemplateLang: env('META_WA_TEMPLATE_LANG', 'en'),
  },
  turso: {
    url: env('TURSO_DATABASE_URL'),
    token: env('TURSO_AUTH_TOKEN'),
  },
  cronSecret: env('CRON_SECRET'),
  serverless: Boolean(process.env.VERCEL),
  zoom: {
    accountId: env('ZOOM_ACCOUNT_ID'),
    clientId: env('ZOOM_CLIENT_ID'),
    clientSecret: env('ZOOM_CLIENT_SECRET'),
  },
  transcripts: {
    webhookSecret: env('TRANSCRIPT_WEBHOOK_SECRET'),
    firefliesKey: env('FIREFLIES_API_KEY'),
    firefliesSecret: env('FIREFLIES_WEBHOOK_SECRET'),
    summaryUrl: env('SUMMARY_API_URL'),
    summaryKey: env('SUMMARY_API_KEY'),
  },
};

export function assertConfig() {
  const problems = [];
  if (!config.adminPassword || config.adminPassword === 'change-me') problems.push('ADMIN_PASSWORD is not set');
  if (!config.appSecret || config.appSecret.length < 32) problems.push('APP_SECRET must be at least 32 characters');
  if (config.serverless) {
    // Serverless disks are wiped between requests, so data must live in Turso.
    if (!config.turso.url) problems.push('TURSO_DATABASE_URL is not set (create a free database at turso.tech)');
    if (!config.turso.token) problems.push('TURSO_AUTH_TOKEN is not set');
    if (!config.cronSecret) problems.push('CRON_SECRET is not set (any long random text — protects the reminder job)');
  }
  return problems;
}
