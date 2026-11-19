// CRM extras for Contacts: tags, lead score, tasks, custom fields, saved views, duplicates.
// Pure helpers first (testable without Chrome), storage helpers after.
import * as store from './store.js';
import { contactType, isClosed } from './crm.js';
import { dedupeOpen } from './fudedupe.js';

// ---------- tags ----------
const TAG_COLORS = ['#3461ff', '#0f9d58', '#e8710a', '#c2185b', '#7b1fa2', '#00838f', '#5d4037', '#b7791f', '#2e7d32', '#ad1457'];
export function tagColor(name) {
  let h = 0;
  for (const c of String(name).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) | 0;
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}
export const cleanTag = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 30);
export function allTags(leads) {
  const m = new Map();
  for (const l of leads) for (const t of l.tags || []) m.set(t.toLowerCase(), { name: t, n: (m.get(t.toLowerCase())?.n || 0) + 1 });
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}
export function withTags(tags = [], add = [], remove = []) {
  const rm = new Set(remove.map((t) => t.toLowerCase()));
  const out = tags.filter((t) => !rm.has(t.toLowerCase()));
  for (const t of add.map(cleanTag).filter(Boolean)) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

// ---------- lead score (0–100): fit + engagement + recency + deals ----------
export function score(l, deals = [], now = Date.now()) {
  const why = [];
  const type = contactType(l);
  if (type === 'Do Not Contact' || l.replyKind === 'optout') return { score: 0, label: 'Closed', why: ['Do Not Contact'] };
  if (l.status === 'Bounced') return { score: 0, label: 'Closed', why: ['Email bounced'] };
  let s = 0;
  const fit = Number(l.fit) || 0;
  if (fit) { s += Math.round(fit * 3); why.push(`Fit ${fit}/10`); } else if (l.jobs?.length) { s += 12; why.push('Hiring now'); }
  if (l.status === 'Interested') { s += 35; why.push('Interested'); }
  else if (l.repliedAt && l.replyKind !== 'decline') { s += 25; why.push('Replied'); }
  if (l.status === 'Not interested' || l.replyKind === 'decline') { s -= 30; why.push('Declined'); }
  const myDeals = deals.filter((d) => d.leadId === l.id);
  if (myDeals.some((d) => d.status === 'open')) { s += 20; why.push('Open deal'); }
  if (myDeals.some((d) => d.status === 'won') || type === 'Client') { s += 20; why.push('Client'); }
  const sent = (l.emailsSent || []).length;
  if (sent) { s += Math.min(8, sent * 2); }
  const acts = (l.activities || []).length;
  if (acts) { s += Math.min(10, acts * 3); why.push(`${acts} logged touch${acts > 1 ? 'es' : ''}`); }
  const last = Math.max(l.updatedAt || 0, l.repliedAt ? Number(l.repliedAt) : 0, ...(l.activities || []).map((a) => a.at || 0));
  if (now - last < 7 * 864e5) { s += 10; why.push('Active this week'); } else if (now - last < 30 * 864e5) s += 5;
  if ((l.tags || []).some((t) => /^hot$/i.test(t))) { s += 10; why.push('Tagged Hot'); }
  if ((l.tasks || []).some((t) => !t.done && !t.deleted)) s += 5;
  s = Math.max(0, Math.min(100, s));
  return { score: s, label: s >= 65 ? 'Hot' : s >= 35 ? 'Warm' : 'Cold', why };
}

// ---------- tasks ----------
export const openTasks = (l) => (l.tasks || []).filter((t) => !t.done && !t.deleted).sort((a, b) => (a.due || 9e15) - (b.due || 9e15));
export function nextTask(l) { return openTasks(l)[0] || null; }

// ---------- duplicates ----------
const normEmail = (e) => String(e || '').trim().toLowerCase();
const normLi = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').replace(/\?.*$/, '');
const normName = (l) => [l.firstName, l.lastName].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const normCo = (c) => String(c || '').toLowerCase().replace(/\b(inc|llc|ltd|corp|co|group|the)\b|[^a-z0-9]/g, '');
// groups of records that look like the same person (same email, same LinkedIn, or same name at the same company)
export function findDuplicates(leads) {
  const parent = new Map(leads.map((l) => [l.id, l.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const seen = new Map();
  const key = (k, id) => { if (!k) return; if (seen.has(k)) join(seen.get(k), id); else seen.set(k, id); };
  for (const l of leads) {
    for (const e of new Set([l.email, ...(l.allEmails || [])].map(normEmail).filter(Boolean))) key('e:' + e, l.id);
    if (normLi(l.linkedinUrl)) key('li:' + normLi(l.linkedinUrl), l.id);
    const n = normName(l), c = normCo(l.company);
    if (n.length > 3 && c.length > 1) key(`nc:${n}|${c}`, l.id);
  }
  const groups = new Map();
  for (const l of leads) { const r = find(l.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(l); }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => richness(b) - richness(a)));
}
// the record with the most history goes first (it becomes the one we keep)
function richness(l) {
  return (l.emailsSent || []).length * 5 + (l.activities || []).length * 3 + (l.followUps || []).length * 2 + (l.email ? 2 : 0) + (l.linkedinUrl ? 1 : 0) + (l.updatedAt || 0) / 1e13;
}
// fold `others` into `keep`: nothing is lost — histories are combined, empty fields filled in
export function mergeRecords(keep, others) {
  const out = JSON.parse(JSON.stringify(keep));
  for (const o of others) {
    for (const [k, v] of Object.entries(o)) {
      if (['id', 'createdAt', 'updatedAt', 'emailsSent', 'followUps', 'activities', 'tasks', 'tags', 'allEmails', 'typeHistory', 'notes', 'custom', 'replies'].includes(k)) continue;
      if ((out[k] === undefined || out[k] === '' || out[k] === null) && v !== '' && v != null) out[k] = v;
    }
    const byKey = (arr, f) => [...new Map(arr.map((x) => [f(x), x])).values()];
    out.emailsSent = byKey([...(out.emailsSent || []), ...(o.emailsSent || [])], (e) => `${e.date}|${e.subject}`).sort((a, b) => a.date - b.date);
    out.followUps = dedupeOpen(byKey([...(out.followUps || []), ...(o.followUps || [])], (f) => f.id));
    out.activities = byKey([...(out.activities || []), ...(o.activities || [])], (a) => a.id).sort((a, b) => a.at - b.at);
    out.tasks = byKey([...(out.tasks || []), ...(o.tasks || [])], (t) => t.id);
    out.typeHistory = byKey([...(out.typeHistory || []), ...(o.typeHistory || [])], (t) => `${t.at}|${t.type}`);
    out.tags = withTags(out.tags || [], o.tags || []);
    out.allEmails = [...new Set([out.email, ...(out.allEmails || []), o.email, ...(o.allEmails || [])].filter(Boolean).map(normEmail))];
    out.custom = { ...(o.custom || {}), ...(out.custom || {}) };
    if (o.notes && !String(out.notes || '').includes(o.notes)) out.notes = [out.notes, o.notes].filter(Boolean).join('\n\n');
    out.createdAt = Math.min(out.createdAt || Date.now(), o.createdAt || Date.now());
    if (o.repliedAt && !out.repliedAt) { out.repliedAt = o.repliedAt; out.replyKind = o.replyKind; out.replySnippet = o.replySnippet; }
    // keep the most "final" status / strictest type
    if (contactType(o) === 'Do Not Contact') out.type = 'Do Not Contact';
    if (isClosed(o) && !isClosed(out)) out.status = o.status;
  }
  out.updatedAt = Date.now();
  return out;
}

// ---------- columns ----------
// key → label; renderers live in the Contacts screen
export const COLUMNS = [
  ['name', 'Name'], ['company', 'Company'], ['title', 'Title'], ['email', 'Email'], ['phone', 'Phone'],
  ['type', 'Type'], ['status', 'Status'], ['track', 'Track'], ['tags', 'Tags'], ['score', 'Score'],
  ['nextTask', 'Next task'], ['nextFollowUp', 'Next follow-up'], ['lastActivity', 'Last activity'], ['added', 'Added'],
  ['deals', 'Deals'], ['location', 'Location'], ['source', 'Source'], ['linkedin', 'LinkedIn'],
];
export const DEFAULT_COLUMNS = ['name', 'company', 'title', 'email', 'type', 'status', 'tags', 'score', 'lastActivity', 'deals'];

// ---------- storage ----------
export async function updateMany(ids, fn) {
  const set = new Set(ids);
  const leads = await store.getLeads();
  const now = Date.now();
  let n = 0;
  for (const l of leads) if (set.has(l.id)) { const patch = fn(l); if (patch) { Object.assign(l, patch, { updatedAt: now }); n++; } }
  await chrome.storage.local.set({ leads });
  return n;
}
export async function addTask(leadId, { title, due = 0, todoistId = '' }) {
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  if (!lead) throw new Error('Contact not found');
  const now = Date.now();
  const t = { id: 'tk-' + store.uid(), title: String(title).trim(), due: Number(due) || 0, done: false, todoistId, createdAt: now, updatedAt: now };
  await store.updateLead(leadId, { tasks: [...(lead.tasks || []), t] });
  return t;
}
export async function patchTask(leadId, taskId, patch) {
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  if (!lead) return null;
  const now = Date.now();
  await store.updateLead(leadId, { tasks: (lead.tasks || []).map((t) => (t.id === taskId ? { ...t, ...patch, updatedAt: now } : t)) });
}
export async function mergeDuplicates(group) {
  const [keep, ...others] = group;
  const merged = mergeRecords(keep, others);
  const leads = (await store.getLeads()).filter((l) => !others.some((o) => o.id === l.id)).map((l) => (l.id === keep.id ? merged : l));
  await chrome.storage.local.set({ leads });
  // deals of the merged records now belong to the one we keep
  const { deals = [] } = await chrome.storage.local.get('deals');
  const ids = new Set(others.map((o) => o.id));
  let moved = 0;
  for (const d of deals) if (ids.has(d.leadId)) { d.leadId = keep.id; d.updatedAt = Date.now(); moved++; }
  if (moved) await chrome.storage.local.set({ deals });
  for (const o of others) await store.addTombstone(o.id);
  return merged;
}

// desktop reminder when a contact's task comes due (once per task, per browser)
export async function remindTasks(now = Date.now()) {
  const { taskReminded = {} } = await chrome.storage.local.get('taskReminded');
  let n = 0;
  for (const l of await store.getLeads()) {
    for (const t of crm2Open(l)) {
      if (!t.due || t.due > now || now - t.due > 2 * 864e5 || taskReminded[t.id]) continue;
      taskReminded[t.id] = now;
      const name = [l.firstName, l.lastName].filter(Boolean).join(' ');
      try { await chrome.notifications.create('task-' + t.id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: 'Task due: ' + t.title, message: `${name}${l.company ? ' · ' + l.company : ''}`, priority: 1 }); } catch { /* fine */ }
      n++;
    }
  }
  for (const [id, at] of Object.entries(taskReminded)) if (now - at > 30 * 864e5) delete taskReminded[id];
  await chrome.storage.local.set({ taskReminded });
  return n;
}
const crm2Open = (l) => (l.tasks || []).filter((t) => !t.done && !t.deleted);


// ---------- lead-finder notes ----------
// The lead finder used to write its own working notes ("Opening style: Direct; subject style: Industry | research…")
// into Notes. Split them: the style tags are dropped, short to-dos stay in Notes, the research goes to `research`.
const STYLE_RE = /opening style\s*:/i;
const KEEP_RE = /CASL|no verified email|find email/i;
export function splitAgentNotes(text, { all = false } = {}) {
  const keep = [], research = [];
  for (const line of String(text || '').split('\n')) {
    if (!all && !STYLE_RE.test(line)) { keep.push(line); continue; }
    for (let part of line.split(/\s+\|\s+/)) {
      part = part.replace(/opening style\s*:[^;|]*;?\s*(subject style\s*:[^;|.]*[;.]?)?/i, '').trim();
      if (!part) continue;
      (KEEP_RE.test(part) ? keep : research).push(part);
    }
  }
  return { notes: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), research: research.join(' ').trim() };
}
// one pass over existing contacts (safe to run on every laptop: only touches notes that still hold style tags)
export async function cleanAgentNotes() {
  const leads = await store.getLeads();
  const ids = leads.filter((l) => STYLE_RE.test(l.notes || '')).map((l) => l.id);
  if (!ids.length) return 0;
  await updateMany(ids, (l) => {
    const { notes, research } = splitAgentNotes(l.notes);
    return { notes, research: [l.research, research].filter(Boolean).join(' ') };
  });
  return ids.length;
}
