import crypto from 'node:crypto';
import { config } from './config.js';

const key = () => crypto.createHash('sha256').update(config.appSecret || 'insecure-dev-secret').digest();

export function encrypt(text) {
  if (text == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload) {
  if (!payload) return null;
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function sign(value) {
  const mac = crypto.createHmac('sha256', key()).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function unsign(signed) {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  return safeEqual(sign(value), signed) ? value : null;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

export function hmacHex(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
