import { config } from '../config.js';
import { hmacHex, safeEqual } from '../crypto.js';
import { json } from '../http.js';
import { getSettings } from '../db.js';
import { userError } from '../bookings.js';
import { fetchFirefliesTranscript, ingestTranscript, storeSummary } from '../transcripts.js';

function requireKey(req) {
  const key = req.query.get('key') || req.headers['x-webhook-key'];
  if (!config.transcripts.webhookSecret || !key || !safeEqual(key, config.transcripts.webhookSecret)) throw userError('Unauthorized', 401);
}

export function mountWebhooks(r) {
  /**
   * Transcript + summary intake. Works with any notetaker that can POST JSON (directly or via Zapier/Make/n8n),
   * including tools like Contreal that transcribe AND summarize. Common field names are accepted:
   * { "transcript" | "transcription" | "text": "..." or [{speaker, text}],
   *   "summary" | "recap" | "overview": "...",          (optional — arrives ready for your approval)
   *   "tasks" | "action_items": ["...", ...] or "...",   (optional — appended to the summary)
   *   "external_id" | "id" | "meeting_id", "title", "start_time", "meeting_url", "booking_token", "source" }
   * Nothing is sent to the client — the transcript waits in the dashboard for your approval.
   */
  const intake = (defaultSource) => async (req, res) => {
    requireKey(req);
    const b = req.body || {};
    const pick = (...keys) => keys.map((k) => b[k]).find((v) => v != null && v !== '');
    const raw = pick('transcript', 'transcription', 'text');
    const transcript = typeof raw === 'string' ? raw
      : Array.isArray(raw) ? raw.map((x) => (typeof x === 'string' ? x : x.speaker ? `${x.speaker}: ${x.text}` : x.text)).join('\n') : '';
    let summary = pick('summary', 'recap', 'overview');
    if (summary && typeof summary !== 'string') summary = summary.text || summary.overview || JSON.stringify(summary);
    const tasks = pick('tasks', 'action_items', 'next_steps');
    const taskLines = Array.isArray(tasks) ? tasks.map((t) => `• ${typeof t === 'string' ? t : t.text || t.title || JSON.stringify(t)}`).join('\n')
      : typeof tasks === 'string' ? tasks : '';
    if (taskLines) summary = `${summary ? `${summary}\n\n` : ''}${(await getSettings()).language === 'he' ? 'משימות להמשך:' : 'Next steps:'}\n${taskLines}`;
    if (!transcript.trim() && !summary) throw userError('transcript or summary is required');
    const startRaw = pick('start_time', 'date', 'meeting_start');
    const id = await ingestTranscript({
      source: String(b.source || defaultSource).slice(0, 50),
      externalId: pick('external_id', 'id', 'meeting_id') != null ? String(pick('external_id', 'id', 'meeting_id')) : null,
      title: pick('title', 'meeting_title'), meetingUrl: pick('meeting_url', 'meeting_link'), bookingToken: b.booking_token,
      start: startRaw ? (typeof startRaw === 'number' ? startRaw : Date.parse(startRaw) || null) : null,
      transcript: transcript.trim() || '(no transcript — summary only)',
    });
    if (summary) {
      try { await storeSummary(id, summary); } catch { /* already sent — keep what was approved */ }
    }
    json(res, 200, { ok: true, id });
  };
  r.post('/api/webhooks/transcript', intake('webhook'));
  r.post('/api/webhooks/contreal', intake('contreal'));

  /** Fireflies.ai webhook: { meetingId, eventType: "Transcription completed" } signed with x-hub-signature. */
  r.post('/api/webhooks/fireflies', async (req, res) => {
    if (config.transcripts.firefliesSecret) {
      const sig = String(req.headers['x-hub-signature'] || '').replace(/^sha256=/, '');
      if (!sig || !safeEqual(sig, hmacHex(config.transcripts.firefliesSecret, req.rawBody))) throw userError('Bad signature', 401);
    } else {
      requireKey(req);
    }
    const { meetingId, eventType } = req.body || {};
    if (!meetingId) throw userError('meetingId missing');
    if (eventType && !/transcription completed/i.test(eventType)) return json(res, 200, { ignored: true });
    const data = await fetchFirefliesTranscript(meetingId);
    json(res, 200, { ok: true, id: await ingestTranscript(data) });
  });

  /** Async callback from the summary tool: { transcript_id, summary }. */
  r.post('/api/webhooks/summary', async (req, res) => {
    requireKey(req);
    const { transcript_id: id, summary } = req.body || {};
    if (!id || !summary) throw userError('transcript_id and summary are required');
    await storeSummary(Number(id), summary);
    json(res, 200, { ok: true });
  });
}
