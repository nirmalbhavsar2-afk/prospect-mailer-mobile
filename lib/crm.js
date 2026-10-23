// CRM: contact types, deals in a pipeline, logged activities, and dashboard metrics.
import * as store from './store.js';

export const CONTACT_TYPES = ['Prospect', 'Client', 'Past Client', 'Do Not Contact'];
export const DEFAULT_STAGES = [
  { id: 'prospect', name: 'Prospect' },
  { id: 'trial', name: 'Trial' },
  { id: 'proposal', name: 'Proposal' },
  { id: 'won', name: 'Won', won: true },
];
export const CURRENCIES = ['USD', 'INR', 'GBP', 'EUR', 'AUD', 'CAD', 'AED', 'SGD'];
export const ACTIVITY_KINDS = { call: 'Call', meeting: 'Meeting', linkedin: 'LinkedIn message', note: 'Note' };

export const contactType = (l) => l.type || 'Prospect';

// ---------- stages ----------
export function stagesOf(s) {
  const st = Array.isArray(s.pipelineStages) && s.pipelineStages.length ? s.pipelineStages : DEFAULT_STAGES;
  // exactly one Won stage, always last
  const won = st.find((x) => x.won) || { id: 'won', name: 'Won', won: true };
  return [...st.filter((x) => !x.won), won];
}
export async function getStages() {
  return stagesOf(await store.getSettings());
}
export async function saveStages(stages) {
  return store.saveSettings({ pipelineStages: stagesOf({ pipelineStages: stages }) });
}

// ---------- deals ----------
export async function getDeals() {
  const { deals } = await chrome.storage.local.get('deals');
  return Array.isArray(deals) ? deals : [];
}
async function putDeals(deals) {
  await chrome.storage.local.set({ deals });
}

// Create or update. Moving into the Won stage marks it won (and the contact becomes a Client).
export async function saveDeal(d) {
  const deals = await getDeals();
  const stages = await getStages();
  const wonStage = stages[stages.length - 1];
  const now = Date.now();
  let deal = d.id && deals.find((x) => x.id === d.id);
  const prev = deal ? { ...deal } : null;
  if (!deal) {
    deal = {
      id: 'deal-' + store.uid(), title: '', company: '', leadId: '', amount: 0, billing: 'one-time',
      stageId: stages[0].id, status: 'open', expectedClose: '', wonAt: 0, lostAt: 0, lostReason: '',
      endedAt: 0, notes: '', history: [], createdAt: now,
    };
    deals.unshift(deal);
  }
  Object.assign(deal, d, { amount: Math.max(0, Number(d.amount ?? deal.amount) || 0), updatedAt: now });
  // dragged out of Won (or Lost) back into an open stage → it's open again
  if (prev && prev.status !== 'open' && !d.status && d.stageId && d.stageId !== wonStage.id) deal.status = 'open';
  if (deal.stageId === wonStage.id && deal.status === 'open') deal.status = 'won';
  if (deal.status === 'won' && deal.stageId !== wonStage.id && (!prev || prev.status !== 'won')) deal.stageId = wonStage.id;
  if (deal.status === 'won' && !deal.wonAt) deal.wonAt = now;
  if (deal.status === 'lost' && !deal.lostAt) deal.lostAt = now;
  if (deal.status === 'open') { deal.wonAt = 0; deal.lostAt = 0; }
  if (!prev || prev.stageId !== deal.stageId || prev.status !== deal.status) {
    deal.history = [...(deal.history || []), { at: now, stageId: deal.stageId, status: deal.status }];
  }
  await putDeals(deals);
  if (deal.leadId && deal.status === 'won' && (!prev || prev.status !== 'won')) {
    const lead = (await store.getLeads()).find((l) => l.id === deal.leadId);
    if (lead && contactType(lead) !== 'Client') await setContactType(lead.id, 'Client');
  }
  return deal;
}
export async function deleteDeal(id) {
  await putDeals((await getDeals()).filter((d) => d.id !== id));
  await store.addTombstone(id);
}

// ---------- contacts ----------
export async function setContactType(leadId, type) {
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  if (!lead) throw new Error('Contact not found');
  if (contactType(lead) === type && lead.type) return lead;
  const typeHistory = [...(lead.typeHistory || []), { from: contactType(lead), type, at: Date.now() }];
  return store.updateLead(leadId, { type, typeHistory });
}

export async function addActivity(leadId, { kind, text, at }) {
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  if (!lead) throw new Error('Contact not found');
  const act = { id: 'act-' + store.uid(), kind: kind || 'note', text: text || '', at: at || Date.now() };
  return store.updateLead(leadId, { activities: [...(lead.activities || []), act] });
}
export async function deleteActivity(leadId, actId) {
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  if (!lead) return null;
  await store.addTombstone(actId);
  return store.updateLead(leadId, { activities: (lead.activities || []).filter((a) => a.id !== actId) });
}

// Everything that happened with a contact, newest first.
export function timeline(lead, deals, stages) {
  const name = (id) => stages.find((s) => s.id === id)?.name || id;
  const items = [];
  for (const e of lead.emailsSent || []) items.push({ at: e.date, kind: 'email', text: (e.followUp ? 'Follow-up: ' : 'Email: ') + e.subject, sub: e.from ? 'from ' + e.from : '' });
  for (const a of lead.activities || []) items.push({ at: a.at, kind: a.kind, text: a.text, id: a.id, sub: ACTIVITY_KINDS[a.kind] || a.kind });
  for (const t of lead.typeHistory || []) items.push({ at: t.at, kind: 'type', text: `Type: ${t.from || '—'} → ${t.type}` });
  if (lead.repliedAt) items.push({ at: lead.repliedAt, kind: 'reply', text: 'Replied to your email' });
  for (const d of deals.filter((x) => x.leadId === lead.id)) {
    for (const h of d.history || []) {
      items.push({ at: h.at, kind: 'deal', text: `Deal “${d.title}”: ${h.status === 'lost' ? 'Lost' : h.status === 'won' ? 'Won' : name(h.stageId)}` });
    }
  }
  return items.filter((i) => i.at).sort((a, b) => b.at - a.at);
}

// ---------- metrics ----------
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfMonth = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const startOfYear = (t) => new Date(new Date(t).getFullYear(), 0, 1).getTime();
const addMonths = (t, n) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); };

// Revenue a deal brings in during [from, to): one-time = amount when won; monthly = amount per active month.
export function dealRevenue(d, from, to) {
  if (d.status !== 'won' || !d.wonAt) return 0;
  if (d.billing !== 'monthly') return d.wonAt >= from && d.wonAt < to ? d.amount : 0;
  let total = 0;
  for (let m = startOfMonth(d.wonAt); m < to; m = addMonths(m, 1)) {
    const mEnd = addMonths(m, 1);
    if (mEnd <= from) continue;
    if (d.endedAt && d.endedAt < m) break;
    total += d.amount;
  }
  return total;
}

export function metrics({ leads, deals, stages, now = Date.now() }) {
  const today = startOfDay(now), month = startOfMonth(now), year = startOfYear(now);
  const week = today - ((new Date(now).getDay() + 6) % 7) * 864e5; // Monday
  const in_ = (t, from, to = Infinity) => t && t >= from && t < to;
  const byType = Object.fromEntries(CONTACT_TYPES.map((t) => [t, 0]));
  for (const l of leads) byType[contactType(l)] = (byType[contactType(l)] || 0) + 1;

  const won = deals.filter((d) => d.status === 'won');
  const lost = deals.filter((d) => d.status === 'lost');
  const open = deals.filter((d) => d.status === 'open');

  const churn = (from, to = Infinity) => leads.filter((l) => (l.typeHistory || []).some((h) => h.type === 'Past Client' && h.from === 'Client' && in_(h.at, from, to))).length;

  const sent = leads.flatMap((l) => (l.emailsSent || []).map((e) => ({ ...e, leadId: l.id })));
  const contacted30 = leads.filter((l) => (l.emailsSent || []).some((e) => in_(e.date, now - 30 * 864e5)));
  const replied30 = contacted30.filter((l) => l.repliedAt || ['Replied', 'Interested', 'Placed'].includes(l.status));

  const closed = [...won, ...lost].filter((d) => in_(d.wonAt || d.lostAt, year));
  const wonYear = won.filter((d) => in_(d.wonAt, year));
  const daysToWin = wonYear.map((d) => (d.wonAt - d.createdAt) / 864e5).filter((x) => x >= 0);

  const revenueByMonth = [];
  for (let i = 11; i >= 0; i--) {
    const from = addMonths(month, -i), to = addMonths(from, 1);
    revenueByMonth.push({ label: new Date(from).toLocaleDateString(undefined, { month: 'short' }), from, value: deals.reduce((s, d) => s + dealRevenue(d, from, to), 0) });
  }
  const emailsByDay = [];
  for (let i = 29; i >= 0; i--) {
    const from = today - i * 864e5, to = from + 864e5;
    emailsByDay.push({ label: new Date(from).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: sent.filter((e) => in_(e.date, from, to)).length });
  }
  const byStage = stages.filter((s) => !s.won).map((s) => {
    const ds = open.filter((d) => d.stageId === s.id);
    return { id: s.id, label: s.name, count: ds.length, value: ds.reduce((a, d) => a + d.amount, 0) };
  });

  const fus = leads.flatMap((l) => (l.followUps || []).map((f) => ({ ...f, lead: l })));
  const dueFollowUps = fus.filter((f) => f.status === 'due' || (f.status === 'scheduled' && f.due <= now));

  const stale = open.filter((d) => now - (d.updatedAt || d.createdAt) > 14 * 864e5);
  const leadDeal = new Set(open.map((d) => d.leadId));
  const repliedNoDeal = leads.filter((l) => contactType(l) === 'Prospect' && (l.repliedAt || l.status === 'Replied' || l.status === 'Interested') && !leadDeal.has(l.id));
  const overdueClose = open.filter((d) => d.expectedClose && new Date(d.expectedClose).getTime() + 864e5 < now);

  return {
    totalContacts: leads.length,
    newContactsMonth: leads.filter((l) => in_(l.createdAt, month)).length,
    byType,
    revenueMonth: deals.reduce((s, d) => s + dealRevenue(d, month, addMonths(month, 1)), 0),
    revenueYear: deals.reduce((s, d) => s + dealRevenue(d, year, now + 1), 0),
    mrr: won.filter((d) => d.billing === 'monthly' && !d.endedAt).reduce((s, d) => s + d.amount, 0),
    openValue: open.reduce((s, d) => s + d.amount, 0),
    openCount: open.length,
    clientsLostMonth: churn(month),
    clientsLostYear: churn(year),
    dealsLostMonth: lost.filter((d) => in_(d.lostAt, month)).length,
    dealsLostYear: lost.filter((d) => in_(d.lostAt, year)).length,
    dealsWonMonth: won.filter((d) => in_(d.wonAt, month)).length,
    dealsWonYear: wonYear.length,
    winRate: closed.length ? Math.round((closed.filter((d) => d.status === 'won').length / closed.length) * 100) : null,
    avgDeal: wonYear.length ? Math.round(wonYear.reduce((s, d) => s + d.amount, 0) / wonYear.length) : 0,
    avgDaysToWin: daysToWin.length ? Math.round(daysToWin.reduce((a, b) => a + b, 0) / daysToWin.length) : null,
    emailsToday: sent.filter((e) => in_(e.date, today)).length,
    emailsWeek: sent.filter((e) => in_(e.date, week)).length,
    emailsMonth: sent.filter((e) => in_(e.date, month)).length,
    replyRate30: contacted30.length ? Math.round((replied30.length / contacted30.length) * 100) : null,
    contacted30: contacted30.length,
    replied30: replied30.length,
    activitiesWeek: leads.reduce((n, l) => n + (l.activities || []).filter((a) => in_(a.at, week)).length, 0),
    followUpsDue: dueFollowUps.length,
    followUpsScheduled: fus.filter((f) => f.status === 'scheduled' && f.due > now).length,
    revenueByMonth, emailsByDay, byStage,
    attention: { stale, repliedNoDeal, overdueClose, dueFollowUps },
  };
}

export function money(n, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n || 0);
  } catch {
    return `${currency} ${Math.round(n || 0).toLocaleString()}`;
  }
}

// ---------- CSV import (Bigin exports or any spreadsheet) ----------
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((x) => x.trim()));
  const header = (clean.shift() || []).map((h) => h.trim());
  return { header, rows: clean.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()]))) };
}

const pick = (row, ...names) => {
  for (const n of names) {
    const k = Object.keys(row).find((h) => h.toLowerCase().replace(/[^a-z]/g, '') === n.toLowerCase().replace(/[^a-z]/g, ''));
    if (k && row[k]) return row[k];
  }
  return '';
};

export function csvKind(header) {
  const h = header.map((x) => x.toLowerCase());
  if (h.some((x) => /deal name|amount|stage/.test(x)) && !h.some((x) => /^first name$/.test(x))) return 'deals';
  return 'contacts';
}

export async function importContacts(rows) {
  let added = 0, merged = 0;
  for (const r of rows) {
    const full = pick(r, 'Full Name', 'Contact Name', 'Name');
    const first = pick(r, 'First Name', 'Firstname') || full.split(' ')[0] || '';
    const last = pick(r, 'Last Name', 'Lastname', 'Surname') || full.split(' ').slice(1).join(' ');
    const email = pick(r, 'Email', 'Email Address', 'Work Email', 'Primary Email');
    const linkedin = pick(r, 'LinkedIn', 'LinkedIn URL', 'LinkedIn Profile', 'Linkedin Url');
    if (!first && !last && !email) continue;
    const before = await store.findLead({ linkedinUrl: linkedin, email });
    const typeRaw = pick(r, 'Type', 'Contact Type', 'Category');
    const type = CONTACT_TYPES.find((t) => t.toLowerCase() === typeRaw.toLowerCase());
    const lead = await store.upsertLead({
      firstName: first, lastName: last, email,
      title: pick(r, 'Title', 'Job Title', 'Designation'),
      company: pick(r, 'Account Name', 'Company Name', 'Company', 'Organization'),
      phone: pick(r, 'Mobile', 'Phone', 'Mobile Phone', 'Work Phone'),
      location: [pick(r, 'Mailing City', 'City'), pick(r, 'Mailing Country', 'Country')].filter(Boolean).join(', '),
      linkedinUrl: linkedin,
      notes: pick(r, 'Description', 'Notes'),
      source: 'import',
    });
    if (type && type !== contactType(lead)) await setContactType(lead.id, type);
    before ? merged++ : added++;
  }
  return { added, merged };
}

export async function importDeals(rows) {
  const stages = await getStages();
  const leads = await store.getLeads();
  let added = 0;
  for (const r of rows) {
    const title = pick(r, 'Deal Name', 'Name', 'Title');
    if (!title) continue;
    const stageRaw = pick(r, 'Stage', 'Sub-Pipeline Stage');
    const isWon = /won/i.test(stageRaw), isLost = /lost/i.test(stageRaw);
    const stage = stages.find((s) => s.name.toLowerCase() === stageRaw.toLowerCase());
    const contactName = pick(r, 'Contact Name', 'Contact').toLowerCase();
    const company = pick(r, 'Account Name', 'Company Name', 'Company');
    const lead = leads.find((l) => contactName && [l.firstName, l.lastName].filter(Boolean).join(' ').toLowerCase() === contactName)
      || leads.find((l) => company && l.company && l.company.toLowerCase() === company.toLowerCase());
    const close = pick(r, 'Closing Date', 'Close Date', 'Expected Close');
    const closeT = close ? new Date(close).getTime() : 0;
    await saveDeal({
      title, company: company || lead?.company || '', leadId: lead?.id || '',
      amount: Number(String(pick(r, 'Amount', 'Value', 'Deal Value')).replace(/[^0-9.]/g, '')) || 0,
      stageId: isWon ? stages[stages.length - 1].id : (stage || stages[0]).id,
      status: isWon ? 'won' : isLost ? 'lost' : 'open',
      wonAt: isWon && closeT ? closeT : 0, lostAt: isLost && closeT ? closeT : 0,
      expectedClose: !isWon && !isLost && closeT ? new Date(closeT).toISOString().slice(0, 10) : '',
      notes: pick(r, 'Description', 'Notes'),
    });
    added++;
  }
  return { added };
}
