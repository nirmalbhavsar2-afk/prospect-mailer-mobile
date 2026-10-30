// Local storage for settings, templates and leads (chrome.storage.local).
// Every change is timestamped so two laptops can be merged safely (see sync.js).

export const DEFAULT_SETTINGS = {
  salesqlKey: '',
  googleClientId: '',
  gmailAccounts: [], // [{ email, name, signature }]
  defaultSender: '',
  senderName: '',
  signature: '',
  saveLeadOnSend: true,
  biginRegion: 'com',
  biginClientId: '',
  biginClientSecret: '',
  biginRefreshToken: '',
  biginApiDomain: '',
  biginAutoSave: false,
  biginLogNotes: true,
  followUpMode: 'remind', // 'none' | 'remind' | 'auto'
  followUpDays: 3,
  followUpTemplateId: 'seed-followup',
  followUpBusinessDays: true,
  trackingEnabled: true,
  idleMinutes: 2,
  workStart: '09:00',
  workEnd: '19:00',
  reportEnabled: true,
  reportTime: '20:00',
  reportTo: '',
  reportWeekends: false,
  reportWeekly: true,
  reportWeekday: 6,
  reminders: null, // null → default 4:00 PM weekday check-in
  anthropicKey: '',
  aiModel: 'claude-sonnet-5-5',
  // AI email writer
  aiPitch: '',   // what you offer, in your words
  aiTone: 'friendly',
  aiLength: 'short',
  aiExample: '', // an email you like, used for style only
  siteCategories: {},
  cloudUrl: '',
  cloudSecret: '',
  cloudAccount: '',
  todoistToken: '',
  todoistInReport: true,
  todoistView: 'inbox-today', // which Todoist board the dashboard, top 3 and daily summary use
  cloudSenders: {}, // other Gmail accounts' own cloud scripts for follow-ups: { email: { url, secret } }
  currency: 'USD',
  pipelineStages: null, // null → default Prospect → Trial → Proposal → Won
};

export const LEAD_STATUSES = ['New', 'Contacted', 'Replied', 'Interested', 'Not interested', 'Placed', 'Bounced'];

const SEED_TEMPLATES = [
  {
    id: 'seed-intro',
    name: 'Candidate intro',
    subject: 'Opportunity for a {{title}} — quick chat?',
    body:
`Hi {{first_name}},

I came across your profile and was impressed by your work as {{title}} at {{company}}.

I'm hiring for a role that looks like a strong match for your background. Would you be open to a 15-minute call this week to hear more?

Best regards,
{{my_name}}`,
  },
  {
    id: 'seed-followup',
    name: 'Follow-up',
    subject: 'Re: Opportunity for a {{title}}',
    body:
`Hi {{first_name}},

Just following up on my earlier note. I'd love to share details of the role — happy to work around your schedule.

Would a short call on Thursday or Friday work?

Thanks,
{{my_name}}`,
  },
  {
    id: 'seed-rpo',
    name: 'Client outreach (RPO)',
    subject: 'Sourcing support for {{company}}',
    body:
`Hi {{first_name}},

I lead a sourcing team that supports staffing agencies and in-house recruiters with pre-screened, ready-to-contact candidate shortlists.

If {{company}} has hard-to-fill roles this quarter, I'd be glad to send a free sample shortlist for one of them.

Open to a quick call?

Regards,
{{my_name}}`,
  },
];

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- settings ----------
export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // v1 → v2: a single connected Gmail becomes the first sender account
  if (s.gmailEmail && !s.gmailAccounts.length) {
    s.gmailAccounts = [{ email: s.gmailEmail, name: '', signature: '' }];
    s.defaultSender = s.gmailEmail;
  }
  delete s.gmailEmail;
  if (s.gmailAccounts.length && !s.gmailAccounts.some((a) => a.email === s.defaultSender)) {
    s.defaultSender = s.gmailAccounts[0].email;
  }
  return s;
}
export async function saveSettings(patch) {
  const { settingsMeta } = await chrome.storage.local.get('settingsMeta');
  const cur = await getSettings();
  const meta = { ...(settingsMeta || {}) };
  const now = Date.now();
  for (const [k, v] of Object.entries(patch)) {
    if (!same(cur[k], v)) meta[k] = now;
  }
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next, settingsMeta: meta });
  return next;
}

// Display name / signature for a sender, falling back to the defaults.
// Put the signature in: replaces any {{signature}} tag, and adds it at the end only if it isn't in the text already.
export function withSignature(text, sig) {
  const s = (sig || '').trim();
  const t = (text || '').replace(/\{\{\s*signature\s*\}\}/gi, s).replace(/\s+$/, '');
  if (!s || t.includes(s)) return t;
  return t + (/[,，]$/.test(t) ? '\n' : '\n\n') + s; // "Best regards," sits right above the signature
}
export function senderProfile(s, email) {
  const acc = s.gmailAccounts.find((a) => a.email === email) || {};
  return {
    email: acc.email || '',
    name: acc.name || s.senderName || '',
    signature: acc.signature !== undefined && acc.signature !== '' ? acc.signature : s.signature || '',
  };
}

// ---------- tombstones (remember deletions so sync doesn't bring them back) ----------
export async function addTombstone(id) {
  const { tombstones } = await chrome.storage.local.get('tombstones');
  await chrome.storage.local.set({ tombstones: { ...(tombstones || {}), [id]: Date.now() } });
}

// ---------- templates ----------
export async function getTemplates() {
  let { templates } = await chrome.storage.local.get('templates');
  if (!Array.isArray(templates)) {
    templates = SEED_TEMPLATES.map((t) => ({ ...t, updatedAt: 0 }));
    await chrome.storage.local.set({ templates });
  }
  return templates;
}
export async function saveTemplate(t) {
  const templates = await getTemplates();
  const now = Date.now();
  if (t.id) {
    const i = templates.findIndex((x) => x.id === t.id);
    if (i >= 0) templates[i] = { ...templates[i], ...t, updatedAt: now };
    else templates.push({ ...t, updatedAt: now });
  } else {
    t = { ...t, id: uid(), updatedAt: now };
    templates.push(t);
  }
  await chrome.storage.local.set({ templates });
  return templates.find((x) => x.id === t.id);
}
export async function deleteTemplate(id) {
  const templates = (await getTemplates()).filter((t) => t.id !== id);
  await chrome.storage.local.set({ templates });
  await addTombstone(id);
}

// ---------- leads ----------
export function normalizeLinkedinUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/in\/([^/?#]+)/i);
    if (!m) return '';
    return 'https://www.linkedin.com/in/' + decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return '';
  }
}

export async function getLeads() {
  const { leads } = await chrome.storage.local.get('leads');
  return Array.isArray(leads) ? leads : [];
}
async function putLeads(leads) {
  await chrome.storage.local.set({ leads });
}
export async function findLead({ linkedinUrl, email }) {
  const leads = await getLeads();
  const url = normalizeLinkedinUrl(linkedinUrl);
  return (
    (url && leads.find((l) => l.linkedinUrl === url)) ||
    (email && leads.find((l) => l.email && l.email.toLowerCase() === email.toLowerCase())) ||
    null
  );
}
// Create or merge a lead. Non-empty incoming fields overwrite stored ones.
export async function upsertLead(data) {
  const leads = await getLeads();
  const url = normalizeLinkedinUrl(data.linkedinUrl);
  let lead =
    (data.id && leads.find((l) => l.id === data.id)) ||
    (url && leads.find((l) => l.linkedinUrl === url)) ||
    (data.email && leads.find((l) => l.email && l.email.toLowerCase() === data.email.toLowerCase()));
  const now = Date.now();
  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && v !== null && v !== '' && k !== 'emailsSent') clean[k] = v;
  }
  if (url) clean.linkedinUrl = url;
  if (lead) {
    Object.assign(lead, clean, { updatedAt: now });
  } else {
    lead = {
      id: uid(),
      firstName: '', lastName: '', title: '', company: '', email: '', phone: '',
      location: '', linkedinUrl: url, status: 'New', notes: '', biginId: '',
      emailsSent: [], createdAt: now, ...clean, updatedAt: now,
    };
    leads.unshift(lead);
  }
  if (data.emailsSent) lead.emailsSent = [...(lead.emailsSent || []), ...data.emailsSent];
  await putLeads(leads);
  return lead;
}
export async function updateLead(id, patch) {
  const leads = await getLeads();
  const lead = leads.find((l) => l.id === id);
  if (!lead) throw new Error('Lead not found');
  Object.assign(lead, patch, { updatedAt: Date.now() });
  await putLeads(leads);
  return lead;
}
export async function deleteLead(id) {
  await putLeads((await getLeads()).filter((l) => l.id !== id));
  await addTombstone(id);
}

// ---------- whole-store snapshot (backup file + Drive sync) ----------
export const SYNC_KEYS = ['settings', 'settingsMeta', 'templates', 'leads', 'deals', 'tombstones', 'activity', 'dailyReports', 'daySummaries', 'periodReports'];

export async function snapshot() {
  const data = await chrome.storage.local.get(SYNC_KEYS);
  return {
    app: 'prospect-mailer',
    version: 2,
    exportedAt: Date.now(),
    settings: await getSettings(),
    settingsMeta: data.settingsMeta || {},
    templates: await getTemplates(),
    leads: data.leads || [],
    deals: data.deals || [],
    tombstones: data.tombstones || {},
    activity: data.activity || {},
    dailyReports: data.dailyReports || {},
    daySummaries: data.daySummaries || {},
    periodReports: data.periodReports || {},
  };
}
// Writes only the parts that actually changed, so open pages don't refresh for nothing.
export async function applySnapshot(snap) {
  const cur = await chrome.storage.local.get(SYNC_KEYS);
  // the tracker may have written a newer minute while sync was talking to Drive — keep the newest device-day
  if (snap.activity && cur.activity) {
    const merged = JSON.parse(JSON.stringify(snap.activity));
    for (const [dev, days] of Object.entries(cur.activity)) {
      const m = merged[dev] || (merged[dev] = {});
      for (const [d, agg] of Object.entries(days)) if (!m[d] || (agg.updatedAt || 0) > (m[d].updatedAt || 0)) m[d] = agg;
    }
    snap = { ...snap, activity: merged };
  }
  const patch = {};
  for (const k of SYNC_KEYS) if (snap[k] !== undefined && !same(cur[k], snap[k])) patch[k] = snap[k];
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return Object.keys(patch);
}
