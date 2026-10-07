// Transcript intake (from your meeting transcriber), review, summary generation and approved sending.
import { config } from './config.js';
import { all, get, getSettings, parseRow, run } from './db.js';
import { emailLayout, sendEmail } from './notify.js';
import { t } from './i18n.js';

const MIN = 60_000;

/** Find the booking a transcript belongs to: by meeting link first, then by start time (±30 min). */
export async function matchBooking({ meetingUrl, start, bookingToken }) {
  if (bookingToken) {
    const b = await get('SELECT id FROM bookings WHERE token=?', bookingToken);
    if (b) return b.id;
  }
  if (meetingUrl) {
    const code = String(meetingUrl).replace(/^https?:\/\//, '').replace(/\?.*$/, '').replace(/\/$/, '');
    const b = await get("SELECT id FROM bookings WHERE meet_link IS NOT NULL AND replace(replace(meet_link,'https://',''),'http://','') = ?", code);
    if (b) return b.id;
  }
  if (start) {
    const b = await get(`SELECT id FROM bookings WHERE status='confirmed' AND start_utc BETWEEN ? AND ?
                   ORDER BY abs(start_utc - ?) LIMIT 1`, start - 30 * MIN, start + 30 * MIN, start);
    if (b) return b.id;
  }
  return null;
}

export async function ingestTranscript({ source, externalId, title, start, meetingUrl, transcript, bookingToken }) {
  if (!transcript || !String(transcript).trim()) throw new Error('Empty transcript');
  const bookingId = await matchBooking({ meetingUrl, start, bookingToken });
  const existing = externalId ? await get('SELECT id FROM transcripts WHERE source=? AND external_id=?', source, externalId) : null;
  if (existing) {
    await run('UPDATE transcripts SET transcript=?, title=?, meeting_start=?, meeting_url=?, booking_id=COALESCE(booking_id, ?) WHERE id=?',
      transcript, title || null, start || null, meetingUrl || null, bookingId, existing.id);
    return existing.id;
  }
  return Number((await run(`INSERT INTO transcripts(booking_id, source, external_id, title, meeting_start, meeting_url, transcript, received_at)
    VALUES(?,?,?,?,?,?,?,?)`, bookingId, source, externalId || null, title || null, start || null, meetingUrl || null,
  String(transcript), Date.now())).lastInsertRowid);
}

/** Fireflies.ai: webhook only carries the meeting id, so fetch the transcript via their GraphQL API. */
export async function fetchFirefliesTranscript(meetingId) {
  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.transcripts.firefliesKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query T($id: String!) { transcript(id: $id) { id title date meeting_link sentences { speaker_name text } } }`,
      variables: { id: meetingId },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error(`Fireflies: ${JSON.stringify(data.errors || data)}`);
  const tr = data.data.transcript;
  const lines = [];
  let last = null;
  for (const s of tr.sentences || []) {
    if (s.speaker_name !== last) { lines.push(`\n${s.speaker_name || 'Speaker'}:`); last = s.speaker_name; }
    lines.push(s.text);
  }
  return {
    source: 'fireflies', externalId: tr.id, title: tr.title, start: Number(tr.date) || null,
    meetingUrl: tr.meeting_link, transcript: lines.join(' ').replace(/ \n/g, '\n').trim(),
  };
}

export async function listTranscripts() {
  return await all(`SELECT t.id, t.booking_id, t.source, t.title, t.meeting_start, t.status, t.error, t.received_at, t.sent_at,
      b.name AS client_name, b.email AS client_email, b.type_name, b.start_utc
    FROM transcripts t LEFT JOIN bookings b ON b.id = t.booking_id ORDER BY t.received_at DESC LIMIT 200`);
}

export async function getTranscript(id) {
  const tr = await get('SELECT * FROM transcripts WHERE id=?', id);
  if (!tr) return null;
  tr.booking = tr.booking_id ? parseRow('bookings', await get('SELECT * FROM bookings WHERE id=?', tr.booking_id)) : null;
  return tr;
}

/**
 * Ask the external summary tool for a summary. It may reply synchronously ({summary}) or
 * later via POST /api/webhooks/summary. Nothing is ever sent to the client from here.
 */
export async function requestSummary(id) {
  const tr = await getTranscript(id);
  if (!tr) throw new Error('Transcript not found');
  if (!config.transcripts.summaryUrl) throw new Error('SUMMARY_API_URL is not configured — write the summary manually or configure the tool.');
  await run("UPDATE transcripts SET status='summarizing', error=NULL WHERE id=?", id);
  try {
    const res = await fetch(config.transcripts.summaryUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.transcripts.summaryKey ? { authorization: `Bearer ${config.transcripts.summaryKey}` } : {}),
      },
      body: JSON.stringify({
        transcript_id: tr.id,
        title: tr.title || tr.booking?.type_name || 'Meeting',
        meeting_start: tr.meeting_start ? new Date(tr.meeting_start).toISOString() : null,
        client_name: tr.booking?.name || null,
        language: (await getSettings()).language,
        transcript: tr.transcript,
        callback_url: `${config.baseUrl}/api/webhooks/summary?key=${encodeURIComponent(config.transcripts.webhookSecret)}`,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Summary tool ${res.status}: ${text.slice(0, 300)}`);
    let summary = null;
    try { const j = JSON.parse(text); summary = j.summary ?? j.text ?? j.result ?? null; } catch { summary = text || null; }
    if (summary) await run("UPDATE transcripts SET summary=?, status='summary_ready' WHERE id=?", String(summary), id);
    // Otherwise stay in 'summarizing' until the tool calls back.
  } catch (e) {
    await run("UPDATE transcripts SET status='pending_review', error=? WHERE id=?", e.message, id);
    throw e;
  }
  return await getTranscript(id);
}

export async function storeSummary(id, summary) {
  const tr = await get('SELECT id, status FROM transcripts WHERE id=?', id);
  if (!tr) throw new Error('Transcript not found');
  if (tr.status === 'sent') throw new Error('Summary already sent');
  await run("UPDATE transcripts SET summary=?, status='summary_ready', error=NULL WHERE id=?", String(summary), id);
}

/** Only called when YOU click "Approve & send" in the dashboard. */
export async function sendSummary(id, { summary, to, subject }) {
  const tr = await getTranscript(id);
  if (!tr) throw new Error('Transcript not found');
  const finalSummary = String(summary ?? tr.summary ?? '').trim();
  if (!finalSummary) throw new Error('Summary is empty');
  const recipient = to || tr.booking?.email;
  if (!recipient) throw new Error('No recipient — link the transcript to a booking or enter an email');
  const s = await getSettings();
  const L = t(s.language);
  const title = tr.booking?.type_name || tr.title || 'Meeting';
  const lines = [L.hi(tr.booking?.name || ''), L.msgSummary, finalSummary];
  await sendEmail({
    to: recipient,
    subject: subject || L.subjSummary(title),
    text: lines.join('\n\n'),
    html: await emailLayout({ lines, dir: L.dir }),
    replyTo: s.owner_email || undefined,
  });
  await run("UPDATE transcripts SET summary=?, status='sent', sent_at=? WHERE id=?", finalSummary, Date.now(), id);
  return await getTranscript(id);
}
