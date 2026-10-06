// Reminder scheduling + background sender.
import { all, get, getSettings, parseRow, run } from './db.js';
import { clientMessage, ownerMessage } from './bookings.js';
import { sendEmail, sendWhatsApp } from './notify.js';

export function scheduleReminders(booking, type) {
  const now = Date.now();
  const add = (recipient, channel, offset) => {
    const at = booking.start_utc - offset * 60_000;
    if (at <= now) return;
    run('INSERT INTO reminders(booking_id, recipient, channel, offset_min, send_at) VALUES(?,?,?,?,?)',
      booking.id, recipient, channel, offset, at);
  };
  for (const ch of booking.reminder_channels) for (const off of booking.reminder_offsets) add('client', ch, off);
  for (const ch of type.owner_reminder_channels) for (const off of type.owner_reminders) add('owner', ch, off);
}

export function cancelReminders(bookingId) {
  run("UPDATE reminders SET status='cancelled' WHERE booking_id=? AND status='pending'", bookingId);
}

async function deliver(r) {
  const b = parseRow('bookings', get('SELECT * FROM bookings WHERE id=?', r.booking_id));
  if (!b || b.status !== 'confirmed') { run("UPDATE reminders SET status='cancelled' WHERE id=?", r.id); return; }
  const s = getSettings();
  const msg = r.recipient === 'client' ? clientMessage('reminder', b) : ownerMessage('reminder', b);
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
    run("UPDATE reminders SET status='failed', error='missed (server offline)' WHERE status='pending' AND send_at < ?", Date.now() - 2 * 3600_000);
    const due = all("SELECT * FROM reminders WHERE status='pending' AND send_at <= ? ORDER BY send_at LIMIT 50", Date.now());
    for (const r of due) {
      try {
        await deliver(r);
        run("UPDATE reminders SET status='sent', sent_at=?, attempts=attempts+1, error=NULL WHERE id=? AND status='pending'", Date.now(), r.id);
      } catch (e) {
        const attempts = r.attempts + 1;
        run('UPDATE reminders SET attempts=?, error=?, status=? WHERE id=?', attempts, e.message, attempts >= 3 ? 'failed' : 'pending', r.id);
        console.error(`[reminder ${r.id}] ${e.message}`);
      }
    }
  } finally { running = false; }
}

export function startReminderWorker(intervalMs = 30_000) {
  const tick = () => processDueReminders().catch((e) => console.error('[reminders]', e));
  tick();
  return setInterval(tick, intervalMs);
}
