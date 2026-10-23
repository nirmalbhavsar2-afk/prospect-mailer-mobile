// Weekly & monthly productivity. Every day is boiled down to a small summary that is kept
// permanently (and synced), so long-range reports work after the minute-by-minute data expires.
import * as store from './store.js';
import * as tracker from './tracker.js';
import * as report from './report.js';
import * as gmail from './gmail.js';

const fmt = report.fmtMin;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// noon, so formatting a date in any time zone lands on the same calendar day
const parse = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const key = (d) => tracker.dayKey(d.getTime());

// ---------- day summaries ----------
export async function getSummaries() {
  const { daySummaries } = await chrome.storage.local.get('daySummaries');
  return daySummaries || {};
}

export async function summarizeDay(date) {
  const d = await report.buildDayData(date);
  const t = d.time, w = d.work;
  const rep = (await report.getReports())[date];
  const { checkins = {} } = await chrome.storage.local.get('checkins');
  const ch = checkins[date] || [];
  return {
    date, updatedAt: Date.now(),
    productive: t.productive, neutral: t.neutral, distracting: t.distracting, otherApps: t.otherApps,
    idle: t.idle, locked: t.locked, offWork: t.workWindow.off, workMinutes: t.workWindow.minutes,
    active: t.active, focusPct: t.focusPct, longestFocus: t.longestFocus.len,
    first: t.firstActive, last: t.lastActive,
    cats: Object.fromEntries(t.cats.map((c) => [c.cat, c.minutes])),
    sites: t.sites.slice(0, 12).map((s) => [s.host, s.cat, s.minutes]),
    work: {
      emailsSent: w.emailsSent, followUpsSent: w.followUpsSent, repliesReceived: w.repliesReceived,
      contactsAdded: w.contactsAdded, linkedinProfilesViewed: w.linkedinProfilesViewed, calls: w.calls,
      meetings: w.meetings, linkedinMessages: w.linkedinMessages, dealsCreated: w.dealsCreated,
      dealsMoved: w.dealsMoved, dealsWon: w.dealsWon.length, wonAmount: w.dealsWon.reduce((a, x) => a + (x.amount || 0), 0),
    },
    score: rep?.ai?.score ?? null,
    checkins: { yes: ch.filter((c) => c.answer === 'yes').length, snoozed: ch.filter((c) => c.answer === 'snooze').length, shown: ch.filter((c) => c.answer === 'shown').length },
  };
}

// Refresh summaries for every day that still has detailed data (call daily / on startup / before viewing).
export async function ensureSummaries({ force = false } = {}) {
  const { activity = {} } = await chrome.storage.local.get('activity');
  const dates = new Map();
  for (const dev of Object.values(activity)) for (const [d, agg] of Object.entries(dev)) dates.set(d, Math.max(dates.get(d) || 0, agg.updatedAt || 0));
  const all = await getSummaries();
  let changed = false;
  for (const [date, upd] of dates) {
    if (!force && all[date] && all[date].updatedAt >= upd && date !== tracker.dayKey(Date.now())) continue;
    all[date] = await summarizeDay(date);
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ daySummaries: all });
  return all;
}

// ---------- periods ----------
export function periodRange(kind, anchor) {
  const a = parse(anchor);
  let start, end;
  if (kind === 'week') {
    start = new Date(a); start.setDate(a.getDate() - ((a.getDay() + 6) % 7)); // Monday
    end = new Date(start); end.setDate(start.getDate() + 7);
  } else {
    start = new Date(a.getFullYear(), a.getMonth(), 1);
    end = new Date(a.getFullYear(), a.getMonth() + 1, 1);
  }
  const days = [];
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) days.push(key(d));
  const label = kind === 'week'
    ? `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${new Date(end - 864e5).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return { kind, start: key(start), end: key(end), days, label, id: `${kind}:${key(start)}` };
}
export function shiftPeriod(kind, anchor, dir) {
  const a = parse(anchor);
  if (kind === 'week') a.setDate(a.getDate() + 7 * dir); else a.setMonth(a.getMonth() + dir, 1);
  return key(a);
}

const WORK_KEYS = ['emailsSent', 'followUpsSent', 'repliesReceived', 'contactsAdded', 'linkedinProfilesViewed', 'calls', 'meetings', 'linkedinMessages', 'dealsCreated', 'dealsMoved', 'dealsWon', 'wonAmount'];
const TIME_KEYS = ['productive', 'neutral', 'distracting', 'otherApps', 'idle', 'locked', 'offWork', 'active'];

export function aggregate(range, summaries) {
  const today = tracker.dayKey(Date.now());
  const rows = range.days.map((d) => summaries[d] || { date: d, empty: true, future: d > today });
  const tracked = rows.filter((r) => !r.empty && r.active > 0);
  const tot = Object.fromEntries([...TIME_KEYS].map((k) => [k, tracked.reduce((a, r) => a + (r[k] || 0), 0)]));
  const work = Object.fromEntries(WORK_KEYS.map((k) => [k, tracked.reduce((a, r) => a + (r.work?.[k] || 0), 0)]));
  const cats = {}, sites = {};
  for (const r of tracked) {
    for (const [c, m] of Object.entries(r.cats || {})) cats[c] = (cats[c] || 0) + m;
    for (const [h, c, m] of r.sites || []) { const s = sites[h] || (sites[h] = { host: h, cat: c, minutes: 0 }); s.minutes += m; }
  }
  const scores = tracked.map((r) => r.score).filter((x) => x !== null && x !== undefined);
  const best = tracked.slice().sort((a, b) => b.productive - a.productive)[0];
  const worst = tracked.slice().sort((a, b) => a.productive - b.productive)[0];
  const n = tracked.length || 1;
  return {
    range, rows, daysTracked: tracked.length,
    totals: tot, work,
    avg: { productive: Math.round(tot.productive / n), distracting: Math.round(tot.distracting / n), idle: Math.round(tot.idle / n), otherApps: Math.round(tot.otherApps / n), offWork: Math.round(tot.offWork / n) },
    focusPct: tot.active ? Math.round((tot.productive / tot.active) * 100) : 0,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    cats: Object.entries(cats).map(([cat, minutes]) => ({ cat, minutes, kind: tracker.kindOfCat(cat) })).sort((a, b) => b.minutes - a.minutes),
    sites: Object.values(sites).map((s) => ({ ...s, kind: tracker.kindOfCat(s.cat) })).sort((a, b) => b.minutes - a.minutes),
    best: best ? { date: best.date, productive: best.productive } : null,
    worst: worst && tracked.length > 1 ? { date: worst.date, productive: worst.productive } : null,
    checkins: tracked.reduce((a, r) => ({ yes: a.yes + (r.checkins?.yes || 0), snoozed: a.snoozed + (r.checkins?.snoozed || 0) }), { yes: 0, snoozed: 0 }),
  };
}

export async function buildPeriod(kind, anchor) {
  const summaries = await ensureSummaries();
  const range = periodRange(kind, anchor);
  const cur = aggregate(range, summaries);
  const prevRange = periodRange(kind, shiftPeriod(kind, anchor, -1));
  const prev = aggregate(prevRange, summaries);
  return { ...cur, prev: { label: prevRange.label, totals: prev.totals, work: prev.work, daysTracked: prev.daysTracked, avg: prev.avg, focusPct: prev.focusPct } };
}

// ---------- AI ----------
export function periodPrompt(p, owner) {
  const payload = {
    period: `${p.range.kind} ${p.range.label}`, days_tracked: p.daysTracked,
    minutes_total: p.totals, minutes_avg_per_tracked_day: p.avg, focus_pct: p.focusPct, avg_daily_score: p.avgScore,
    by_category_minutes: Object.fromEntries(p.cats.slice(0, 12).map((c) => [c.cat, c.minutes])),
    top_sites_minutes: p.sites.slice(0, 12).map((x) => `${x.host} (${x.cat}): ${x.minutes}`),
    per_day: p.rows.filter((r) => !r.empty).map((r) => ({ date: r.date, productive: r.productive, off_focus: r.distracting, idle: r.idle, other_apps: r.otherApps, emails: r.work?.emailsSent, follow_ups: r.work?.followUpsSent, score: r.score })),
    crm_work: p.work, marketing_checkins: p.checkins,
    previous_period: p.prev,
  };
  const system = `You are a sharp, encouraging productivity coach for ${owner || 'a founder'} who runs a recruitment/RPO and KPO business focused on client development (LinkedIn + email outreach, follow-ups, calls, proposals, marketing). You get a ${p.range.kind} of tracked activity. "Idle" = no keyboard/mouse (away or on the phone). Compare with the previous period per tracked day. Use real numbers. Reply with JSON only.`;
  const user = `${JSON.stringify(payload)}\n\nReturn exactly: {"score": <0-100>, "headline": "<max 12 words>", "summary": "<4-6 sentences: overall productivity, trend vs previous ${p.range.kind}, best/worst days, focus vs off-focus vs away>", "patterns": ["<up to 4 patterns, e.g. most productive time of week, recurring drains>"], "wins": ["<up to 4>"], "improve": ["<up to 4 specific changes>"], "next_goals": ["<3 measurable goals for next ${p.range.kind}>"]}`;
  return { system, user };
}

export function parsePeriodAi(text, model) {
  let out;
  try { out = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) { throw new Error('Claude returned an unexpected answer — try again.'); }
  const arr = (x) => (Array.isArray(x) ? x.filter(Boolean).map(String).slice(0, 4) : []);
  return { score: Math.max(0, Math.min(100, Math.round(Number(out.score) || 0))), headline: String(out.headline || ''), summary: String(out.summary || ''),
    patterns: arr(out.patterns), wins: arr(out.wins), improve: arr(out.improve), next_goals: arr(out.next_goals).slice(0, 3), source: 'claude', model };
}

export async function askClaudePeriod(p) {
  const s = await store.getSettings();
  if (!s.anthropicKey) throw new Error('no-key');
  const { system, user } = periodPrompt(p, s.senderName);
  const model = s.aiModel || 'claude-sonnet-5-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model, max_tokens: 1600, system, messages: [{ role: 'user', content: user }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(report.claudeError(res.status, body.error?.message || res.statusText, model));
  return parsePeriodAi((body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''), model);
}

export function basicPeriodSummary(p) {
  const d = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / Math.max(1, b)) * 100)}%` : 'n/a');
  return {
    score: p.avgScore ?? Math.round(Math.min(100, p.focusPct)),
    headline: `${fmt(p.totals.productive)} productive over ${p.daysTracked} day${p.daysTracked === 1 ? '' : 's'}`,
    summary: `Average ${fmt(p.avg.productive)} productive, ${fmt(p.avg.distracting)} off-focus and ${fmt(p.avg.idle)} away per tracked day (focus ${p.focusPct}%). Productive time per day vs previous ${p.range.kind}: ${d(p.avg.productive, p.prev.avg.productive)}. You sent ${p.work.emailsSent} emails and ${p.work.followUpsSent} follow-ups.`,
    patterns: [], wins: p.best ? [`Best day: ${p.best.date} (${fmt(p.best.productive)} productive)`] : [], improve: [], next_goals: [], source: 'basic',
  };
}

export async function getPeriodReports() {
  const { periodReports } = await chrome.storage.local.get('periodReports');
  return periodReports || {};
}
async function savePeriodReport(id, patch) {
  const all = await getPeriodReports();
  all[id] = { ...(all[id] || {}), ...patch, id, updatedAt: Date.now() };
  await chrome.storage.local.set({ periodReports: all });
  return all[id];
}

export async function generatePeriod(kind, anchor, { send = false, useAi = true, interactive = false } = {}) {
  const p = await buildPeriod(kind, anchor);
  let ai, aiError = '';
  if (useAi) { try { ai = await askClaudePeriod(p); } catch (e) { aiError = e.message === 'no-key' ? '' : e.message; ai = basicPeriodSummary(p); } }
  else ai = basicPeriodSummary(p);
  let rep = await savePeriodReport(p.range.id, { ai, aiError, label: p.range.label, kind });
  const html = renderPeriodEmail(p, ai);
  if (send) {
    const s = await store.getSettings();
    const to = s.reportTo || s.defaultSender;
    if (!to) throw new Error('Add a Gmail account so the report can be emailed.');
    const res = await gmail.sendEmail({ from: s.defaultSender, to, subject: `Your ${kind}: ${ai.score}/100 — ${p.range.label}`, text: `${ai.headline}\n\n${ai.summary}`, html, interactive });
    rep = await savePeriodReport(p.range.id, { sentAt: Date.now(), sentTo: to, messageId: res.id });
  }
  return { period: p, report: rep, html };
}

// Weekly email on the chosen weekday (called from the daily report run).
export async function runWeeklyIfDue({ beforeSend } = {}) {
  const s = await store.getSettings();
  if (s.reportWeekly === false) return null;
  const now = new Date();
  const [h, m] = String(s.reportTime || '20:00').split(':').map(Number);
  const at = new Date(now); at.setHours(h, m, 0, 0);
  const wd = Number(s.reportWeekday ?? 6);
  if (now.getDay() !== wd || now < at) return null;
  // the week that ends today (for Monday, the week that just ended)
  const anchor = tracker.dayKey(wd === 1 ? Date.now() - 864e5 : Date.now());
  const range = periodRange('week', anchor);
  if (beforeSend) await beforeSend();
  if ((await getPeriodReports())[range.id]?.sentAt) return null;
  return generatePeriod('week', anchor, { send: true });
}

// ---------- email ----------
export function renderPeriodEmail(p, ai) {
  const COLORS = { P: '#0b6e57', D: '#e07a3f', I: '#f0c75e', O: '#7d8fd6' };
  const maxDay = Math.max(60, ...p.rows.map((r) => (r.productive || 0) + (r.distracting || 0) + (r.idle || 0) + (r.otherApps || 0)));
  const bar = (r) => {
    if (r.empty) return `<div style="height:14px;background:#f2f4f3;border-radius:3px"></div>`;
    const seg = (v, c) => (v ? `<td style="background:${c};width:${(v / maxDay) * 100}%;height:14px"></td>` : '');
    const rest = 100 - (((r.productive || 0) + (r.distracting || 0) + (r.idle || 0) + (r.otherApps || 0)) / maxDay) * 100;
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed;border-radius:3px;overflow:hidden"><tr>${seg(r.productive, COLORS.P)}${seg(r.otherApps, COLORS.O)}${seg(r.distracting, COLORS.D)}${seg(r.idle, COLORS.I)}<td style="width:${Math.max(0, rest)}%"></td></tr></table>`;
  };
  const delta = (a, b, good = true) => {
    if (!b) return '';
    const pct = Math.round(((a - b) / Math.max(1, b)) * 100);
    const up = pct >= 0;
    const color = (up === good) ? '#0b6e57' : '#c2410c';
    return `<div style="font-size:11px;color:${color}">${up ? '▲' : '▼'} ${Math.abs(pct)}% per day</div>`;
  };
  const kpi = (l, v, d) => `<td width="20%" style="padding:10px 4px;text-align:center;border-right:1px solid #eef0f1;vertical-align:top"><div style="font-size:10px;color:#6b7a86;text-transform:uppercase">${esc(l)}</div><div style="font-size:18px;font-weight:700;margin-top:2px">${esc(v)}</div>${d}</td>`;
  const list = (title, items, color) => (items?.length ? `<tr><td style="padding:12px 24px 0"><div style="font-weight:700;font-size:14px;color:${color};margin-bottom:4px">${esc(title)}</div><ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.55;color:#33424d">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></td></tr>` : '');
  const row = (a, b) => `<tr><td style="padding:5px 0;border-bottom:1px solid #f0f2f1">${a}</td><td style="padding:5px 0;border-bottom:1px solid #f0f2f1;text-align:right;font-weight:600">${b}</td></tr>`;
  const w = p.work;
  return `<!doctype html><html><body style="margin:0;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif;color:#1d2226">
<table role="presentation" width="100%" style="padding:20px 0"><tr><td align="center">
<table role="presentation" width="640" style="max-width:640px;width:100%;background:#fff;border-radius:14px;border:1px solid #e3e8e6;overflow:hidden" cellspacing="0" cellpadding="0">
<tr><td style="background:#0b6e57;color:#fff;padding:20px 24px">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Your ${esc(p.range.kind)} · ${esc(p.range.label)}</div>
  <table role="presentation" width="100%"><tr><td style="font-size:20px;font-weight:700;padding-top:6px">${esc(ai.headline)}</td>
  <td width="84" align="right"><div style="background:#fff;color:#0b6e57;border-radius:12px;padding:8px 0;width:72px;text-align:center"><div style="font-size:26px;font-weight:800">${ai.score}</div><div style="font-size:10px;color:#6b7a86">SCORE</div></div></td></tr></table>
</td></tr>
<tr><td style="padding:18px 24px 4px;font-size:15px;line-height:1.6;color:#33424d">${esc(ai.summary)}</td></tr>
<tr><td style="padding:12px 16px 0"><table role="presentation" width="100%" style="border:1px solid #eef0f1;border-radius:10px;table-layout:fixed"><tr>
  ${kpi('Productive', fmt(p.totals.productive), '')}
  ${kpi('Avg / day', fmt(p.avg.productive), delta(p.avg.productive, p.prev.avg.productive))}
  ${kpi('Off-focus', fmt(p.totals.distracting), delta(p.avg.distracting, p.prev.avg.distracting, false))}
  ${kpi('Idle / away', fmt(p.totals.idle), delta(p.avg.idle, p.prev.avg.idle, false))}
  ${kpi('Focus', p.focusPct + '%', '')}
</tr></table></td></tr>
<tr><td style="padding:16px 24px 0"><div style="font-weight:700;font-size:14px;margin-bottom:6px">Day by day</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="3" style="font-size:12px">${p.rows.map((r) => `<tr><td width="70" style="color:#56687a;white-space:nowrap">${esc(parse(r.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }))}</td><td>${bar(r)}</td><td width="56" style="text-align:right;font-weight:600">${r.empty ? '' : esc(fmt(r.productive))}</td></tr>`).join('')}</table>
<div style="font-size:11px;color:#6b7a86;margin-top:4px"><span style="color:${COLORS.P}">■</span> Productive &nbsp; <span style="color:${COLORS.O}">■</span> Other apps &nbsp; <span style="color:${COLORS.D}">■</span> Off-focus &nbsp; <span style="color:${COLORS.I}">■</span> Idle / away</div></td></tr>
<tr><td style="padding:16px 24px 0"><div style="font-weight:700;font-size:14px;margin-bottom:4px">Where your time went</div>
<table role="presentation" width="100%" style="font-size:14px" cellspacing="0" cellpadding="0">${p.cats.slice(0, 8).map((c) => row(esc(c.cat), fmt(c.minutes))).join('')}</table></td></tr>
<tr><td style="padding:16px 24px 0"><div style="font-weight:700;font-size:14px;margin-bottom:4px">Outreach &amp; CRM work</div>
<table role="presentation" width="100%" style="font-size:14px" cellspacing="0" cellpadding="0">
${[['Emails sent', w.emailsSent], ['Follow-ups sent', w.followUpsSent], ['Replies received', w.repliesReceived], ['LinkedIn profiles viewed', w.linkedinProfilesViewed], ['New contacts', w.contactsAdded], ['Calls', w.calls], ['Meetings', w.meetings], ['Deals created', w.dealsCreated], ['Deals won', w.dealsWon], ['Marketing check-ins answered “yes”', p.checkins.yes]].filter(([, v]) => v).map(([k, v]) => row(esc(k), esc(v))).join('') || '<tr><td style="color:#8796a1">No outreach logged.</td></tr>'}
</table></td></tr>
${list('Patterns', ai.patterns, '#1d2226')}${list('Wins', ai.wins, '#0b6e57')}${list('What to improve', ai.improve, '#c2410c')}${list(`Goals for next ${p.range.kind}`, ai.next_goals, '#4f5fb3')}
<tr><td style="padding:18px 24px 20px;font-size:12px;color:#8796a1">${p.daysTracked} day${p.daysTracked === 1 ? '' : 's'} tracked. ${ai.source === 'claude' ? `Summary by ${esc(ai.model)}.` : 'Add a Claude API key in Settings for an AI summary.'}</td></tr>
</table></td></tr></table></body></html>`;
}
