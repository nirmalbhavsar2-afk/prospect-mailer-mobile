// Follow-ups: remind you, or send automatically as a reply in the same Gmail thread.
// Anything scheduled stops as soon as the person replies (checked via Gmail headers).
import * as store from './store.js';
import { dedupeOpen, stepKey } from './fudedupe.js';
import * as gmail from './gmail.js';
// cloud-script helpers are handed in by background.js (importing cloud.js here would create an import loop)
const cloud = { claim: async () => ({ claimed: true, local: true }), release: async () => {}, cancel: async () => {}, hasSender: async () => false };
export function useCloud(c) { Object.assign(cloud, c); }

export const STOP_STATUSES = ['Replied', 'Interested', 'Not interested', 'Placed', 'Bounced'];

// Is this reply a "no"? Looks only at their new words (quoted history and signatures are cut off).
const DECLINE = /\b(not interested|no longer interested|not (?:a )?(?:good )?fit|no,? thanks?|no thank you|not at this (?:time|point|moment)|not right now|not for (?:now|us)|we(?:'re| are) (?:all set|good|covered|set)|(?:we|i) (?:do not|don't) (?:need|use|work with|require)|(?:we|i)(?:'ll| will) pass|pass on this|please remove|remove (?:me|us|my email)|take (?:me|us) off|unsubscribe|stop (?:emailing|contacting|sending)|do not (?:contact|email)|don't (?:contact|email) (?:me|us)|not looking|no need|not hiring|no budget|have (?:a|our own) (?:team|vendor|partner)s? (?:for|in place)|already have (?:a |an )?(?:vendor|partner|team|provider))\b/i;
const STRONG_YES = /\b(interested|let'?s (?:talk|chat|connect|set)|schedule|book a|call me|send (?:me|over)|sounds good|tell me more|what are your rates|how much|pricing)\b/i;
// "Stop", "Unsubscribe", "Remove me" — an opt-out: never email them again
const OPTOUT = /^\W*(stop|stop\s+(?:please|now|it)|unsubscribe|unsub|remove|remove me|opt[ -]?out|please stop|stop emailing(?: me)?|do not (?:contact|email)(?: me)?)\W*$/i;
const OPTOUT_ANY = /\b(unsubscribe|remove me from|take me off|stop (?:emailing|contacting|sending)|do not (?:contact|email) me|opt[ -]?out)\b/i;
export function isOptOut(text) {
  const t = String(text || '').replace(/\s+/g, ' ').split(/\bOn [^]{0,120}?wrote:|-----Original Message|\bFrom: /i)[0].trim().slice(0, 300);
  return OPTOUT.test(t) || OPTOUT.test(t.split(/[.\n]/)[0] || '') || OPTOUT_ANY.test(t);
}
export function isDecline(text) {
  let t = String(text || '').replace(/\s+/g, ' ');
  t = t.split(/\bOn [^]{0,120}?wrote:|-----Original Message|\bFrom: /i)[0].slice(0, 600);
  if (!DECLINE.test(t)) return false;
  // "not interested right now but send me pricing" → treat as a maybe, not a no
  const rest = t.replace(DECLINE, ' ');
  return !(/\bbut\b/i.test(t) && STRONG_YES.test(rest.replace(/not interested|no longer interested/gi, '')));
}
const OPEN = ['scheduled', 'due'];

// ---------- helpers ----------
export async function deviceId() {
  let { deviceId: id } = await chrome.storage.local.get('deviceId');
  if (!id) { id = 'dev-' + store.uid(); await chrome.storage.local.set({ deviceId: id }); }
  return id;
}

// Minutes a time zone is ahead of UTC at instant t (e.g. America/New_York → -240 or -300).
function tzOffsetMin(tz, t) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1000) * 1000) / 60000);
  } catch { return null; }
}
// N days after `from`, optionally skipping weekends, nudged into 9:00–18:00 — in the recipient's time zone
// when `tz` is given (follow-ups to U.S. prospects shouldn't land at 2 a.m. their time), else local time.
export function computeDue(from, days, businessDays = true, tz = '') {
  const off = tz ? tzOffsetMin(tz, from) : null;
  if (off === null) return computeLocal(from, days, businessDays);
  // work on the recipient's wall clock using UTC getters, then convert back
  const d = new Date(from + off * 60000);
  let left = Math.max(0, Number(days) || 0);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!businessDays || (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)) left--;
  }
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (h < 9) d.setUTCHours(9, 30, 0, 0);
  else if (h >= 18) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(9, 30, 0, 0); }
  while (businessDays && (d.getUTCDay() === 0 || d.getUTCDay() === 6)) d.setUTCDate(d.getUTCDate() + 1);
  const wall = d.getTime();
  return wall - (tzOffsetMin(tz, wall - off * 60000) ?? off) * 60000;
}
function computeLocal(from, days, businessDays) {
  const d = new Date(from);
  let left = Math.max(0, Number(days) || 0);
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (!businessDays || (d.getDay() !== 0 && d.getDay() !== 6)) left--;
  }
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 9) d.setHours(9, 30, 0, 0);
  else if (h >= 18) { d.setDate(d.getDate() + 1); d.setHours(9, 30, 0, 0); }
  while (businessDays && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function fillTemplate(text, lead, senderName, signature) {
  const v = {
    first_name: lead.firstName || '', last_name: lead.lastName || '',
    full_name: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
    title: lead.title || '', company: lead.company || '', email: lead.email || '', my_name: senderName || '', signature: signature ?? '{{signature}}',
  };
  return (text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => v[k.toLowerCase()] ?? '');
}

const reSubject = (s) => (/^re:/i.test(s || '') ? s : 'Re: ' + (s || ''));

async function notify(id, title, message) {
  try {
    await chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 1 });
  } catch { /* notifications are a nicety */ }
}

async function patchFollowUp(leadId, fuId, patch, leadPatch = {}) {
  const leads = await store.getLeads();
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) return null;
  const now = Date.now();
  lead.followUps = (lead.followUps || []).map((f) => (f.id === fuId ? { ...f, ...patch, updatedAt: now } : f));
  return store.updateLead(leadId, { ...leadPatch, followUps: lead.followUps });
}

// ---------- scheduling ----------
// `sent` = the email just sent: { from, to, subject, threadId, rfcId, date }
// Content of a follow-up: its own written text (a per-person sequence step) or a saved template.
export function contentOf(fu, templates = []) {
  if (fu.custom && fu.custom.body) return { subject: fu.custom.subject || '', body: fu.custom.body, name: fu.templateName || 'Sequence step ' + (fu.step || 1) };
  const tpl = templates.find((t) => t.id === fu.templateId);
  return tpl ? { subject: tpl.subject, body: tpl.body, name: tpl.name } : null;
}
// After a sequence step goes out, the next step (if any) is scheduled in the same thread.
export function nextStep(fu, sentAt, businessDays = true, tz = '', sent = null) {
  const rest = Array.isArray(fu.rest) ? fu.rest.filter((x) => x && x.body) : [];
  if (!rest.length) return null;
  const [n, ...more] = rest;
  const now = Date.now();
  const cur = Number.isInteger(fu.step) ? fu.step : 1; // a bulk first email is step 0
  // after the first email of a bulk send, the follow-ups reply in the thread it started
  const thread = fu.initial && sent ? { threadId: sent.threadId || '', origSubject: sent.subject || '', inReplyTo: sent.rfcId || '', initial: false, kind: 'bulk-followup' } : {};
  return {
    // same id on every browser that plans it, so sync folds the copies into one
    ...fu, id: String(fu.id).replace(/-s\d+$/, '') + '-s' + (cur + 1), step: cur + 1, days: Number(n.days) || 4,
    due: computeDue(sentAt || now, Number(n.days) || 4, businessDays, tz),
    custom: { subject: n.subject || '', body: n.body }, rest: more, templateName: fu.initial ? 'Follow-up 1 · ' + String(fu.templateName || '').replace(/^Bulk · /, '') : 'Sequence step ' + (cur + 1),
    status: 'scheduled', attempts: 0, error: '', sentAt: undefined, by: undefined, createdAt: now, updatedAt: now,
    ...thread,
  };
}

// a first email (bulk send) only stops for people who said no — a past reply doesn't block a new email
export function bulkBlocked(lead) {
  return lead.type === 'Do Not Contact' || lead.replyKind === 'optout' || lead.replyKind === 'decline' || ['Bounced', 'Not interested'].includes(lead.status);
}
export async function scheduleBulk({ campaign, from, name, items }) {
  const me = await deviceId();
  const leads = await store.getLeads();
  const now = Date.now();
  let n = 0;
  for (const it of items) {
    const l = leads.find((x) => x.id === it.leadId);
    if (!l || !l.email || bulkBlocked(l)) continue;
    // a new email replaces any follow-up plan they already had
    const old = (l.followUps || []).map((f) => (OPEN.includes(f.status) ? { ...f, status: 'cancelled', error: 'Replaced by a bulk email', updatedAt: now } : f));
    const fu = {
      id: 'fu-' + store.uid(), initial: true, kind: 'bulk', campaign, step: 0, mode: 'auto', status: 'scheduled', due: it.due,
      from, to: l.email, custom: { subject: it.subject, body: it.body }, rest: it.rest || [], templateName: 'Bulk · ' + name,
      threadId: '', origSubject: '', deviceId: me, attempts: 0, error: '', createdAt: now, updatedAt: now,
    };
    l.followUps = [...old, fu];
    l.updatedAt = now;
    n++;
  }
  await chrome.storage.local.set({ leads });
  return { scheduled: n };
}

export async function schedule(leadId, { mode, days, templateId, sequence }, sent) {
  if (!mode || mode === 'none') return null;
  const seq = Array.isArray(sequence) ? sequence.filter((x) => x && String(x.body || '').trim()) : [];
  if (seq.length) days = Number(seq[0].days) || days;
  const s = await store.getSettings();
  const tpl = (await store.getTemplates()).find((t) => t.id === templateId);
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  if (!lead) return null;
  const now = Date.now();
  // one open follow-up per person: a new email replaces the old plan
  const followUps = (lead.followUps || []).map((f) => (OPEN.includes(f.status) ? { ...f, status: 'replaced', updatedAt: now } : f));
  const fu = {
    id: 'fu-' + store.uid(),
    mode, days: Number(days) || 3,
    due: computeDue(sent.date || now, days, s.followUpBusinessDays !== false, s.followUpTz),
    templateId: seq.length ? '' : tpl?.id || '', templateName: seq.length ? 'Sequence step 1' : tpl?.name || '',
    ...(seq.length ? { custom: { subject: seq[0].subject || '', body: seq[0].body }, rest: seq.slice(1).map((x) => ({ days: Number(x.days) || 4, subject: x.subject || '', body: x.body })), step: 1 } : {}),
    from: sent.from, to: sent.to, threadId: sent.threadId || '', inReplyTo: sent.rfcId || '', origSubject: sent.subject || '',
    status: 'scheduled', deviceId: await deviceId(), attempts: 0, createdAt: now, updatedAt: now,
  };
  followUps.push(fu);
  await store.updateLead(leadId, { followUps });
  return fu;
}

export async function cancel(leadId, fuId) {
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  const fu = lead?.followUps?.find((f) => f.id === fuId);
  if (fu) cloud.cancel(fu.from, [fuId]).catch(() => {});
  return patchFollowUp(leadId, fuId, { status: 'cancelled' });
}
export async function reschedule(leadId, fuId, due) {
  return patchFollowUp(leadId, fuId, { due, status: 'scheduled', error: '' });
}
// A reminder the person acted on (they sent the follow-up themselves from the panel).
export async function markDone(leadId, fuId) {
  const out = await patchFollowUp(leadId, fuId, { status: 'done', sentAt: Date.now() });
  await chainNext(leadId, fuId);
  return (await store.getLeads()).find((l) => l.id === leadId) || out;
}
async function chainNext(leadId, fuId, sentAt, sent = null) {
  const s = await store.getSettings();
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  const fu = lead?.followUps?.find((f) => f.id === fuId);
  if (!fu || (fu.initial ? bulkBlocked(lead) : STOP_STATUSES.includes(lead.status))) return null;
  const n = nextStep(fu, sentAt, s.followUpBusinessDays !== false, s.followUpTz, sent);
  if (!n) return null;
  if (lead.followUps.some((f) => f.id === n.id || (stepKey(f) === stepKey(n) && f.status !== 'cancelled'))) return null;
  await store.updateLead(leadId, { followUps: dedupeOpen([...lead.followUps, n]) });
  return n;
}

export async function listAll() {
  const out = [];
  for (const l of await store.getLeads()) {
    for (const f of l.followUps || []) out.push({ ...f, lead: l });
  }
  return out.sort((a, b) => a.due - b.due);
}

// ---------- sending ----------
async function sendFollowUp(lead, fu, { interactive = false } = {}) {
  const s = await store.getSettings();
  const tpl = contentOf(fu, await store.getTemplates());
  if (!tpl) throw new Error(`Template “${fu.templateName || 'follow-up'}” no longer exists.`);
  const prof = store.senderProfile(s, fu.from);
  const text = store.withSignature(fillTemplate(tpl.body, lead, prof.name, prof.signature), prof.signature);
  const subject = fu.threadId ? reSubject(fu.origSubject) : fillTemplate(tpl.subject, lead, prof.name) || reSubject(fu.origSubject);
  const res = await gmail.sendEmail({
    from: fu.from, to: lead.email || fu.to, subject, text,
    threadId: fu.threadId || undefined, inReplyTo: fu.inReplyTo || undefined, interactive,
  });
  const rfcId = res.rfcId || await gmail.getMessageId(res.from, res.id);
  const now = Date.now();
  const leads = await store.getLeads();
  const cur = leads.find((l) => l.id === lead.id) || lead;
  const followUps = (cur.followUps || []).map((f) => (f.id === fu.id ? { ...f, status: 'sent', sentAt: now, error: '', updatedAt: now } : f));
  let updated = await store.updateLead(lead.id, {
    followUps,
    emailsSent: [...(cur.emailsSent || []), { date: now, subject, templateName: tpl.name, messageId: res.id, threadId: res.threadId, rfcId, from: res.from, followUp: !fu.initial, ...(fu.campaign ? { campaign: fu.campaign } : {}) }],
    ...(fu.initial && (!cur.status || cur.status === 'New') ? { status: 'Contacted' } : {}),
  });
  if (await chainNext(lead.id, fu.id, now, { threadId: res.threadId, subject, rfcId })) updated = (await store.getLeads()).find((l) => l.id === lead.id) || updated;
  return { lead: updated, subject, text, from: res.from };
}

// Send one now (from the dashboard's "Send now").
export async function sendNow(leadId, fuId) {
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  const fu = lead?.followUps?.find((f) => f.id === fuId);
  if (!lead || !fu) throw new Error('Follow-up not found');
  if (!OPEN.includes(fu.status)) throw new Error('This follow-up is already ' + fu.status);
  const cl = await cloud.claim(fu.from, fu.id).catch((e) => ({ claimed: true, warn: e.message }));
  if (cl.result) {
    await absorbCloudResults({ [fu.id]: cl.result });
    throw new Error(cl.result.status === 'sent' ? 'The cloud already sent this follow-up.' : 'The cloud already handled this follow-up (' + cl.result.status + ').');
  }
  try { return await sendFollowUp(lead, fu, { interactive: true }); } catch (e) { await cloud.release(fu.from, fu.id).catch(() => {}); throw e; }
}

// ---------- cloud follow-ups ----------
// Everything the cloud script needs to send a follow-up on its own: the finished subject and text.
const leadId_step = (lead, fu) => `${lead.id}|${fu.step || 1}|${fu.threadId || String(fu.origSubject || '').toLowerCase()}`;
// one-time tidy-up: drop duplicate copies of planned follow-ups already saved (from before this fix)
export async function cleanDuplicates() {
  let n = 0;
  for (const l of await store.getLeads()) {
    const fus = l.followUps || [];
    const clean = dedupeOpen(fus);
    if (clean.length !== fus.length) { n += fus.length - clean.length; await store.updateLead(l.id, { followUps: clean }); }
  }
  return n;
}
export async function cloudJobs(email) {
  const who = (email || '').toLowerCase();
  if (!who) return [];
  const s = await store.getSettings();
  const tpls = await store.getTemplates();
  const prof = store.senderProfile(s, email);
  const horizon = Date.now() + 14 * 864e5;
  const out = [];
  for (const lead of await store.getLeads()) {
    if (lead.type === 'Do Not Contact') continue;
    for (const fu of dedupeOpen(lead.followUps || [])) {
      if (fu.initial ? bulkBlocked(lead) : STOP_STATUSES.includes(lead.status)) continue;
      if (fu.status !== 'scheduled' || fu.mode !== 'auto' || (fu.from || '').toLowerCase() !== who || fu.due > horizon) continue;
      const tpl = contentOf(fu, tpls);
      if (!tpl) continue;
      const text = store.withSignature(fillTemplate(tpl.body, lead, prof.name, prof.signature), prof.signature);
      const subject = fu.threadId ? reSubject(fu.origSubject) : fillTemplate(tpl.subject, lead, prof.name) || reSubject(fu.origSubject);
      // a first email isn't stopped by old replies; follow-ups are
      const threads = fu.initial ? [] : [...new Set((lead.emailsSent || []).filter((e) => e.threadId && (e.from || '').toLowerCase() === who).map((e) => e.threadId))];
      out.push({
        id: fu.id, leadId: lead.id, due: fu.due, from: email, fromName: prof.name, to: lead.email || fu.to,
        subject, text, html: gmail.textToHtml(text), threadId: fu.threadId || '', inReplyTo: fu.inReplyTo || '', threads,
        step: fu.step || 1, key: leadId_step(lead, fu),
      });
    }
  }
  return out;
}

// Apply what the cloud did (sent / stopped because they replied / failed) to local follow-ups.
export async function absorbCloudResults(results = {}) {
  const entries = Object.entries(results || {}).filter(([, r]) => r && ['sent', 'stopped-replied', 'stopped-bounced', 'failed', 'duplicate'].includes(r.status));
  if (!entries.length) return 0;
  const leads = await store.getLeads();
  const touched = new Set();
  const fs = await store.getSettings();
  const bizDays = fs.followUpBusinessDays !== false;
  for (const [fuId, r] of entries) {
    const lead = leads.find((l) => (l.followUps || []).some((f) => f.id === fuId));
    if (!lead) continue;
    const fu = lead.followUps.find((f) => f.id === fuId);
    if (!OPEN.includes(fu.status)) continue; // already up to date
    const now = Date.now();
    const patch = {};
    if (r.status === 'sent') {
      lead.followUps = lead.followUps.map((f) => (f.id === fuId ? { ...f, status: 'sent', sentAt: r.at || now, by: 'cloud', error: '', updatedAt: now } : f));
      const n = !(fu.initial ? bulkBlocked(lead) : STOP_STATUSES.includes(lead.status)) && nextStep(fu, r.at || now, bizDays, fs.followUpTz, { threadId: r.threadId, subject: r.subject, rfcId: r.rfcId });
      if (n && !lead.followUps.some((f) => f.id === n.id || (stepKey(f) === stepKey(n) && f.status !== 'cancelled'))) lead.followUps.push(n);
      lead.followUps = dedupeOpen(lead.followUps);
      patch.emailsSent = [...(lead.emailsSent || []), { date: r.at || now, subject: r.subject || reSubject(fu.origSubject), templateName: fu.templateName || '', messageId: r.messageId || '', threadId: r.threadId || fu.threadId || '', rfcId: r.rfcId || '', from: r.from || fu.from, followUp: !fu.initial, by: 'cloud', ...(fu.campaign ? { campaign: fu.campaign } : {}) }];
      if (fu.initial && (!lead.status || lead.status === 'New')) patch.status = 'Contacted';
    } else if (r.status === 'duplicate') {
      lead.followUps = lead.followUps.map((f) => (f.id === fuId ? { ...f, status: 'cancelled', error: 'Duplicate of a follow-up already sent', updatedAt: now } : f));
    } else if (r.status === 'failed') {
      lead.followUps = lead.followUps.map((f) => (f.id === fuId ? { ...f, status: 'failed', error: 'Cloud: ' + (r.error || 'could not send'), updatedAt: now } : f));
    } else {
      const replied = r.status === 'stopped-replied';
      lead.followUps = lead.followUps.map((f) => (OPEN.includes(f.status) ? { ...f, status: r.status, updatedAt: now } : f));
      patch.status = replied ? (STOP_STATUSES.includes(lead.status) ? lead.status : 'Replied') : 'Bounced';
      if (replied) {
        patch.repliedAt = r.repliedAt || lead.repliedAt || now;
        const optout = isOptOut(r.snippet);
        const declined = optout || isDecline(r.snippet);
        patch.replyKind = optout ? 'optout' : declined ? 'decline' : 'reply';
        if (r.snippet) patch.replySnippet = String(r.snippet).slice(0, 300);
        if (declined && patch.status === 'Replied') patch.status = 'Not interested';
        if (optout) { patch.status = 'Not interested'; patch.type = 'Do Not Contact'; }
      }
    }
    Object.assign(lead, patch);
    touched.add(lead.id);
  }
  for (const id of touched) {
    const l = leads.find((x) => x.id === id);
    await store.updateLead(id, { followUps: l.followUps, emailsSent: l.emailsSent, status: l.status, repliedAt: l.repliedAt || '', ...(l.replyKind ? { replyKind: l.replyKind, replySnippet: l.replySnippet || '' } : {}), ...(l.type === 'Do Not Contact' ? { type: l.type } : {}) });
  }
  return touched.size;
}

// ---------- reply detection ----------

// Look for replies on every recent outreach email — not only when a follow-up is due —
// so a quick "Stop" or "Yes, let's talk" shows up within minutes. Checked per contact at most every 20 min.
export async function scanReplies({ days = 30, limit = 30, force = false, ids = null } = {}) {
  const now = Date.now();
  const { replyScan = {} } = await chrome.storage.local.get('replyScan');
  const leads = (await store.getLeads()).filter((l) => (ids ? ids.includes(l.id) : true) &&
    !l.repliedAt && l.status !== 'Bounced' && (l.emailsSent || []).some((e) => e.threadId && e.from && now - (e.date || 0) < days * 864e5) &&
    (force || now - (replyScan[l.id] || 0) > 20 * 60000))
    .sort((a, b) => (replyScan[a.id] || 0) - (replyScan[b.id] || 0)).slice(0, limit);
  let replied = 0, bounced = 0;
  const errors = new Set();
  for (const lead of leads) {
    try {
      const st = await checkLeadReplied(lead);
      if (st.replied || st.bounced) { await stopForReply(lead, st); st.replied ? replied++ : bounced++; }
      replyScan[lead.id] = now;
    } catch (e) {
      errors.add(/needs-signin/.test(e.message) ? 'needs-signin' : e.message);
      if (/needs-signin/.test(e.message)) break; // that Gmail account needs signing in again — stop for now
    }
  }
  for (const [id, t] of Object.entries(replyScan)) if (now - t > 45 * 864e5) delete replyScan[id];
  await chrome.storage.local.set({ replyScan });
  return { checked: leads.length, replied, bounced, errors: [...errors] };
}

export async function checkLeadReplied(lead) {
  const threads = new Map();
  for (const e of lead.emailsSent || []) if (e.threadId && e.from) threads.set(e.threadId, e.from);
  for (const f of lead.followUps || []) if (f.threadId && f.from) threads.set(f.threadId, f.from);
  for (const [threadId, from] of threads) {
    const st = await gmail.threadStatus(from, threadId);
    if (st.replied && !st.snippet) {
      // metadata gives no text — read it if this account allowed reply text, so "Stop" / "not interested" are understood
      const reps = await gmail.threadReplies(from, threadId).catch(() => []);
      const last = reps.filter((r) => !r.bounce).pop();
      if (last?.snippet) { st.snippet = last.snippet; st.replies = reps.slice(-5); }
    }
    if (st.replied || st.bounced) return st;
  }
  return { replied: false, bounced: false };
}

async function stopForReply(lead, st) {
  const now = Date.now();
  const followUps = (lead.followUps || []).map((f) => (OPEN.includes(f.status) ? { ...f, status: st.replied ? 'stopped-replied' : 'stopped-bounced', updatedAt: now } : f));
  const optout = st.replied && isOptOut(st.snippet);
  const declined = st.replied && (optout || isDecline(st.snippet));
  let status = st.replied ? (STOP_STATUSES.includes(lead.status) ? lead.status : 'Replied') : 'Bounced';
  if (declined && ['Replied', 'Contacted', 'New', ''].includes(status || '')) status = 'Not interested';
  const patch = { followUps, status, repliedAt: st.at || lead.repliedAt || '' };
  if (st.replied) { patch.replyKind = optout ? 'optout' : declined ? 'decline' : 'reply'; patch.replySnippet = String(st.snippet || '').slice(0, 300); if (st.replies) patch.replies = st.replies; }
  if (optout) { patch.status = 'Not interested'; patch.type = 'Do Not Contact'; }
  const updated = await store.updateLead(lead.id, patch);
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email;
  if (optout) await notify('reply-' + lead.id, `${name} asked to stop`, 'Marked Do Not Contact — they won\'t be emailed or imported again.');
  else if (declined) await notify('reply-' + lead.id, `${name} declined`, 'Follow-ups stopped and status set to Not interested. Open the contact if you want to change it.');
  else if (st.replied) await notify('reply-' + lead.id, `${name} replied`, 'Follow-ups for them were stopped. Status set to Replied.');
  else await notify('bounce-' + lead.id, `Email to ${name} bounced`, `${lead.email} looks invalid — follow-ups stopped.`);
  return updated;
}

// ---------- the periodic job ----------
let running = false;
export async function tick({ beforeSend, onSent, force = false } = {}) {
  if (running) return;
  running = true;
  const result = { sent: 0, reminders: 0, stopped: 0, checked: 0, needsSignin: [], errors: [] };
  try {
    const me = await deviceId();
    const now = Date.now();
    const leads = await store.getLeads();
    const { replyChecks = {} } = await chrome.storage.session.get('replyChecks');

    // 1) reply detection for recently emailed people still waiting on an answer
    for (const lead of leads) {
      if (STOP_STATUSES.includes(lead.status)) continue;
      const lastSent = Math.max(0, ...(lead.emailsSent || []).map((e) => e.date || 0));
      const hasOpen = (lead.followUps || []).some((f) => OPEN.includes(f.status));
      if (!hasOpen && now - lastSent > 21 * 864e5) continue;
      const key = lead.id;
      if (!force && now - (replyChecks[key] || 0) < (hasOpen ? 10 : 30) * 60000) continue;
      replyChecks[key] = now;
      try {
        const st = await checkLeadReplied(lead);
        result.checked++;
        if (st.replied || st.bounced) { await stopForReply(lead, st); result.stopped++; }
      } catch (e) {
        if (e.message === 'needs-signin') result.needsSignin.push(...new Set((lead.emailsSent || []).map((x) => x.from).filter(Boolean)));
        else result.errors.push(e.message);
      }
    }

    await chrome.storage.session.set({ replyChecks });

    // 2) due follow-ups
    for (const lead of await store.getLeads()) {
      for (const fu of dedupeOpen(lead.followUps || [])) {
        if (fu.status !== 'scheduled' || fu.due > now) continue;
        if (fu.initial ? bulkBlocked(lead) : STOP_STATUSES.includes(lead.status)) {
          await patchFollowUp(lead.id, fu.id, fu.initial ? { status: 'cancelled', error: 'They said no / Do Not Contact' } : { status: 'stopped-replied' });
          continue;
        }
        if (fu.mode === 'remind') {
          await patchFollowUp(lead.id, fu.id, { status: 'due' });
          const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
          await notify('due-' + fu.id, `Follow up with ${name}`, `${lead.company ? lead.company + ' · ' : ''}Open the dashboard or their LinkedIn profile — the follow-up template is ready.`);
          result.reminders++;
          continue;
        }
        // auto-send: the laptop that scheduled it sends; another laptop takes over if it's 6h overdue
        // scheduled from the phone ('any'): whichever laptop is on sends it (the Drive pull above prevents doubles)
        // with a cloud script for this account, any laptop may send — the cloud's claim makes sure only one does
        const hasCloud = await cloud.hasSender(fu.from);
        if (!hasCloud && fu.deviceId !== 'any' && fu.deviceId !== me && now - fu.due < 6 * 3600e3) continue;
        if (beforeSend) {
          await beforeSend(); // pull from Drive first so two laptops never both send
          const fresh = (await store.getLeads()).find((l) => l.id === lead.id);
          const freshFu = fresh?.followUps?.find((f) => f.id === fu.id);
          if (!freshFu || freshFu.status !== 'scheduled' || (freshFu.initial ? bulkBlocked(fresh) : STOP_STATUSES.includes(fresh.status))) continue;
        }
        let claimed = false;
        if (hasCloud) {
          // ask the cloud first: it may already have sent this (laptop was off), or it holds it back for us now
          let cl;
          try { cl = await cloud.claim(fu.from, fu.id); } catch (e) {
            // cloud unreachable: wait, unless it's well overdue — then send from here rather than not at all
            if (now - fu.due < 3 * 3600e3) { await patchFollowUp(lead.id, fu.id, { error: 'Waiting for the cloud script: ' + e.message }); continue; }
            cl = { claimed: true };
          }
          if (cl.result) { await absorbCloudResults({ [fu.id]: cl.result }); continue; }
          claimed = !!cl.claimed;
        }
        try {
          // last check for a reply right before sending (not for a brand-new email: an old reply doesn't block it)
          const st = fu.initial ? {} : await checkLeadReplied(lead).catch(() => ({}));
          if (st.replied || st.bounced) { await stopForReply(lead, st); result.stopped++; continue; }
          const r = await sendFollowUp(lead, fu, { interactive: false });
          result.sent++;
          result.lastSent = r;
          const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
          if (!fu.initial) await notify('sent-' + fu.id, `Follow-up sent to ${name}`, r.subject);
          if (onSent) await onSent(r).catch(() => {});
        } catch (e) {
          if (claimed) await cloud.release(fu.from, fu.id).catch(() => {});
          if (e.message === 'needs-signin' || /sign-?in|expired|needs/i.test(e.message)) {
            result.needsSignin.push(fu.from);
            if (!fu.error) await notify('signin-' + fu.from, 'Follow-up waiting for sign-in', `Open Pitchbird → Settings and reconnect ${fu.from}.`);
            await patchFollowUp(lead.id, fu.id, { error: `Waiting for sign-in to ${fu.from}` });
          } else {
            const attempts = (fu.attempts || 0) + 1;
            await patchFollowUp(lead.id, fu.id, attempts >= 3 ? { status: 'failed', attempts, error: e.message } : { attempts, error: e.message });
          }
        }
      }
    }
  } finally {
    running = false;
    const needs = [...new Set(result.needsSignin.filter(Boolean))];
    await chrome.storage.session.set({ gmailNeedsSignin: needs });
  }
  return result;
}
