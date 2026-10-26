// Prospect Mailer — mobile companion. Same data as the Chrome extension, via your Google Drive.
import * as D from './data.js';
import * as auth from './auth.js';
import * as crm from './lib/crm.js';
import { LEAD_STATUSES, normalizeLinkedinUrl, senderProfile } from './lib/store.js';
import { fillTemplate } from './lib/followups.js';
import { combine, summarize, dayKey, kindOfCat } from './lib/tracker.js';
import { periodRange, aggregate, shiftPeriod } from './lib/periods.js';
import { fmtMin } from './lib/report.js';

const VERSION = '1.7.0-202610261826';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => crm.money(n, D.currency());
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fmtShort = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const ago = (t) => { if (!t) return ''; const m = Math.round((Date.now() - t) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; if (m < 1440) return `${Math.round(m / 60)} h ago`; const d = Math.round(m / 1440); return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : fmtDate(t); };
const initials = (l) => ((l.firstName || l.email || '?')[0] + (l.lastName || '')[0] || '').toUpperCase();
const typeClass = (t) => 't-' + t.toLowerCase().replace(/[^a-z]+/g, '-');
const localInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const lastTouch = (l) => Math.max(l.createdAt || 0, ...(l.emailsSent || []).map((e) => e.date || 0), ...(l.activities || []).map((a) => a.at || 0), l.repliedAt || 0);
const COLORS = { P: '#0b6e57', N: '#8fb9ad', D: '#e07a3f', O: '#7d8fd6', I: '#f0c75e', L: '#c7ccd1', '.': 'var(--line)' };
const KIND = { productive: 'P', neutral: 'N', distracting: 'D' };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- bottom sheet ----------
function openSheet(html, mount) {
  const sh = $('#sheet'), bg = $('#sheet-bg');
  sh.innerHTML = `<div class="grab"></div>${html}`;
  sh.hidden = false; bg.hidden = false;
  sh.scrollTop = 0;
  const close = () => { sh.hidden = true; bg.hidden = true; sh.innerHTML = ''; };
  bg.onclick = close;
  $$('[data-close]', sh).forEach((b) => b.addEventListener('click', close));
  mount?.(sh, close);
  return close;
}
const closeSheet = () => { $('#sheet').hidden = true; $('#sheet-bg').hidden = true; };

async function guard(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) {
    if (e instanceof auth.NeedsAuth) { askAuth(e); return null; }
    toast(e.message || String(e));
    return null;
  } finally { if (btn) btn.disabled = false; }
}
function askAuth(e) {
  if (e.purpose === 'main') return auth.signIn({ purpose: 'main', email: auth.mainEmail() });
  if (confirm(`Sign in to ${e.email} on this phone so emails can be sent from it?`)) auth.signIn({ purpose: 'gmail', email: e.email });
}

// =====================================================================
// ROUTER
// =====================================================================
const TITLES = { home: 'Prospect Mailer', contacts: 'Contacts', contact: 'Contact', pipeline: 'Pipeline', followups: 'Follow-ups', day: 'My Day', add: 'Add from LinkedIn', settings: 'Settings' };
const route = () => { const [, name = 'home', arg = ''] = location.hash.split('/'); return { name: name.split('?')[0] || 'home', arg: decodeURIComponent(arg || '') }; };

function render() {
  const { name, arg } = route();
  const view = $('#view');
  const signedIn = !!auth.mainEmail();
  const tab = name === 'contact' ? 'contacts' : name;
  $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  $('#title').textContent = TITLES[name] || 'Prospect Mailer';
  $('#back').hidden = !['contact', 'add', 'settings'].includes(name);
  $('#tabs').hidden = !signedIn || !D.S.snap;
  $('#fab').hidden = !signedIn || !D.S.snap || !['home', 'contacts'].includes(name);
  $('#settings-btn').hidden = !signedIn;
  renderStatus();
  if (!signedIn) return welcome(view);
  if (!D.S.snap) {
    if (D.S.noData) return noData(view);
    if (D.S.needsAuth) return welcome(view, true);
    view.innerHTML = `<div class="spinner"></div><p class="center muted">Loading your data from Google Drive…</p>`;
    return;
  }
  const screens = { home, contacts, contact, pipeline, followups, day, add, settings: settingsScreen };
  (screens[name] || home)(view, arg);
}
window.addEventListener('hashchange', () => {
  if (route().name !== 'add') sessionStorage.removeItem('pm_share');
  closeSheet(); render(); window.scrollTo(0, 0);
});
$('#back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/home'));
$('#settings-btn').onclick = () => { location.hash = '#/settings'; };
$('#fab').onclick = () => { location.hash = '#/add'; };

function renderStatus() {
  const dot = $('#sync-dot'), b = $('#banner');
  const S = D.S;
  dot.className = 'sync-dot ' + (S.syncing ? 'busy' : S.error || S.needsAuth ? 'err' : S.lastPull ? 'ok' : '');
  dot.title = S.syncing ? 'Syncing…' : S.error || (S.lastPull ? 'Synced ' + ago(S.lastPull) : 'Not synced yet');
  if (S.needsAuth && S.snap) {
    b.hidden = false; b.className = 'banner';
    b.innerHTML = `${S.needsAuth.purpose === 'main' ? 'Google sign-in expired — showing your saved copy.' : `Sign in to ${esc(S.needsAuth.email)} to send from it.`}<button class="btn primary sm" id="reauth">Continue</button>`;
    $('#reauth').onclick = () => askAuth(S.needsAuth);
  } else if (S.error && S.snap) {
    b.hidden = false; b.className = 'banner err';
    b.innerHTML = `${esc(S.error)}<button class="btn secondary sm" id="retry">Retry</button>`;
    $('#retry').onclick = () => D.pull();
  } else if (S.pending && !S.syncing) {
    b.hidden = false; b.className = 'banner'; b.textContent = 'Saved on this phone — will sync when you are back online.';
  } else b.hidden = true;
  const due = S.snap ? D.allFollowUps().filter((f) => D.OPEN_FU.includes(f.status) && (f.status === 'due' || f.due <= Date.now())).length : 0;
  $('#fu-badge').hidden = !due; $('#fu-badge').textContent = due;
}

// =====================================================================
// SIGN-IN
// =====================================================================
function welcome(v, expired = false) {
  v.innerHTML = `<div class="welcome">
    <img src="icons/icon-192.png" alt="">
    <h2>${expired ? 'Welcome back' : 'Prospect Mailer'}</h2>
    <p>${expired ? 'Your Google sign-in expired. Continue to load your latest data.' : 'Sign in with the Google account you sync the Chrome extension with. Your contacts, pipeline, follow-ups and reports appear here.'}</p>
    <button class="btn primary" id="signin">${expired ? 'Continue' : 'Sign in with Google'}</button>
    <p class="note" style="margin-top:16px">Google may say the app isn't verified — it's your own private app. Tap <b>Advanced → Go to Prospect Mailer</b> and allow access.</p>
  </div>`;
  $('#signin').onclick = () => auth.signIn({ purpose: 'main', email: expired ? auth.mainEmail() : '', choose: !expired });
}
function noData(v) {
  v.innerHTML = `<div class="welcome">
    <img src="icons/icon-192.png" alt="">
    <h2>No data found</h2>
    <p>${esc(auth.mainEmail())} has no Prospect Mailer data yet. Sign in with the account you chose in the extension under <b>Settings → Sync &amp; backup</b>.</p>
    <button class="btn primary" id="switch">Use another Google account</button>
  </div>`;
  $('#switch').onclick = async () => { await D.signOutAll(); auth.signIn({ purpose: 'main', choose: true }); };
}

// =====================================================================
// HOME
// =====================================================================
function todayTime(date = dayKey(Date.now())) {
  const s = D.settings();
  const devs = Object.values(D.S.snap.activity || {}).map((d) => d[date]).filter(Boolean);
  if (!devs.length) return null;
  const isToday = date === dayKey(Date.now());
  const n = new Date();
  return { day: combine(devs), t: summarize(combine(devs), { workStart: s.workStart, workEnd: s.workEnd, upTo: isToday ? n.getHours() * 60 + n.getMinutes() : 1440 }) };
}

function home(v) {
  const L = D.leads(), m = crm.metrics({ leads: L, deals: D.deals(), stages: D.stages() });
  const s = D.settings();
  const hour = new Date().getHours();
  const first = (s.senderName || '').split(' ')[0];
  const reps = D.S.snap.dailyReports || {};
  const lastRep = Object.values(reps).filter((r) => r.ai).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const tt = todayTime();
  const tile = (l, val, sub, href = '', cls = '') => `<a class="kpi ${cls}" ${href ? `href="${href}"` : ''}><div class="l">${esc(l)}</div><div class="v">${val}</div><div class="s">${sub}</div></a>`;
  const a = m.attention;
  const item = (href, t, sub, end = '') => `<a class="row" href="${href}"><div class="main"><div class="t">${esc(t)}</div><div class="sub">${esc(sub)}</div></div>${end}<span class="chev">›</span></a>`;
  v.innerHTML = `
    <div class="hello"><span class="muted">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span><b>Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}${first ? ', ' + esc(first) : ''}</b></div>
    <div class="kpis">
      ${tile('Revenue this month', esc(money(m.revenueMonth)), `${m.dealsWonMonth} won · MRR ${esc(money(m.mrr))}`, '#/pipeline', 'accent')}
      ${tile('Open pipeline', esc(money(m.openValue)), `${m.openCount} open deal${m.openCount === 1 ? '' : 's'}`, '#/pipeline')}
      ${tile('Follow-ups due', m.followUpsDue, `${m.followUpsScheduled} scheduled`, '#/followups')}
      ${tile('Active clients', m.byType.Client || 0, `${m.byType.Prospect || 0} prospects`, '#/contacts')}
      ${tile('Emails this week', m.emailsWeek, `${m.emailsToday} today`)}
      ${tile('Reply rate', m.replyRate30 === null ? '—' : m.replyRate30 + '%', 'last 30 days')}
    </div>
    <a class="card" href="#/day" style="display:block;text-decoration:none;color:inherit">
      <h3>Today so far <span class="link">My Day ›</span></h3>
      ${tt ? `<div class="stats">
        <div class="stat"><span>Productive</span><b style="color:${COLORS.P}">${fmtMin(tt.t.productive)}</b></div>
        <div class="stat"><span>Off-focus</span><b style="color:#c2410c">${fmtMin(tt.t.distracting)}</b></div>
        <div class="stat"><span>Idle / away</span><b>${fmtMin(tt.t.idle)}</b></div>
        <div class="stat"><span>Other apps</span><b>${fmtMin(tt.t.otherApps)}</b></div></div>`
        : '<div class="muted small">Nothing tracked yet today — tracking runs in Chrome on your laptops.</div>'}
      ${lastRep ? `<div class="ai-head" style="margin-top:12px"><div class="score" style="color:${scoreColor(lastRep.ai.score)};border-color:${scoreColor(lastRep.ai.score)}">${lastRep.ai.score}</div><div><b>${esc(lastRep.ai.headline)}</b><span class="muted small">${lastRep.date === dayKey(Date.now()) ? 'Today' : esc(fmtShort(new Date(lastRep.date + 'T12:00').getTime()))}'s report</span></div></div>` : ''}
    </a>
    <div class="card"><h3>Needs your attention</h3>
      ${a.dueFollowUps.length + a.repliedNoDeal.length + a.stale.length + a.overdueClose.length === 0 ? '<div class="muted small">All caught up. 🎉</div>' : ''}
      <div class="list">
        ${a.dueFollowUps.slice(0, 5).map((f) => item(`#/contact/${f.lead.id}`, D.fullName(f.lead), `Follow-up due · ${f.lead.company || ''}`, '<span class="pill due">Due</span>')).join('')}
        ${a.repliedNoDeal.slice(0, 4).map((l) => item(`#/contact/${l.id}`, D.fullName(l), `Replied — no deal yet · ${l.company || ''}`, '<span class="pill t-prospect">Replied</span>')).join('')}
        ${a.stale.slice(0, 3).map((d) => item('#/pipeline', d.title, `${money(d.amount)} · idle ${ago(d.updatedAt || d.createdAt)}`)).join('')}
        ${a.overdueClose.slice(0, 3).map((d) => item('#/pipeline', d.title, `Expected close ${fmtShort(new Date(d.expectedClose).getTime())}`, '<span class="pill due">Overdue</span>')).join('')}
      </div>
    </div>`;
}
const scoreColor = (s) => (s >= 70 ? '#0b6e57' : s >= 45 ? '#b7791f' : '#c2410c');

// =====================================================================
// CONTACTS
// =====================================================================
let cSearch = '', cType = '';
function contacts(v) {
  const all = D.leads();
  const counts = Object.fromEntries(crm.CONTACT_TYPES.map((t) => [t, all.filter((l) => crm.contactType(l) === t).length]));
  v.innerHTML = `
    <div class="search"><input type="search" id="q" placeholder="Search name, company, email…" value="${esc(cSearch)}" autocomplete="off">
      <div class="chips" style="margin-top:8px">${[['', 'All', all.length], ...crm.CONTACT_TYPES.map((t) => [t, t, counts[t]])].map(([val, l, n]) => `<button class="chip ${cType === val ? 'on' : ''}" data-t="${esc(val)}">${esc(l)}<b>${n}</b></button>`).join('')}</div></div>
    <div class="card" style="padding:4px 12px"><div class="list" id="clist"></div></div>`;
  const draw = () => {
    const q = cSearch.trim().toLowerCase();
    const list = all.filter((l) => (!cType || crm.contactType(l) === cType) && (!q || [l.firstName, l.lastName, l.company, l.title, l.email, l.notes].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => lastTouch(b) - lastTouch(a));
    $('#clist').innerHTML = list.slice(0, 300).map((l) => {
      const t = crm.contactType(l);
      return `<a class="row" href="#/contact/${esc(l.id)}"><div class="av">${esc(initials(l))}</div><div class="main"><div class="t">${esc(D.fullName(l))}</div><div class="sub">${esc([l.title, l.company].filter(Boolean).join(' · ') || l.email)}</div></div><div class="end"><span class="pill ${typeClass(t)}">${esc(t === 'Do Not Contact' ? 'DNC' : t)}</span><div class="small muted" style="margin-top:3px">${esc(ago(lastTouch(l)))}</div></div></a>`;
    }).join('') || `<div class="empty">${all.length ? 'No contacts match.' : 'No contacts yet. Tap + to add one from LinkedIn.'}</div>`;
  };
  draw();
  $('#q').oninput = (e) => { cSearch = e.target.value; draw(); };
  $$('.chip[data-t]').forEach((b) => b.addEventListener('click', () => { cType = b.dataset.t; contacts(v); }));
}

// ---------- one contact ----------
function contact(v, id) {
  const l = D.lead(id);
  if (!l) { v.innerHTML = '<div class="empty">This contact no longer exists.</div>'; return; }
  const t = crm.contactType(l);
  const myDeals = D.deals().filter((d) => d.leadId === l.id);
  const st = D.stages();
  const fu = D.openFollowUp(l);
  const fuDue = fu && (fu.status === 'due' || fu.due <= Date.now());
  const tl = crm.timeline(l, D.deals(), st).slice(0, 30);
  const svg = (p) => `<svg viewBox="0 0 24 24"><path d="${p}"/></svg>`;
  $('#title').textContent = D.fullName(l);
  v.innerHTML = `
    <div class="person"><div class="av">${esc(initials(l))}</div><h2>${esc(D.fullName(l))}</h2>
      <div class="sub">${esc([l.title, l.company].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:6px"><span class="pill ${typeClass(t)}">${esc(t)}</span> <span class="pill">${esc(l.status || 'New')}</span></div></div>
    ${t === 'Do Not Contact' ? '<div class="fu-line due">This person is marked Do Not Contact.</div>' : ''}
    <div class="actions">
      <button class="act ${l.email ? '' : 'off'}" id="a-email">${svg('M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zm2.3-.1L12 11.6l6.7-5.2zM19 8.1l-6.4 5a1 1 0 0 1-1.2 0L5 8.1v9.4c0 .3.2.5.5.5h13c.3 0 .5-.2.5-.5z')}Email</button>
      <a class="act ${l.phone ? '' : 'off'}" id="a-call" href="tel:${esc((l.phone || '').replace(/[^\d+]/g, ''))}">${svg('M6.6 10.8a15.2 15.2 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.3c1.1.4 2.3.6 3.6.6a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.3.2 2.5.6 3.6a1 1 0 0 1-.3 1z')}Call</a>
      <a class="act ${l.linkedinUrl ? '' : 'off'}" href="${esc(l.linkedinUrl || '#')}" target="_blank" rel="noopener">${svg('M5 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM3.3 9h3.4v11H3.3zm5.5 0h3.3v1.5c.5-.9 1.7-1.8 3.4-1.8 3.6 0 4.2 2.3 4.2 5.4V20h-3.4v-5.2c0-1.2 0-2.8-1.7-2.8s-2 1.3-2 2.7V20H8.8z')}LinkedIn</a>
      <button class="act" id="a-log">${svg('M5 4h11l3 3v13H5zm2 2v12h10V8h-2V6zm2 4h6v2H9zm0 4h6v2H9z')}Log</button>
    </div>
    ${fu ? `<div class="fu-line ${fuDue ? 'due' : ''}">${fuDue ? '⏰ Follow-up due' : `↻ ${fu.mode === 'auto' ? 'Auto follow-up' : 'Reminder'} ${esc(fmtWhen(fu.due))}`}<button class="link" id="fu-cancel">Cancel</button></div>` : ''}
    <div class="card"><h3>Type</h3>
      <div class="seg" id="types">${crm.CONTACT_TYPES.map((x) => `<button class="${x === t ? 'on' : ''}" data-t="${esc(x)}">${esc(x === 'Do Not Contact' ? 'Do not contact' : x)}</button>`).join('')}</div></div>
    <div class="card"><h3>Details <button class="link" id="edit">Edit</button></h3>
      <div class="kv">
        <span>Email</span><b>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '—'}</b>
        <span>Phone</span><b>${esc(l.phone || '—')}</b>
        <span>Company</span><b>${esc(l.company || '—')}</b>
        <span>Title</span><b>${esc(l.title || '—')}</b>
        ${l.location ? `<span>Location</span><b>${esc(l.location)}</b>` : ''}
        <span>Outreach</span><b><select class="inline" id="status" style="padding:6px 8px;font-size:14px">${LEAD_STATUSES.map((s) => `<option ${s === l.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></b>
      </div></div>
    <div class="card"><h3>Deals <button class="link" id="new-deal">+ New deal</button></h3>
      ${myDeals.length ? myDeals.map((d) => dealCard(d, st)).join('') : '<div class="muted small">No deals yet.</div>'}</div>
    <div class="card"><h3>Notes</h3><div class="field" style="margin:0"><textarea id="notes" rows="3" placeholder="Anything useful about this contact…" style="min-height:80px">${esc(l.notes)}</textarea></div></div>
    <div class="card"><h3>Timeline</h3>${tl.length ? `<ul class="timeline">${tl.map((i) => `<li><span class="w">${esc(fmtShort(i.at))}</span><span class="k-${esc(i.kind)}">${esc(i.text)}${i.sub && i.kind !== 'email' ? ` <span class="muted small">· ${esc(i.sub)}</span>` : ''}</span></li>`).join('')}</ul>` : '<div class="muted small">Nothing yet.</div>'}</div>`;

  $('#a-email').onclick = () => compose(l.id);
  $('#a-call').addEventListener('click', () => { if (l.phone) sessionStorage.setItem('pm_call', JSON.stringify({ id: l.id, at: Date.now() })); });
  $('#a-log').onclick = () => logSheet(l.id);
  $('#edit').onclick = () => editContact(l.id);
  $('#new-deal').onclick = () => dealSheet(null, { leadId: l.id });
  $$('#view .deal').forEach((el) => el.addEventListener('click', () => dealSheet(el.dataset.id)));
  $('#fu-cancel')?.addEventListener('click', () => { D.fuCancel(l.id, fu.id); toast('Follow-up cancelled'); });
  $$('#types button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.t === t) return;
    if (b.dataset.t === 'Past Client' && t === 'Client') {
      const monthly = D.deals().filter((d) => d.leadId === l.id && d.status === 'won' && d.billing === 'monthly' && !d.endedAt);
      if (monthly.length && confirm('Stop counting their monthly deals in recurring revenue from today?')) monthly.forEach((d) => D.saveDeal({ id: d.id, endedAt: Date.now() }));
    }
    D.setType(l.id, b.dataset.t); toast(`${D.fullName(l)} → ${b.dataset.t}`);
  }));
  $('#status').onchange = (e) => { D.updateLead(l.id, { status: e.target.value }); toast('Status updated'); };
  $('#notes').onchange = (e) => { D.updateLead(l.id, { notes: e.target.value }); toast('Notes saved'); };

  // came back from a sign-in in the middle of writing an email?
  const draft = JSON.parse(sessionStorage.getItem('pm_draft') || 'null');
  if (draft && draft.leadId === l.id) { sessionStorage.removeItem('pm_draft'); compose(l.id, draft); }
}

function dealCard(d, st) {
  const leadObj = D.lead(d.leadId);
  const overdue = d.status === 'open' && d.expectedClose && new Date(d.expectedClose).getTime() + 864e5 < Date.now();
  const stageName = d.status === 'lost' ? 'Lost' : d.status === 'won' ? 'Won' : st.find((x) => x.id === d.stageId)?.name || '';
  return `<div class="deal" data-id="${esc(d.id)}"><div class="t">${esc(d.title || '(untitled)')}</div>
    <div class="amt">${esc(money(d.amount))}${d.billing === 'monthly' ? '<span>/mo</span>' : ''}${d.endedAt ? ' <span class="pill">ended</span>' : ''}</div>
    <div class="m">${esc([d.company, leadObj ? D.fullName(leadObj) : ''].filter(Boolean).join(' · '))}</div>
    <div class="f"><span class="pill ${d.status}">${esc(stageName)}</span>${d.status === 'open' && d.expectedClose ? ` · <span class="${overdue ? 'over' : ''}">close ${esc(fmtShort(new Date(d.expectedClose).getTime()))}</span>` : ''}${d.status === 'won' ? ' · ' + esc(fmtShort(d.wonAt)) : ''}${d.status === 'lost' && d.lostReason ? ' · ' + esc(d.lostReason) : ''}</div></div>`;
}

// ---------- log a call / meeting / note ----------
function logSheet(id, preset = {}) {
  const l = D.lead(id);
  let kind = preset.kind || 'call';
  openSheet(`<h2>Log activity <span class="spacer"></span><button class="link" data-close>Close</button></h2>
    <p class="muted small" style="margin-top:-6px">${esc(D.fullName(l))}</p>
    <div class="seg" id="kinds" style="margin-bottom:10px">${Object.entries(crm.ACTIVITY_KINDS).map(([k, v]) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${esc(v === 'LinkedIn message' ? 'LinkedIn' : v)}</button>`).join('')}</div>
    <div class="field"><label>When</label><input type="datetime-local" id="lat" value="${localInput(preset.at || Date.now())}"></div>
    <div class="field"><label>What happened</label><textarea id="ltxt" rows="4" placeholder="e.g. Intro call — interested in a 2-week trial">${esc(preset.text || '')}</textarea></div>
    <button class="btn primary block" id="lsave">Add to timeline</button>`, (sh, close) => {
    $$('#kinds button', sh).forEach((b) => b.addEventListener('click', () => { kind = b.dataset.k; $$('#kinds button', sh).forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#lsave', sh).onclick = () => {
      const text = $('#ltxt', sh).value.trim();
      if (!text) return toast('Write what happened first');
      D.addActivity(id, { kind, text, at: new Date($('#lat', sh).value).getTime() || Date.now() });
      close(); toast('Added to timeline');
    };
    setTimeout(() => $('#ltxt', sh).focus(), 250);
  });
}

// ---------- edit contact ----------
function editContact(id) {
  const l = id ? D.lead(id) : {};
  const f = ['firstName', 'lastName', 'email', 'phone', 'company', 'title', 'linkedinUrl', 'location'];
  const labels = { firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', company: 'Company', title: 'Title', linkedinUrl: 'LinkedIn URL', location: 'Location' };
  openSheet(`<h2>${id ? 'Edit contact' : 'New contact'} <span class="spacer"></span><button class="link" data-close>Close</button></h2>
    <div class="row2">${f.slice(0, 2).map((k) => `<div class="field"><label>${labels[k]}</label><input id="e-${k}" value="${esc(l[k])}"></div>`).join('')}</div>
    ${f.slice(2).map((k) => `<div class="field"><label>${labels[k]}</label><input id="e-${k}" value="${esc(l[k])}" ${k === 'email' ? 'type="email" inputmode="email"' : k === 'phone' ? 'type="tel"' : k === 'linkedinUrl' ? 'type="url"' : ''}></div>`).join('')}
    <button class="btn primary block" id="esave">Save</button>`, (sh, close) => {
    $('#esave', sh).onclick = () => {
      const v = Object.fromEntries(f.map((k) => [k, $('#e-' + k, sh).value.trim()]));
      if (!v.firstName && !v.lastName && !v.email) return toast('Add a name or email');
      v.linkedinUrl = normalizeLinkedinUrl(v.linkedinUrl) || v.linkedinUrl;
      const saved = id ? D.updateLead(id, v) : D.upsertContact(v);
      close(); toast('Saved');
      if (!id) location.hash = '#/contact/' + saved.id;
    };
  });
}

// ---------- compose an email ----------
function compose(id, draft = null) {
  const l = D.lead(id);
  const s = D.settings();
  const accounts = (s.gmailAccounts || []).map((a) => a.email);
  if (!accounts.length) return toast('Add a Gmail account in the extension first (Settings → Gmail accounts).');
  const tpls = D.templates();
  const last = D.lastThread(l);
  const fu = D.openFollowUp(l);
  const dueReminder = fu && fu.mode === 'remind' && (fu.status === 'due' || fu.due <= Date.now());
  const sentFrom = (l.emailsSent || []).slice(-1)[0]?.from;
  const st = {
    from: draft?.from || (sentFrom && accounts.includes(sentFrom) ? sentFrom : s.defaultSender || accounts[0]),
    to: draft?.to || l.email || '',
    templateId: draft?.templateId ?? (dueReminder ? fu.templateId : ''),
    reply: draft?.reply ?? (dueReminder && !!last),
    subject: draft?.subject || '', body: draft?.body || '',
    fuMode: draft?.fuMode || (dueReminder ? 'none' : s.followUpMode || 'remind'),
    fuDays: draft?.fuDays || s.followUpDays || 3,
    fuTpl: draft?.fuTpl || s.followUpTemplateId || tpls.find((x) => /follow/i.test(x.name))?.id || tpls[0]?.id || '',
  };
  const nameFor = (e) => senderProfile({ gmailAccounts: [], ...s }, e).name;
  openSheet(`<h2>Email ${esc(l.firstName || D.fullName(l))} <span class="spacer"></span><button class="link" data-close>Close</button></h2>
    ${accounts.length > 1 ? `<div class="field"><label>From</label><select id="m-from">${accounts.map((e) => `<option ${e === st.from ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></div>` : `<p class="note" style="margin-top:-6px">From ${esc(nameFor(st.from) ? nameFor(st.from) + ' · ' : '')}${esc(st.from)}</p>`}
    <div class="field"><label>To</label><input id="m-to" type="email" inputmode="email" value="${esc(st.to)}" placeholder="name@company.com"></div>
    <div class="field"><label>Template</label><select id="m-tpl"><option value="">— Write my own —</option>${tpls.map((x) => `<option value="${esc(x.id)}" ${x.id === st.templateId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
    ${last ? `<label class="check"><input type="checkbox" id="m-reply" ${st.reply ? 'checked' : ''}> Reply in the same thread <span class="muted small">(${esc(last.subject.replace(/^re:\s*/i, ''))})</span></label>` : ''}
    <div class="field"><label>Subject</label><input id="m-sub" value="${esc(st.subject)}"></div>
    <div class="field"><label>Message</label><textarea id="m-body" rows="9">${esc(st.body)}</textarea></div>
    <div class="field"><label>Follow up</label>
      <div class="row2"><select id="m-fu"><option value="none">No follow-up</option><option value="remind">Remind me</option><option value="auto">Send automatically</option></select>
      <select id="m-fudays">${[1, 2, 3, 4, 5, 7, 10, 14].map((d) => `<option value="${d}" ${Number(st.fuDays) === d ? 'selected' : ''}>after ${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select></div>
      <select id="m-futpl" style="margin-top:8px">${tpls.map((x) => `<option value="${esc(x.id)}" ${x.id === st.fuTpl ? 'selected' : ''}>with “${esc(x.name)}”</option>`).join('')}</select>
      <p class="note">Stops automatically if they reply. Automatic follow-ups are sent by your laptop or the cloud.</p></div>
    <button class="btn primary block" id="m-send">Send email</button>`, (sh, close) => {
    const vals = () => ({ ...l, email: $('#m-to', sh).value.trim() });
    const fromSel = () => ($('#m-from', sh) ? $('#m-from', sh).value : st.from);
    const applyTpl = () => {
      const tpl = tpls.find((x) => x.id === $('#m-tpl', sh).value);
      if (tpl) {
        $('#m-body', sh).value = fillTemplate(tpl.body, vals(), nameFor(fromSel()), senderProfile({ gmailAccounts: [], ...s }, fromSel()).signature);
        $('#m-sub', sh).value = fillTemplate(tpl.subject, vals(), nameFor(fromSel()));
      }
      applyReply();
    };
    const applyReply = () => {
      const r = $('#m-reply', sh);
      if (r && r.checked && last) { $('#m-sub', sh).value = /^re:/i.test(last.subject) ? last.subject : 'Re: ' + last.subject; $('#m-sub', sh).readOnly = true; }
      else $('#m-sub', sh).readOnly = false;
    };
    $('#m-fu', sh).value = st.fuMode;
    $('#m-futpl', sh).hidden = st.fuMode === 'none'; $('#m-fudays', sh).hidden = st.fuMode === 'none';
    $('#m-fu', sh).onchange = (e) => { $('#m-futpl', sh).hidden = e.target.value === 'none'; $('#m-fudays', sh).hidden = e.target.value === 'none'; };
    $('#m-tpl', sh).onchange = applyTpl;
    $('#m-reply', sh)?.addEventListener('change', () => { if (!$('#m-reply', sh).checked) applyTpl(); else applyReply(); });
    $('#m-from', sh)?.addEventListener('change', () => { if ($('#m-tpl', sh).value) applyTpl(); });
    if (!draft && st.templateId) applyTpl(); else applyReply();

    $('#m-send', sh).onclick = (e) => guard(async () => {
      const to = $('#m-to', sh).value.trim(), subject = $('#m-sub', sh).value.trim(), body = $('#m-body', sh).value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return toast('Enter a valid email address');
      if (!subject || !body.trim()) return toast('Add a subject and a message');
      if (/\{\{\s*\w+\s*\}\}/.test(subject + body) && !confirm('The message still has a {{placeholder}} in it. Send anyway?')) return;
      if (crm.contactType(l) === 'Do Not Contact' && !confirm('This person is marked Do Not Contact. Send anyway?')) return;
      const reply = !!$('#m-reply', sh)?.checked;
      const from = reply && last?.from && accounts.includes(last.from) ? last.from : fromSel();
      const followUp = { mode: $('#m-fu', sh).value, days: Number($('#m-fudays', sh).value), templateId: $('#m-futpl', sh).value };
      try {
        const sent = await D.sendEmail({ from, to, subject, text: body, threadId: reply ? last.threadId : undefined, inReplyTo: reply ? last.rfcId : undefined });
        if (to !== l.email) D.updateLead(l.id, { email: to });
        const tpl = tpls.find((x) => x.id === $('#m-tpl', sh).value);
        D.recordSent(l.id, { subject, templateName: tpl?.name, sent, followUp, doneFollowUpId: dueReminder ? fu.id : '', isReply: reply });
        close();
        toast(`Sent to ${to}${followUp.mode !== 'none' ? ' · follow-up scheduled' : ''}`);
      } catch (err) {
        if (err instanceof auth.NeedsAuth) {
          sessionStorage.setItem('pm_draft', JSON.stringify({ leadId: l.id, from, to, templateId: $('#m-tpl', sh).value, reply, subject, body, fuMode: followUp.mode, fuDays: followUp.days, fuTpl: followUp.templateId }));
        }
        throw err;
      }
    }, e.target);
  });
}

// =====================================================================
// PIPELINE
// =====================================================================
let pStage = '';
function pipeline(v) {
  const st = D.stages(), all = D.deals();
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  const open = all.filter((d) => d.status === 'open');
  const groups = [
    ...st.filter((x) => !x.won).map((x) => ({ id: x.id, name: x.name, deals: open.filter((d) => d.stageId === x.id) })),
    { id: '__won', name: st[st.length - 1].name, won: true, deals: all.filter((d) => d.status === 'won' && (d.wonAt >= yearStart || (d.billing === 'monthly' && !d.endedAt))) },
    { id: '__lost', name: 'Lost', deals: all.filter((d) => d.status === 'lost') },
  ];
  if (!groups.some((g) => g.id === pStage)) pStage = groups[0].id;
  const g = groups.find((x) => x.id === pStage);
  v.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="flex:1"><b>${open.length}</b> open · <b>${esc(money(open.reduce((s, d) => s + d.amount, 0)))}</b></div><button class="btn primary sm" id="p-new">+ New deal</button></div>
    <div class="stage-tabs">${groups.map((x) => `<button class="stab ${x.id === pStage ? 'on' : ''} ${x.won ? 'won' : ''}" data-s="${esc(x.id)}"><div class="n">${esc(x.name)}<i>${x.deals.length}</i></div><div class="a">${esc(money(x.deals.reduce((s, d) => s + d.amount, 0)))}</div></button>`).join('')}</div>
    ${g.deals.length ? g.deals.map((d) => dealCard(d, st)).join('') : `<div class="empty">No deals in ${esc(g.name)}.</div>`}`;
  $$('.stab').forEach((b) => b.addEventListener('click', () => { pStage = b.dataset.s; pipeline(v); }));
  $$('#view .deal').forEach((el) => el.addEventListener('click', () => dealSheet(el.dataset.id)));
  $('#p-new').onclick = () => dealSheet(null, { stageId: pStage.startsWith('__') ? '' : pStage });
}

function dealSheet(id, preset = {}) {
  const d = D.deals().find((x) => x.id === id) || null;
  const st = D.stages();
  const L = D.leads().slice().sort((a, b) => D.fullName(a).localeCompare(D.fullName(b)));
  const leadId = d?.leadId || preset.leadId || '';
  const lead0 = D.lead(leadId);
  const status = d?.status || 'open';
  openSheet(`<h2>${d ? 'Deal' : 'New deal'} ${d ? `<span class="pill ${status}">${status === 'open' ? 'Open' : status === 'won' ? 'Won' : 'Lost'}</span>` : ''}<span class="spacer"></span><button class="link" data-close>Close</button></h2>
    <div class="field"><label>Deal name</label><input id="d-title" value="${esc(d?.title || (lead0 ? `${lead0.company || D.fullName(lead0)} — ${new Date().toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : ''))}"></div>
    <div class="field"><label>Contact</label><select id="d-lead"><option value="">— None —</option>${L.map((l) => `<option value="${esc(l.id)}" ${l.id === leadId ? 'selected' : ''}>${esc(D.fullName(l))}${l.company ? ' · ' + esc(l.company) : ''}</option>`).join('')}</select></div>
    <div class="field"><label>Company</label><input id="d-co" value="${esc(d?.company || lead0?.company || '')}"></div>
    <div class="row2">
      <div class="field"><label>Amount (${esc(D.currency())})</label><input id="d-amt" type="number" inputmode="decimal" min="0" step="any" value="${d ? esc(d.amount || '') : ''}" placeholder="0"></div>
      <div class="field"><label>Billing</label><select id="d-bill"><option value="one-time">One-time</option><option value="monthly" ${d?.billing === 'monthly' ? 'selected' : ''}>Monthly</option></select></div>
    </div>
    <div class="row2">
      <div class="field"><label>Stage</label><select id="d-stage">${st.map((x) => `<option value="${esc(x.id)}" ${x.id === (d?.stageId || preset.stageId || st[0].id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Expected close</label><input id="d-close" type="date" value="${esc(d?.expectedClose || '')}"></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="d-notes" rows="3" style="min-height:70px">${esc(d?.notes || '')}</textarea></div>
    ${d?.status === 'lost' && d.lostReason ? `<p class="note">Lost reason: ${esc(d.lostReason)}</p>` : ''}
    <button class="btn primary block" id="d-save">Save</button>
    ${d ? `<div class="btns" style="margin-top:8px">
      ${status === 'open' ? '<button class="btn secondary" id="d-won">🎉 Won</button><button class="btn secondary" id="d-lost">Lost</button>' : '<button class="btn secondary" id="d-reopen">Reopen</button>'}
      ${status === 'won' && d.billing === 'monthly' && !d.endedAt ? '<button class="btn secondary" id="d-ended">Client ended</button>' : ''}
    </div><button class="btn danger block" id="d-del" style="margin-top:6px">Delete deal</button>` : ''}`, (sh, close) => {
    $('#d-lead', sh).onchange = (e) => { const l = D.lead(e.target.value); if (l && !$('#d-co', sh).value) $('#d-co', sh).value = l.company || ''; };
    const collect = () => ({ id: d?.id, title: $('#d-title', sh).value.trim(), leadId: $('#d-lead', sh).value, company: $('#d-co', sh).value.trim(), amount: Number($('#d-amt', sh).value) || 0, billing: $('#d-bill', sh).value, stageId: $('#d-stage', sh).value, expectedClose: $('#d-close', sh).value, notes: $('#d-notes', sh).value });
    const save = (extra = {}, msg = 'Saved') => { const v = { ...collect(), ...extra }; if (!v.title) return toast('Give the deal a name'); D.saveDeal(v); close(); toast(msg); };
    $('#d-save', sh).onclick = () => save({}, d ? 'Deal saved' : 'Deal added');
    $('#d-won', sh)?.addEventListener('click', () => save({ status: 'won' }, '🎉 Deal won'));
    $('#d-lost', sh)?.addEventListener('click', () => { const r = prompt('Why was it lost? (optional)'); if (r !== null) save({ status: 'lost', lostReason: r.trim() }, 'Marked lost'); });
    $('#d-reopen', sh)?.addEventListener('click', () => save({ status: 'open', stageId: $('#d-stage', sh).value === st[st.length - 1].id ? (st[st.length - 2] || st[0]).id : $('#d-stage', sh).value, lostReason: '', endedAt: 0 }, 'Reopened'));
    $('#d-ended', sh)?.addEventListener('click', () => {
      if (!confirm('Client stopped? Monthly billing ends today.')) return;
      save({ endedAt: Date.now() }, 'Monthly billing ended');
      if (d.leadId && confirm('Also mark the contact as a Past Client?')) D.setType(d.leadId, 'Past Client');
    });
    $('#d-del', sh)?.addEventListener('click', () => {
      if (!confirm('Delete this deal for good?')) return;
      D.commit((s) => { s.deals = s.deals.filter((x) => x.id !== d.id); s.tombstones = { ...(s.tombstones || {}), [d.id]: Date.now() }; });
      close(); toast('Deal deleted');
    });
  });
}

// =====================================================================
// FOLLOW-UPS
// =====================================================================
const FU_LABEL = { scheduled: 'Scheduled', due: 'Due', sent: 'Sent', done: 'Done', cancelled: 'Cancelled', replaced: 'Replaced', 'stopped-replied': 'They replied', 'stopped-bounced': 'Bounced', failed: 'Failed' };
function followups(v) {
  const all = D.allFollowUps(), now = Date.now();
  const due = all.filter((f) => D.OPEN_FU.includes(f.status) && (f.status === 'due' || f.due <= now));
  const sched = all.filter((f) => f.status === 'scheduled' && f.due > now);
  const hist = all.filter((f) => !D.OPEN_FU.includes(f.status) && f.status !== 'replaced').sort((a, b) => (b.sentAt || b.updatedAt) - (a.sentAt || a.updatedAt)).slice(0, 30);
  const item = (f) => {
    const open = D.OPEN_FU.includes(f.status);
    return `<div class="row" data-l="${esc(f.lead.id)}" data-f="${esc(f.id)}" data-open="${open ? 1 : ''}"><div class="av">${esc(initials(f.lead))}</div>
      <div class="main"><div class="t">${esc(D.fullName(f.lead))}</div><div class="sub">${esc(open ? fmtWhen(f.due) : fmtShort(f.sentAt || f.updatedAt))} · ${esc(f.templateName || '')}</div></div>
      <div class="end">${open ? `<span class="pill ${f.status === 'due' || f.due <= now ? 'due' : ''}">${f.mode === 'auto' ? 'Auto' : 'Reminder'}</span>` : `<span class="pill ${esc(f.status)}">${esc(FU_LABEL[f.status] || f.status)}</span>`}</div></div>`;
  };
  v.innerHTML = `
    <div class="card" style="padding:4px 12px"><h3 style="margin:10px 0 2px">Due now</h3><div class="list">${due.map(item).join('') || '<div class="empty" style="padding:14px">Nothing due — nice.</div>'}</div></div>
    <div class="card" style="padding:4px 12px"><h3 style="margin:10px 0 2px">Scheduled</h3><div class="list">${sched.map(item).join('') || '<div class="empty" style="padding:14px">No follow-ups scheduled.</div>'}</div></div>
    <div class="card" style="padding:4px 12px"><h3 style="margin:10px 0 2px">History</h3><div class="list">${hist.map(item).join('') || '<div class="empty" style="padding:14px">No history yet.</div>'}</div></div>`;
  $$('#view .row').forEach((r) => r.addEventListener('click', () => {
    if (!r.dataset.open) { location.hash = '#/contact/' + r.dataset.l; return; }
    const f = all.find((x) => x.id === r.dataset.f);
    openSheet(`<h2>${esc(D.fullName(f.lead))}<span class="spacer"></span><button class="link" data-close>Close</button></h2>
      <p class="muted small" style="margin-top:-6px">${f.mode === 'auto' ? 'Automatic follow-up' : 'Reminder'} · ${esc(fmtWhen(f.due))}<br>“${esc(f.templateName || 'Follow-up')}” from ${esc(f.from || '')}</p>
      <button class="btn primary block" id="f-send">Send it now</button>
      <div class="field" style="margin-top:12px"><label>Change date</label><input type="datetime-local" id="f-when" value="${localInput(f.due)}"></div>
      <div class="btns"><button class="btn secondary" id="f-move">Save new date</button><button class="btn secondary" id="f-open">Open contact</button></div>
      <button class="btn danger block" id="f-cancel" style="margin-top:6px">Cancel follow-up</button>`, (sh, close) => {
      $('#f-send', sh).onclick = (e) => guard(async () => { const subj = await D.sendFollowUpNow(f.lead.id, f.id); close(); toast('Sent: ' + subj); }, e.target);
      $('#f-move', sh).onclick = () => { const t = new Date($('#f-when', sh).value).getTime(); if (!t) return; D.fuReschedule(f.lead.id, f.id, t); close(); toast('Rescheduled'); };
      $('#f-open', sh).onclick = () => { close(); location.hash = '#/contact/' + f.lead.id; };
      $('#f-cancel', sh).onclick = () => { D.fuCancel(f.lead.id, f.id); close(); toast('Follow-up cancelled'); };
    });
  }));
}

// =====================================================================
// MY DAY
// =====================================================================
let dRange = 'day', dDate = '', wAnchor = '';
function workFor(date) {
  const [y, m, d] = date.split('-').map(Number);
  const a = new Date(y, m - 1, d).getTime(), b = a + 864e5, inD = (t) => t && t >= a && t < b;
  const L = D.leads();
  const sent = L.flatMap((l) => (l.emailsSent || []).filter((e) => inD(e.date)));
  const acts = L.flatMap((l) => (l.activities || []).filter((x) => inD(x.at)));
  return {
    'Emails sent': sent.filter((e) => !e.followUp).length, 'Follow-ups sent': sent.filter((e) => e.followUp).length,
    'Replies received': L.filter((l) => inD(l.repliedAt)).length, 'New contacts': L.filter((l) => inD(l.createdAt)).length,
    'Calls': acts.filter((x) => x.kind === 'call').length, 'Meetings': acts.filter((x) => x.kind === 'meeting').length,
    'Deals won': D.deals().filter((x) => inD(x.wonAt)).length,
  };
}
function aiBlock(rep, period = false) {
  if (!rep?.ai) return `<div class="muted small">No AI summary for this ${period ? 'week' : 'day'} yet.${period ? '' : ' It is written at your report time (8 PM by default).'}</div>`;
  const a = rep.ai, c = scoreColor(a.score);
  const list = (t, items, cls = '') => (items?.length ? `<h4 class="${cls}">${esc(t)}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  return `<div class="ai"><div class="ai-head"><div class="score" style="color:${c};border-color:${c}">${a.score}</div><div><b>${esc(a.headline)}</b><span class="muted small">${rep.sentAt ? 'Emailed ' + esc(ago(rep.sentAt)) : ''}</span></div></div>
    <p>${esc(a.summary)}</p>
    ${period ? list('Patterns', a.patterns) + list('Wins', a.wins, 'good') + list('What to improve', a.improve, 'bad') + list('Goals', a.next_goals, 'idea')
      : list('Marketing & outreach done', a.marketing_done, 'good') + list('What went well', a.went_well, 'good') + list('Time drains', a.time_drains, 'bad') + list('What you could have done', a.could_have_done, 'idea') + list('Top 3 for tomorrow', a.tomorrow)}</div>`;
}
function day(v) {
  const today = dayKey(Date.now());
  if (!dDate) dDate = today;
  if (!wAnchor) wAnchor = today;
  const seg = `<div class="seg" id="range" style="margin-bottom:12px"><button data-r="day" class="${dRange === 'day' ? 'on' : ''}">Day</button><button data-r="week" class="${dRange === 'week' ? 'on' : ''}">Week</button></div>`;
  if (dRange === 'week') return week(v, seg);
  const snapSum = D.S.snap.daySummaries?.[dDate];
  const tt = todayTime(dDate);
  const t = tt?.t;
  const rep = D.S.snap.dailyReports?.[dDate];
  const label = dDate === today ? 'Today' : new Date(dDate + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const val = (k) => (t ? t[k] : snapSum ? snapSum[k] : 0);
  let tl = '';
  if (tt) {
    const s = D.settings();
    const first = t.firstActive ? new Date(t.firstActive).getHours() : Number(String(s.workStart || '09').slice(0, 2));
    const lastH = t.lastActive ? new Date(t.lastActive).getHours() + 1 : Number(String(s.workEnd || '19').slice(0, 2));
    const h0 = Math.min(first, Number(String(s.workStart || '09').slice(0, 2))), h1 = Math.max(lastH, Number(String(s.workEnd || '19').slice(0, 2)));
    const cells = [];
    for (let m = h0 * 60; m < h1 * 60; m += 10) {
      const c = {}; for (let i = m; i < m + 10; i++) c[tt.day.mins[i]] = (c[tt.day.mins[i]] || 0) + 1;
      cells.push(`<i style="background:${COLORS[Object.entries(c).sort((x, y) => y[1] - x[1])[0][0]]}"></i>`);
    }
    tl = `<div class="card"><h3>Your day at a glance</h3><div class="tlbar" style="grid-template-columns:repeat(${cells.length},1fr)">${cells.join('')}</div>
      <div class="tlhours"><span>${new Date(2000, 0, 1, h0).toLocaleTimeString(undefined, { hour: 'numeric' })}</span><span>${new Date(2000, 0, 1, Math.round((h0 + h1) / 2)).toLocaleTimeString(undefined, { hour: 'numeric' })}</span><span>${new Date(2000, 0, 1, h1 % 24).toLocaleTimeString(undefined, { hour: 'numeric' })}</span></div>
      <div class="legend"><span><i style="background:${COLORS.P}"></i>Productive</span><span><i style="background:${COLORS.D}"></i>Off-focus</span><span><i style="background:${COLORS.O}"></i>Other apps</span><span><i style="background:${COLORS.I}"></i>Away</span></div></div>`;
  }
  const cats = t ? t.cats : Object.entries(snapSum?.cats || {}).map(([cat, minutes]) => ({ cat, minutes, kind: kindOfCat(cat) })).sort((a, b) => b.minutes - a.minutes);
  const topCat = cats[0]?.minutes || 1;
  const work = workFor(dDate);
  v.innerHTML = `${seg}
    <div class="daynav"><button class="btn secondary sm" id="prev">‹</button><div class="d">${esc(label)}</div><button class="btn secondary sm" id="next" ${dDate >= today ? 'disabled' : ''}>›</button></div>
    <div class="kpis">
      <div class="kpi"><div class="l">Productive</div><div class="v" style="color:${COLORS.P}">${fmtMin(val('productive'))}</div><div class="s">${t ? t.focusPct : snapSum?.focusPct || 0}% of active time</div></div>
      <div class="kpi"><div class="l">Off-focus</div><div class="v" style="color:#c2410c">${fmtMin(val('distracting'))}</div><div class="s">social, video, shopping</div></div>
      <div class="kpi"><div class="l">Idle / away</div><div class="v" style="color:#b7791f">${fmtMin(val('idle'))}</div><div class="s">no keyboard / mouse</div></div>
      <div class="kpi"><div class="l">Other apps</div><div class="v" style="color:#4f5fb3">${fmtMin(val('otherApps'))}</div><div class="s">outside Chrome</div></div>
    </div>
    ${tl}
    <div class="card"><h3>AI summary</h3>${aiBlock(rep)}</div>
    <div class="card"><h3>Where your time went</h3>${cats.length ? `<div class="bars">${cats.slice(0, 8).map((c) => `<div class="bar-row"><span><i class="sw" style="background:${COLORS[KIND[c.kind]]}"></i>${esc(c.cat)}</span><b>${fmtMin(c.minutes)}</b><div class="track"><div class="fill" style="width:${(c.minutes / topCat) * 100}%;background:${COLORS[KIND[c.kind]]}"></div></div></div>`).join('')}</div>` : '<div class="muted small">Nothing tracked for this day.</div>'}</div>
    <div class="card"><h3>Outreach &amp; CRM work</h3><div class="stats">${Object.entries(work).map(([k, n]) => `<div class="stat"><span>${esc(k)}</span><b>${n}</b></div>`).join('')}</div></div>`;
  $$('#range button').forEach((b) => b.addEventListener('click', () => { dRange = b.dataset.r; day(v); }));
  $('#prev').onclick = () => { const d = new Date(dDate + 'T12:00'); d.setDate(d.getDate() - 1); dDate = dayKey(d.getTime()); day(v); };
  $('#next').onclick = () => { const d = new Date(dDate + 'T12:00'); d.setDate(d.getDate() + 1); const k = dayKey(d.getTime()); if (k <= today) { dDate = k; day(v); } };
}
function week(v, seg) {
  const today = dayKey(Date.now());
  const sums = { ...(D.S.snap.daySummaries || {}) };
  // today's numbers are live from the minute-by-minute data
  const tt = todayTime(today);
  if (tt) sums[today] = { ...(sums[today] || {}), date: today, productive: tt.t.productive, distracting: tt.t.distracting, idle: tt.t.idle, otherApps: tt.t.otherApps, active: tt.t.active, neutral: tt.t.neutral, locked: tt.t.locked, offWork: tt.t.workWindow.off, cats: Object.fromEntries(tt.t.cats.map((c) => [c.cat, c.minutes])), sites: tt.t.sites.slice(0, 12).map((x) => [x.host, x.cat, x.minutes]), work: sums[today]?.work || {} };
  const range = periodRange('week', wAnchor);
  const p = aggregate(range, sums);
  const rep = D.S.snap.periodReports?.[range.id];
  const max = Math.max(60, ...p.rows.map((r) => (r.productive || 0) + (r.otherApps || 0) + (r.distracting || 0) + (r.idle || 0)));
  const topCat = p.cats[0]?.minutes || 1;
  v.innerHTML = `${seg}
    <div class="daynav"><button class="btn secondary sm" id="prev">‹</button><div class="d">${esc(range.label)}</div><button class="btn secondary sm" id="next" ${range.end > today ? 'disabled' : ''}>›</button></div>
    <div class="kpis">
      <div class="kpi"><div class="l">Productive</div><div class="v" style="color:${COLORS.P}">${fmtMin(p.totals.productive)}</div><div class="s">${p.daysTracked} day${p.daysTracked === 1 ? '' : 's'} tracked</div></div>
      <div class="kpi"><div class="l">Average / day</div><div class="v" style="color:${COLORS.P}">${fmtMin(p.avg.productive)}</div><div class="s">focus ${p.focusPct}%</div></div>
      <div class="kpi"><div class="l">Off-focus</div><div class="v" style="color:#c2410c">${fmtMin(p.totals.distracting)}</div><div class="s">avg ${fmtMin(p.avg.distracting)} a day</div></div>
      <div class="kpi"><div class="l">Idle / away</div><div class="v" style="color:#b7791f">${fmtMin(p.totals.idle)}</div><div class="s">avg ${fmtMin(p.avg.idle)} a day</div></div>
    </div>
    <div class="card"><h3>Day by day</h3><div class="wbars">${p.rows.map((r) => {
      const segs = r.empty ? '' : [['productive', 'P'], ['otherApps', 'O'], ['distracting', 'D'], ['idle', 'I']].map(([k, c]) => (r[k] ? `<i style="height:${(r[k] / max) * 100}%;background:${COLORS[c]}"></i>` : '')).join('');
      return `<div class="wb ${r.date === today ? 'today' : ''}" data-d="${esc(r.date)}"><div class="stack">${segs}</div><div class="lb">${esc(new Date(r.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'narrow' }))}</div></div>`;
    }).join('')}</div>
      <div class="legend"><span><i style="background:${COLORS.P}"></i>Productive</span><span><i style="background:${COLORS.O}"></i>Other apps</span><span><i style="background:${COLORS.D}"></i>Off-focus</span><span><i style="background:${COLORS.I}"></i>Away</span></div></div>
    <div class="card"><h3>AI summary</h3>${aiBlock(rep, true)}</div>
    <div class="card"><h3>Where your time went</h3>${p.cats.length ? `<div class="bars">${p.cats.slice(0, 8).map((c) => `<div class="bar-row"><span><i class="sw" style="background:${COLORS[KIND[c.kind]]}"></i>${esc(c.cat)}</span><b>${fmtMin(c.minutes)}</b><div class="track"><div class="fill" style="width:${(c.minutes / topCat) * 100}%;background:${COLORS[KIND[c.kind]]}"></div></div></div>`).join('')}</div>` : '<div class="muted small">Nothing tracked this week.</div>'}</div>
    <div class="card"><h3>Outreach &amp; CRM work</h3><div class="stats">${[['Emails sent', p.work.emailsSent], ['Follow-ups sent', p.work.followUpsSent], ['Replies', p.work.repliesReceived], ['New contacts', p.work.contactsAdded], ['Calls', p.work.calls], ['Meetings', p.work.meetings], ['Deals won', p.work.dealsWon], ['Profiles viewed', p.work.linkedinProfilesViewed]].map(([k, n]) => `<div class="stat"><span>${esc(k)}</span><b>${n || 0}</b></div>`).join('')}</div></div>`;
  $$('#range button').forEach((b) => b.addEventListener('click', () => { dRange = b.dataset.r; day(v); }));
  $('#prev').onclick = () => { wAnchor = shiftPeriod('week', wAnchor, -1); day(v); };
  $('#next').onclick = () => { const n = shiftPeriod('week', wAnchor, 1); if (n <= today) { wAnchor = n; day(v); } };
  $$('.wb').forEach((b) => b.addEventListener('click', () => { dDate = b.dataset.d; dRange = 'day'; day(v); }));
}

// =====================================================================
// ADD FROM LINKEDIN (also where Android's Share → Prospect lands)
// =====================================================================
function parseShare(sh) {
  const all = [sh.url, sh.text, sh.title].filter(Boolean).join(' ');
  const m = all.match(/https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[^\s?#"']+/i);
  const url = m ? normalizeLinkedinUrl(m[0].replace(/^https?:\/\/[a-z]{2,3}\.linkedin/i, 'https://www.linkedin')) : '';
  let name = '';
  const n1 = (sh.text || sh.title || '').match(/check out (.+?)['’]s profile/i);
  if (n1) name = n1[1];
  else if (sh.title && !/linkedin\.com/i.test(sh.title)) name = sh.title.replace(/\s*[|–-]\s*LinkedIn.*$/i, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (!name && url) name = decodeURIComponent(url.split('/in/')[1] || '').replace(/-[0-9a-f]{5,}$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const parts = name.split(' ').filter(Boolean);
  return { url, firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

function add(v) {
  // kept until the contact is saved or you leave this screen (it survives a Google sign-in redirect)
  const shared = JSON.parse(sessionStorage.getItem('pm_share') || 'null');
  const pre = shared ? parseShare(shared) : { url: '', firstName: '', lastName: '' };
  let emails = [];
  v.innerHTML = `
    <div class="card">
      <div class="field"><label>LinkedIn profile link</label><input id="x-url" type="url" inputmode="url" placeholder="https://www.linkedin.com/in/…" value="${esc(pre.url)}"></div>
      <p class="note" style="margin-top:-4px">On Android: in the LinkedIn app open a profile → Share → <b>Prospect</b>. On iPhone: Share → Copy link, then paste here.</p>
      <div id="x-exists"></div>
      <button class="btn secondary block" id="x-find">🔍 Find email with SalesQL</button>
    </div>
    <div class="card">
      <div class="row2"><div class="field"><label>First name</label><input id="x-first" value="${esc(pre.firstName)}"></div><div class="field"><label>Last name</label><input id="x-last" value="${esc(pre.lastName)}"></div></div>
      <div class="field"><label>Title</label><input id="x-title"></div>
      <div class="field"><label>Company</label><input id="x-co"></div>
      <div class="field"><label>Email</label><input id="x-email" type="email" inputmode="email"></div>
      <div class="found" id="x-found"></div>
      <div class="field"><label>Phone</label><input id="x-phone" type="tel"></div>
      <div class="field"><label>Type</label><select id="x-type">${crm.CONTACT_TYPES.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
      <button class="btn primary block" id="x-save">Save contact</button>
    </div>`;
  const checkExists = () => {
    const url = normalizeLinkedinUrl($('#x-url').value);
    const ex = url && D.leads().find((l) => l.linkedinUrl === url);
    $('#x-exists').innerHTML = ex ? `<div class="fu-line">Already in your contacts: <a href="#/contact/${esc(ex.id)}" style="margin-left:auto">Open ${esc(D.fullName(ex))} ›</a></div>` : '';
    if (url && !$('#x-first').value) { const p = parseShare({ url }); $('#x-first').value = p.firstName; $('#x-last').value = p.lastName; }
  };
  $('#x-url').oninput = checkExists; checkExists();
  const drawEmails = () => {
    const cur = $('#x-email').value.toLowerCase();
    $('#x-found').innerHTML = emails.map((e) => `<button class="${e.email.toLowerCase() === cur ? 'on' : ''}" data-e="${esc(e.email)}">${esc(e.email)}${e.type ? ' · ' + esc(e.type) : ''}${e.status ? ' · ' + esc(e.status) : ''}</button>`).join('');
    $$('#x-found button').forEach((b) => b.addEventListener('click', () => { $('#x-email').value = b.dataset.e; drawEmails(); }));
  };
  $('#x-find').onclick = (e) => guard(async () => {
    const url = $('#x-url').value.trim();
    if (!url) return toast('Paste a LinkedIn profile link first');
    e.target.textContent = 'Looking up…';
    try {
      const p = await D.findEmail(url);
      if (!p) return toast('SalesQL has no match for this profile');
      const set = (id, val) => { if (val && !$(id).value) $(id).value = val; };
      set('#x-first', p.firstName); set('#x-last', p.lastName); set('#x-title', p.title); set('#x-co', p.company);
      if (p.firstName) { $('#x-first').value = p.firstName; $('#x-last').value = p.lastName; }
      emails = p.emails || [];
      if (emails[0]) $('#x-email').value = emails[0].email;
      if (p.phones?.[0]) $('#x-phone').value = p.phones[0].phone;
      drawEmails();
      toast(emails.length ? `Found ${emails.length} email${emails.length > 1 ? 's' : ''}` : 'Found the person, but no email');
    } finally { e.target.textContent = '🔍 Find email with SalesQL'; }
  }, e.target);
  $('#x-save').onclick = () => {
    const data = { firstName: $('#x-first').value.trim(), lastName: $('#x-last').value.trim(), title: $('#x-title').value.trim(), company: $('#x-co').value.trim(), email: $('#x-email').value.trim(), phone: $('#x-phone').value.trim(), linkedinUrl: $('#x-url').value.trim(), allEmails: emails.map((x) => x.email) };
    if (!data.firstName && !data.lastName && !data.email) return toast('Add at least a name or email');
    sessionStorage.removeItem('pm_share');
    const l = D.upsertContact(data);
    const type = $('#x-type').value;
    if (type !== crm.contactType(l)) D.setType(l.id, type);
    toast('Contact saved');
    location.hash = '#/contact/' + l.id;
  };
}

// =====================================================================
// SETTINGS
// =====================================================================
function settingsScreen(v) {
  const s = D.settings();
  const main = auth.mainEmail();
  const accts = (s.gmailAccounts || []).map((a) => a.email);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  v.innerHTML = `
    <div class="card"><h3>Google account</h3>
      <div class="kv"><span>Signed in</span><b>${esc(main)}</b><span>Last synced</span><b>${esc(D.S.lastPull ? ago(D.S.lastPull) : 'never')}</b></div>
      <div class="btns" style="margin-top:12px"><button class="btn secondary" id="s-sync">Sync now</button><button class="btn danger" id="s-out">Sign out</button></div></div>
    <div class="card"><h3>Send emails from</h3>
      <p class="note" style="margin-top:-4px">Each Gmail address signs in once on this phone the first time you send from it.</p>
      <div class="list">${accts.map((e) => `<div class="row"><div class="main"><div class="t">${esc(e)}</div><div class="sub">${auth.hasToken(e, 'gmail') ? 'Ready on this phone' : e === main ? 'Ready after your next sign-in' : 'Not signed in on this phone yet'}</div></div>${auth.hasToken(e, 'gmail') ? '<span class="pill won">Ready</span>' : `<button class="btn secondary sm" data-acct="${esc(e)}">Sign in</button>`}</div>`).join('') || '<div class="muted small">No Gmail accounts — add them in the extension.</div>'}</div></div>
    ${standalone ? '' : `<div class="card"><h3>Add to your home screen</h3>
      <p class="small" style="margin:0">${ios ? 'In Safari, tap the <b>Share</b> button, then <b>Add to Home Screen</b>.' : 'In Chrome, tap <b>⋮</b> then <b>Install app</b> (or <b>Add to Home screen</b>). After installing, Prospect shows up in the LinkedIn app\'s Share menu.'}</p></div>`}
    <div class="card"><h3>About</h3><div class="kv"><span>Version</span><b>${esc(VERSION)}</b><span>Templates</span><b>${D.templates().length}</b><span>Contacts</span><b>${D.leads().length}</b></div>
      <p class="note">Templates, Gmail accounts and other settings are managed in the Chrome extension.</p></div>`;
  $('#s-sync').onclick = (e) => guard(async () => { await D.pull(); toast(D.S.error ? D.S.error : 'Up to date'); render(); }, e.target);
  $('#s-out').onclick = async () => { if (!confirm('Sign out on this phone? Your data stays safe in Google Drive.')) return; await D.signOutAll(); location.hash = '#/home'; render(); };
  $$('[data-acct]').forEach((b) => b.addEventListener('click', () => auth.signIn({ purpose: b.dataset.acct === main ? 'main' : 'gmail', email: b.dataset.acct })));
}

// =====================================================================
// START
// =====================================================================
async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Android share sheet → ?title=…&text=…&url=…
  const q = new URLSearchParams(location.search);
  if (q.has('text') || q.has('url') || q.has('title')) {
    sessionStorage.setItem('pm_share', JSON.stringify({ title: q.get('title') || '', text: q.get('text') || '', url: q.get('url') || '' }));
    history.replaceState(null, '', auth.redirectUri() + '#/add');
  }
  const r = await auth.handleRedirect();
  if (r?.error) setTimeout(() => toast(r.error), 300);
  D.onChange(() => {
    // don't rebuild the screen under someone who is typing or has a sheet open
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const onForm = route().name === 'add' && $('#x-save');
    if (!$('#sheet').hidden || onForm || (typing && D.S.snap)) { renderStatus(); return; }
    render();
  });
  await D.init();
  render();
  if (auth.mainEmail()) {
    if (auth.hasToken(auth.mainEmail(), 'main')) await D.pull();
    else if (navigator.onLine) {
      // quietly renew the 1-hour Google sign-in (Google sends you straight back)
      const lastTry = Number(sessionStorage.getItem('pm_autoauth') || 0);
      if (Date.now() - lastTry > 60000) { sessionStorage.setItem('pm_autoauth', String(Date.now())); return auth.signIn({ purpose: 'main', email: auth.mainEmail() }); }
      D.S.needsAuth = new auth.NeedsAuth(auth.mainEmail(), 'main'); render();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !auth.mainEmail()) return;
    const call = JSON.parse(sessionStorage.getItem('pm_call') || 'null');
    if (call && Date.now() - call.at < 45 * 60000 && Date.now() - call.at > 8000) {
      sessionStorage.removeItem('pm_call');
      if (D.lead(call.id)) logSheet(call.id, { kind: 'call', at: call.at, text: 'Called — ' });
    }
    if (Date.now() - D.S.lastPull > 120000 && auth.hasToken(auth.mainEmail(), 'main')) D.pull();
  });
  window.addEventListener('online', () => { if (D.S.pending) D.push(); });
}
start();
