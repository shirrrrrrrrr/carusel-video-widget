// Email + WhatsApp delivery.
import { config } from './config.js';
import { get, getSettings } from './db.js';
import { gmailSend } from './google.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };

function senderAccountId() {
  if (config.email.fromGoogleAccount) {
    const a = get('SELECT id FROM google_accounts WHERE email = ?', config.email.fromGoogleAccount);
    if (a) return a.id;
  }
  const s = getSettings();
  const cal = s.default_calendar && get('SELECT account_id FROM calendars WHERE id = ?', Number(s.default_calendar));
  if (cal) return cal.account_id;
  return get('SELECT id FROM google_accounts ORDER BY id LIMIT 1')?.id;
}

export function emailEnabled() {
  if (config.email.provider === 'resend') return Boolean(config.email.resendKey && config.email.resendFrom);
  if (config.email.provider === 'gmail') return Boolean(senderAccountId());
  return false;
}

export function whatsappEnabled() {
  const w = config.whatsapp;
  if (w.provider === 'twilio') return Boolean(w.twilioSid && w.twilioToken && w.twilioFrom);
  if (w.provider === 'meta') return Boolean(w.metaToken && w.metaPhoneId);
  return false;
}

/** Wrap paragraphs (plain text lines) into a simple, mail-client-safe HTML layout. */
export function emailLayout({ lines, dir = 'ltr', button }) {
  const s = getSettings();
  const body = lines.map((l) => `<p style="margin:0 0 12px">${esc(l).replace(/\n/g, '<br>')}</p>`).join('');
  const btn = button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="background:${esc(s.brand_color)};color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">${esc(button.label)}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f5f7;padding:24px;font-family:Arial,Helvetica,sans-serif">
<div dir="${dir}" style="max-width:560px;margin:auto;background:#fff;border-radius:12px;padding:28px;color:#1d1d1f;font-size:15px;line-height:1.5;text-align:${dir === 'rtl' ? 'right' : 'left'}">
${body}${btn}<p style="margin:24px 0 0;color:#86868b;font-size:13px">${esc(s.owner_name)}</p></div></body></html>`;
}

export async function sendEmail({ to, subject, text, html, replyTo }) {
  if (!to) throw new Error('No recipient email');
  if (config.email.provider === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.email.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.email.resendFrom, to: [to], subject, text, html, reply_to: replyTo || undefined }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return;
  }
  if (config.email.provider === 'gmail') {
    const id = senderAccountId();
    if (!id) throw new Error('No Google account connected for sending email');
    await gmailSend(id, { to, subject, text, html, replyTo });
    return;
  }
  throw new Error('Email is disabled (EMAIL_PROVIDER=none)');
}

export function normalizePhone(p) {
  if (!p) return '';
  let s = String(p).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  return /^\+\d{8,15}$/.test(s) ? s : '';
}

/**
 * Send a WhatsApp message. `vars` feed approved templates (required by WhatsApp for
 * business-initiated messages); `text` is used for free-form sends (e.g. Twilio sandbox).
 */
export async function sendWhatsApp({ to, text, vars = [] }) {
  const phone = normalizePhone(to);
  if (!phone) throw new Error(`Invalid phone number: ${to}`);
  const w = config.whatsapp;
  if (w.provider === 'twilio') {
    const params = new URLSearchParams({ From: w.twilioFrom, To: `whatsapp:${phone}` });
    if (w.twilioContentSid) {
      params.set('ContentSid', w.twilioContentSid);
      params.set('ContentVariables', JSON.stringify(Object.fromEntries(vars.map((v, i) => [String(i + 1), String(v)]))));
    } else {
      params.set('Body', text);
    }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${w.twilioSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${w.twilioSid}:${w.twilioToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
    return;
  }
  if (w.provider === 'meta') {
    const message = w.metaTemplate
      ? {
          type: 'template',
          template: {
            name: w.metaTemplate,
            language: { code: w.metaTemplateLang },
            components: [{ type: 'body', parameters: vars.map((v) => ({ type: 'text', text: String(v) })) }],
          },
        }
      : { type: 'text', text: { body: text } };
    const res = await fetch(`https://graph.facebook.com/v21.0/${w.metaPhoneId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${w.metaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.slice(1), ...message }),
    });
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${await res.text()}`);
    return;
  }
  throw new Error('WhatsApp is disabled (WHATSAPP_PROVIDER=none)');
}
