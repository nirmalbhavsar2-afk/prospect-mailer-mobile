// Daily report: gathers the day's activity + CRM work, asks Claude for a coaching summary,
// and emails it (8 PM by default) from your own Gmail.
import * as store from './store.js';
import * as crm from './crm.js';
import * as tracker from './tracker.js';
import * as gmail from './gmail.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const AI_MODELS = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (recommended)'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (fastest, cheapest)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (most thorough)'],
];

const dayBounds = (date, start) => { if (start) return [start, start + 864e5]; const [y, m, d] = date.split('-').map(Number); const s = new Date(y, m - 1, d).getTime(); return [s, s + 864e5]; };
const inDay = (t, [a, b]) => t && t >= a && t < b;
const fullName = (l) => [l.firstName, l.lastName].filter(Boolean).join(' ') || l.email || 'someone';
export const fmtMin = (m) => { m = Math.round(m || 0); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const clock = (t) => (t ? new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '—');

// ---------- gather ----------
export async function buildDayData(date) {
  const s = await store.getSettings();
  const bounds = dayBounds(date);
  const isToday = date === tracker.dayKey(Date.now());
  const upTo = isToday ? Math.floor((Date.now() - bounds[0]) / 60000) : 1440;
  const day = await tracker.getCombinedDay(date);
  const time = tracker.summarize(day, { workStart: s.workStart, workEnd: s.workEnd, upTo });
  const [leads, deals] = await Promise.all([store.getLeads(), crm.getDeals()]);
  const stages = crm.stagesOf(s);
  const cur = s.currency || 'USD';

  const sent = leads.flatMap((l) => (l.emailsSent || []).filter((e) => inDay(e.date, bounds)).map((e) => ({ ...e, lead: l })));
  const acts = leads.flatMap((l) => (l.activities || []).filter((a) => inDay(a.at, bounds)).map((a) => ({ ...a, lead: l })));
  const fuScheduled = leads.flatMap((l) => (l.followUps || []).filter((f) => inDay(f.createdAt, bounds)));
  const moves = deals.flatMap((d) => (d.history || []).filter((h) => inDay(h.at, bounds)).map((h) => ({ ...h, deal: d })));
  const work = {
    emailsSent: sent.filter((e) => !e.followUp).length,
    followUpsSent: sent.filter((e) => e.followUp).length,
    peopleEmailed: [...new Set(sent.map((e) => e.lead.id))].length,
    repliesReceived: leads.filter((l) => inDay(l.repliedAt, bounds)).length,
    contactsAdded: leads.filter((l) => inDay(l.createdAt, bounds)).length,
    linkedinProfilesViewed: time.profilesViewed,
    followUpsScheduled: fuScheduled.length,
    calls: acts.filter((a) => a.kind === 'call').length,
    meetings: acts.filter((a) => a.kind === 'meeting').length,
    linkedinMessages: acts.filter((a) => a.kind === 'linkedin').length,
    notes: acts.filter((a) => a.kind === 'note').length,
    dealsCreated: deals.filter((d) => inDay(d.createdAt, bounds)).length,
    dealsMoved: moves.filter((m) => m.status === 'open').length,
    dealsWon: deals.filter((d) => inDay(d.wonAt, bounds)),
    dealsLost: deals.filter((d) => inDay(d.lostAt, bounds)),
    emailSamples: sent.slice(0, 12).map((e) => ({ to: fullName(e.lead), company: e.lead.company || '', subject: e.subject, followUp: !!e.followUp })),
    activitySamples: acts.slice(0, 12).map((a) => ({ kind: crm.ACTIVITY_KINDS[a.kind] || a.kind, with: fullName(a.lead), company: a.lead.company || '', note: (a.text || '').slice(0, 140) })),
  };
  const m = crm.metrics({ leads, deals, stages });
  const att = m.attention;
  const opportunities = {
    followUpsDue: att.dueFollowUps.slice(0, 8).map((f) => ({ name: fullName(f.lead), company: f.lead.company || '' })),
    repliedNoDeal: att.repliedNoDeal.slice(0, 8).map((l) => ({ name: fullName(l), company: l.company || '' })),
    staleDeals: att.stale.slice(0, 8).map((d) => ({ deal: d.title, amount: crm.money(d.amount, cur), idleDays: Math.round((Date.now() - (d.updatedAt || d.createdAt)) / 864e5) })),
    overdueDeals: att.overdueClose.slice(0, 8).map((d) => ({ deal: d.title, expectedClose: d.expectedClose })),
  };
  return {
    date, dayStart: bounds[0], isToday, generatedAt: Date.now(), currency: cur, idleMinutes: Math.max(1, Number(s.idleMinutes) || 2),
    owner: s.senderName || '',
    time, work,
    pipeline: { open: m.openCount, openValue: crm.money(m.openValue, cur), revenueMonth: crm.money(m.revenueMonth, cur), mrr: crm.money(m.mrr, cur), replyRate30: m.replyRate30 },
    opportunities,
    mins: day.mins,
  };
}

// ---------- AI ----------
function aiPayload(d) {
  const t = d.time;
  return {
    date: d.date,
    work_hours: `${t.workWindow.start}–${t.workWindow.end}`,
    first_active: clock(t.firstActive), last_active: clock(t.lastActive),
    minutes: {
      productive_sites: t.productive, neutral_sites: t.neutral, distracting_sites: t.distracting,
      other_apps_outside_chrome: t.otherApps, idle_away_or_phone: t.idle, screen_locked: t.locked,
      in_work_hours_not_at_computer_or_chrome_closed: t.workWindow.off,
      longest_focus_block: t.longestFocus.len, longest_idle_block: t.longestIdle.len,
    },
    time_by_category_minutes: Object.fromEntries(t.cats.map((c) => [c.cat, c.minutes])),
    top_sites_minutes: t.sites.slice(0, 15).map((s) => `${s.host} (${s.cat}): ${s.minutes}`),
    hourly_productive_minutes: t.hours.map((h, i) => [i, h.P]).filter(([, v]) => v > 0),
    hourly_idle_minutes: t.hours.map((h, i) => [i, h.I + h.L]).filter(([, v]) => v > 0),
    crm_work_done: { ...d.work, dealsWon: d.work.dealsWon.map((x) => x.title), dealsLost: d.work.dealsLost.map((x) => x.title) },
    pipeline_now: d.pipeline,
    open_opportunities: d.opportunities,
  };
}

// Prompt + parsing are pure so the cloud script (cloud/Code.gs) can reuse them word for word.
export function dayPrompt(d) {
  const system = `You are a sharp, encouraging productivity coach for ${d.owner || 'a founder'}, who runs a recruitment/RPO and KPO business and spends the day on client development: B2B outreach on LinkedIn and email, follow-ups, calls, proposals and marketing. You receive one day of tracked activity (minutes per category, idle/away time, other-app time) and the CRM work done. Judge the day honestly but kindly. Be specific: use the real numbers, sites, people and deals provided. "Idle" means no keyboard/mouse input on the computer (likely away or on the phone). "Other apps" means active outside Chrome. Reply with JSON only, no prose around it.`;
  const user = `Here is the day:\n${JSON.stringify(aiPayload(d))}\n\nReturn exactly this JSON shape:
{"score": <0-100 productivity score>, "headline": "<max 12 words>", "summary": "<3-5 sentences on how the day went, where time went, how much was focused vs off-focus or away>", "went_well": ["<up to 4>"], "time_drains": ["<up to 3, with minutes>"], "marketing_done": ["<each outreach/marketing activity done today, concrete>"], "could_have_done": ["<up to 5 specific, actionable things using the open opportunities and names given>"], "tomorrow": ["<exactly 3 priorities for tomorrow>"]}`;
  return { system, user };
}

export function parseDayAi(text, model) {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let out;
  try { out = JSON.parse(json); } catch (e) { throw new Error('Claude returned an unexpected answer — try again.'); }
  const arr = (x, n) => (Array.isArray(x) ? x.filter(Boolean).map(String).slice(0, n) : []);
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(out.score) || 0))),
    headline: String(out.headline || '').slice(0, 140),
    summary: String(out.summary || ''),
    went_well: arr(out.went_well, 4), time_drains: arr(out.time_drains, 3), marketing_done: arr(out.marketing_done, 8),
    could_have_done: arr(out.could_have_done, 5), tomorrow: arr(out.tomorrow, 3),
    model, source: 'claude',
  };
}

export function claudeError(status, message, model) {
  if (status === 401) return 'Claude API key was rejected — check it in Settings.';
  if (status === 404) return `Model not available on your account (${model}). Pick another in Settings.`;
  return 'Claude API: ' + message;
}

export async function askClaude(d) {
  const s = await store.getSettings();
  if (!s.anthropicKey) throw new Error('no-key');
  const { system, user } = dayPrompt(d);
  const model = s.aiModel || 'claude-sonnet-5-5';
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': s.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 1600, system, messages: [{ role: 'user', content: user }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(claudeError(res.status, body.error?.message || res.statusText, model));
  return parseDayAi((body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''), model);
}

// Used when no API key is set or the API is unreachable.
export function basicSummary(d) {
  const t = d.time, w = d.work;
  const score = t.active ? Math.round(Math.min(100, (t.productive / Math.max(60, t.workWindow.minutes)) * 100 * 0.7 + (t.focusPct * 0.3))) : 0;
  const could = [
    ...d.opportunities.followUpsDue.slice(0, 2).map((x) => `Follow up with ${x.name}${x.company ? ` (${x.company})` : ''}`),
    ...d.opportunities.repliedNoDeal.slice(0, 2).map((x) => `${x.name} replied — open a deal and propose a trial`),
    ...d.opportunities.staleDeals.slice(0, 1).map((x) => `Nudge “${x.deal}” — idle ${x.idleDays} days`),
  ];
  return {
    score,
    headline: t.active ? `${fmtMin(t.productive)} focused, ${fmtMin(t.distracting)} off-focus, ${fmtMin(t.idle)} away` : 'No activity recorded today',
    summary: `Productive time ${fmtMin(t.productive)} (${t.focusPct}% of active time). Off-focus sites ${fmtMin(t.distracting)}, other apps ${fmtMin(t.otherApps)}, idle/away ${fmtMin(t.idle)}. You sent ${w.emailsSent} emails and ${w.followUpsSent} follow-ups and viewed ${w.linkedinProfilesViewed} LinkedIn profiles.`,
    went_well: [], time_drains: t.sites.filter((s) => s.kind === 'distracting').slice(0, 3).map((s) => `${s.host}: ${fmtMin(s.minutes)}`),
    marketing_done: [], could_have_done: could, tomorrow: could.slice(0, 3),
    source: 'basic',
  };
}

// ---------- email ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = { P: '#0b6e57', N: '#8fb9ad', D: '#e07a3f', O: '#7d8fd6', I: '#f0c75e', L: '#c7ccd1', '.': '#eef0f1' };
export const LEGEND = [['P', 'Productive'], ['N', 'Neutral'], ['D', 'Off-focus sites'], ['O', 'Other apps'], ['I', 'Idle / away'], ['L', 'Locked'], ['.', 'Off / Chrome closed']];

function timelineCells(d) {
  const t = d.time;
  const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const firstM = t.firstActive ? Math.floor((t.firstActive - dayBounds(d.date, d.dayStart)[0]) / 60000) : hm(t.workWindow.start);
  const lastM = t.lastActive ? Math.ceil((t.lastActive - dayBounds(d.date, d.dayStart)[0]) / 60000) : hm(t.workWindow.end);
  const from = Math.max(0, Math.floor(Math.min(firstM, hm(t.workWindow.start)) / 60) * 60);
  const to = Math.min(1440, Math.ceil(Math.max(lastM, hm(t.workWindow.end)) / 60) * 60);
  const RANKS = { '.': 0, L: 1, I: 2, O: 3, D: 4, N: 5, P: 6 };
  const step = 10, cells = [];
  for (let m = from; m < to; m += step) {
    const counts = {};
    for (let i = m; i < m + step; i++) counts[d.mins[i]] = (counts[d.mins[i]] || 0) + 1;
    const code = Object.entries(counts).sort((a, b) => b[1] - a[1] || RANKS[b[0]] - RANKS[a[0]])[0][0];
    cells.push(code);
  }
  return { cells, from, to };
}

export function renderEmail(d, ai) {
  const t = d.time, w = d.work;
  const dateLabel = new Date(dayBounds(d.date, d.dayStart)[0]).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const scoreColor = ai.score >= 70 ? '#0b6e57' : ai.score >= 45 ? '#b7791f' : '#c2410c';
  const tl = timelineCells(d);
  const hourLabels = [];
  for (let m = tl.from; m < tl.to; m += 60) hourLabels.push(new Date(dayBounds(d.date, d.dayStart)[0] + m * 60000).toLocaleTimeString(undefined, { hour: 'numeric' }));
  const cellW = (100 / tl.cells.length).toFixed(3);
  const list = (title, items, color = '#1d2226') => (items?.length ? `<tr><td style="padding:14px 24px 0"><div style="font-weight:700;font-size:14px;color:${color};margin-bottom:6px">${esc(title)}</div><ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.55;color:#33424d">${items.map((x) => `<li style="margin:2px 0">${esc(x)}</li>`).join('')}</ul></td></tr>` : '');
  const kpi = (label, val, sub, color) => `<td width="20%" style="width:20%;padding:10px 4px;text-align:center;border-right:1px solid #eef0f1;vertical-align:top"><div style="font-size:10px;color:#6b7a86;text-transform:uppercase;letter-spacing:.04em">${esc(label)}</div><div style="font-size:18px;font-weight:700;color:${color};margin-top:2px">${esc(val)}</div>${sub ? `<div style="font-size:10px;color:#8796a1">${esc(sub)}</div>` : ''}</td>`;
  const row = (a, b, c = '') => `<tr><td style="padding:6px 0;border-bottom:1px solid #f0f2f1">${a}</td><td style="padding:6px 0;border-bottom:1px solid #f0f2f1;text-align:right;color:#56687a">${c}</td><td style="padding:6px 0 6px 12px;border-bottom:1px solid #f0f2f1;text-align:right;font-weight:600;white-space:nowrap">${b}</td></tr>`;
  const totalActive = Math.max(1, t.cats.reduce((s, c) => s + c.minutes, 0) + t.otherApps);
  const dot = (k) => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${COLORS[{ productive: 'P', neutral: 'N', distracting: 'D' }[k] || k]};margin-right:6px"></span>`;
  const workRows = [
    ['Emails sent', w.emailsSent], ['Follow-ups sent', w.followUpsSent], ['Replies received', w.repliesReceived],
    ['LinkedIn profiles viewed', w.linkedinProfilesViewed], ['New contacts added', w.contactsAdded],
    ['Calls', w.calls], ['Meetings', w.meetings], ['LinkedIn messages logged', w.linkedinMessages],
    ['Deals created', w.dealsCreated], ['Deals moved forward', w.dealsMoved],
    ['Deals won', w.dealsWon.length ? `${w.dealsWon.length} · ${w.dealsWon.map((x) => crm.money(x.amount, d.currency)).join(', ')}` : 0],
    ['Deals lost', w.dealsLost.length],
  ].filter(([, v]) => v);

  return `<!doctype html><html><body style="margin:0;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif;color:#1d2226">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f5;padding:20px 0"><tr><td align="center">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e8e6">
  <tr><td style="background:#0b6e57;padding:20px 24px;color:#fff">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Your day · ${esc(dateLabel)}</div>
    <table role="presentation" width="100%"><tr>
      <td style="font-size:20px;font-weight:700;padding-top:6px;line-height:1.3">${esc(ai.headline || 'Daily summary')}</td>
      <td width="84" align="right" valign="top"><div style="background:#fff;color:${scoreColor};border-radius:12px;padding:8px 0;width:72px;text-align:center"><div style="font-size:26px;font-weight:800;line-height:1">${ai.score}</div><div style="font-size:10px;color:#6b7a86;margin-top:2px">SCORE</div></div></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:18px 24px 4px;font-size:15px;line-height:1.6;color:#33424d">${esc(ai.summary)}</td></tr>
  <tr><td style="padding:12px 16px 0"><table role="presentation" width="100%" style="border:1px solid #eef0f1;border-radius:10px;border-collapse:separate;table-layout:fixed"><tr>
    ${kpi('Productive', fmtMin(t.productive), `${t.focusPct}% of active`, '#0b6e57')}
    ${kpi('Off-focus', fmtMin(t.distracting), 'social, video, shopping', '#c2410c')}
    ${kpi('Idle / away', fmtMin(t.idle), t.longestIdle.len ? `longest ${fmtMin(t.longestIdle.len)}` : '', '#b7791f')}
    ${kpi('Other apps', fmtMin(t.otherApps), 'outside Chrome', '#4f5fb3')}
    ${kpi('Not on computer', fmtMin(t.workWindow.off), `in ${t.workWindow.start}–${t.workWindow.end}`, '#56687a')}
  </tr></table></td></tr>
  <tr><td style="padding:16px 24px 0">
    <div style="font-weight:700;font-size:14px;margin-bottom:6px">Your day at a glance <span style="font-weight:400;color:#8796a1;font-size:12px">· first active ${esc(clock(t.firstActive))}, last ${esc(clock(t.lastActive))}</span></div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed"><tr>${tl.cells.map((c) => `<td style="height:22px;width:${cellW}%;background:${COLORS[c]}"></td>`).join('')}</tr></table>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed;font-size:10px;color:#8796a1"><tr>${hourLabels.map((h) => `<td style="padding-top:3px">${esc(h)}</td>`).join('')}</tr></table>
    <div style="font-size:11px;color:#6b7a86;margin-top:6px">${LEGEND.map(([k, l]) => `<span style="margin-right:10px;white-space:nowrap">${dot(k)}${esc(l)}</span>`).join('')}</div>
  </td></tr>
  <tr><td style="padding:16px 24px 0">
    <div style="font-weight:700;font-size:14px;margin-bottom:4px">Where your time went</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px">
      ${t.cats.slice(0, 10).map((c) => row(`${dot(c.kind)}${esc(c.cat)}`, fmtMin(c.minutes), `${Math.round((c.minutes / totalActive) * 100)}%`)).join('')}
      ${t.otherApps ? row(`${dot('O')}Other apps (outside Chrome)`, fmtMin(t.otherApps), `${Math.round((t.otherApps / totalActive) * 100)}%`) : ''}
      ${t.idle ? row(`${dot('I')}Idle / away from keyboard`, fmtMin(t.idle), '') : ''}
    </table>
  </td></tr>
  <tr><td style="padding:16px 24px 0">
    <div style="font-weight:700;font-size:14px;margin-bottom:4px">Top sites</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px">
      ${t.sites.slice(0, 10).map((s) => row(`${dot(s.kind)}${esc(s.host)}`, fmtMin(s.minutes), esc(s.cat))).join('') || '<tr><td style="color:#8796a1">No browsing recorded.</td></tr>'}
    </table>
  </td></tr>
  <tr><td style="padding:16px 24px 0">
    <div style="font-weight:700;font-size:14px;margin-bottom:4px">Outreach &amp; CRM work</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px">
      ${workRows.map(([k, v]) => row(esc(k), esc(v))).join('') || '<tr><td style="color:#8796a1;padding:4px 0">No outreach logged today.</td></tr>'}
    </table>
  </td></tr>
  ${list('Marketing & outreach done', ai.marketing_done, '#0b6e57')}
  ${list('What went well', ai.went_well, '#0b6e57')}
  ${list('Time drains', ai.time_drains, '#c2410c')}
  ${list('What you could have done', ai.could_have_done, '#4f5fb3')}
  ${list('Top 3 for tomorrow', ai.tomorrow, '#1d2226')}
  <tr><td style="padding:18px 24px 20px;font-size:12px;color:#8796a1;border-top:1px solid #f0f2f1;margin-top:14px">
    Pipeline: ${esc(d.pipeline.open)} open deals (${esc(d.pipeline.openValue)}) · revenue this month ${esc(d.pipeline.revenueMonth)} · MRR ${esc(d.pipeline.mrr)}<br>
    Tracks Chrome on the laptops where Prospect Mailer runs. “Idle” = no keyboard or mouse for ${esc(d.idleMinutes || 2)}+ minutes. ${ai.source === 'claude' ? `Summary by ${esc(ai.model)}.` : 'Add a Claude API key in Settings for an AI summary.'}
  </td></tr>
</table></td></tr></table></body></html>`;
}

export function renderText(d, ai) {
  const t = d.time;
  const lines = [
    `Your day — ${d.date}   Score ${ai.score}/100`, ai.headline, '', ai.summary, '',
    `Productive ${fmtMin(t.productive)} · Off-focus ${fmtMin(t.distracting)} · Idle/away ${fmtMin(t.idle)} · Other apps ${fmtMin(t.otherApps)} · Not on computer (work hours) ${fmtMin(t.workWindow.off)}`,
    '', 'Where your time went:', ...t.cats.slice(0, 8).map((c) => `  ${c.cat}: ${fmtMin(c.minutes)}`),
    '', 'What you could have done:', ...(ai.could_have_done || []).map((x) => '  - ' + x),
    '', 'Top 3 for tomorrow:', ...(ai.tomorrow || []).map((x, i) => `  ${i + 1}. ${x}`),
  ];
  return lines.join('\n');
}

// ---------- generate / send ----------
export async function getReports() {
  const { dailyReports } = await chrome.storage.local.get('dailyReports');
  return dailyReports || {};
}
async function saveReport(date, patch) {
  const all = await getReports();
  all[date] = { ...(all[date] || {}), ...patch, date, updatedAt: Date.now() };
  // keep 60 days
  const keys = Object.keys(all).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete all[k];
  await chrome.storage.local.set({ dailyReports: all });
  return all[date];
}

export async function generate(date, { send = false, useAi = true, interactive = false } = {}) {
  const data = await buildDayData(date);
  let ai, aiError = '';
  if (useAi) {
    try { ai = await askClaude(data); }
    catch (e) { aiError = e.message === 'no-key' ? '' : e.message; ai = basicSummary(data); }
  } else ai = basicSummary(data);
  const { mins, ...rest } = data;
  let report = await saveReport(date, { data: rest, ai, aiError });
  if (send) {
    const s = await store.getSettings();
    const to = s.reportTo || s.defaultSender;
    if (!to) throw new Error('Add a Gmail account (Settings → Gmail accounts) so the report can be emailed.');
    const html = renderEmail(data, ai);
    const subject = `Your day: ${ai.score}/100 — ${ai.headline || data.date}`.slice(0, 150);
    const res = await gmail.sendEmail({ from: s.defaultSender, to, subject, text: renderText(data, ai), html, interactive });
    report = await saveReport(date, { sentAt: Date.now(), sentTo: to, messageId: res.id, sendError: '' });
  }
  return { report, html: renderEmail(data, ai) };
}

// ---------- scheduling ----------
const hmOf = (s) => { const [h, m] = String(s || '20:00').split(':').map(Number); return [h || 0, m || 0]; };
export function nextReportTime(reportTime, now = Date.now()) {
  const [h, m] = hmOf(reportTime);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
export async function schedule() {
  const s = await store.getSettings();
  await chrome.alarms.clear('dailyReport');
  if (s.reportEnabled === false) return;
  chrome.alarms.create('dailyReport', { when: nextReportTime(s.reportTime) });
}

// Called when the alarm fires and on startup (to catch up on a report missed while the laptop was off).
export async function runDue({ beforeSend } = {}) {
  const s = await store.getSettings();
  if (s.reportEnabled === false) return null;
  const now = Date.now();
  const [h, m] = hmOf(s.reportTime);
  const todayAt = new Date(now); todayAt.setHours(h, m, 0, 0);
  const today = tracker.dayKey(now);
  const yesterday = tracker.dayKey(now - 864e5);
  const candidates = [];
  if (now >= todayAt.getTime()) candidates.push(today);
  else candidates.push(yesterday); // laptop was off at report time yesterday
  for (const date of candidates) {
    const [y, mo, dd] = date.split('-').map(Number);
    const wd = new Date(y, mo - 1, dd).getDay();
    if (!s.reportWeekends && (wd === 0 || wd === 6)) continue;
    if (beforeSend) await beforeSend();
    const rep = (await getReports())[date];
    if (rep?.sentAt) continue;
    const day = await tracker.getCombinedDay(date);
    if (!/[PNDOIL]/.test(day.mins)) continue; // nothing tracked that day
    try {
      return await generate(date, { send: true });
    } catch (e) {
      await saveReport(date, { sendError: e.message });
      try {
        await chrome.notifications.create('report-' + date, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: 'Daily report not sent', message: e.message.slice(0, 180) });
      } catch { /* ignore */ }
    }
  }
  return null;
}
