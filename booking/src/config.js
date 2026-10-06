import fs from 'node:fs';
import path from 'node:path';
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
loadEnvFile(path.join(ROOT, '.env'));

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '3000')),
  baseUrl: env('BASE_URL', 'http://localhost:3000').replace(/\/$/, ''),
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
  return problems;
}
