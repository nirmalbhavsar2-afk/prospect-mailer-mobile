// Outreach leads: rows prepared by Claude (or by you) with the job postings, the decision-maker,
// a written first email and 2–3 written follow-ups — split into two tracks:
//   Sourcer    — U.S./Canadian staffing agencies hiring recruiters/sourcers (contact type Prospect)
//   Full Cycle — direct employers with open roles (contact type FC-Prospect)
// The same columns work for a CSV file, a JSON file and the "Pitchbird Leads" Google Sheet.
import * as store from './store.js';

export const TRACKS = ['Sourcer', 'Full Cycle'];
export const TRACK_TYPE = { Sourcer: 'Prospect', 'Full Cycle': 'FC-Prospect' };

// Column order of the Google Sheet tabs and of the CSV files Claude writes.
export const HEADERS = [
  'Lead ID', 'Track', 'Batch Date',
  'Company', 'Company Website', 'Company Size', 'Industry',
  'Roles', 'Job URLs', 'Date Posted', 'Job Location', 'Openings', 'Fit Score', 'Fit Reason',
  'First Name', 'Last Name', 'Title', 'LinkedIn URL', 'Email', 'Location',
  'Subject', 'Email Body',
  'FU1 Days', 'FU1 Subject', 'FU1 Body', 'FU2 Days', 'FU2 Subject', 'FU2 Body', 'FU3 Days', 'FU3 Subject', 'FU3 Body',
  'Personalization', 'Pain Point', 'Offer Line', 'Notes',
  'Pitchbird Status', 'Sent At', 'Replied At', 'Updated',
];

export function normTrack(v, fallback = '') {
  const t = String(v || '').toLowerCase();
  if (/full|fc|employer|direct/.test(t)) return 'Full Cycle';
  if (/sourc|agency|staff/.test(t)) return 'Sourcer';
  return fallback ? normTrack(fallback) : '';
}
export const trackOf = (l) => l.track || (l.type === 'FC-Prospect' ? 'Full Cycle' : '');

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function picker(row) {
  const map = {};
  for (const [k, v] of Object.entries(row || {})) map[key(k)] = v;
  return (...names) => {
    for (const n of names) { const v = map[key(n)]; if (v !== undefined && v !== null && String(v).trim() !== '') return v; }
    return '';
  };
}
const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
const list = (v) => (Array.isArray(v) ? v.map(str) : str(v).split(/\s*(?:\||\n|;)\s*/)).filter(Boolean);
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };
// literal "\n" written into a CSV cell → real line break
const text = (v) => str(v).replace(/\r\n/g, '\n').replace(/\\n/g, '\n');

// One row (CSV, Sheet or JSON object) → a clean outreach lead, or null when it has no person.
export function normalizeRow(row, { track: tabTrack = '' } = {}) {
  const p = picker(row);
  const nested = row && typeof row === 'object' ? row : {};
  const full = str(p('Full Name', 'Name', 'Decision Maker'));
  const firstName = str(p('First Name', 'Firstname')) || full.split(' ')[0] || '';
  const lastName = str(p('Last Name', 'Lastname', 'Surname')) || full.split(' ').slice(1).join(' ');
  let liRaw = str(p('LinkedIn URL', 'LinkedIn', 'Linkedin Profile', 'Profile URL'));
  if (liRaw && !/^https?:\/\//i.test(liRaw) && /linkedin\.com\//i.test(liRaw)) liRaw = 'https://' + liRaw.replace(/^\/+/, '');
  const linkedinUrl = store.normalizeLinkedinUrl(liRaw) || '';
  const email = str(p('Email', 'Work Email', 'Email Address'));
  if (!firstName && !lastName && !linkedinUrl && !email) return null;
  const track = normTrack(p('Track', 'List', 'Campaign'), tabTrack) || normTrack(tabTrack) || 'Sourcer';

  // jobs: either a JSON "jobs" array, or "Roles" + "Job URLs" separated by " | "
  let jobs = [];
  if (Array.isArray(nested.jobs)) {
    jobs = nested.jobs.map((j) => ({ role: str(j.role || j.title), url: str(j.url || j.link), posted: str(j.posted || j.datePosted || j.date_posted), location: str(j.location), openings: num(j.openings) || 1 }));
  } else {
    const roles = list(p('Roles', 'Role', 'Job Title', 'Job Titles', 'Open Roles'));
    const urls = list(p('Job URLs', 'Job URL', 'Posting Link', 'Job Link', 'Posting URL'));
    const posted = list(p('Date Posted', 'Posted', 'Posted Date'));
    const locs = list(p('Job Location', 'Job Locations'));
    const n = Math.max(roles.length, urls.length);
    for (let i = 0; i < n; i++) jobs.push({ role: roles[i] || roles[0] || '', url: urls[i] || '', posted: posted[i] || posted[0] || '', location: locs[i] || locs[0] || '', openings: 1 });
    const total = num(p('Openings', 'Number of Openings', 'Open Roles Count'));
    if (jobs.length && total > jobs.length) jobs[0].openings += total - jobs.length;
  }
  jobs = jobs.filter((j) => j.role || j.url);

  const followUps = [];
  if (Array.isArray(nested.followUps)) {
    for (const f of nested.followUps) if (str(f.body)) followUps.push({ days: num(f.days) || 4, subject: str(f.subject), body: text(f.body) });
  } else {
    for (const i of [1, 2, 3]) {
      const body = text(p(`FU${i} Body`, `Follow Up ${i} Body`, `Follow-up ${i}`, `Followup ${i} Body`));
      if (body) followUps.push({ days: num(p(`FU${i} Days`, `Follow Up ${i} Days`)) || [3, 4, 7][i - 1], subject: str(p(`FU${i} Subject`, `Follow Up ${i} Subject`)), body });
    }
  }
  const subject = str(p('Subject', 'Custom Subject', 'Email Subject'));
  const body = text(nested.draft?.body || p('Email Body', 'Body', 'Draft', 'Email 1'));

  return {
    sheetId: str(p('Lead ID', 'ID', 'Row ID')),
    track,
    batch: str(p('Batch Date', 'Batch', 'Date Added')),
    firstName, lastName, linkedinUrl, email,
    title: str(p('Title', 'Job Title Of Contact', 'Position', 'Designation')),
    company: str(p('Company', 'Company Name', 'Account Name')),
    location: str(p('Location', 'Contact Location')),
    company_info: {
      website: str(p('Company Website', 'Website', 'Domain')),
      size: str(p('Company Size', 'Employees', 'Headcount')),
      industry: str(p('Industry')),
    },
    jobs,
    fit: num(p('Fit Score', 'Fit', 'Score')),
    fitWhy: str(p('Fit Reason', 'Why', 'Fit Notes')),
    vars: { personalization: text(p('Personalization')), pain_point: text(p('Pain Point')), offer_line: text(p('Offer Line')) },
    notes: text(p('Notes')),
    draft: body || subject ? { subject: nested.draft?.subject || subject, body, followUps } : null,
  };
}

// Turn a file's text (CSV or JSON) into rows.
export function parseFile(name, content, parseCsv) {
  const t = String(content || '').replace(/^﻿/, '').trim();
  if (/\.json$/i.test(name) || /^[[{]/.test(t)) {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.leads)) return j.leads;
    // { "Sourcer": [...], "Full Cycle": [...] }
    return Object.entries(j).flatMap(([k, v]) => (Array.isArray(v) ? v.map((r) => ({ Track: k, ...r })) : []));
  }
  return parseCsv(t).rows;
}
export function looksLikeOutreach(header) {
  const h = header.map(key);
  return h.includes('track') || h.includes('emailbody') || h.includes('fu1body') || h.includes('leadid');
}

// Save rows into Pitchbird. Existing people (same Lead ID, LinkedIn URL or email) are updated —
// a draft you already sent is never replaced.
export async function apply(rows, { source = 'import' } = {}) {
  const res = { added: 0, updated: 0, skipped: 0, drafts: 0, ids: [], sheetIds: [] };
  const leads = await store.getLeads();
  for (const raw of rows) {
    const r = raw && raw.track && raw.jobs ? raw : normalizeRow(raw);
    if (!r) { res.skipped++; continue; }
    const existing = (r.sheetId && leads.find((l) => l.sheetId === r.sheetId))
      || (r.linkedinUrl && leads.find((l) => l.linkedinUrl === r.linkedinUrl))
      || (r.email && leads.find((l) => l.email && l.email.toLowerCase() === r.email.toLowerCase()));
    if (existing && (existing.type === 'Do Not Contact' || existing.status === 'Not interested')) { res.skipped++; if (r.sheetId) res.sheetIds.push(r.sheetId); continue; }
    const now = Date.now();
    const jobs = mergeJobs(existing?.jobs, r.jobs);
    const keepDraft = existing?.draft && existing.draft.status === 'sent';
    const draft = r.draft && !keepDraft ? { ...r.draft, status: 'ready', at: now, batch: r.batch || '' } : existing?.draft;
    const patch = {
      id: existing?.id, firstName: r.firstName, lastName: r.lastName, title: r.title, company: r.company,
      linkedinUrl: r.linkedinUrl, email: existing?.email || r.email, location: r.location,
      track: r.track, sheetId: r.sheetId || existing?.sheetId || '', jobs, fit: r.fit || existing?.fit || 0, fitWhy: r.fitWhy || existing?.fitWhy || '',
      companyInfo: { ...(existing?.companyInfo || {}), ...Object.fromEntries(Object.entries(r.company_info).filter(([, v]) => v)) },
      vars: { ...(existing?.vars || {}), ...Object.fromEntries(Object.entries(r.vars).filter(([, v]) => v)) },
      draft, source: existing?.source || source, batch: r.batch || existing?.batch || '',
    };
    if (r.notes && !(existing?.notes || '').includes(r.notes)) patch.notes = [existing?.notes, r.notes].filter(Boolean).join('\n');
    const lead = await store.upsertLead(patch);
    // contact type follows the track, unless they are already a client / do-not-contact
    if (!['Client', 'Past Client', 'Do Not Contact'].includes(lead.type)) {
      const type = TRACK_TYPE[r.track];
      if (lead.type !== type) await store.updateLead(lead.id, { type, typeHistory: [...(lead.typeHistory || []), { from: lead.type || 'Prospect', type, at: now }] });
    }
    // keep our in-memory copy current for later rows in the same file
    const i = leads.findIndex((l) => l.id === lead.id);
    if (i >= 0) leads[i] = lead; else leads.unshift(lead);
    existing ? res.updated++ : res.added++;
    if (draft && draft.status === 'ready' && r.draft && !keepDraft) res.drafts++;
    res.ids.push(lead.id);
    if (r.sheetId) res.sheetIds.push(r.sheetId);
  }
  return res;
}
function mergeJobs(a = [], b = []) {
  const out = [...(a || [])];
  for (const j of b || []) if (!out.some((x) => (j.url && x.url === j.url) || (!j.url && x.role === j.role))) out.push(j);
  return out;
}

// ---------- the review queue ----------
export const daysOpen = (posted, now = Date.now()) => { const t = Date.parse(posted || ''); return t ? Math.max(0, Math.floor((now - t) / 864e5)) : null; };
export function queue(leads, track = '') {
  return leads
    .filter((l) => l.draft && l.draft.status === 'ready' && (!track || trackOf(l) === track))
    .sort((a, b) => (b.fit || 0) - (a.fit || 0) || (b.draft.at || 0) - (a.draft.at || 0));
}

// Where each sheet lead stands — written back to the "Pitchbird Status" column by the cloud script.
export function sheetStatus(l) {
  const sent = (l.emailsSent || []).filter((e) => !e.followUp);
  const fus = (l.emailsSent || []).filter((e) => e.followUp).length;
  let status = 'In Pitchbird';
  if (l.draft?.status === 'skipped') status = 'Skipped';
  if (sent.length || l.draft?.status === 'sent') status = fus ? `Sent + ${fus} follow-up${fus > 1 ? 's' : ''}` : 'Sent';
  if (l.status === 'Bounced') status = 'Bounced';
  if (l.repliedAt || ['Replied', 'Interested'].includes(l.status)) status = l.status === 'Interested' ? 'Interested' : 'Replied';
  if (l.status === 'Not interested') status = 'Not interested';
  if (l.type === 'Do Not Contact') status = 'Unsubscribed';
  return {
    id: l.sheetId, track: trackOf(l), status,
    sentAt: sent.length ? new Date(sent[0].date).toISOString() : '',
    repliedAt: l.repliedAt ? new Date(l.repliedAt).toISOString() : '',
    email: l.email || '',
  };
}

// A file you picked (CSV or JSON) — same columns as the sheet.
export async function importText(name, content, parseCsv) {
  const rows = parseFile(name, content, parseCsv).map((o) => normalizeRow(o, { track: o.Track || o.track || name })).filter(Boolean);
  if (!rows.length) throw new Error('No leads found in that file — it needs at least a name, LinkedIn URL or email per row.');
  return apply(rows, { source: 'import' });
}
