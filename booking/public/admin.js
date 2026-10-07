import { api, esc, $, $$, durationLabel, fmtDate, fmtTime } from '/common.js';
import { ADMIN_STRINGS } from '/admin-i18n.js';

const app = $('#app');
const PRESETS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];
const LOC_ICON = { google_meet: '🎥', zoom: '🟦', phone: '📞', in_person: '📍', custom: '🔗' };

let S = null;               // admin state
let tab = 'bookings';
let draft = null;           // meeting type being edited
let transcriptId = null;
let lang = 'he';
let T = ADMIN_STRINGS.he;

function setLang(l) {
  lang = ADMIN_STRINGS[l] ? l : 'he';
  T = ADMIN_STRINGS[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = T.dir;
  try { localStorage.setItem('adminLang', lang); } catch { /* private mode */ }
}
try { setLang(localStorage.getItem('adminLang') || 'he'); } catch { setLang('he'); }

const toast = (msg) => {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  document.body.append(el); setTimeout(() => el.remove(), 2600);
};
const tz = () => S.settings.timezone;
const dur = (m) => durationLabel(m, lang);
const when = (ms) => `${fmtDate(ms, tz(), lang, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} ${fmtTime(ms, tz(), lang)}`;
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHHMM = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

async function load() {
  try {
    S = await api('/api/admin/state');
    setLang(S.settings.admin_language || lang);
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
        <h1>${T.dashboard}</h1>
        <div><label for="pw">${T.password}</label><input type="password" id="pw" autocomplete="current-password" autofocus></div>
        <div id="err"></div>
        <button class="primary" type="submit">${T.signIn}</button>
        <button type="button" class="link small" id="lang">${T.langToggle}</button>
      </form>
    </main>`;
  $('#lang').onclick = () => { setLang(lang === 'he' ? 'en' : 'he'); loginView(); };
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
  app.innerHTML = `
    <div class="topbar"><div class="wrap">
      <strong style="margin-inline-end:12px">📅 ${esc(S.settings.owner_name)}</strong>
      <nav class="tabs row" style="gap:2px">${Object.entries(T.tabs).map(([k, l]) => `<a href="#${k}" class="${tab === k ? 'active' : ''}">${l}${k === 'transcripts' ? ' <span id="trBadge"></span>' : ''}</a>`).join('')}</nav>
      <span class="grow"></span>
      <a href="/" target="_blank" class="small">${T.bookingPage}</a>
      <button class="link small" id="langBtn">${T.langToggle}</button>
      <button class="link small" id="logout">${T.signOut}</button>
    </div></div>
    <main class="wrap stack" id="view"></main>`;
  $('#logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST', body: {} }); location.reload(); };
  $('#langBtn').onclick = async () => {
    setLang(lang === 'he' ? 'en' : 'he');
    S = await api('/api/admin/settings', { method: 'PUT', body: { admin_language: lang } }).catch(() => S);
    shell();
  };
  ({ bookings: bookingsView, types: typesView, calendars: calendarsView, transcripts: transcriptsView, settings: settingsView })[tab]();
  api('/api/admin/transcripts').then((list) => {
    const n = list.filter((t) => ['pending_review', 'summary_ready'].includes(t.status)).length;
    if (n && $('#trBadge')) $('#trBadge').innerHTML = `<span class="badge">${n}</span>`;
  }).catch(() => {});
}

function setupWarnings() {
  const w = [];
  if (!S.status.googleConfigured) w.push(T.wGoogleNotConfigured);
  else if (!S.accounts.length) w.push(T.wNoAccount);
  else if (!S.settings.default_calendar) w.push(T.wNoDefault);
  for (const a of S.accounts) if (a.last_error) w.push(T.wAccountError(esc(a.email), esc(a.last_error)));
  if (!S.status.emailEnabled) w.push(T.wNoEmail);
  if (!S.settings.owner_email) w.push(T.wNoOwnerEmail);
  return w.length ? `<div class="warn-box stack small">${w.map((x) => `<div>⚠️ ${x}</div>`).join('')}</div>` : '';
}

// ---------------- Bookings ----------------
let bookingScope = 'upcoming';
async function bookingsView() {
  const v = $('#view');
  const scopes = { upcoming: T.upcoming, past: T.past, cancelled: T.cancelledScope };
  v.innerHTML = `${setupWarnings()}
    <div class="row"><h1 class="grow" style="margin:0">${T.bookings}</h1>
      <div class="choice-row">${Object.entries(scopes).map(([s, l]) => `<button data-scope="${s}" class="${s === bookingScope ? 'sel' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="card table-wrap" id="blist"><p class="muted">${T.loading}</p></div>`;
  $$('[data-scope]').forEach((b) => b.onclick = () => { bookingScope = b.dataset.scope; bookingsView(); });
  const list = await api(`/api/admin/bookings?scope=${bookingScope}`);
  const box = $('#blist');
  if (!list.length) { box.innerHTML = `<p class="muted">${T.nothing}</p>`; return; }
  box.innerHTML = `<table><thead><tr><th>${T.thWhen}</th><th>${T.thMeeting}</th><th>${T.thClient}</th><th>${T.thDetails}</th><th></th></tr></thead><tbody>
    ${list.map((b) => `<tr>
      <td><strong>${esc(when(b.start_utc))}</strong><div class="muted small">${esc(T.minClientTz((b.end_utc - b.start_utc) / 60000, b.client_tz))}</div></td>
      <td>${esc(b.type_name)}${b.meet_link ? `<div><a class="small" href="${esc(b.meet_link)}" target="_blank" rel="noopener">${b.location_type === 'zoom' ? T.joinZoom : T.joinMeet}</a></div>` : b.location ? `<div class="small muted">${esc(b.location)}</div>` : ''}</td>
      <td>${esc(b.name)}<div class="small"><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></div>${b.phone ? `<div class="small" dir="ltr">${esc(b.phone)}</div>` : ''}</td>
      <td class="small">
        ${b.answers.filter((a) => a.value !== '' && a.value !== false).map((a) => `<div><span class="muted">${esc(a.label)}:</span> ${esc(a.value === true ? '✓' : a.value)}</div>`).join('')}
        ${b.reminder_channels.length && b.reminder_offsets.length
          ? `<div class="muted">${esc(T.remindersInfo(b.reminder_channels.map((c) => T.channelName[c] || c).join(' + '), b.reminder_offsets.map(dur).join(', ')))}</div>`
          : `<div class="muted">${T.noClientReminders}</div>`}
        ${b.status === 'cancelled' ? `<div class="field-error">${T.cancelledLabel}${b.cancel_reason ? `: ${esc(b.cancel_reason)}` : ''}</div>` : ''}
      </td>
      <td>${b.status === 'confirmed' && b.end_utc > Date.now() ? `<button class="danger small" data-cancel="${b.id}">${T.cancel}</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
  $$('[data-cancel]').forEach((btn) => btn.onclick = async () => {
    const reason = prompt(T.cancelPrompt);
    if (reason === null) return;
    btn.disabled = true;
    try { await api(`/api/admin/bookings/${btn.dataset.cancel}/cancel`, { method: 'POST', body: { reason } }); toast(T.cancelledToast); bookingsView(); }
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
    locations: [{ type: 'google_meet', value: '' }], fields: [], require_phone: 0,
    client_reminder_channels: ['email'], client_reminder_options: [60, 1440], client_reminder_defaults: [1440],
    owner_reminders: [30], owner_reminder_channels: ['email'], transcriber_enabled: 0, transcriber_email: '',
    color: S.settings.brand_color || '#4f46e5', active: 1, position: 0,
  };
}

function typesView() {
  if (draft) return typeEditor();
  const v = $('#view');
  v.innerHTML = `${setupWarnings()}
    <div class="row"><h1 class="grow" style="margin:0">${T.types}</h1><button class="primary" id="newType">${T.newType}</button></div>
    <div class="type-list">${S.types.map((t) => `
      <div class="card type-card stack" style="border-top-color:${esc(t.color)}">
        <div class="row"><h3 class="grow" style="margin:0">${esc(t.name)}</h3>${t.active ? '' : `<span class="pill">${T.hidden}</span>`}</div>
        <div class="small muted">${t.durations.map(dur).join(' / ')} · ${t.slot_mode === 'free' ? T.anyStart : T.everyMin(t.slot_interval)} · ${T.buffer(t.buffer_before, t.buffer_after)}</div>
        <div class="small">${(t.locations || []).map((l) => LOC_ICON[l.type]).join(' ') || '—'}</div>
        <div class="small" dir="ltr" style="text-align:start"><a href="/book/${encodeURIComponent(t.slug)}" target="_blank">/book/${esc(t.slug)}</a></div>
        <div class="row"><button data-edit="${t.id}">${T.edit}</button><button data-copy="${esc(t.slug)}">${T.copyLink}</button><button data-dup="${t.id}">${T.duplicate}</button></div>
      </div>`).join('')}</div>`;
  $('#newType').onclick = () => { draft = blankType(); typeEditor(); };
  $$('[data-edit]').forEach((b) => b.onclick = () => { draft = structuredClone(S.types.find((t) => t.id === Number(b.dataset.edit))); typeEditor(); });
  $$('[data-dup]').forEach((b) => b.onclick = () => {
    const t = structuredClone(S.types.find((x) => x.id === Number(b.dataset.dup)));
    delete t.id; t.name += T.copySuffix; t.slug = ''; draft = t; typeEditor();
  });
  $$('[data-copy]').forEach((b) => b.onclick = async () => {
    await navigator.clipboard.writeText(`${S.status.baseUrl}/book/${b.dataset.copy}`); toast(T.linkCopied);
  });
}

const minuteChecks = (name, selected, list = PRESETS) => list.map((m) =>
  `<label class="inline"><input type="checkbox" name="${name}" value="${m}" ${selected.includes(m) ? 'checked' : ''}> ${dur(m)}</label>`).join('');
const channelChecks = (name, selected) => ['email', 'whatsapp'].map((c) =>
  `<label class="inline"><input type="checkbox" name="${name}" value="${c}" ${selected.includes(c) ? 'checked' : ''}> ${T.channelName[c]}</label>`).join('');

function typeEditor() {
  const d = draft;
  const writable = S.calendars.filter((c) => ['owner', 'writer'].includes(c.access_role));
  const def = S.calendars.find((c) => c.id === Number(S.settings.default_calendar));
  const hint = (s) => `<span class="hint">${s}</span>`;
  const v = $('#view');
  v.innerHTML = `
    <div class="row"><button class="link" id="backTypes">${T.backTypes}</button></div>
    <h1>${d.id ? T.editTitle(esc(d.name)) : T.newTitle}</h1>
    <form id="tform" class="stack">
      <fieldset class="stack"><legend>${T.basics}</legend>
        <div class="grid2">
          <div><label>${T.name} *</label><input name="name" value="${esc(d.name)}" required></div>
          <div><label>${T.link}</label><div class="row" style="flex-wrap:nowrap" dir="ltr"><span class="muted small">/book/</span><input name="slug" value="${esc(d.slug)}" placeholder="${T.slugPh}"></div></div>
        </div>
        <div><label>${T.description} ${hint(T.descHint)}</label><textarea name="description" rows="4" dir="auto">${esc(d.description)}</textarea></div>
        <div class="grid3">
          <div><label>${T.durations} ${hint(T.durationsHint)}</label><input name="durations" value="${d.durations.join(', ')}" dir="ltr"></div>
          <div><label>${T.color}</label><input type="color" name="color" value="${esc(d.color)}"></div>
          <div><label>${T.visible}</label><label class="inline"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}> ${T.showOnPage}</label></div>
        </div>
      </fieldset>

      <fieldset class="stack"><legend>${T.whereLegend}</legend>
        <div class="small muted">${T.whereHint}</div>
        ${Object.entries(T.loc).map(([k, l]) => {
          const cur = (d.locations || []).find((x) => x.type === k);
          return `<div class="field-item stack">
            <label class="inline" style="font-weight:600"><input type="checkbox" name="loc" value="${k}" ${cur ? 'checked' : ''}> ${l.label}</label>
            <div class="hint">${k === 'zoom' && S.status.zoomConfigured ? T.zoomApiOn : l.hint}</div>
            ${l.placeholder ? `<input data-locval="${k}" value="${esc(cur?.value || '')}" placeholder="${esc(l.placeholder)}" ${cur ? '' : 'disabled'} dir="auto">` : ''}
          </div>`;
        }).join('')}
      </fieldset>

      <fieldset class="stack"><legend>${T.calendarLegend}</legend>
        <div><label>${T.saveTo} ${hint(T.saveToHint)}</label>
          <select name="calendar_ref">
            <option value="">${T.defaultCal}${def ? ` — ${esc(def.summary)} (${esc(def.account_email)})` : T.notSet}</option>
            ${writable.map((c) => `<option value="${c.id}" ${d.calendar_ref === c.id ? 'selected' : ''}>${esc(c.summary)} — ${esc(c.account_email)}</option>`).join('')}
          </select>
        </div>
        <div class="small muted">${T.conflictsNote}</div>
      </fieldset>

      <fieldset class="stack"><legend>${T.timesLegend}</legend>
        <div>
          <label class="inline"><input type="radio" name="slot_mode" value="interval" ${d.slot_mode !== 'free' ? 'checked' : ''}> ${T.fixedStarts}</label>
          <label class="inline"><input type="radio" name="slot_mode" value="free" ${d.slot_mode === 'free' ? 'checked' : ''}> ${T.freeStarts}</label>
        </div>
        <div class="grid3">
          <div id="intervalBox"><label>${T.startsEvery}</label><select name="slot_interval">${[10, 15, 20, 30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${d.slot_interval === m ? 'selected' : ''}>${T.minutesN(m)}</option>`).join('')}</select></div>
          <div id="granBox"><label>${T.roundTo}</label><select name="free_granularity">${[1, 5, 10, 15].map((m) => `<option value="${m}" ${d.free_granularity === m ? 'selected' : ''}>${T.minuteN(m)}</option>`).join('')}</select></div>
          <div><label>${T.gapBefore} ${hint(T.gapBeforeHint)}</label><input type="number" min="0" name="buffer_before" value="${d.buffer_before}"></div>
          <div><label>${T.gapAfter} ${hint(T.gapAfterHint)}</label><input type="number" min="0" name="buffer_after" value="${d.buffer_after}"></div>
          <div><label>${T.minNotice} ${hint(T.minNoticeHint)}</label><input type="number" min="0" step="0.5" name="min_notice_h" value="${d.min_notice / 60}"></div>
          <div><label>${T.bookAhead} ${hint(T.bookAheadHint)}</label><input type="number" min="1" name="max_days_ahead" value="${d.max_days_ahead}"></div>
          <div><label>${T.maxPerDay} ${hint(T.maxPerDayHint)}</label><input type="number" min="0" name="daily_limit" value="${d.daily_limit}"></div>
        </div>
        <div><label>${T.weeklyHours} ${hint(T.inTz(esc(tz())))}</label><div id="sched"></div></div>
      </fieldset>

      <fieldset class="stack"><legend>${T.questionsLegend}</legend>
        <div class="small muted">${T.alwaysAsked}</div>
        <label class="inline"><input type="checkbox" name="require_phone" ${d.require_phone ? 'checked' : ''}> ${T.alwaysPhone}</label>
        <div id="fields" class="stack"></div>
        <div><button type="button" id="addField">${T.addQuestion}</button></div>
      </fieldset>

      <fieldset class="stack"><legend>${T.remindersLegend}</legend>
        <div><label>${T.clientChannels}</label>${channelChecks('client_reminder_channels', d.client_reminder_channels)}</div>
        <div><label>${T.clientOptions}</label>${minuteChecks('client_reminder_options', d.client_reminder_options)}</div>
        <div><label>${T.clientDefaults}</label>${minuteChecks('client_reminder_defaults', d.client_reminder_defaults)}<div class="hint">${T.clientDefaultsHint}</div></div>
        <hr style="border:none;border-top:1px solid var(--line)">
        <div><label>${T.ownerChannels}</label>${channelChecks('owner_reminder_channels', d.owner_reminder_channels)}</div>
        <div><label>${T.ownerOffsets}</label>${minuteChecks('owner_reminders', d.owner_reminders)}</div>
      </fieldset>

      <fieldset class="stack"><legend>${T.transcriberLegend}</legend>
        <label class="inline"><input type="checkbox" name="transcriber_enabled" ${d.transcriber_enabled ? 'checked' : ''}> ${T.inviteNotetaker}</label>
        <div><label>${T.notetakerEmail} ${hint(T.notetakerHint)}</label><input name="transcriber_email" type="email" dir="ltr" value="${esc(d.transcriber_email)}"></div>
        <div class="small muted">${T.transcriberNote}</div>
      </fieldset>

      <div id="terr"></div>
      <div class="row">
        <button class="primary" type="submit">${T.save}</button>
        <button type="button" id="cancelEdit">${T.cancelBtn}</button>
        <span class="grow"></span>
        ${d.id ? `<button type="button" class="danger" id="delType">${T.delete}</button>` : ''}
      </div>
    </form>`;

  const form = $('#tform');
  const syncMode = () => {
    const free = form.slot_mode.value === 'free';
    $('#intervalBox').classList.toggle('hidden', free);
    $('#granBox').classList.toggle('hidden', !free);
  };
  $$('input[name=slot_mode]').forEach((r) => r.onchange = syncMode);
  $$('input[name=loc]', form).forEach((c) => c.onchange = () => {
    const inp = form.querySelector(`[data-locval=${c.value}]`);
    if (inp) inp.disabled = !c.checked;
  });
  syncMode();
  renderSchedule();
  renderFields();

  $('#backTypes').onclick = $('#cancelEdit').onclick = () => { draft = null; typesView(); };
  $('#addField').onclick = () => { readFields(); d.fields.push({ id: `q${Date.now().toString(36)}`, label: '', type: 'text', required: false, placeholder: '', options: [] }); renderFields(); };
  if ($('#delType')) $('#delType').onclick = async () => {
    if (!confirm(T.deleteConfirm(d.name))) return;
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
      locations: $$('input[name=loc]:checked', form).map((c) => ({ type: c.value, value: form.querySelector(`[data-locval=${c.value}]`)?.value || '' })),
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
      draft = null; toast(T.saved); typesView();
    } catch (err) { $('#terr').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  };
}

function renderSchedule() {
  const box = $('#sched');
  box.innerHTML = T.days.map((name, wd) => `
    <div class="sched-row">
      <strong class="small" style="padding-top:8px">${name}</strong>
      <div class="ranges">
        ${(draft.schedule[wd] || []).map(([a, b], i) => `
          <div class="range" dir="ltr">
            <input type="time" data-wd="${wd}" data-i="${i}" data-pos="0" value="${toHHMM(a)}">–
            <input type="time" data-wd="${wd}" data-i="${i}" data-pos="1" value="${toHHMM(b === 1440 ? 1439 : b)}">
            <button type="button" class="link" data-del="${wd}:${i}" aria-label="${T.remove}">✕</button>
          </div>`).join('') || `<span class="muted small" style="padding-top:8px">${T.unavailable}</span>`}
        <div><button type="button" class="link small" data-add="${wd}">${T.addHours}</button></div>
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
        <div><label>${T.question}</label><input data-f="label" value="${esc(f.label)}" placeholder="${esc(T.questionPh)}" dir="auto"></div>
        <div><label>${T.answerType}</label><select data-f="type">${Object.entries(T.fieldTypes).map(([k, l]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="opts ${['select', 'radio'].includes(f.type) ? '' : 'hidden'}"><label>${T.options} <span class="hint">${T.optionsHint}</span></label><textarea data-f="options" rows="3" dir="auto">${esc((f.options || []).join('\n'))}</textarea></div>
      <div class="row">
        <div class="grow"><input data-f="placeholder" value="${esc(f.placeholder || '')}" placeholder="${esc(T.placeholderPh)}" dir="auto"></div>
        <label class="inline"><input type="checkbox" data-f="required" ${f.required ? 'checked' : ''}> ${T.required}</label>
        <button type="button" class="link" data-move="${i}:-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="link" data-move="${i}:1" ${i === draft.fields.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="link danger" data-rm="${i}">${T.remove}</button>
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
    <div class="row"><h1 class="grow" style="margin:0">${T.calendars}</h1>
      ${st.googleConfigured ? `<a class="btn primary" href="/admin/google/connect">${T.connectGoogle}</a>` : ''}</div>
    ${st.googleConfigured ? '' : `<div class="warn-box small stack">
      <div><strong>${T.googleNotConfigured}</strong></div>
      <div>${T.gStep1}</div><div>${T.gStep2(esc(st.redirectUri))}</div><div>${T.gStep3}</div><div>${T.gStep4}</div></div>`}
    <p class="muted small">${T.calendarsIntro}</p>
    ${S.accounts.map((a) => `
      <div class="card stack">
        <div class="row">
          <div class="grow"><strong>${esc(a.email)}</strong> <span class="muted small">${esc(a.name || '')}</span>
            ${a.last_error ? `<div class="field-error">${esc(a.last_error)} — ${T.reconnect}</div>` : ''}</div>
          <button data-sync="${a.id}">${T.refreshList}</button>
          <button class="danger" data-rmacc="${a.id}">${T.disconnect}</button>
        </div>
        <div class="table-wrap"><table><thead><tr><th>${T.thCalendar}</th><th>${T.thConflicts}</th><th>${T.thDefault}</th></tr></thead><tbody>
          ${S.calendars.filter((c) => c.account_id === a.id).map((c) => `<tr>
            <td>${esc(c.summary)} ${c.is_primary ? `<span class="pill">${T.primary}</span>` : ''}<div class="muted small">${esc(c.access_role)}</div></td>
            <td><input type="checkbox" data-conf="${c.id}" ${c.check_conflicts ? 'checked' : ''}></td>
            <td>${['owner', 'writer'].includes(c.access_role) ? `<input type="radio" name="defcal" value="${c.id}" ${Number(S.settings.default_calendar) === c.id ? 'checked' : ''}>` : `<span class="muted small">${T.readOnly}</span>`}</td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`).join('') || (st.googleConfigured ? `<div class="card muted">${T.noAccounts}</div>` : '')}`;
  $$('[data-conf]').forEach((c) => c.onchange = async () => { S = await api(`/api/admin/calendars/${c.dataset.conf}`, { method: 'PUT', body: { check_conflicts: c.checked } }); toast(T.saved); });
  $$('input[name=defcal]').forEach((r) => r.onchange = async () => { S = await api('/api/admin/settings', { method: 'PUT', body: { default_calendar: r.value } }); toast(T.defaultSaved); });
  $$('[data-sync]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { S = await api(`/api/admin/accounts/${b.dataset.sync}/sync`, { method: 'POST', body: {} }); calendarsView(); toast(T.updated); }
    catch (e) { alert(e.message); b.disabled = false; }
  });
  $$('[data-rmacc]').forEach((b) => b.onclick = async () => {
    if (!confirm(T.disconnectConfirm)) return;
    S = await api(`/api/admin/accounts/${b.dataset.rmacc}`, { method: 'DELETE' }); calendarsView();
  });
}

// ---------------- Transcripts ----------------
async function transcriptsView() {
  if (transcriptId) return transcriptDetail(transcriptId);
  const v = $('#view');
  const list = await api('/api/admin/transcripts');
  const st = S.status;
  v.innerHTML = `
    <div class="row"><h1 class="grow" style="margin:0">${T.transcripts}</h1><button id="addTr">${T.pasteBtn}</button></div>
    <p class="muted small">${T.transcriptsIntro}</p>
    <div class="card table-wrap">${list.length ? `<table><thead><tr><th>${T.thReceived}</th><th>${T.thMeeting}</th><th>${T.thClient}</th><th>${T.thStatus}</th><th></th></tr></thead><tbody>
      ${list.map((t) => `<tr>
        <td class="small">${esc(when(t.received_at))}</td>
        <td>${esc(t.type_name || t.title || '—')}<div class="muted small">${t.start_utc ? esc(when(t.start_utc)) : t.meeting_start ? esc(when(t.meeting_start)) : ''} · ${esc(t.source)}</div></td>
        <td>${t.client_name ? `${esc(t.client_name)}<div class="small muted">${esc(t.client_email)}</div>` : `<span class="field-error small">${T.notLinked}</span>`}</td>
        <td><span class="small">${T.trStatus[t.status] || t.status}</span>${t.error ? `<div class="field-error small">${esc(t.error)}</div>` : ''}</td>
        <td><button data-open="${t.id}">${T.open}</button></td></tr>`).join('')}</tbody></table>` : `<p class="muted">${T.noTranscripts}</p>`}</div>
    <details class="card"><summary><strong>${T.connectingTitle}</strong></summary>
      <div class="stack small" style="margin-top:12px">
        <div><span class="status-dot ${st.webhookConfigured ? 'on' : 'off'}"></span>${T.contrealLine(esc(st.webhooks.contreal))}</div>
        <div><span class="status-dot ${st.webhookConfigured ? 'on' : 'off'}"></span>${T.genericLine(esc(st.webhooks.transcript), st.webhookConfigured)}</div>
        <div><span class="status-dot ${st.firefliesConfigured ? 'on' : ''}"></span>${T.firefliesLine(esc(st.webhooks.fireflies))}</div>
        <div><span class="status-dot ${st.summaryConfigured ? 'on' : ''}"></span>${T.summaryLine(st.summaryConfigured, esc(st.webhooks.summary))}</div>
        <div class="muted">${T.readmeNote}</div>
      </div>
    </details>`;
  $$('[data-open]').forEach((b) => b.onclick = () => { transcriptId = Number(b.dataset.open); transcriptsView(); });
  $('#addTr').onclick = () => addTranscriptForm();
}

async function addTranscriptForm() {
  const bookings = await api('/api/admin/bookings?scope=past');
  $('#view').innerHTML = `
    <button class="link" id="back">${T.backTranscripts}</button>
    <form class="card stack" id="trf"><h2>${T.pasteTitle}</h2>
      <div><label>${T.booking}</label><select name="booking_id"><option value="">—</option>${bookings.map((b) => `<option value="${b.id}">${esc(when(b.start_utc))} — ${esc(b.type_name)} — ${esc(b.name)}</option>`).join('')}</select></div>
      <div><label>${T.title}</label><input name="title" dir="auto"></div>
      <div><label>${T.source}</label><select name="source"><option value="contreal">Contreal / קונטריל</option><option value="manual">${T.otherManual}</option></select></div>
      <div><label>${T.transcript} <span class="hint">${T.transcriptOptional}</span></label><textarea name="transcript" rows="8" dir="auto"></textarea></div>
      <div><label>${T.summary} <span class="hint">${T.summaryPasteHint}</span></label><textarea name="summary" rows="8" dir="auto"></textarea></div>
      <div id="trErr"></div>
      <div><button class="primary">${T.save}</button></div>
    </form>`;
  $('#back').onclick = () => transcriptsView();
  $('#trf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const tr = await api('/api/admin/transcripts', { method: 'POST', body: { booking_id: f.booking_id.value || null, title: f.title.value, source: f.source.value, transcript: f.transcript.value, summary: f.summary.value } });
      transcriptId = tr.id; transcriptsView();
    } catch (err) { $('#trErr').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  };
}

async function transcriptDetail(id) {
  const [tr, past, upcoming] = await Promise.all([api(`/api/admin/transcripts/${id}`), api('/api/admin/bookings?scope=past'), api('/api/admin/bookings?scope=upcoming')]);
  const bookings = [...upcoming, ...past];
  const b = tr.booking;
  const locked = tr.status === 'sent';
  $('#view').innerHTML = `
    <button class="link" id="back">${T.backTranscripts}</button>
    <div class="row"><h1 class="grow" style="margin:0">${esc(b?.type_name || tr.title || T.transcript)}</h1><span class="pill">${T.trStatus[tr.status] || tr.status}</span></div>
    <div class="card stack">
      <div class="grid2">
        <div><label>${T.linkedBooking}</label>
          <select id="link" ${locked ? 'disabled' : ''}><option value="">${T.notLinkedOpt}</option>${bookings.map((x) => `<option value="${x.id}" ${x.id === tr.booking_id ? 'selected' : ''}>${esc(when(x.start_utc))} — ${esc(x.type_name)} — ${esc(x.name)}</option>`).join('')}</select></div>
        <div class="small">${b ? `<div><strong>${esc(b.name)}</strong> · ${esc(b.email)}</div><div class="muted">${esc(when(b.start_utc))}</div>` : `<span class="muted">${T.linkHint}</span>`}
          <div class="muted">${esc(T.sourceReceived(tr.source, when(tr.received_at)))}</div></div>
      </div>
      <details><summary><strong>${T.transcript}</strong> <span class="muted small">${T.chars(tr.transcript.length.toLocaleString())}</span></summary><div class="transcript-box" style="margin-top:10px" dir="auto">${esc(tr.transcript)}</div></details>
    </div>
    <div class="card stack">
      <div class="row"><h2 class="grow" style="margin:0">${T.summary}</h2>
        ${locked || !S.status.summaryConfigured ? '' : `<button id="gen">✨ ${tr.summary ? T.regenerate : T.generate} ${T.withTool}</button>`}</div>
      ${tr.source === 'contreal' && tr.summary && !locked ? `<div class="muted small">${T.fromContreal}</div>` : ''}
      ${tr.error ? `<div class="error-box small">${esc(tr.error)}</div>` : ''}
      ${tr.status === 'summarizing' ? `<div class="muted small">${T.waitingTool}</div>` : ''}
      <textarea id="summary" rows="14" dir="auto" ${locked ? 'readonly' : ''} placeholder="${esc(T.summaryPh)}">${esc(tr.summary || '')}</textarea>
      ${locked ? `<div class="ok-box small">${esc(T.sentAt(when(tr.sent_at)))}</div>` : `
      <div class="grid2">
        <div><label>${T.sendTo}</label><input id="to" type="email" dir="ltr" value="${esc(b?.email || '')}"></div>
        <div><label>${T.subject} <span class="hint">${T.optional}</span></label><input id="subject" dir="auto" placeholder="${esc(T.defaultSubject)}"></div>
      </div>
      <div class="row">
        <button id="save">${T.saveDraft}</button>
        <button class="primary" id="send">${T.approveSend}</button>
        <span class="grow"></span>
        <button class="danger" id="dismiss">${T.dismiss}</button>
      </div>`}
    </div>`;
  $('#back').onclick = () => { transcriptId = null; transcriptsView(); };
  if (locked) return;
  $('#link').onchange = async (e) => { await api(`/api/admin/transcripts/${id}`, { method: 'PUT', body: { booking_id: e.target.value || null } }); transcriptDetail(id); };
  if ($('#gen')) $('#gen').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = T.generating;
    try { await api(`/api/admin/transcripts/${id}/summarize`, { method: 'POST', body: {} }); } catch (err) { alert(err.message); }
    transcriptDetail(id);
  };
  $('#save').onclick = async () => { await api(`/api/admin/transcripts/${id}`, { method: 'PUT', body: { summary: $('#summary').value } }); toast(T.draftSaved); };
  $('#send').onclick = async (e) => {
    const to = $('#to').value;
    if (!$('#summary').value.trim()) return alert(T.emptySummary);
    if (!confirm(T.sendConfirm(to))) return;
    e.target.disabled = true;
    try {
      await api(`/api/admin/transcripts/${id}/send`, { method: 'POST', body: { summary: $('#summary').value, to, subject: $('#subject').value } });
      toast(T.summarySent); transcriptDetail(id);
    } catch (err) { alert(err.message); e.target.disabled = false; }
  };
  $('#dismiss').onclick = async () => { if (!confirm(T.dismissConfirm)) return; await api(`/api/admin/transcripts/${id}/dismiss`, { method: 'POST', body: {} }); transcriptId = null; transcriptsView(); };
}

// ---------------- Settings ----------------
function settingsView() {
  const s = S.settings, st = S.status;
  const hint = (x) => `<span class="hint">${x}</span>`;
  let zones = []; try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = [s.timezone]; }
  $('#view').innerHTML = `
    <h1>${T.settings}</h1>
    <form class="card stack" id="sform">
      <div class="grid2">
        <div><label>${T.ownerName} ${hint(T.ownerNameHint)}</label><input name="owner_name" dir="auto" value="${esc(s.owner_name)}"></div>
        <div><label>${T.timezone} ${hint(T.timezoneHint)}</label><select name="timezone" dir="ltr">${zones.map((z) => `<option ${z === s.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>
        <div><label>${T.ownerEmail} ${hint(T.ownerEmailHint)}</label><input name="owner_email" type="email" dir="ltr" value="${esc(s.owner_email)}"></div>
        <div><label>${T.ownerPhone} ${hint(T.ownerPhoneHint)}</label><input name="owner_phone" dir="ltr" value="${esc(s.owner_phone)}"></div>
        <div><label>${T.pageLang}</label><select name="language"><option value="he" ${s.language === 'he' ? 'selected' : ''}>עברית</option><option value="en" ${s.language === 'en' ? 'selected' : ''}>English</option></select></div>
        <div><label>${T.brandColor}</label><input type="color" name="brand_color" value="${esc(s.brand_color)}"></div>
      </div>
      <div><label>${T.welcome}</label><textarea name="welcome_text" rows="3" dir="auto">${esc(s.welcome_text)}</textarea></div>
      <div><button class="primary">${T.saveSettings}</button></div>
    </form>
    <div class="card stack">
      <h2>${T.integrations}</h2>
      <div><span class="status-dot ${st.googleConfigured && S.accounts.length ? 'on' : 'off'}"></span>${T.googleCal(S.accounts.length)}</div>
      <div class="row"><div class="grow"><span class="status-dot ${st.emailEnabled ? 'on' : 'off'}"></span>${T.emailProv} <code>${esc(st.emailProvider)}</code></div><button id="testEmail" ${st.emailEnabled ? '' : 'disabled'}>${T.testEmail}</button></div>
      <div class="row"><div class="grow"><span class="status-dot ${st.whatsappEnabled ? 'on' : 'off'}"></span>${T.waProv} <code>${esc(st.whatsappProvider)}</code></div><button id="testWa" ${st.whatsappEnabled ? '' : 'disabled'}>${T.testWa}</button></div>
      <div><span class="status-dot ${st.webhookConfigured ? 'on' : 'off'}"></span>${T.contrealWebhook(st.webhookConfigured)}</div>
      <div class="muted small">${T.envNote}</div>
    </div>`;
  $('#sform').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try { S = await api('/api/admin/settings', { method: 'PUT', body }); toast(T.saved); shell(); } catch (err) { alert(err.message); }
  };
  $('#testEmail').onclick = async () => { try { await api('/api/admin/test/email', { method: 'POST', body: {} }); toast(T.testEmailSent(S.settings.owner_email)); } catch (e) { alert(e.message); } };
  $('#testWa').onclick = async () => { try { await api('/api/admin/test/whatsapp', { method: 'POST', body: {} }); toast(T.testWaSent); } catch (e) { alert(e.message); } };
}

load();
