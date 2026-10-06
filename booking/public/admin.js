import { api, esc, $, $$, durationLabel, fmtDate, fmtTime } from '/common.js';

const app = $('#app');
const PRESETS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FIELD_TYPES = { text: 'Short text', textarea: 'Long text', email: 'Email', phone: 'Phone', number: 'Number', url: 'URL', select: 'Dropdown', radio: 'Multiple choice', checkbox: 'Checkbox', date: 'Date' };
const LOCATIONS = { google_meet: 'Google Meet (link created automatically)', phone: 'Phone call', in_person: 'In person (address)', custom: 'Custom (Zoom link, etc.)', none: 'No location' };

let S = null;               // admin state
let tab = 'bookings';
let draft = null;           // meeting type being edited
let transcriptId = null;

const toast = (msg) => {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 2600);
};
const tz = () => S.settings.timezone;
const when = (ms) => `${fmtDate(ms, tz(), 'en', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} ${fmtTime(ms, tz(), 'en')}`;
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHHMM = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

async function load() {
  try {
    S = await api('/api/admin/state');
    route();
  } catch (e) {
    if (e.status === 401) return loginView();
    app.innerHTML = `<main class="wrap"><div class="error-box">${esc(e.message)}</div></main>`;
  }
}

function loginView() {
  app.innerHTML = `
    <main class="wrap" style="max-width:380px;padding-top:80px">
      <form class="card stack" id="login">
        <h1>Dashboard</h1>
        <div><label for="pw">Password</label><input type="password" id="pw" autocomplete="current-password" autofocus></div>
        <div id="err"></div>
        <button class="primary" type="submit">Sign in</button>
      </form>
    </main>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } }); load(); }
    catch (err) { $('#err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  };
}

function route() {
  const h = location.hash.slice(1);
  const [name, query] = h.split('?');
  tab = ['bookings', 'types', 'calendars', 'transcripts', 'settings'].includes(name) ? name : 'bookings';
  const params = new URLSearchParams(query || '');
  if (params.get('error')) setTimeout(() => alert(`Google: ${params.get('error')}`), 50);
  shell();
}
window.addEventListener('hashchange', () => { if (S) route(); });

function shell() {
  const tabs = [['bookings', 'Bookings'], ['types', 'Meeting types'], ['calendars', 'Calendars'], ['transcripts', 'Transcripts'], ['settings', 'Settings']];
  app.innerHTML = `
    <div class="topbar"><div class="wrap">
      <strong style="margin-inline-end:12px">📅 ${esc(S.settings.owner_name)}</strong>
      <nav class="tabs row" style="gap:2px">${tabs.map(([k, l]) => `<a href="#${k}" class="${tab === k ? 'active' : ''}">${l}${k === 'transcripts' ? ' <span id="trBadge"></span>' : ''}</a>`).join('')}</nav>
      <span class="grow"></span>
      <a href="/" target="_blank" class="small">Booking page ↗</a>
      <button class="link small" id="logout">Sign out</button>
    </div></div>
    <main class="wrap stack" id="view"></main>`;
  $('#logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST', body: {} }); location.reload(); };
  ({ bookings: bookingsView, types: typesView, calendars: calendarsView, transcripts: transcriptsView, settings: settingsView })[tab]();
  api('/api/admin/transcripts').then((list) => {
    const n = list.filter((t) => ['pending_review', 'summary_ready'].includes(t.status)).length;
    if (n && $('#trBadge')) $('#trBadge').innerHTML = `<span class="badge">${n}</span>`;
  }).catch(() => {});
}

function setupWarnings() {
  const w = [];
  if (!S.status.googleConfigured) w.push('Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  else if (!S.accounts.length) w.push('No Google account connected yet — go to <a href="#calendars">Calendars</a>.');
  else if (!S.settings.default_calendar) w.push('No default calendar selected — go to <a href="#calendars">Calendars</a>.');
  for (const a of S.accounts) if (a.last_error) w.push(`Google account ${esc(a.email)}: ${esc(a.last_error)} — reconnect it in <a href="#calendars">Calendars</a>.`);
  if (!S.status.emailEnabled) w.push('Email sending is not set up — confirmations and reminders by email will not be sent.');
  if (!S.settings.owner_email) w.push('Set your notification email in <a href="#settings">Settings</a>.');
  return w.length ? `<div class="warn-box stack small">${w.map((x) => `<div>⚠️ ${x}</div>`).join('')}</div>` : '';
}

// ---------------- Bookings ----------------
let bookingScope = 'upcoming';
async function bookingsView() {
  const v = $('#view');
  v.innerHTML = `${setupWarnings()}
    <div class="row"><h1 class="grow" style="margin:0">Bookings</h1>
      <div class="choice-row">${['upcoming', 'past', 'cancelled'].map((s) => `<button data-scope="${s}" class="${s === bookingScope ? 'sel' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
    </div>
    <div class="card table-wrap" id="blist"><p class="muted">Loading…</p></div>`;
  $$('[data-scope]').forEach((b) => b.onclick = () => { bookingScope = b.dataset.scope; bookingsView(); });
  const list = await api(`/api/admin/bookings?scope=${bookingScope}`);
  const box = $('#blist');
  if (!list.length) { box.innerHTML = '<p class="muted">Nothing here yet.</p>'; return; }
  box.innerHTML = `<table><thead><tr><th>When</th><th>Meeting</th><th>Client</th><th>Details</th><th></th></tr></thead><tbody>
    ${list.map((b) => `<tr>
      <td><strong>${esc(when(b.start_utc))}</strong><div class="muted small">${(b.end_utc - b.start_utc) / 60000} min · client tz ${esc(b.client_tz)}</div></td>
      <td>${esc(b.type_name)}${b.meet_link ? `<div><a class="small" href="${esc(b.meet_link)}" target="_blank" rel="noopener">Join Meet</a></div>` : b.location ? `<div class="small muted">${esc(b.location)}</div>` : ''}</td>
      <td>${esc(b.name)}<div class="small"><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></div>${b.phone ? `<div class="small" dir="ltr">${esc(b.phone)}</div>` : ''}</td>
      <td class="small">
        ${b.answers.filter((a) => a.value !== '' && a.value !== false).map((a) => `<div><span class="muted">${esc(a.label)}:</span> ${esc(a.value === true ? '✓' : a.value)}</div>`).join('')}
        ${b.reminder_channels.length && b.reminder_offsets.length ? `<div class="muted">🔔 ${b.reminder_channels.join(' + ')} · ${b.reminder_offsets.map((m) => durationLabel(m)).join(', ')} before</div>` : '<div class="muted">🔕 no client reminders</div>'}
        ${b.status === 'cancelled' ? `<div class="field-error">Cancelled${b.cancel_reason ? `: ${esc(b.cancel_reason)}` : ''}</div>` : ''}
      </td>
      <td>${b.status === 'confirmed' && b.end_utc > Date.now() ? `<button class="danger small" data-cancel="${b.id}">Cancel</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
  $$('[data-cancel]').forEach((btn) => btn.onclick = async () => {
    const reason = prompt('Cancel this meeting? The client will be notified.\nOptional reason:');
    if (reason === null) return;
    btn.disabled = true;
    try { await api(`/api/admin/bookings/${btn.dataset.cancel}/cancel`, { method: 'POST', body: { reason } }); toast('Cancelled'); bookingsView(); }
    catch (e) { alert(e.message); btn.disabled = false; }
  });
}

// ---------------- Meeting types ----------------
function blankType() {
  const wk = [[540, 1020]];
  return {
    name: '', slug: '', description: '', durations: [30], slot_mode: 'interval', slot_interval: 30, free_granularity: 5,
    buffer_before: 0, buffer_after: 15, min_notice: 240, max_days_ahead: 30, daily_limit: 0,
    schedule: { 0: wk, 1: wk, 2: wk, 3: wk, 4: wk, 5: [], 6: [] }, calendar_ref: null,
    location_type: 'google_meet', location_value: '', fields: [], require_phone: 0,
    client_reminder_channels: ['email'], client_reminder_options: [60, 1440], client_reminder_defaults: [1440],
    owner_reminders: [30], owner_reminder_channels: ['email'], transcriber_enabled: 0, transcriber_email: '',
    color: S.settings.brand_color || '#4f46e5', active: 1, position: 0,
  };
}

function typesView() {
  if (draft) return typeEditor();
  const v = $('#view');
  v.innerHTML = `${setupWarnings()}
    <div class="row"><h1 class="grow" style="margin:0">Meeting types</h1><button class="primary" id="newType">+ New meeting type</button></div>
    <div class="type-list">${S.types.map((t) => `
      <div class="card type-card stack" style="border-top-color:${esc(t.color)}">
        <div class="row"><h3 class="grow" style="margin:0">${esc(t.name)}</h3>${t.active ? '' : '<span class="pill">Hidden</span>'}</div>
        <div class="small muted">${t.durations.map((d) => durationLabel(d)).join(' / ')} · ${t.slot_mode === 'free' ? 'any start time' : `every ${t.slot_interval} min`} · buffer ${t.buffer_before}/${t.buffer_after} min</div>
        <div class="small"><a href="/book/${encodeURIComponent(t.slug)}" target="_blank">/book/${esc(t.slug)}</a></div>
        <div class="row"><button data-edit="${t.id}">Edit</button><button data-copy="${esc(t.slug)}">Copy link</button><button data-dup="${t.id}">Duplicate</button></div>
      </div>`).join('')}</div>`;
  $('#newType').onclick = () => { draft = blankType(); typeEditor(); };
  $$('[data-edit]').forEach((b) => b.onclick = () => { draft = structuredClone(S.types.find((t) => t.id === Number(b.dataset.edit))); typeEditor(); });
  $$('[data-dup]').forEach((b) => b.onclick = () => {
    const t = structuredClone(S.types.find((x) => x.id === Number(b.dataset.dup)));
    delete t.id; t.name += ' (copy)'; t.slug = ''; draft = t; typeEditor();
  });
  $$('[data-copy]').forEach((b) => b.onclick = async () => {
    await navigator.clipboard.writeText(`${S.status.baseUrl}/book/${b.dataset.copy}`); toast('Link copied');
  });
}

const minuteChecks = (name, selected, list = PRESETS) => list.map((m) =>
  `<label class="inline"><input type="checkbox" name="${name}" value="${m}" ${selected.includes(m) ? 'checked' : ''}> ${durationLabel(m)}</label>`).join('');
const channelChecks = (name, selected) => ['email', 'whatsapp'].map((c) =>
  `<label class="inline"><input type="checkbox" name="${name}" value="${c}" ${selected.includes(c) ? 'checked' : ''}> ${c === 'email' ? 'Email' : 'WhatsApp'}</label>`).join('');

function typeEditor() {
  const d = draft;
  const writable = S.calendars.filter((c) => ['owner', 'writer'].includes(c.access_role));
  const def = S.calendars.find((c) => c.id === Number(S.settings.default_calendar));
  const v = $('#view');
  v.innerHTML = `
    <div class="row"><button class="link" id="backTypes">← Meeting types</button></div>
    <h1>${d.id ? `Edit “${esc(d.name)}”` : 'New meeting type'}</h1>
    <form id="tform" class="stack">
      <fieldset class="stack"><legend>Basics</legend>
        <div class="grid2">
          <div><label>Name *</label><input name="name" value="${esc(d.name)}" required></div>
          <div><label>Link</label><div class="row" style="flex-wrap:nowrap"><span class="muted small">/book/</span><input name="slug" value="${esc(d.slug)}" placeholder="auto from name"></div></div>
        </div>
        <div><label>Description <span class="hint">shown on the booking page and in the calendar event</span></label><textarea name="description" rows="4">${esc(d.description)}</textarea></div>
        <div class="grid3">
          <div><label>Duration(s) in minutes <span class="hint">comma-separated; several = client chooses</span></label><input name="durations" value="${d.durations.join(', ')}"></div>
          <div><label>Color</label><input type="color" name="color" value="${esc(d.color)}"></div>
          <div><label>Visible</label><label class="inline"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}> Show on booking page</label></div>
        </div>
        <div class="grid2">
          <div><label>Location</label><select name="location_type">${Object.entries(LOCATIONS).map(([k, l]) => `<option value="${k}" ${d.location_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div id="locVal"><label>Location details</label><input name="location_value" value="${esc(d.location_value)}" placeholder="Address / link / phone"></div>
        </div>
      </fieldset>

      <fieldset class="stack"><legend>Calendar</legend>
        <div><label>Save bookings to <span class="hint">the event is created in this calendar, and the invitation is sent from its Google account</span></label>
          <select name="calendar_ref">
            <option value="">Default calendar${def ? ` — ${esc(def.summary)} (${esc(def.account_email)})` : ' (not set)'}</option>
            ${writable.map((c) => `<option value="${c.id}" ${d.calendar_ref === c.id ? 'selected' : ''}>${esc(c.summary)} — ${esc(c.account_email)}</option>`).join('')}
          </select>
        </div>
        <div class="small muted">Conflicts are always checked across every calendar marked “check for conflicts” in all connected accounts.</div>
      </fieldset>

      <fieldset class="stack"><legend>Times</legend>
        <div>
          <label class="inline"><input type="radio" name="slot_mode" value="interval" ${d.slot_mode !== 'free' ? 'checked' : ''}> Client picks from my fixed start times</label>
          <label class="inline"><input type="radio" name="slot_mode" value="free" ${d.slot_mode === 'free' ? 'checked' : ''}> Client chooses any start time within my hours</label>
        </div>
        <div class="grid3">
          <div id="intervalBox"><label>Start times every</label><select name="slot_interval">${[10, 15, 20, 30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${d.slot_interval === m ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></div>
          <div id="granBox"><label>Round start time to</label><select name="free_granularity">${[1, 5, 10, 15].map((m) => `<option value="${m}" ${d.free_granularity === m ? 'selected' : ''}>${m} minute${m > 1 ? 's' : ''}</option>`).join('')}</select></div>
          <div><label>Gap before <span class="hint">min, free time required before</span></label><input type="number" min="0" name="buffer_before" value="${d.buffer_before}"></div>
          <div><label>Gap after <span class="hint">min, free time required after (e.g. 15)</span></label><input type="number" min="0" name="buffer_after" value="${d.buffer_after}"></div>
          <div><label>Minimum notice <span class="hint">hours before the meeting</span></label><input type="number" min="0" step="0.5" name="min_notice_h" value="${d.min_notice / 60}"></div>
          <div><label>Book up to <span class="hint">days ahead</span></label><input type="number" min="1" name="max_days_ahead" value="${d.max_days_ahead}"></div>
          <div><label>Max per day <span class="hint">0 = unlimited</span></label><input type="number" min="0" name="daily_limit" value="${d.daily_limit}"></div>
        </div>
        <div><label>Weekly hours <span class="hint">in your timezone (${esc(tz())})</span></label><div id="sched"></div></div>
      </fieldset>

      <fieldset class="stack"><legend>Questions for the client</legend>
        <div class="small muted">Name and email are always asked.</div>
        <label class="inline"><input type="checkbox" name="require_phone" ${d.require_phone ? 'checked' : ''}> Always ask for a phone number</label>
        <div id="fields" class="stack"></div>
        <div><button type="button" id="addField">+ Add question</button></div>
      </fieldset>

      <fieldset class="stack"><legend>Reminders</legend>
        <div><label>Client may get reminders by</label>${channelChecks('client_reminder_channels', d.client_reminder_channels)}</div>
        <div><label>Timing options the client can choose from</label>${minuteChecks('client_reminder_options', d.client_reminder_options)}</div>
        <div><label>Pre-selected for the client</label>${minuteChecks('client_reminder_defaults', d.client_reminder_defaults)}<div class="hint">Must also be in the options above. Leave empty to have reminders off by default.</div></div>
        <hr style="border:none;border-top:1px solid var(--line)">
        <div><label>Remind me by</label>${channelChecks('owner_reminder_channels', d.owner_reminder_channels)}</div>
        <div><label>Remind me before the meeting</label>${minuteChecks('owner_reminders', d.owner_reminders)}</div>
      </fieldset>

      <fieldset class="stack"><legend>Meeting transcriber</legend>
        <label class="inline"><input type="checkbox" name="transcriber_enabled" ${d.transcriber_enabled ? 'checked' : ''}> Invite my notetaker to these meetings</label>
        <div><label>Notetaker email <span class="hint">added as an attendee so the bot joins automatically (e.g. fred@fireflies.ai, or your Otter/tl;dv/Fathom calendar address)</span></label><input name="transcriber_email" type="email" value="${esc(d.transcriber_email)}"></div>
        <div class="small muted">Transcripts arrive in the <a href="#transcripts">Transcripts</a> tab for your review. Nothing goes to the client until you approve it.</div>
      </fieldset>

      <div id="terr"></div>
      <div class="row">
        <button class="primary" type="submit">Save</button>
        <button type="button" id="cancelEdit">Cancel</button>
        <span class="grow"></span>
        ${d.id ? '<button type="button" class="danger" id="delType">Delete</button>' : ''}
      </div>
    </form>`;

  const form = $('#tform');
  const syncMode = () => {
    const free = form.slot_mode.value === 'free';
    $('#intervalBox').classList.toggle('hidden', free);
    $('#granBox').classList.toggle('hidden', !free);
    $('#locVal').classList.toggle('hidden', ['google_meet', 'none'].includes(form.location_type.value));
  };
  $$('input[name=slot_mode]').forEach((r) => r.onchange = syncMode);
  form.location_type.onchange = syncMode;
  syncMode();
  renderSchedule();
  renderFields();

  $('#backTypes').onclick = $('#cancelEdit').onclick = () => { draft = null; typesView(); };
  $('#addField').onclick = () => { readFields(); d.fields.push({ id: `q${Date.now().toString(36)}`, label: '', type: 'text', required: false, placeholder: '', options: [] }); renderFields(); };
  if ($('#delType')) $('#delType').onclick = async () => {
    if (!confirm(`Delete “${d.name}”? Existing bookings stay.`)) return;
    S = await api(`/api/admin/types/${d.id}`, { method: 'DELETE' }); draft = null; typesView();
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    readFields();
    const checks = (n) => $$(`input[name=${n}]:checked`, form).map((i) => (isNaN(i.value) ? i.value : Number(i.value)));
    const body = {
      ...d,
      name: form.name.value, slug: form.slug.value, description: form.description.value,
      durations: form.durations.value.split(/[,\s]+/).map(Number).filter((n) => n > 0),
      color: form.color.value, active: form.active.checked,
      location_type: form.location_type.value, location_value: form.location_value.value,
      calendar_ref: form.calendar_ref.value ? Number(form.calendar_ref.value) : null,
      slot_mode: form.slot_mode.value, slot_interval: Number(form.slot_interval.value), free_granularity: Number(form.free_granularity.value),
      buffer_before: Number(form.buffer_before.value), buffer_after: Number(form.buffer_after.value),
      min_notice: Math.round(Number(form.min_notice_h.value) * 60), max_days_ahead: Number(form.max_days_ahead.value),
      daily_limit: Number(form.daily_limit.value), require_phone: form.require_phone.checked,
      client_reminder_channels: checks('client_reminder_channels'), client_reminder_options: checks('client_reminder_options'),
      client_reminder_defaults: checks('client_reminder_defaults'), owner_reminders: checks('owner_reminders'),
      owner_reminder_channels: checks('owner_reminder_channels'),
      transcriber_enabled: form.transcriber_enabled.checked, transcriber_email: form.transcriber_email.value,
    };
    try {
      S = d.id ? await api(`/api/admin/types/${d.id}`, { method: 'PUT', body }) : await api('/api/admin/types', { method: 'POST', body });
      draft = null; toast('Saved'); typesView();
    } catch (err) { $('#terr').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  };
}

function renderSchedule() {
  const box = $('#sched');
  box.innerHTML = DAYS.map((name, wd) => `
    <div class="sched-row">
      <strong class="small" style="padding-top:8px">${name}</strong>
      <div class="ranges">
        ${(draft.schedule[wd] || []).map(([a, b], i) => `
          <div class="range">
            <input type="time" data-wd="${wd}" data-i="${i}" data-pos="0" value="${toHHMM(a)}">–
            <input type="time" data-wd="${wd}" data-i="${i}" data-pos="1" value="${toHHMM(b === 1440 ? 1439 : b)}">
            <button type="button" class="link" data-del="${wd}:${i}" aria-label="remove">✕</button>
          </div>`).join('') || '<span class="muted small" style="padding-top:8px">Unavailable</span>'}
        <div><button type="button" class="link small" data-add="${wd}">+ add hours</button></div>
      </div>
    </div>`).join('');
  $$('input[type=time]', box).forEach((inp) => inp.onchange = () => {
    if (!inp.value) return;
    const { wd, i, pos } = inp.dataset;
    let m = fromHHMM(inp.value);
    if (pos === '1' && m === 1439) m = 1440;
    draft.schedule[wd][i][pos] = m;
  });
  $$('[data-del]', box).forEach((b) => b.onclick = () => { const [wd, i] = b.dataset.del.split(':'); draft.schedule[wd].splice(i, 1); renderSchedule(); });
  $$('[data-add]', box).forEach((b) => b.onclick = () => {
    const wd = b.dataset.add; const list = draft.schedule[wd] = draft.schedule[wd] || [];
    const last = list[list.length - 1];
    list.push(last ? [Math.min(last[1] + 60, 1380), Math.min(last[1] + 180, 1440)] : [540, 1020]);
    renderSchedule();
  });
}

function renderFields() {
  const box = $('#fields');
  box.innerHTML = draft.fields.map((f, i) => `
    <div class="field-item stack" data-field="${i}">
      <div class="grid2">
        <div><label>Question</label><input data-f="label" value="${esc(f.label)}" placeholder="e.g. What's your company?"></div>
        <div><label>Answer type</label><select data-f="type">${Object.entries(FIELD_TYPES).map(([k, l]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="opts ${['select', 'radio'].includes(f.type) ? '' : 'hidden'}"><label>Options <span class="hint">one per line</span></label><textarea data-f="options" rows="3">${esc((f.options || []).join('\n'))}</textarea></div>
      <div class="row">
        <div class="grow"><input data-f="placeholder" value="${esc(f.placeholder || '')}" placeholder="Placeholder (optional)"></div>
        <label class="inline"><input type="checkbox" data-f="required" ${f.required ? 'checked' : ''}> Required</label>
        <button type="button" class="link" data-move="${i}:-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="link" data-move="${i}:1" ${i === draft.fields.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="link danger" data-rm="${i}">Remove</button>
      </div>
    </div>`).join('');
  $$('select[data-f=type]', box).forEach((s) => s.onchange = () => {
    s.closest('.field-item').querySelector('.opts').classList.toggle('hidden', !['select', 'radio'].includes(s.value));
  });
  $$('[data-rm]', box).forEach((b) => b.onclick = () => { readFields(); draft.fields.splice(Number(b.dataset.rm), 1); renderFields(); });
  $$('[data-move]', box).forEach((b) => b.onclick = () => {
    readFields();
    const [i, dir] = b.dataset.move.split(':').map(Number);
    const [f] = draft.fields.splice(i, 1); draft.fields.splice(i + dir, 0, f); renderFields();
  });
}

function readFields() {
  $$('[data-field]').forEach((el) => {
    const f = draft.fields[Number(el.dataset.field)];
    const val = (k) => el.querySelector(`[data-f=${k}]`);
    f.label = val('label').value; f.type = val('type').value; f.placeholder = val('placeholder').value;
    f.required = val('required').checked; f.options = val('options').value.split('\n').map((s) => s.trim()).filter(Boolean);
  });
}

// ---------------- Calendars ----------------
function calendarsView() {
  const v = $('#view');
  const st = S.status;
  v.innerHTML = `
    <div class="row"><h1 class="grow" style="margin:0">Calendars</h1>
      ${st.googleConfigured ? '<a class="btn primary" href="/admin/google/connect">+ Connect Google account</a>' : ''}</div>
    ${st.googleConfigured ? '' : `<div class="warn-box small stack">
      <div><strong>Google is not configured yet.</strong></div>
      <div>1. In Google Cloud Console create an OAuth client of type “Web application”.</div>
      <div>2. Add this authorized redirect URI: <code>${esc(st.redirectUri)}</code></div>
      <div>3. Enable the Google Calendar API (and Gmail API for sending email).</div>
      <div>4. Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in <code>.env</code> and restart.</div></div>`}
    <p class="muted small">Connect as many Google accounts as you like. Tick “Check for conflicts” on every calendar where you might have events — times that are busy in <em>any</em> of them won’t be offered. Choose one <strong>default</strong> calendar where new bookings are saved (each meeting type can override it).</p>
    ${S.accounts.map((a) => `
      <div class="card stack">
        <div class="row">
          <div class="grow"><strong>${esc(a.email)}</strong> <span class="muted small">${esc(a.name || '')}</span>
            ${a.last_error ? `<div class="field-error">${esc(a.last_error)} — click “Connect Google account” and sign in with this account again.</div>` : ''}</div>
          <button data-sync="${a.id}">Refresh list</button>
          <button class="danger" data-rmacc="${a.id}">Disconnect</button>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Calendar</th><th>Check for conflicts</th><th>Default for new bookings</th></tr></thead><tbody>
          ${S.calendars.filter((c) => c.account_id === a.id).map((c) => `<tr>
            <td>${esc(c.summary)} ${c.is_primary ? '<span class="pill">primary</span>' : ''}<div class="muted small">${esc(c.access_role)}</div></td>
            <td><input type="checkbox" data-conf="${c.id}" ${c.check_conflicts ? 'checked' : ''}></td>
            <td>${['owner', 'writer'].includes(c.access_role) ? `<input type="radio" name="defcal" value="${c.id}" ${Number(S.settings.default_calendar) === c.id ? 'checked' : ''}>` : '<span class="muted small">read-only</span>'}</td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`).join('') || (st.googleConfigured ? '<div class="card muted">No accounts connected yet.</div>' : '')}`;
  $$('[data-conf]').forEach((c) => c.onchange = async () => { S = await api(`/api/admin/calendars/${c.dataset.conf}`, { method: 'PUT', body: { check_conflicts: c.checked } }); toast('Saved'); });
  $$('input[name=defcal]').forEach((r) => r.onchange = async () => { S = await api('/api/admin/settings', { method: 'PUT', body: { default_calendar: r.value } }); toast('Default calendar saved'); });
  $$('[data-sync]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { S = await api(`/api/admin/accounts/${b.dataset.sync}/sync`, { method: 'POST', body: {} }); calendarsView(); toast('Updated'); }
    catch (e) { alert(e.message); b.disabled = false; }
  });
  $$('[data-rmacc]').forEach((b) => b.onclick = async () => {
    if (!confirm('Disconnect this Google account? Its calendars will no longer be checked.')) return;
    S = await api(`/api/admin/accounts/${b.dataset.rmacc}`, { method: 'DELETE' }); calendarsView();
  });
}

// ---------------- Transcripts ----------------
const TR_STATUS = { pending_review: ['Needs review', 'warn'], summarizing: ['Summarizing…', ''], summary_ready: ['Summary ready — approve to send', 'warn'], sent: ['Sent to client', 'ok'], dismissed: ['Dismissed', ''] };

async function transcriptsView() {
  if (transcriptId) return transcriptDetail(transcriptId);
  const v = $('#view');
  const list = await api('/api/admin/transcripts');
  const st = S.status;
  v.innerHTML = `
    <div class="row"><h1 class="grow" style="margin:0">Transcripts</h1><button id="addTr">+ Paste transcript / Contreal summary</button></div>
    <p class="muted small">When your notetaker finishes a meeting it sends the transcript here. Review it, generate a summary with your summary tool, edit it, and only then approve sending it to the client.</p>
    <div class="card table-wrap">${list.length ? `<table><thead><tr><th>Received</th><th>Meeting</th><th>Client</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((t) => `<tr>
        <td class="small">${esc(when(t.received_at))}</td>
        <td>${esc(t.type_name || t.title || '—')}<div class="muted small">${t.start_utc ? esc(when(t.start_utc)) : t.meeting_start ? esc(when(t.meeting_start)) : ''} · ${esc(t.source)}</div></td>
        <td>${t.client_name ? `${esc(t.client_name)}<div class="small muted">${esc(t.client_email)}</div>` : '<span class="field-error small">Not linked to a booking</span>'}</td>
        <td><span class="small">${TR_STATUS[t.status]?.[0] || t.status}</span>${t.error ? `<div class="field-error small">${esc(t.error)}</div>` : ''}</td>
        <td><button data-open="${t.id}">Open</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No transcripts yet.</p>'}</div>
    <details class="card"><summary><strong>Connecting your transcriber & summary tool</strong></summary>
      <div class="stack small" style="margin-top:12px">
        <div><span class="status-dot ${st.webhookConfigured ? 'on' : 'off'}"></span><strong>Contreal</strong> (transcript + summary): <code>POST ${esc(st.webhooks.contreal)}</code></div>
        <div><span class="status-dot ${st.webhookConfigured ? 'on' : 'off'}"></span>Generic transcript webhook (any tool / Zapier / Make): <code>POST ${esc(st.webhooks.transcript)}</code> ${st.webhookConfigured ? '' : '— set TRANSCRIPT_WEBHOOK_SECRET'}</div>
        <div><span class="status-dot ${st.firefliesConfigured ? 'on' : ''}"></span>Fireflies.ai webhook: <code>${esc(st.webhooks.fireflies)}</code></div>
        <div><span class="status-dot ${st.summaryConfigured ? 'on' : ''}"></span>Separate summary tool (optional, not needed with Contreal) ${st.summaryConfigured ? 'configured' : '— SUMMARY_API_URL not set'}; async results: <code>POST ${esc(st.webhooks.summary)}</code></div>
        <div class="muted">See README → “Transcripts & summaries” for payload formats.</div>
      </div>
    </details>`;
  $$('[data-open]').forEach((b) => b.onclick = () => { transcriptId = Number(b.dataset.open); transcriptsView(); });
  $('#addTr').onclick = () => addTranscriptForm();
}

async function addTranscriptForm() {
  const bookings = await api('/api/admin/bookings?scope=past');
  $('#view').innerHTML = `
    <button class="link" id="back">← Transcripts</button>
    <form class="card stack" id="trf"><h2>Paste a transcript or summary</h2>
      <div><label>Booking</label><select name="booking_id"><option value="">—</option>${bookings.map((b) => `<option value="${b.id}">${esc(when(b.start_utc))} — ${esc(b.type_name)} — ${esc(b.name)}</option>`).join('')}</select></div>
      <div><label>Title</label><input name="title"></div>
      <div><label>Source</label><select name="source"><option value="contreal">Contreal</option><option value="manual">Other / manual</option></select></div>
      <div><label>Transcript <span class="hint">optional if you paste a summary</span></label><textarea name="transcript" rows="8"></textarea></div>
      <div><label>Summary <span class="hint">e.g. the summary Contreal sent you — you can still edit it before approving</span></label><textarea name="summary" rows="8"></textarea></div>
      <div><button class="primary">Save</button></div>
    </form>`;
  $('#back').onclick = () => transcriptsView();
  $('#trf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const tr = await api('/api/admin/transcripts', { method: 'POST', body: { booking_id: f.booking_id.value || null, title: f.title.value, source: f.source.value, transcript: f.transcript.value, summary: f.summary.value } });
    transcriptId = tr.id; transcriptsView();
  };
}

async function transcriptDetail(id) {
  const [tr, past, upcoming] = await Promise.all([api(`/api/admin/transcripts/${id}`), api('/api/admin/bookings?scope=past'), api('/api/admin/bookings?scope=upcoming')]);
  const bookings = [...upcoming, ...past];
  const b = tr.booking;
  const locked = tr.status === 'sent';
  $('#view').innerHTML = `
    <button class="link" id="back">← Transcripts</button>
    <div class="row"><h1 class="grow" style="margin:0">${esc(b?.type_name || tr.title || 'Transcript')}</h1><span class="pill">${TR_STATUS[tr.status]?.[0] || tr.status}</span></div>
    <div class="card stack">
      <div class="grid2">
        <div><label>Linked booking</label>
          <select id="link" ${locked ? 'disabled' : ''}><option value="">— not linked —</option>${bookings.map((x) => `<option value="${x.id}" ${x.id === tr.booking_id ? 'selected' : ''}>${esc(when(x.start_utc))} — ${esc(x.type_name)} — ${esc(x.name)}</option>`).join('')}</select></div>
        <div class="small">${b ? `<div><strong>${esc(b.name)}</strong> · ${esc(b.email)}</div><div class="muted">${esc(when(b.start_utc))}</div>` : '<span class="muted">Link a booking so the summary goes to the right client.</span>'}
          <div class="muted">Source: ${esc(tr.source)} · received ${esc(when(tr.received_at))}</div></div>
      </div>
      <details><summary><strong>Transcript</strong> <span class="muted small">(${tr.transcript.length.toLocaleString()} characters)</span></summary><div class="transcript-box" style="margin-top:10px">${esc(tr.transcript)}</div></details>
    </div>
    <div class="card stack">
      <div class="row"><h2 class="grow" style="margin:0">Summary</h2>
        ${locked || !S.status.summaryConfigured ? '' : `<button id="gen">✨ ${tr.summary ? 'Regenerate' : 'Generate'} with summary tool</button>`}</div>
      ${tr.source === 'contreal' && tr.summary && !locked ? '<div class="muted small">Summary from Contreal — review and edit before sending.</div>' : ''}
      ${tr.error ? `<div class="error-box small">${esc(tr.error)}</div>` : ''}
      ${tr.status === 'summarizing' ? '<div class="muted small">Waiting for the summary tool… refresh in a moment.</div>' : ''}
      <textarea id="summary" rows="14" ${locked ? 'readonly' : ''} placeholder="The summary will appear here. You can also write or paste it yourself.">${esc(tr.summary || '')}</textarea>
      ${locked ? `<div class="ok-box small">Sent ${esc(when(tr.sent_at))}</div>` : `
      <div class="grid2">
        <div><label>Send to</label><input id="to" type="email" value="${esc(b?.email || '')}"></div>
        <div><label>Subject <span class="hint">optional</span></label><input id="subject" placeholder="Default subject"></div>
      </div>
      <div class="row">
        <button id="save">Save draft</button>
        <button class="primary" id="send">✅ Approve & send to client</button>
        <span class="grow"></span>
        <button class="danger" id="dismiss">Dismiss</button>
      </div>`}
    </div>`;
  $('#back').onclick = () => { transcriptId = null; transcriptsView(); };
  if (locked) return;
  $('#link').onchange = async (e) => { await api(`/api/admin/transcripts/${id}`, { method: 'PUT', body: { booking_id: e.target.value || null } }); transcriptDetail(id); };
  if ($('#gen')) $('#gen').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Generating…';
    try { await api(`/api/admin/transcripts/${id}/summarize`, { method: 'POST', body: {} }); } catch (err) { alert(err.message); }
    transcriptDetail(id);
  };
  $('#save').onclick = async () => { await api(`/api/admin/transcripts/${id}`, { method: 'PUT', body: { summary: $('#summary').value } }); toast('Draft saved'); };
  $('#send').onclick = async (e) => {
    const to = $('#to').value;
    if (!$('#summary').value.trim()) return alert('The summary is empty.');
    if (!confirm(`Send this summary to ${to}?`)) return;
    e.target.disabled = true;
    try {
      await api(`/api/admin/transcripts/${id}/send`, { method: 'POST', body: { summary: $('#summary').value, to, subject: $('#subject').value } });
      toast('Summary sent'); transcriptDetail(id);
    } catch (err) { alert(err.message); e.target.disabled = false; }
  };
  $('#dismiss').onclick = async () => { if (!confirm('Dismiss this transcript?')) return; await api(`/api/admin/transcripts/${id}/dismiss`, { method: 'POST', body: {} }); transcriptId = null; transcriptsView(); };
}

// ---------------- Settings ----------------
function settingsView() {
  const s = S.settings, st = S.status;
  let zones = []; try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = [s.timezone]; }
  $('#view').innerHTML = `
    <h1>Settings</h1>
    <form class="card stack" id="sform">
      <div class="grid2">
        <div><label>Your name <span class="hint">shown on the booking page</span></label><input name="owner_name" value="${esc(s.owner_name)}"></div>
        <div><label>Timezone <span class="hint">your working hours are in this zone</span></label><select name="timezone">${zones.map((z) => `<option ${z === s.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>
        <div><label>Notification email <span class="hint">new bookings, cancellations, your reminders</span></label><input name="owner_email" type="email" value="${esc(s.owner_email)}"></div>
        <div><label>Your WhatsApp number <span class="hint">for your own reminders, e.g. +972501234567</span></label><input name="owner_phone" dir="ltr" value="${esc(s.owner_phone)}"></div>
        <div><label>Booking page language</label><select name="language"><option value="en" ${s.language === 'en' ? 'selected' : ''}>English</option><option value="he" ${s.language === 'he' ? 'selected' : ''}>עברית (Hebrew, RTL)</option></select></div>
        <div><label>Brand color</label><input type="color" name="brand_color" value="${esc(s.brand_color)}"></div>
      </div>
      <div><label>Welcome text</label><textarea name="welcome_text" rows="3">${esc(s.welcome_text)}</textarea></div>
      <div><button class="primary">Save settings</button></div>
    </form>
    <div class="card stack">
      <h2>Integrations</h2>
      <div><span class="status-dot ${st.googleConfigured && S.accounts.length ? 'on' : 'off'}"></span>Google Calendar — ${S.accounts.length} account(s) connected</div>
      <div class="row"><div class="grow"><span class="status-dot ${st.emailEnabled ? 'on' : 'off'}"></span>Email — provider: <code>${esc(st.emailProvider)}</code></div><button id="testEmail" ${st.emailEnabled ? '' : 'disabled'}>Send test email</button></div>
      <div class="row"><div class="grow"><span class="status-dot ${st.whatsappEnabled ? 'on' : 'off'}"></span>WhatsApp — provider: <code>${esc(st.whatsappProvider)}</code></div><button id="testWa" ${st.whatsappEnabled ? '' : 'disabled'}>Send test WhatsApp</button></div>
      <div><span class="status-dot ${st.webhookConfigured ? 'on' : 'off'}"></span>Contreal / transcript webhook ${st.webhookConfigured ? '' : '— set TRANSCRIPT_WEBHOOK_SECRET'}</div>
      <div class="muted small">Providers and API keys are configured in the <code>.env</code> file on the server.</div>
    </div>`;
  $('#sform').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try { S = await api('/api/admin/settings', { method: 'PUT', body }); toast('Saved'); shell(); } catch (err) { alert(err.message); }
  };
  $('#testEmail').onclick = async () => { try { await api('/api/admin/test/email', { method: 'POST', body: {} }); toast(`Test email sent to ${S.settings.owner_email}`); } catch (e) { alert(e.message); } };
  $('#testWa').onclick = async () => { try { await api('/api/admin/test/whatsapp', { method: 'POST', body: {} }); toast('Test WhatsApp sent'); } catch (e) { alert(e.message); } };
}

load();
