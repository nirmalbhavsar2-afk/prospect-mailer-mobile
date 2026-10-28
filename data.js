// Your data on the phone: the same file the extension syncs in your Google Drive app folder.
// Every change is timestamped and merged with the extension's merge rules, so phone and laptops never overwrite each other.
import { merge } from './lib/sync.js';
import { uid, normalizeLinkedinUrl, senderProfile, withSignature } from './lib/store.js';
import * as crm from './lib/crm.js';
import { computeDue, fillTemplate } from './lib/followups.js';
import { buildMime, textToHtml } from './lib/gmail.js';
import { normalizePerson } from './lib/salesql.js';
import * as auth from './auth.js';
import { idbGet, idbSet, idbClear } from './idb.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE = 'prospect-mailer-sync.json';

export const S = { snap: null, fileId: null, lastPull: 0, pending: false, syncing: false, error: '', needsAuth: null, noData: false };
const listeners = new Set();
export const onChange = (f) => listeners.add(f);
const emit = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

const persist = () => idbSet('state', { owner: auth.mainEmail(), snap: S.snap, fileId: S.fileId, lastPull: S.lastPull, pending: S.pending });

// ---------- Drive ----------
async function drive(url, opts = {}) {
  const token = auth.getToken(auth.mainEmail(), 'main');
  let res;
  try { res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } }); }
  catch { throw new Error('offline'); }
  if (res.status === 401) { auth.forget(auth.mainEmail()); throw new auth.NeedsAuth(auth.mainEmail(), 'main'); }
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(`Google Drive ${res.status}: ${b.error?.message || res.statusText}`);
  }
  return res;
}
async function findFile() {
  const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name='${FILE}'`, fields: 'files(id,modifiedTime)', orderBy: 'modifiedTime desc' });
  const files = (await (await drive(`${API}?${q}`)).json()).files || [];
  return files[0] || null;
}
async function download(id) {
  return (await drive(`${API}/${id}?alt=media`)).json();
}

function fail(e) {
  if (e instanceof auth.NeedsAuth) S.needsAuth = e;
  else S.error = e.message === 'offline' ? 'You are offline — showing your saved copy.' : e.message;
}

// ---------- lifecycle ----------
export async function init() {
  const saved = await idbGet('state');
  if (saved?.snap && saved.owner === auth.mainEmail()) {
    const { owner, ...rest } = saved;
    Object.assign(S, rest);
  }
  emit();
}

let pulling = null;
export function pull() {
  if (pulling) return pulling;
  pulling = (async () => {
    S.syncing = true; S.error = ''; emit();
    try {
      const f = await findFile();
      if (!f) { S.noData = true; return; }
      S.noData = false;
      const remote = await download(f.id);
      S.fileId = f.id;
      S.snap = S.snap && S.pending ? merge(S.snap, remote) : remote;
      S.lastPull = Date.now();
      S.needsAuth = null;
      await persist();
      if (S.pending) await push();
    } catch (e) { fail(e); }
    finally { S.syncing = false; pulling = null; emit(); }
  })();
  return pulling;
}

let pushTimer = null;
let pushing = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push(), 1200);
}
export function push() {
  if (pushing) return pushing.then(() => (S.pending ? push() : null));
  pushing = (async () => {
    S.syncing = true; emit();
    try {
      const f = S.fileId ? { id: S.fileId } : await findFile();
      if (!f) throw new Error('Your Prospect Mailer data was not found in this Google account.');
      const remote = await download(f.id);
      const merged = merge(S.snap, remote);
      await drive(`${UPLOAD}/${f.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...merged, exportedAt: Date.now() }) });
      S.snap = merged;
      S.pending = false;
      S.lastPull = Date.now();
      S.error = '';
      await persist();
    } catch (e) { fail(e); }
    finally { S.syncing = false; pushing = null; emit(); }
  })();
  return pushing;
}

export function commit(fn) {
  if (!S.snap) throw new Error('Your data has not loaded yet.');
  const out = fn(S.snap);
  S.pending = true;
  persist();
  emit();
  schedulePush();
  return out;
}

export async function signOutAll() {
  auth.signOut();
  await idbClear();
  Object.assign(S, { snap: null, fileId: null, lastPull: 0, pending: false, error: '', needsAuth: null });
  emit();
}

// ---------- reading ----------
export const settings = () => S.snap?.settings || {};
export const leads = () => S.snap?.leads || [];
export const deals = () => S.snap?.deals || [];
export const templates = () => S.snap?.templates || [];
export const stages = () => crm.stagesOf(settings());
export const lead = (id) => leads().find((l) => l.id === id);
export const currency = () => settings().currency || 'USD';
export const fullName = (l) => [l.firstName, l.lastName].filter(Boolean).join(' ') || l.email || '(no name)';

// ---------- changes (same rules as the extension) ----------
const now = () => Date.now();
const touch = (obj, patch) => Object.assign(obj, patch, { updatedAt: now() });

export const updateLead = (id, patch) => commit((s) => touch(s.leads.find((l) => l.id === id), patch));

export const setType = (id, type) => commit((s) => {
  const l = s.leads.find((x) => x.id === id);
  if (crm.contactType(l) === type) return l;
  return touch(l, { type, typeHistory: [...(l.typeHistory || []), { from: crm.contactType(l), type, at: now() }] });
});

export const addActivity = (id, { kind, text, at }) => commit((s) => {
  const l = s.leads.find((x) => x.id === id);
  return touch(l, { activities: [...(l.activities || []), { id: 'act-' + uid(), kind: kind || 'note', text: text || '', at: at || now() }] });
});

export const upsertContact = (data) => commit((s) => {
  s.leads = s.leads || [];
  const url = normalizeLinkedinUrl(data.linkedinUrl);
  const email = (data.email || '').toLowerCase();
  let l = (url && s.leads.find((x) => x.linkedinUrl === url)) || (email && s.leads.find((x) => (x.email || '').toLowerCase() === email));
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  if (url) clean.linkedinUrl = url;
  if (l) return touch(l, clean);
  l = { id: uid(), firstName: '', lastName: '', title: '', company: '', email: '', phone: '', location: '', linkedinUrl: url, status: 'New', notes: '', biginId: '', emailsSent: [], createdAt: now(), source: 'mobile', ...clean, updatedAt: now() };
  s.leads.unshift(l);
  return l;
});

export const saveDeal = (d) => commit((s) => {
  s.deals = s.deals || [];
  const st = crm.stagesOf(s.settings || {});
  const wonStage = st[st.length - 1];
  let deal = d.id && s.deals.find((x) => x.id === d.id);
  const prev = deal ? { ...deal } : null;
  if (!deal) {
    deal = { id: 'deal-' + uid(), title: '', company: '', leadId: '', amount: 0, billing: 'one-time', stageId: st[0].id, status: 'open', expectedClose: '', wonAt: 0, lostAt: 0, lostReason: '', endedAt: 0, notes: '', history: [], createdAt: now() };
    s.deals.unshift(deal);
  }
  touch(deal, { ...d, amount: Math.max(0, Number(d.amount ?? deal.amount) || 0) });
  if (prev && prev.status !== 'open' && !d.status && d.stageId && d.stageId !== wonStage.id) deal.status = 'open';
  if (deal.stageId === wonStage.id && deal.status === 'open') deal.status = 'won';
  if (deal.status === 'won' && deal.stageId !== wonStage.id && (!prev || prev.status !== 'won')) deal.stageId = wonStage.id;
  if (deal.status === 'won' && !deal.wonAt) deal.wonAt = now();
  if (deal.status === 'lost' && !deal.lostAt) deal.lostAt = now();
  if (deal.status === 'open') { deal.wonAt = 0; deal.lostAt = 0; }
  if (!prev || prev.stageId !== deal.stageId || prev.status !== deal.status) deal.history = [...(deal.history || []), { at: now(), stageId: deal.stageId, status: deal.status }];
  if (deal.leadId && deal.status === 'won' && (!prev || prev.status !== 'won')) {
    const l = s.leads.find((x) => x.id === deal.leadId);
    if (l && crm.contactType(l) !== 'Client') touch(l, { type: 'Client', typeHistory: [...(l.typeHistory || []), { from: crm.contactType(l), type: 'Client', at: now() }] });
  }
  return deal;
});

const patchFu = (leadId, fuId, patch) => commit((s) => {
  const l = s.leads.find((x) => x.id === leadId);
  l.followUps = (l.followUps || []).map((f) => (f.id === fuId ? { ...f, ...patch, updatedAt: now() } : f));
  return touch(l, {});
});
export const fuCancel = (leadId, fuId) => {
  const fu = lead(leadId)?.followUps?.find((f) => f.id === fuId);
  const r = patchFu(leadId, fuId, { status: 'cancelled' });
  if (fu) { const snd = cloudFor(fu.from); if (snd) cloudCall(snd, { type: 'fu-cancel', ids: [fuId] }).catch(() => {}); }
  return r;
};
export const fuReschedule = (leadId, fuId, due) => { const r = patchFu(leadId, fuId, { due, status: 'scheduled', error: '' }); cloudQueue(leadId); return r; };

// ---------- cloud follow-ups: tell the cloud script right away (the laptop may be off) ----------
const low = (e) => (e || '').toLowerCase();
function cloudFor(email) {
  const s = settings();
  if (s.cloudUrl && s.cloudSecret && low(s.cloudAccount) === low(email)) return { url: s.cloudUrl, secret: s.cloudSecret };
  const x = (s.cloudSenders || {})[low(email)];
  return x && x.url && x.secret ? x : null;
}
async function cloudCall(snd, body) {
  const r = await fetch(snd.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, secret: snd.secret }) }).then((x) => x.json());
  if (!r.ok) throw new Error(r.error || 'Cloud script error');
  return r;
}
export function cloudQueue(leadId) {
  setTimeout(async () => {
    const l = lead(leadId);
    if (!l || l.type === 'Do Not Contact') return;
    const s = settings();
    for (const fu of (l.followUps || []).filter((f) => f.status === 'scheduled' && f.mode === 'auto')) {
      const snd = cloudFor(fu.from);
      const tpl = templates().find((t) => t.id === fu.templateId);
      if (!snd || !tpl) continue;
      const prof = senderProfile({ gmailAccounts: [], ...s }, fu.from);
      const text = withSignature(fillTemplate(tpl.body, l, prof.name, prof.signature), prof.signature);
      const subject = fu.threadId ? (/^re:/i.test(fu.origSubject) ? fu.origSubject : 'Re: ' + fu.origSubject) : fillTemplate(tpl.subject, l, prof.name);
      const threads = [...new Set((l.emailsSent || []).filter((e) => e.threadId && low(e.from) === low(fu.from)).map((e) => e.threadId))];
      const job = { id: fu.id, leadId: l.id, due: fu.due, from: fu.from, fromName: prof.name, to: l.email || fu.to, subject, text, html: textToHtml(text), threadId: fu.threadId || '', inReplyTo: fu.inReplyTo || '', threads };
      cloudCall(snd, { type: 'fu-add', jobs: [job] }).catch(() => { /* older script: the laptop will pass it on */ });
    }
  }, 0);
}

export function allFollowUps() {
  return leads().flatMap((l) => (l.followUps || []).map((f) => ({ ...f, lead: l }))).sort((a, b) => a.due - b.due);
}
export const OPEN_FU = ['scheduled', 'due'];
export const openFollowUp = (l) => (l?.followUps || []).filter((f) => OPEN_FU.includes(f.status)).sort((a, b) => a.due - b.due)[0] || null;
export const lastThread = (l) => { const s = (l?.emailsSent || []).filter((e) => e.threadId); return s[s.length - 1] || null; };

// ---------- email (from your Gmail) ----------
const b64url = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function sendEmail({ from, to, subject, text, threadId, inReplyTo }) {
  const s = settings();
  const prof = senderProfile({ gmailAccounts: [], ...s }, from);
  const fullText = withSignature(text, prof.signature);
  const token = auth.getToken(from, 'gmail');
  const raw = b64url(buildMime({ to, subject, text: fullText, fromName: prof.name, fromEmail: from, inReplyTo }));
  let res;
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
    });
  } catch { throw new Error('No internet connection — the email was not sent.'); }
  if (res.status === 401) { auth.forget(from); throw new auth.NeedsAuth(from, 'gmail'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Gmail: ' + (body.error?.message || res.statusText));
  let rfcId = '';
  try {
    const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${body.id}?format=metadata&metadataHeaders=Message-ID`, { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json());
    rfcId = (m.payload?.headers || []).find((h) => h.name.toLowerCase() === 'message-id')?.value || '';
  } catch { /* threading still works via threadId */ }
  return { id: body.id, threadId: body.threadId, rfcId, from, text: fullText };
}

// Record a sent email on the contact, close a due reminder, and schedule the next follow-up.
export const recordSent = (leadId, { subject, templateName, sent, followUp, doneFollowUpId, isReply }) => commit((s) => {
  const l = s.leads.find((x) => x.id === leadId);
  const t = now();
  l.emailsSent = [...(l.emailsSent || []), { date: t, subject, templateName: templateName || '', messageId: sent.id, threadId: sent.threadId, rfcId: sent.rfcId, from: sent.from, followUp: !!isReply }];
  let fus = (l.followUps || []).map((f) => {
    if (f.id === doneFollowUpId) return { ...f, status: 'done', sentAt: t, updatedAt: t };
    if (followUp && followUp.mode !== 'none' && OPEN_FU.includes(f.status)) return { ...f, status: 'replaced', updatedAt: t };
    return f;
  });
  if (followUp && followUp.mode !== 'none') {
    const tpl = s.templates.find((x) => x.id === followUp.templateId);
    fus = [...fus, {
      id: 'fu-' + uid(), mode: followUp.mode, days: Number(followUp.days) || 3,
      due: computeDue(t, followUp.days, s.settings?.followUpBusinessDays !== false),
      templateId: tpl?.id || '', templateName: tpl?.name || '',
      from: sent.from, to: l.email, threadId: sent.threadId || '', inReplyTo: sent.rfcId || '', origSubject: subject,
      status: 'scheduled', deviceId: 'any', attempts: 0, createdAt: t, updatedAt: t,
    }];
  }
  if (followUp && followUp.mode === 'auto') cloudQueue(leadId);
  return touch(l, { followUps: fus, status: !l.status || l.status === 'New' ? 'Contacted' : l.status });
});

// Send a scheduled follow-up right now, as a reply in the same thread.
export async function sendFollowUpNow(leadId, fuId) {
  const l = lead(leadId);
  const fu = l?.followUps?.find((f) => f.id === fuId);
  if (!fu) throw new Error('Follow-up not found');
  const tpl = templates().find((t) => t.id === fu.templateId);
  if (!tpl) throw new Error(`Template “${fu.templateName || 'follow-up'}” no longer exists.`);
  const prof = senderProfile({ gmailAccounts: [], ...settings() }, fu.from);
  const subject = fu.threadId ? (/^re:/i.test(fu.origSubject) ? fu.origSubject : 'Re: ' + fu.origSubject) : fillTemplate(tpl.subject, l, prof.name);
  // make sure the cloud hasn't already sent it (and stop it from sending it now)
  const snd = cloudFor(fu.from);
  if (snd) {
    const c = await cloudCall(snd, { type: 'fu-claim', id: fu.id }).catch(() => ({ claimed: true }));
    if (c.result && c.result.status === 'sent') throw new Error('The cloud already sent this follow-up.');
  }
  const sent = await sendEmail({ from: fu.from, to: l.email || fu.to, subject, text: fillTemplate(tpl.body, l, prof.name, prof.signature), threadId: fu.threadId || undefined, inReplyTo: fu.inReplyTo || undefined });
  commit((s) => {
    const x = s.leads.find((y) => y.id === leadId);
    const t = now();
    x.followUps = x.followUps.map((f) => (f.id === fuId ? { ...f, status: 'sent', sentAt: t, error: '', updatedAt: t } : f));
    x.emailsSent = [...(x.emailsSent || []), { date: t, subject, templateName: tpl.name, messageId: sent.id, threadId: sent.threadId, rfcId: sent.rfcId, from: sent.from, followUp: true }];
    return touch(x, {});
  });
  return subject;
}

// ---------- SalesQL ----------
export async function findEmail(linkedinUrl) {
  const s = settings();
  if (!s.salesqlKey) throw new Error('Add your SalesQL key in the extension (Settings → SalesQL) first.');
  const url = normalizeLinkedinUrl(linkedinUrl);
  if (!url) throw new Error('That is not a LinkedIn profile link (it should contain linkedin.com/in/…).');
  // 1) straight to SalesQL
  try {
    const res = await fetch('https://api-public.salesql.com/v1/persons/enrich?linkedin_url=' + encodeURIComponent(url), { headers: { Authorization: 'Bearer ' + s.salesqlKey, Accept: 'application/json' } });
    if (res.status === 404) return null;
    const body = await res.json().catch(() => null);
    if (res.ok) return normalizePerson(body);
    if (res.status === 401) throw new Error('SalesQL rejected the API key.');
    throw new Error('SalesQL: ' + (body?.message || res.status));
  } catch (e) {
    if (!(e instanceof TypeError)) throw e; // TypeError = the browser blocked the call → try the cloud script
  }
  // 2) through your cloud script (runs on Google's servers)
  if (!s.cloudUrl || !s.cloudSecret) throw new Error('SalesQL can\'t be reached from the phone directly. Connect Cloud reports in the extension (Settings) so the phone can look emails up through it.');
  let r;
  try {
    r = await fetch(s.cloudUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ type: 'salesql', secret: s.cloudSecret, key: s.salesqlKey, linkedin_url: url }) }).then((x) => x.json());
  } catch { throw new Error('Could not reach your cloud script — check your connection.'); }
  if (!r.ok) throw new Error(r.error === 'unknown-request' ? 'Update your cloud script to the latest version (extension → Settings → Cloud reports) to find emails from the phone.' : r.error);
  if (r.status === 404 || !r.data) return null;
  if (r.status === 401) throw new Error('SalesQL rejected the API key.');
  if (r.status >= 300) throw new Error('SalesQL: ' + (r.data?.message || r.status));
  return normalizePerson(r.data);
}
