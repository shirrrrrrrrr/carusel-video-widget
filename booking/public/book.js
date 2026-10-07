import { api, esc, $, $$, applyBranding, browserTz, dateKey, durationLabel, fmtDate, fmtTime } from '/common.js';

const app = $('#app');
const slug = decodeURIComponent(location.pathname.split('/')[2]);

const state = {
  profile: null, type: null, S: null, L: 'en',
  tz: browserTz(), duration: null,
  month: null,               // {y, m} shown in calendar (client tz)
  slotsByDate: new Map(),    // client-local date -> [ms]
  rangesByDate: new Map(),
  loadedFor: null,
  date: null, start: null, loc: null,
  step: 'pick',              // pick | form | done
  loading: false, error: '',
};

const pad = (n) => String(n).padStart(2, '0');
const LOC_ICON = { google_meet: '🎥', zoom: '🟦', phone: '📞', in_person: '📍', custom: '🔗' };
const locName = (t) => ({ google_meet: state.S.locGoogleMeet, zoom: state.S.locZoom, phone: state.S.locPhone, in_person: state.S.locInPerson, custom: state.S.locCustom })[t];
const needsPhone = () => state.type.require_phone || state.loc === 'phone';
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

async function init() {
  try {
    const [profile, type] = await Promise.all([api('/api/public/profile'), api(`/api/public/types/${encodeURIComponent(slug)}`)]);
    Object.assign(state, { profile, type, S: profile.strings, L: profile.language, duration: type.durations[0], loc: type.locations[0]?.type || null });
    applyBranding(profile);
    document.title = profile.owner_name ? `${type.name} — ${profile.owner_name}` : type.name;
    const now = new Date();
    state.month = { y: now.getFullYear(), m: now.getMonth() + 1 };
    render();
    await loadMonth();
  } catch (e) {
    app.innerHTML = `<div class="main"><div class="error-box">${esc(e.message)}</div></div>`;
  }
}

async function loadMonth() {
  const { y, m } = state.month;
  const key = `${y}-${m}-${state.duration}`;
  if (state.loadedFor === key) return;
  state.loading = true; state.error = ''; render();
  // Ask for a range padded by a day on each side: owner dates and client dates can differ by timezone.
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  first.setUTCDate(first.getUTCDate() - 1); last.setUTCDate(last.getUTCDate() + 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  try {
    const data = await api(`/api/public/types/${encodeURIComponent(slug)}/availability?from=${iso(first)}&to=${iso(last)}&duration=${state.duration}`);
    state.slotsByDate = new Map(); state.rangesByDate = new Map();
    for (const day of data.days) {
      for (const s of day.slots) {
        const k = dateKey(s, state.tz);
        if (!state.slotsByDate.has(k)) state.slotsByDate.set(k, []);
        state.slotsByDate.get(k).push(s);
      }
      for (const r of day.ranges) {
        const k = dateKey(r[0], state.tz);
        if (!state.rangesByDate.has(k)) state.rangesByDate.set(k, []);
        state.rangesByDate.get(k).push(r);
      }
    }
    state.loadedFor = key;
    if (!state.date || !state.slotsByDate.has(state.date)) {
      state.date = [...state.slotsByDate.keys()].sort()[0] || null;
      if (state.date && !state.date.startsWith(`${y}-${pad(m)}`)) state.date = null;
    }
  } catch (e) {
    state.error = e.status === 503 ? state.S.loadError : e.message;
  } finally {
    state.loading = false; render();
  }
}

function infoPanel() {
  const { type, profile, S, L } = state;
  const loc = type.locations.map((l) => `${LOC_ICON[l.type]} ${l.type === 'in_person' && l.value ? l.value : locName(l.type)}`).join(' · ');
  return `
    <div class="info stack">
      <a href="/" class="muted small">${esc(profile.owner_name || (state.S.dir === 'rtl' ? '→' : '←'))}</a>
      <h1>${esc(type.name)}</h1>
      <div class="pill">⏱ ${durationLabel(state.duration, L)}</div>
      ${loc ? `<div class="muted small">${esc(loc)}</div>` : ''}
      ${state.start ? `<div class="ok-box small">${esc(fmtDate(state.start, state.tz, L))}<br><strong>${fmtTime(state.start, state.tz, L)}</strong> – ${fmtTime(state.start + state.duration * 60000, state.tz, L)}</div>` : ''}
      ${type.description ? `<div class="muted" style="white-space:pre-wrap">${esc(type.description)}</div>` : ''}
    </div>`;
}

function calendarHtml() {
  const { y, m } = state.month;
  const { L } = state;
  const firstDow = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const dows = [...Array(7)].map((_, i) => new Intl.DateTimeFormat(L === 'he' ? 'he-IL' : 'en-GB', { weekday: 'narrow' }).format(new Date(2024, 0, 7 + i)));
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<span></span>');
  for (let d = 1; d <= days; d++) {
    const k = ymd(y, m, d);
    const avail = state.slotsByDate.has(k);
    cells.push(`<button data-date="${k}" class="${avail ? 'avail' : ''} ${state.date === k ? 'sel' : ''}" ${avail ? '' : 'disabled'} aria-label="${k}">${d}</button>`);
  }
  const now = new Date();
  const canPrev = y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1);
  const title = new Intl.DateTimeFormat(L === 'he' ? 'he-IL' : 'en-GB', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  return `
    <div>
      <div class="cal-head">
        <button class="nav" data-nav="-1" ${canPrev ? '' : 'disabled'} aria-label="previous month">${state.S.dir === 'rtl' ? '›' : '‹'}</button>
        <strong>${esc(title)}</strong>
        <button class="nav" data-nav="1" aria-label="next month">${state.S.dir === 'rtl' ? '‹' : '›'}</button>
      </div>
      <div class="cal">${dows.map((d) => `<span class="dow">${d}</span>`).join('')}${cells.join('')}</div>
      <div style="margin-top:14px">
        <label for="tz" class="small">${esc(state.S.timezone)}</label>
        <select id="tz">${tzOptions()}</select>
      </div>
    </div>`;
}

function tzOptions() {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = [state.tz]; }
  if (!zones.includes(state.tz)) zones.unshift(state.tz);
  return zones.map((z) => `<option ${z === state.tz ? 'selected' : ''}>${esc(z)}</option>`).join('');
}

function slotsHtml() {
  const { S, L } = state;
  if (state.loading) return '<p class="muted">…</p>';
  if (!state.date) return `<p class="muted small">${esc(S.selectDate)}</p>`;
  const slots = state.slotsByDate.get(state.date) || [];
  const header = `<strong class="small">${esc(fmtDate(slots[0] ?? Date.now(), state.tz, L, { weekday: 'long', day: 'numeric', month: 'short' }))}</strong>`;
  if (!slots.length) return `${header}<p class="muted small">${esc(S.noTimes)}</p>`;
  if (state.type.slot_mode === 'free') {
    const ranges = (state.rangesByDate.get(state.date) || [])
      .map(([a, b]) => `${fmtTime(a, state.tz, L)}–${fmtTime(b, state.tz, L)}`).join(', ');
    const cur = state.start && dateKey(state.start, state.tz) === state.date ? fmtTime(state.start, state.tz, 'en') : '';
    return `${header}
      <div class="stack" style="margin-top:10px">
        <div class="small muted">${esc(S.availableBetween)}: <bdi>${esc(ranges)}</bdi></div>
        <label for="freeTime">${esc(S.pickTime)}</label>
        <input type="time" id="freeTime" value="${cur}">
        <div id="freeErr" class="field-error"></div>
        <button class="primary" id="freeNext">${esc(S.next)}</button>
      </div>`;
  }
  return `${header}<div class="slots" style="margin-top:10px">${slots.map((s) =>
    `<button data-start="${s}" class="${state.start === s ? 'sel' : ''}">${fmtTime(s, state.tz, L)}</button>`).join('')}</div>`;
}

function pickStep() {
  const { type, S, L } = state;
  return `
    ${type.durations.length > 1 ? `
      <div style="margin-bottom:18px"><label>${esc(S.duration)}</label>
        <div class="choice-row">${type.durations.map((d) => `<button data-duration="${d}" class="${d === state.duration ? 'sel' : ''}">${durationLabel(d, L)}</button>`).join('')}</div>
      </div>` : ''}
    <h2>${esc(S.selectDate)}</h2>
    ${state.error ? `<div class="error-box">${esc(state.error)}</div>` : ''}
    <div class="picker">${calendarHtml()}<div>${slotsHtml()}</div></div>`;
}

function fieldHtml(f) {
  const id = `q_${f.id}`;
  const req = f.required ? 'required' : '';
  const star = f.required ? ' *' : '';
  const label = `<label for="${id}">${esc(f.label)}${star}</label>`;
  switch (f.type) {
    case 'textarea': return `<div>${label}<textarea id="${id}" name="${esc(f.id)}" placeholder="${esc(f.placeholder)}" ${req}></textarea></div>`;
    case 'select': return `<div>${label}<select id="${id}" name="${esc(f.id)}" ${req}><option value=""></option>${f.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select></div>`;
    case 'radio': return `<div><label>${esc(f.label)}${star}</label>${f.options.map((o, i) => `<label class="inline"><input type="radio" name="${esc(f.id)}" value="${esc(o)}" ${req && i === 0 ? 'required' : ''}> ${esc(o)}</label>`).join('')}</div>`;
    case 'checkbox': return `<div><label class="inline"><input type="checkbox" id="${id}" name="${esc(f.id)}" ${req}> ${esc(f.label)}${star}</label></div>`;
    default: {
      const type = { email: 'email', phone: 'tel', number: 'number', url: 'url', date: 'date' }[f.type] || 'text';
      return `<div>${label}<input id="${id}" type="${type}" name="${esc(f.id)}" placeholder="${esc(f.placeholder)}" ${req}></div>`;
    }
  }
}

function formStep() {
  const { type, S, L } = state;
  const ch = type.client_reminder_channels;
  const opts = type.client_reminder_options;
  const showReminders = ch.length && opts.length;
  return `
    <button class="link" id="back">${S.dir === 'rtl' ? '→' : '←'} ${esc(S.back)}</button>
    <h2 style="margin-top:10px">${esc(S.yourDetails)}</h2>
    <form id="form" class="stack" novalidate>
      ${type.locations.length > 1 ? `
        <div><label>${esc(S.howToMeet)}</label>
          <div class="choice-row">${type.locations.map((l) => `<button type="button" data-loc="${l.type}" class="${state.loc === l.type ? 'sel' : ''}">${LOC_ICON[l.type]} ${esc(locName(l.type))}</button>`).join('')}</div>
          ${type.locations.find((l) => l.type === 'in_person' && l.value) && state.loc === 'in_person' ? `<div class="small muted" style="margin-top:6px">📍 ${esc(type.locations.find((l) => l.type === 'in_person').value)}</div>` : ''}
        </div>` : ''}
      <div class="grid2">
        <div><label for="name">${esc(S.name)} *</label><input id="name" name="name" autocomplete="name" required maxlength="200"></div>
        <div><label for="email">${esc(S.email)} *</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="200"></div>
      </div>
      <div id="phoneWrap" class="${needsPhone() ? '' : 'hidden'}">
        <label for="phone">${esc(S.phone)}<span id="phoneStar">${needsPhone() ? ' *' : ''}</span></label>
        <div class="hint small muted ${state.loc === 'phone' ? '' : 'hidden'}" id="phoneHint">${esc(S.phoneCallHint)}</div>
        <input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="+972 50 123 4567" dir="ltr">
      </div>
      ${type.fields.map(fieldHtml).join('')}
      ${showReminders ? `
        <fieldset class="stack">
          <legend>${esc(S.reminders)}</legend>
          <label class="inline"><input type="checkbox" id="remind" ${type.client_reminder_defaults.length ? 'checked' : ''}> ${esc(S.remindMe)}</label>
          <div id="remindOpts" class="stack ${type.client_reminder_defaults.length ? '' : 'hidden'}">
            <div><div class="small muted">${esc(S.remindVia)}</div>
              ${ch.map((c) => `<label class="inline"><input type="checkbox" name="rch" value="${c}" ${c === 'email' || ch.length === 1 ? 'checked' : ''}> ${esc(c === 'email' ? S.viaEmail : S.viaWhatsapp)}</label>`).join('')}
            </div>
            <div><div class="small muted">${esc(S.remindWhen)}</div>
              ${opts.map((m) => `<label class="inline"><input type="checkbox" name="roff" value="${m}" ${type.client_reminder_defaults.includes(m) ? 'checked' : ''}> ${durationLabel(m, L)} ${esc(S.before)}</label>`).join('')}
            </div>
          </div>
        </fieldset>` : ''}
      <div id="formErr"></div>
      <div><button class="primary" type="submit" id="submit">${esc(S.confirm)}</button></div>
    </form>`;
}

function doneStep() {
  const { S } = state;
  return `
    <div class="stack" style="text-align:center;padding:30px 0">
      <div style="font-size:3rem">✅</div>
      <h2>${esc(S.confirmed)}</h2>
      <p class="muted">${esc(S.confirmedText)}</p>
      <p><a class="btn" href="/manage/${encodeURIComponent(state.token)}">${esc(S.manage)}</a></p>
    </div>`;
}

function render() {
  const main = { pick: pickStep, form: formStep, done: doneStep }[state.step]();
  app.innerHTML = `${infoPanel()}<div class="main">${main}</div>`;
  bind();
}

function updatePhoneVisibility() {
  const wa = $$('input[name=rch]').some((i) => i.checked && i.value === 'whatsapp') && $('#remind')?.checked;
  const required = needsPhone() || wa;
  $('#phoneWrap')?.classList.toggle('hidden', !required);
  const phone = $('#phone');
  if (phone) phone.required = required;
  if ($('#phoneStar')) $('#phoneStar').textContent = required ? ' *' : '';
  $('#phoneHint')?.classList.toggle('hidden', state.loc !== 'phone');
}

function bind() {
  $$('[data-duration]').forEach((b) => b.onclick = () => { state.duration = Number(b.dataset.duration); state.start = null; state.loadedFor = null; loadMonth(); });
  $$('[data-nav]').forEach((b) => b.onclick = () => {
    let { y, m } = state.month; m += Number(b.dataset.nav);
    if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
    state.month = { y, m }; state.date = null; loadMonth();
  });
  $$('[data-date]').forEach((b) => b.onclick = () => { state.date = b.dataset.date; render(); });
  $$('[data-start]').forEach((b) => b.onclick = () => { state.start = Number(b.dataset.start); state.step = 'form'; render(); });
  const tz = $('#tz');
  if (tz) tz.onchange = () => { state.tz = tz.value; state.loadedFor = null; state.date = null; state.start = null; loadMonth(); };

  const freeNext = $('#freeNext');
  if (freeNext) freeNext.onclick = () => {
    const v = $('#freeTime').value;
    const slots = state.slotsByDate.get(state.date) || [];
    const hit = slots.find((s) => fmtTime(s, state.tz, 'en') === v);
    if (!hit) { $('#freeErr').textContent = `${state.S.availableBetween}: ${(state.rangesByDate.get(state.date) || []).map(([a, b]) => `${fmtTime(a, state.tz, state.L)}–${fmtTime(b, state.tz, state.L)}`).join(', ')}`; return; }
    state.start = hit; state.step = 'form'; render();
  };

  $$('[data-loc]').forEach((b) => b.onclick = () => {
    state.loc = b.dataset.loc;
    // Keep what the client already typed while re-rendering the form.
    const keep = Object.fromEntries($$('input, select, textarea', $('#form')).map((el) => [el.id || el.name, el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value]));
    render();
    for (const el of $$('input, select, textarea', $('#form'))) {
      const v = keep[el.id || el.name];
      if (v === undefined || el.type === 'radio') continue;
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
    }
    $('#remindOpts')?.classList.toggle('hidden', !$('#remind')?.checked);
    updatePhoneVisibility();
  });

  const back = $('#back');
  if (back) back.onclick = () => { state.step = 'pick'; render(); };

  const remind = $('#remind');
  if (remind) remind.onchange = () => { $('#remindOpts').classList.toggle('hidden', !remind.checked); updatePhoneVisibility(); };
  $$('input[name=rch]').forEach((i) => i.onchange = updatePhoneVisibility);
  if ($('#form')) updatePhoneVisibility();

  const form = $('#form');
  if (form) form.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = $('#formErr');
    err.innerHTML = '';
    // Native validation for visible required fields
    for (const el of $$('input, select, textarea', form)) {
      if (el.closest('.hidden')) continue;
      if (!el.checkValidity()) { el.reportValidity(); return; }
    }
    const answers = {};
    for (const f of state.type.fields) {
      if (f.type === 'checkbox') answers[f.id] = form.elements[f.id]?.checked || false;
      else if (f.type === 'radio') answers[f.id] = form.querySelector(`input[name="${CSS.escape(f.id)}"]:checked`)?.value || '';
      else answers[f.id] = form.elements[f.id]?.value || '';
    }
    const wantsReminders = remind ? remind.checked : false;
    const body = {
      start: state.start, duration: state.duration, timezone: state.tz, location_type: state.loc,
      name: $('#name').value, email: $('#email').value, phone: $('#phone').value, answers,
      reminder_channels: wantsReminders ? $$('input[name=rch]:checked').map((i) => i.value) : [],
      reminder_offsets: wantsReminders ? $$('input[name=roff]:checked').map((i) => Number(i.value)) : [],
    };
    const btn = $('#submit');
    btn.disabled = true; btn.textContent = state.S.booking;
    try {
      const r = await api(`/api/public/types/${encodeURIComponent(slug)}/book`, { method: 'POST', body });
      state.token = r.token; state.step = 'done'; render();
    } catch (e) {
      if (e.status === 409) {
        state.step = 'pick'; state.start = null; state.loadedFor = null; state.error = state.S.taken;
        await loadMonth(); state.error = state.S.taken; render();
        return;
      }
      err.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
      btn.disabled = false; btn.textContent = state.S.confirm;
    }
  };
}

init();
