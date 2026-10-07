// Reminder scheduling + background sender.
import { all, get, getSettings, parseRow, run } from './db.js';
import { clientMessage, ownerMessage } from './bookings.js';
import { sendEmail, sendWhatsApp } from './notify.js';

export async function scheduleReminders(booking, type) {
  const now = Date.now();
  const add = async (recipient, channel, offset) => {
    const at = booking.start_utc - offset * 60_000;
    if (at <= now) return;
    await run('INSERT INTO reminders(booking_id, recipient, channel, offset_min, send_at) VALUES(?,?,?,?,?)',
      booking.id, recipient, channel, offset, at);
  };
  for (const ch of booking.reminder_channels) for (const off of booking.reminder_offsets) await add('client', ch, off);
  for (const ch of type.owner_reminder_channels) for (const off of type.owner_reminders) await add('owner', ch, off);
}

export async function cancelReminders(bookingId) {
  await run("UPDATE reminders SET status='cancelled' WHERE booking_id=? AND status='pending'", bookingId);
}

async function deliver(r) {
  const b = parseRow('bookings', await get('SELECT * FROM bookings WHERE id=?', r.booking_id));
  if (!b || b.status !== 'confirmed') { await run("UPDATE reminders SET status='cancelled' WHERE id=?", r.id); return; }
  const s = await getSettings();
  const msg = r.recipient === 'client' ? await clientMessage('reminder', b) : await ownerMessage('reminder', b);
  if (r.channel === 'email') {
    const to = r.recipient === 'client' ? b.email : s.owner_email;
    await sendEmail({ to, subject: msg.subject, text: msg.text, html: msg.html, replyTo: r.recipient === 'client' ? s.owner_email || undefined : b.email });
  } else if (r.channel === 'whatsapp') {
    const to = r.recipient === 'client' ? b.phone : s.owner_phone;
    await sendWhatsApp({ to, text: msg.text, vars: msg.vars });
  }
}

let running = false;
export async function processDueReminders() {
  if (running) return;
  running = true;
  try {
    // Skip reminders that are more than 2h late (e.g. server was down) — a stale reminder is worse than none.
    await run("UPDATE reminders SET status='failed', error='missed (server offline)' WHERE status='pending' AND send_at < ?", Date.now() - 2 * 3600_000);
    const due = await all("SELECT * FROM reminders WHERE status='pending' AND send_at <= ? ORDER BY send_at LIMIT 50", Date.now());
    for (const r of due) {
      // Claim it first, so two overlapping runs (e.g. serverless cron) never send the same reminder twice.
      const claim = await run("UPDATE reminders SET status='sending' WHERE id=? AND status='pending'", r.id);
      if (!claim.changes) continue;
      try {
        await deliver(r);
        await run("UPDATE reminders SET status='sent', sent_at=?, attempts=attempts+1, error=NULL WHERE id=? AND status='sending'", Date.now(), r.id);
      } catch (e) {
        const attempts = r.attempts + 1;
        await run("UPDATE reminders SET attempts=?, error=?, status=? WHERE id=? AND status='sending'", attempts, e.message, attempts >= 3 ? 'failed' : 'pending', r.id);
        console.error(`[reminder ${r.id}] ${e.message}`);
      }
    }
    // A run that crashed mid-send leaves 'sending' rows; release them after 10 minutes.
    await run("UPDATE reminders SET status='pending' WHERE status='sending' AND send_at < ?", Date.now() - 10 * 60_000);
  } finally { running = false; }
}

export function startReminderWorker(intervalMs = 30_000) {
  const tick = () => processDueReminders().catch((e) => console.error('[reminders]', e));
  tick();
  return setInterval(tick, intervalMs);
}
