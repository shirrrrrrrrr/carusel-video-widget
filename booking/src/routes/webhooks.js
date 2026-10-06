import { config } from '../config.js';
import { hmacHex, safeEqual } from '../crypto.js';
import { json } from '../http.js';
import { userError } from '../bookings.js';
import { fetchFirefliesTranscript, ingestTranscript, storeSummary } from '../transcripts.js';

function requireKey(req) {
  const key = req.query.get('key') || req.headers['x-webhook-key'];
  if (!config.transcripts.webhookSecret || !key || !safeEqual(key, config.transcripts.webhookSecret)) throw userError('Unauthorized', 401);
}

export function mountWebhooks(r) {
  /**
   * Generic transcript intake. Works with any transcriber that can POST JSON (directly or via Zapier/Make/n8n):
   * { "transcript": "...", "external_id": "abc", "title": "...", "start_time": "2026-10-06T10:00:00Z",
   *   "meeting_url": "https://meet.google.com/xxx-yyyy-zzz", "booking_token": "(optional)", "source": "otter" }
   */
  r.post('/api/webhooks/transcript', (req, res) => {
    requireKey(req);
    const b = req.body || {};
    const id = ingestTranscript({
      source: String(b.source || 'webhook').slice(0, 50),
      externalId: b.external_id ? String(b.external_id) : null,
      title: b.title, meetingUrl: b.meeting_url, bookingToken: b.booking_token,
      start: b.start_time ? Date.parse(b.start_time) || null : null,
      transcript: typeof b.transcript === 'string' ? b.transcript
        : Array.isArray(b.transcript) ? b.transcript.map((x) => (x.speaker ? `${x.speaker}: ${x.text}` : x.text)).join('\n') : '',
    });
    json(res, 200, { ok: true, id });
  });

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
    json(res, 200, { ok: true, id: ingestTranscript(data) });
  });

  /** Async callback from the summary tool: { transcript_id, summary }. */
  r.post('/api/webhooks/summary', (req, res) => {
    requireKey(req);
    const { transcript_id: id, summary } = req.body || {};
    if (!id || !summary) throw userError('transcript_id and summary are required');
    storeSummary(Number(id), summary);
    json(res, 200, { ok: true });
  });
}
