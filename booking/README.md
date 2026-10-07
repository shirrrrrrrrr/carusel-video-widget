# Booking — a self-hosted Calendly replacement

Clients book meetings with you. The system checks **all your Google calendars across several Google accounts**
for conflicts and saves each booking to the calendar you choose. It sends reminders by **email or WhatsApp**
(the client picks whether and when). Transcripts from your notetaker come in for **your review**, and a summary
is sent to the client **only after you approve it**.

No npm packages: it runs on Node.js ≥ 22.5 alone (built-in HTTP server and SQLite), locally or on Vercel with Turso.

## Features

| Area | What you get |
|---|---|
| Meeting types | Name, link (`/book/<slug>`), description, one or several durations (the client chooses), color |
| Where | Per meeting type: **Google Meet** (link created automatically), **Zoom** (personal link, or a new meeting per booking via the Zoom API), **phone call** (the client's number is required and you call them), in person, or another link. Tick several and the client chooses |
| Times | **Fixed start times** (every 15/30/60… min) or **client picks any start time** within your hours · gap before/after meetings · minimum notice · how far ahead · max per day · weekly hours per meeting type |
| Calendars | Connect **several Google accounts** · tick "check for conflicts" on any calendar · one **default calendar** for new bookings · each meeting type can save to a different calendar or account |
| Client questions | Custom fields: short/long text, email, phone, number, URL, dropdown, multiple choice, checkbox, date. Each can be required |
| Reminders | Per meeting type: channels offered (email / WhatsApp), timing options (5 min … 1 week), pre-selected defaults. The client chooses. **You** get your own reminders too (email / WhatsApp) |
| Notifications | Confirmation + cancellation emails, a "new booking" email to you, the Google Calendar invite, a self-service cancel link |
| Transcripts | Your notetaker is invited to the meeting automatically → its transcript arrives by webhook → you review it → "Generate summary" sends it to your summary tool → you edit → **Approve & send** |
| Languages | Hebrew by default (RTL) for the dashboard, booking pages, error messages and all emails; English available (toggle in the dashboard top bar; client language in Settings) |

## Quick start

```bash
cd booking
cp .env.example .env          # then fill it in (see below)
npm start                     # http://localhost:5050  ·  dashboard: /admin
npm test                      # unit + end-to-end tests
```

### 1. Google Calendar (required)
1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library**: enable **Google Calendar API**, plus **Gmail API** if you want emails sent from your Gmail.
3. **OAuth consent screen**: choose External, add your own Google addresses as *test users* (or publish the app).
4. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI: `https://YOUR-DOMAIN/admin/google/callback`.
5. Put the client ID and secret in `.env`. Restart, open `/admin` → **Calendars → Connect Google account**. Repeat for each account.
6. Tick **Check for conflicts** on every calendar that matters, and choose the **Default** calendar.

### 2. Email
- `EMAIL_PROVIDER=gmail` sends from a connected Google account (the default calendar's account, or `EMAIL_FROM_GOOGLE_ACCOUNT`).
- `EMAIL_PROVIDER=resend` sends via [Resend](https://resend.com) (needs a verified domain).

### 3. Zoom (optional)
- Without setup: tick **Zoom** in a meeting type and paste your personal Zoom link.
- For a separate Zoom meeting per booking: create a **Server-to-Server OAuth** app at [marketplace.zoom.us](https://marketplace.zoom.us/)
  with the `meeting:write:meeting:admin` scope, and put `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` in `.env`.
  Cancelled bookings delete their Zoom meeting.

### 4. WhatsApp (optional)
- **Twilio** (`WHATSAPP_PROVIDER=twilio`): the sandbox works for testing. In production WhatsApp requires an
  approved template for messages you start, so set `TWILIO_CONTENT_SID`.
- **Meta Cloud API** (`WHATSAPP_PROVIDER=meta`): create a message template, e.g. `meeting_reminder`, with 4 body
  variables: `{{1}}` name, `{{2}}` meeting, `{{3}}` date/time, `{{4}}` link.

Test both from **Settings → Integrations**.

## Transcripts & summaries

1. In a meeting type, enable **Invite my notetaker** and enter the bot's address (e.g. `fred@fireflies.ai`, or your
   Otter / tl;dv / Fathom calendar address). The notetaker is added to the calendar event and joins by itself.
2. When the transcript is ready, the notetaker (or Zapier / Make / n8n) posts it to:

```
POST /api/webhooks/transcript?key=TRANSCRIPT_WEBHOOK_SECRET
{
  "source": "otter",
  "external_id": "meeting-123",
  "title": "Consultation — Dana",
  "start_time": "2026-10-06T10:00:00Z",
  "meeting_url": "https://meet.google.com/abc-defg-hij",
  "transcript": "Dana: Hi…\nMe: Hello…"        // or [{ "speaker": "Dana", "text": "Hi" }, …]
}
```
   The transcript is matched to its booking by `booking_token`, the Meet link, or the start time (±30 min).
   **Fireflies.ai** is built in: set `FIREFLIES_API_KEY` + `FIREFLIES_WEBHOOK_SECRET` and use `/api/webhooks/fireflies` as the webhook URL.
3. It appears in **Dashboard → Transcripts** as *Needs review*.
4. **Generate with summary tool** POSTs this to `SUMMARY_API_URL` (`Authorization: Bearer SUMMARY_API_KEY`):
   ```json
   { "transcript_id": 7, "title": "...", "client_name": "Dana", "language": "he",
     "meeting_start": "...", "transcript": "...", "callback_url": "https://…/api/webhooks/summary?key=…" }
   ```
   The tool replies with `{"summary": "..."}` right away, or later calls `callback_url` with `{"transcript_id": 7, "summary": "..."}`.
   You can also write or paste the summary yourself.
5. Edit the summary, then click **Approve & send to client**. Nothing is sent without that click.

### Contreal (קונטריל): transcript + summary

[Contreal](https://contreal.io/) joins the Meet/Zoom meetings on your calendar by itself, then transcribes **and** summarizes,
so no separate summary tool or "Invite my notetaker" setting is needed:

1. Connect Contreal to the Google Calendar where bookings are saved (every booking gets a Meet link automatically).
2. Have Contreal (or Zapier/Make) POST its result to `/api/webhooks/contreal?key=TRANSCRIPT_WEBHOOK_SECRET`, e.g.
   `{"id": "...", "title": "...", "start_time": "...", "meeting_url": "...", "transcript": "...", "summary": "...", "tasks": ["..."]}`.
   Common field names are accepted (`transcription`, `recap`, `action_items`, …). Tasks are appended to the summary.
3. The meeting appears in **Transcripts** as *Summary ready*, matched to the booking by Meet link or time.
   Edit it, then **Approve & send to client**.

No webhook yet? Use **Transcripts → Paste transcript / Contreal summary**.
Make sure Contreal itself is **not** set to email summaries to participants, otherwise the client gets the summary before you approve it.

## Deploying

### Vercel (Pro plan)
The repo includes `vercel.json` and `api/index.js`. Vercel keeps no files between requests, so data lives in **Turso** (hosted SQLite, free tier).
Reminders are sent by a **Vercel Cron** job every minute, which needs the Pro plan; the Hobby plan only allows daily crons.

1. **Turso:** create a database at [turso.tech](https://turso.tech), then copy its URL (`libsql://…`) and an auth token.
2. **Vercel:** Add New → Project → import this GitHub repo. Set **Root Directory** to `booking` and leave the framework as "Other".
3. **Region:** `vercel.json` runs the function in Dublin (`dub1`); create the Turso database in AWS EU West (Ireland) too, or change `regions` to match.
4. **Environment Variables:** `ADMIN_PASSWORD`, `APP_SECRET` (64 random hex chars), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
   `CRON_SECRET` (random text), plus Google / email / WhatsApp keys as needed. `BASE_URL` is optional: the production domain is detected automatically.
5. Deploy. If something is missing, the site shows which variables to add.
6. In Google Cloud, add `https://YOUR-DOMAIN/admin/google/callback` as an authorized redirect URI.

Production deploys follow the project's production branch (Settings → Environments → Production).

### Always-on servers (Railway, Render, a VPS)
Run `npm start`. Keep `data/` on persistent storage, or set the Turso variables. Reminders are sent by the running process every 30 s.

## How availability works

A start time is offered when:
- it falls inside that weekday's hours (in your timezone), and the meeting ends before the window closes;
- it is at least *minimum notice* from now and within *book up to* days;
- `[start − gap before, end + gap after]` doesn't touch any busy time in **any** calendar marked "check for conflicts"
  in **any** connected account, or any existing booking (with that booking's own gaps);
- the daily limit for that meeting type isn't reached.

Times are re-checked against fresh calendar data at the moment of booking. If Google can't be reached, no times are
shown, rather than risk a double booking.

## Project layout

```
src/app.js           request handler, page routing, cron endpoint (shared by local + Vercel)
src/server.js        local HTTP server + reminder timer
api/index.js         Vercel function entry
src/db.js            SQLite (local file) or Turso (HTTP) driver, schema, migrations
src/availability.js  pure slot engine (unit-tested)
src/bookings.js      booking create/cancel, messages
src/google.js        OAuth, calendars, free/busy, events, Gmail send
src/notify.js        email (Gmail/Resend) + WhatsApp (Twilio/Meta)
src/reminders.js     reminder scheduling + background sender
src/transcripts.js   transcript intake, summary tool, approved sending
src/routes/*.js      public, admin and webhook APIs
public/              booking page, manage page, admin dashboard
```
