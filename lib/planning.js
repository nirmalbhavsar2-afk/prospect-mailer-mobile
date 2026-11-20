// Planning: year / 3-year plans with goals that track themselves from Pitchbird data, a monthly plan,
// an AI assistant (weekly focus, monthly review drafts, questions), weekly Todoist tasks made from the plan,
// and a monthly market brief (Claude + web search + your own outreach results).
//
// Storage (all synced to your other laptops):
//   plans        [{ id, name, type, startYear, years, theme, vision, bets[], goals[], months{}, decisions[], autoTasks, createdAt, updatedAt }]
//   planState    { '<planId>:coach' | '<planId>:todoist' | '<planId>:chat' : {..., updatedAt} }  — written by the assistant, merged per key
//   marketBriefs [{ id: 'mb-YYYY-MM', month, text, opportunities[], at, updatedAt }]
import * as store from './store.js';
import * as crm from './crm.js';
import * as todoist from './todoist.js';
import { detectIndustry, INDUSTRIES } from './aiwrite.js';

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const DAY = 864e5;
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const mKey = (i) => String(i + 1).padStart(2, '0');

// ---------------- metrics a goal can track on its own ----------------
export const METRICS = {
  revenue: { label: 'Revenue (deals won)', unit: 'money' },
  wonDeals: { label: 'Deals won', unit: '' },
  newClients: { label: 'New clients', unit: '' },
  emails: { label: 'Emails sent', unit: '' },
  replies: { label: 'People who replied', unit: '' },
  contacts: { label: 'New contacts added', unit: '' },
  manual: { label: 'I update it myself', unit: '' },
};
export const AREAS = { business: 'Nexellence', personal: 'Personal' };
export const TYPES = { year: 'Year plan', '3year': '3-year plan' };

export function periodOf(p) {
  const y = Number(p.startYear) || new Date().getFullYear();
  const years = p.type === '3year' ? Math.max(1, Number(p.years) || 3) : 1;
  return { from: new Date(y, 0, 1).getTime(), to: new Date(y + years, 0, 1).getTime(), years };
}

export function computeMetric(metric, { leads = [], deals = [] }, from, to) {
  const inR = (t) => t && t >= from && t < to;
  switch (metric) {
    case 'revenue': return deals.reduce((a, d) => a + crm.dealRevenue(d, from, to), 0);
    case 'wonDeals': return deals.filter((d) => d.status === 'won' && inR(d.wonAt)).length;
    case 'newClients': return leads.filter((l) => (l.typeHistory || []).some((h) => h.type === 'Client' && inR(h.at)) || (crm.contactType(l) === 'Client' && !(l.typeHistory || []).length && inR(l.createdAt))).length;
    case 'emails': return leads.reduce((a, l) => a + (l.emailsSent || []).filter((e) => inR(typeof e.date === 'number' ? e.date : Date.parse(e.date))).length, 0);
    case 'replies': return leads.filter((l) => inR(l.repliedAt)).length;
    case 'contacts': return leads.filter((l) => inR(l.createdAt)).length;
    default: return null;
  }
}

// how far along a goal is, and whether that's on pace for the time gone
export function progress(goal, data, plan, now = Date.now()) {
  const { from, to } = periodOf(plan);
  const auto = goal.metric && goal.metric !== 'manual';
  const current = auto ? computeMetric(goal.metric, data, from, Math.min(to, now + 1)) : Number(goal.current) || 0;
  const target = Number(goal.target) || 0;
  const pct = target ? current / target : goal.done ? 1 : 0;
  const elapsed = Math.max(0, Math.min(1, (now - from) / (to - from)));
  let status = 'none';
  if (goal.done || (target && pct >= 1)) status = 'done';
  else if (now < from) status = 'upcoming';
  else if (target) status = pct >= elapsed * 1.05 ? 'ahead' : pct >= elapsed * 0.9 ? 'on' : 'behind';
  return { current, target, pct, elapsed, status, auto };
}

// ---------------- plans ----------------
export async function getPlans() {
  const { plans } = await chrome.storage.local.get('plans');
  return (plans || []).filter((p) => !p.deleted).sort((a, b) => (a.startYear - b.startYear) || (a.type === '3year' ? -1 : 1));
}
export async function getPlan(id) { return (await getPlans()).find((p) => p.id === id) || null; }
export async function savePlan(plan) {
  const { plans = [] } = await chrome.storage.local.get('plans');
  const now = Date.now();
  const i = plans.findIndex((p) => p.id === plan.id);
  const out = { ...(i >= 0 ? plans[i] : {}), ...plan, updatedAt: now };
  if (i >= 0) plans[i] = out; else plans.push(out);
  await chrome.storage.local.set({ plans });
  return out;
}
export async function deletePlan(id) {
  const { plans = [] } = await chrome.storage.local.get('plans');
  await chrome.storage.local.set({ plans: plans.filter((p) => p.id !== id) });
  await store.addTombstone(id);
}
export function blankPlan({ type = 'year', name = '', startYear }) {
  const y = Number(startYear) || new Date().getFullYear() + (new Date().getMonth() >= 9 ? 1 : 0);
  const p = { id: 'plan-' + uid(), type, startYear: y, years: type === '3year' ? 3 : 1, name: name || (type === '3year' ? `${y}–${y + 2}` : String(y)),
    theme: '', vision: '', bets: [], goals: [], months: {}, decisions: [], autoTasks: true, createdAt: Date.now() };
  if (type === '3year') p.bets = [{ id: uid(), text: '', checkpoints: {} }];
  return p;
}
export const newId = uid;

// the plan the assistant works from: this year's year plan (or the nearest one), plus the 3-year plan around it
export function activePlans(plans, now = Date.now()) {
  const y = new Date(now).getFullYear();
  const years = plans.filter((p) => p.type === 'year');
  const year = years.find((p) => Number(p.startYear) === y) || years.filter((p) => Number(p.startYear) > y).sort((a, b) => a.startYear - b.startYear)[0] || null;
  const yy = year ? Number(year.startYear) : y;
  const three = plans.find((p) => p.type === '3year' && yy >= p.startYear && yy < p.startYear + (Number(p.years) || 3)) || null;
  return { year, three };
}

// ---------------- assistant state (separate from the plan, so the assistant never overwrites your edits) ----------------
export async function getState(key) { return ((await chrome.storage.local.get('planState')).planState || {})[key] || null; }
export async function setState(key, val) {
  const { planState = {} } = await chrome.storage.local.get('planState');
  planState[key] = { ...val, updatedAt: Date.now() };
  for (const k of Object.keys(planState)) if (k.startsWith('lock:') && Date.now() - (planState[k].updatedAt || 0) > 40 * DAY) delete planState[k];
  await chrome.storage.local.set({ planState });
  return planState[key];
}

// ---------------- context for Claude ----------------
const money = (n, cur) => crm.money(n, cur);
async function loadData() {
  const [leads, deals, s] = await Promise.all([store.getLeads(), crm.getDeals(), store.getSettings()]);
  return { leads, deals, s };
}
function goalLine(g, data, plan, cur) {
  const pr = progress(g, data, plan);
  const fmt = (v) => (METRICS[g.metric]?.unit === 'money' ? money(v, cur) : Math.round(v * 10) / 10);
  const tgt = pr.target ? `${fmt(pr.current)} of ${fmt(pr.target)} (${Math.round(pr.pct * 100)}%, ${Math.round(pr.elapsed * 100)}% of the period gone → ${pr.status})` : (g.done ? 'done' : 'no number target');
  return `- [${AREAS[g.area] || 'Nexellence'}] ${g.title}: ${tgt}${g.milestones && Object.values(g.milestones).some(Boolean) ? ` · milestones: ${Object.entries(g.milestones).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('; ')}` : ''}`;
}
export function planContext(year, three, data, cur = 'USD', now = Date.now()) {
  const m = new Date(now).getMonth();
  const out = [];
  if (three) {
    out.push(`3-YEAR PLAN "${three.name}" (${three.startYear}–${three.startYear + (three.years || 3) - 1})`);
    if (three.vision) out.push(`Vision: ${three.vision}`);
    three.bets?.filter((b) => b.text).forEach((b) => out.push(`- Big bet: ${b.text}${b.checkpoints && Object.keys(b.checkpoints).length ? ` (checkpoints: ${Object.entries(b.checkpoints).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('; ')})` : ''}`));
    three.goals?.forEach((g) => out.push(goalLine(g, data, three, cur)));
  }
  if (year) {
    out.push(`\nYEAR PLAN "${year.name}"${year.theme ? ` — theme: ${year.theme}` : ''}`);
    year.goals?.forEach((g) => out.push(goalLine(g, data, year, cur)));
    const months = year.months || {};
    for (let i = Math.max(0, m - 2); i <= Math.min(11, m + 1); i++) {
      const mo = months[mKey(i)] || {};
      const pr = (mo.priorities || '').trim();
      const rv = mo.review || {};
      if (pr || rv.achieved || rv.slipped) out.push(`${MONTHS[i]}${i === m ? ' (this month)' : ''}: priorities: ${pr.replace(/\n+/g, '; ') || '—'}${rv.achieved ? ` | achieved: ${rv.achieved}` : ''}${rv.slipped ? ` | slipped: ${rv.slipped}` : ''}${rv.learned ? ` | learned: ${rv.learned}` : ''}`);
    }
    (year.decisions || []).slice(-8).forEach((d) => out.push(`Decision (${new Date(d.at).toLocaleDateString()}): ${d.text}`));
  }
  return out.join('\n');
}
function numbers(data, now = Date.now()) {
  const d30 = now - 30 * DAY;
  const won = data.deals.filter((d) => d.status === 'won');
  const open = data.deals.filter((d) => d.status === 'open');
  return `Last 30 days: ${computeMetric('emails', data, d30, now)} emails sent, ${computeMetric('replies', data, d30, now)} replies, ${computeMetric('contacts', data, d30, now)} new contacts, ${computeMetric('wonDeals', data, d30, now)} deals won. Open deals: ${open.length} (${open.slice(0, 6).map((d) => `${d.title} ${d.amount}`).join(', ')}). Clients now: ${data.leads.filter((l) => crm.contactType(l) === 'Client').length}. Deals won all-time: ${won.length}.`;
}

// ---------------- Claude ----------------
async function claude(s, { system, user, maxTokens = 900, tools, model }) {
  if (!s.anthropicKey) throw new Error('Add your Claude API key in Settings ▸ AI first.');
  const body = { model: model || s.aiModel || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  if (tools) body.tools = tools;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j.error?.message || String(res.status);
    if (res.status === 401) throw new Error('Claude API key was rejected.');
    if (tools && /web.?search|tool/i.test(msg)) throw new Error('Web search is turned off for your Claude API account — turn it on in console.anthropic.com ▸ Settings ▸ Privacy / Web search, then try again.');
    throw new Error('Claude: ' + msg);
  }
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}
const jsonOf = (t) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
const who = (s) => `${s.senderName || 'Nirmal'}, founder of Nexellence (recruiting / RPO: offshore sourcers and full-cycle recruiting for US/Canada staffing agencies and employers; 35+ people)`;

// ---------------- 1. weekly focus note ----------------
// local calendar dates (not UTC — in India midnight is 18:30 UTC the day before)
export const ymd = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const weekKey = (t = Date.now()) => { const d = new Date(t); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d.getTime()); };

export async function weeklyFocus({ force = false } = {}) {
  const { leads, deals, s } = await loadData();
  const { year, three } = activePlans(await getPlans());
  if (!year && !three) return null;
  const plan = year || three;
  const key = plan.id + ':coach';
  const wk = weekKey();
  const cur = await getState(key);
  if (!force && cur?.week === wk && cur.text) return cur;
  const data = { leads, deals };
  const system = `You are the planning assistant of ${who(s)}. You keep their plan in view and tell them, plainly and briefly, where to put their energy this week. Be specific and honest: name goals that are behind, say what to drop or postpone if it doesn't serve the plan, and tie advice to their real numbers. No hype, no generic productivity tips, no emojis. Reply with JSON only.`;
  const user = `Today: ${new Date().toDateString()}\n\n${planContext(year, three, data, s.currency)}\n\n${numbers(data)}\n\nReturn {"headline":"<max 12 words>","focus":["<3 concrete things for this week, max 18 words each>"],"watch":"<one goal or risk to watch, max 22 words>","drop":"<one thing to postpone or say no to this week, or empty>"}`;
  const j = jsonOf(await claude(s, { system, user, maxTokens: 600 }));
  return setState(key, { week: wk, at: Date.now(), headline: String(j.headline || '').slice(0, 120), focus: (j.focus || []).slice(0, 3).map((x) => String(x).slice(0, 200)), watch: String(j.watch || '').slice(0, 240), drop: String(j.drop || '').slice(0, 200) });
}

// ---------------- 2. monthly review draft ----------------
export async function draftReview(planId, monthIndex) {
  const { leads, deals, s } = await loadData();
  const plans = await getPlans();
  const plan = plans.find((p) => p.id === planId);
  const { three } = activePlans(plans);
  const y = Number(plan.startYear), from = new Date(y, monthIndex, 1).getTime(), to = new Date(y, monthIndex + 1, 1).getTime();
  const data = { leads, deals };
  const td = await todoist.getCache().catch(() => null);
  const tasksDone = td?.doneByDay ? Object.entries(td.doneByDay).filter(([k]) => k.startsWith(`${y}-${mKey(monthIndex)}`)).reduce((a, [, n]) => a + n, 0) : null;
  const st = await getState(planId + ':todoist');
  const created = Object.values(st?.weeks || {}).flatMap((w) => w.tasks || []).filter((t) => t.at >= from && t.at < to);
  const nums = `${MONTHS[monthIndex]} ${y}: ${computeMetric('emails', data, from, to)} emails sent, ${computeMetric('replies', data, from, to)} replies, ${computeMetric('contacts', data, from, to)} new contacts, ${computeMetric('wonDeals', data, from, to)} deals won, revenue ${money(computeMetric('revenue', data, from, to), s.currency)}${tasksDone != null ? `, ${tasksDone} Todoist tasks done` : ''}. Plan tasks Pitchbird created: ${created.length} (${created.filter((t) => t.done).length} done).`;
  const mo = (plan.months || {})[mKey(monthIndex)] || {};
  const system = `You draft a short, honest monthly review for ${who(s)}. Use only the facts given. First person, plain words. Reply with JSON only.`;
  const user = `${planContext(plan, three, data, s.currency, Math.min(Date.now(), to - DAY))}\n\nThis month's priorities: ${mo.priorities || '—'}\nNumbers: ${nums}\nTasks created from the plan: ${created.map((t) => `${t.done ? '✓' : '✗'} ${t.content}`).join('; ') || 'none'}\n\nReturn {"achieved":"<2-3 sentences>","slipped":"<1-2 sentences>","learned":"<1-2 sentences>","next":"<3 priorities for next month, separated by newlines>"}`;
  const j = jsonOf(await claude(s, { system, user, maxTokens: 700 }));
  return { achieved: String(j.achieved || ''), slipped: String(j.slipped || ''), learned: String(j.learned || ''), next: String(j.next || '') };
}

// ---------------- 3. ask the assistant ----------------
export async function ask(planId, question) {
  const { leads, deals, s } = await loadData();
  const plans = await getPlans();
  const { year, three } = activePlans(plans);
  const plan = plans.find((p) => p.id === planId) || year || three;
  const key = (plan?.id || 'none') + ':chat';
  const chat = (await getState(key))?.items || [];
  const brief = (await getBriefs())[0];
  const system = `You are the planning assistant of ${who(s)}. Answer their question about their plan and business directly, with numbers where you have them, in under 160 words. If something is uncertain, say what it depends on. Plain text, no markdown headings.`;
  const user = `${planContext(plan?.type === '3year' ? year : plan, three, { leads, deals }, s.currency)}\n\n${numbers({ leads, deals })}${brief ? `\n\nLatest market brief (${brief.month}): ${brief.text.slice(0, 1500)}` : ''}\n\nEarlier questions: ${chat.slice(-3).map((c) => `Q: ${c.q} A: ${c.a.slice(0, 300)}`).join(' | ') || 'none'}\n\nQuestion: ${question}`;
  const a = await claude(s, { system, user, maxTokens: 700 });
  await setState(key, { items: [...chat, { q: question, a, at: Date.now() }].slice(-10) });
  return a;
}

// ---------------- 4. weekly Todoist tasks from the plan ----------------
function weekDays(start) { return [0, 1, 2, 3, 4].map((i) => ymd(new Date(start + 'T12:00').getTime() + i * DAY)); }

export async function planTasks(planId, { force = false, deviceId = '' } = {}) {
  const { leads, deals, s } = await loadData();
  if (!s.todoistToken) throw new Error('Connect Todoist in Settings first.');
  const plans = await getPlans();
  const plan = plans.find((p) => p.id === planId);
  if (!plan) throw new Error('Plan not found.');
  const { three } = activePlans(plans);
  const key = plan.id + ':todoist';
  const st = (await getState(key)) || { weeks: {}, sections: {} };
  const wk = weekKey();
  if (!force && st.weeks?.[wk]?.tasks?.length) return st.weeks[wk];
  // what happened to last week's tasks
  const cache = await todoist.refresh({ force: true }).catch(() => todoist.getCache());
  const open = new Set((cache?.pending || []).map((t) => t.id));
  for (const w of Object.values(st.weeks || {})) for (const t of w.tasks || []) if (t.id && (t.at || 0) < (cache?.at || 0) - 5000 && !open.has(t.id)) t.done = true;
  const prev = Object.entries(st.weeks || {}).filter(([k]) => k < wk).sort().slice(-1)[0]?.[1];
  const days = weekDays(wk);
  const today = ymd();
  const usable = days.filter((d) => d >= today);
  const m = new Date().getMonth();
  const monthEnd = new Date(new Date().getFullYear(), m + 1, 0);
  const endKey = ymd(monthEnd.getTime());
  const reviewThisWeek = endKey <= days[4] && endKey >= days[0];
  const system = `You turn ${who(s)}'s plan into this week's to-do list. Write 4–7 concrete, doable tasks (each finishable in under 2 hours, starting with a verb, specific: who/what/how many). Favour goals that are behind and this month's priorities. Include at most one personal-goal task if personal goals exist. Don't repeat tasks that are already done. Reply with JSON only.`;
  const user = `Today: ${new Date().toDateString()}. Work days left this week: ${usable.join(', ') || days[4]}.\n\n${planContext(plan, three, { leads, deals }, s.currency)}\n\n${numbers({ leads, deals })}\n\nLast week's plan tasks: ${prev?.tasks?.map((t) => `${t.done ? '✓' : '✗ (not done)'} ${t.content}`).join('; ') || 'none'}\n\nReturn {"tasks":[{"content":"<max 12 words>","goal":"<goal title it serves>","day":"<one of the dates above>"}]}`;
  const j = jsonOf(await claude(s, { system, user, maxTokens: 900 }));
  let tasks = (j.tasks || []).filter((t) => t && t.content).slice(0, 7).map((t) => ({ content: String(t.content).slice(0, 140), goal: String(t.goal || '').slice(0, 100), day: (usable.includes(t.day) ? t.day : usable[0] || days[4]) }));
  if (reviewThisWeek) tasks.push({ content: `Monthly review: ${MONTHS[m]} in Pitchbird ▸ Planning`, goal: 'Review', day: endKey });
  if (reviewThisWeek && [2, 5, 8, 11].includes(m)) tasks.push({ content: `Quarter re-plan: set next quarter's milestones in Pitchbird`, goal: 'Review', day: endKey });
  // put them in Todoist: project "<plan> Plan", section per month
  const projectName = `${plan.name} Plan`;
  const projectId = await todoist.ensureProject(projectName, st.projectId);
  const secName = MONTHS[m];
  const sectionId = await todoist.ensureSection(projectId, secName, st.sections?.[secName]);
  const made = [];
  for (const t of tasks) {
    try {
      const r = await todoist.createTask({ content: t.content, description: `From your Pitchbird plan${t.goal ? ` · Goal: ${t.goal}` : ''}`, projectId, sectionId, dueDate: t.day });
      made.push({ ...t, id: r.id, at: Date.now(), done: false });
    } catch (e) { made.push({ ...t, id: '', error: e.message, at: Date.now() }); }
  }
  const weeks = { ...(st.weeks || {}), [wk]: { tasks: made, at: Date.now(), by: deviceId } };
  for (const k of Object.keys(weeks).sort().slice(0, -26)) delete weeks[k]; // keep half a year
  await setState(key, { ...st, projectId, sections: { ...(st.sections || {}), [secName]: sectionId }, weeks });
  todoist.refresh({ force: true }).catch(() => {});
  return weeks[wk];
}
export async function refreshTaskStatus(planId) {
  const key = planId + ':todoist';
  const st = await getState(key);
  if (!st) return null;
  const cache = await todoist.getCache();
  if (!cache?.pending) return st;
  const open = new Set(cache.pending.map((t) => t.id));
  let changed = false;
  // only trust a task list fetched after the task was made
  for (const w of Object.values(st.weeks || {})) for (const t of w.tasks || []) if (t.id && !t.done && (t.at || 0) < (cache.at || 0) - 5000 && !open.has(t.id)) { t.done = true; changed = true; }
  return changed ? setState(key, st) : st;
}

// ---------------- 5. market brief ----------------
export async function getBriefs() {
  const { marketBriefs } = await chrome.storage.local.get('marketBriefs');
  return (marketBriefs || []).filter((b) => !b.deleted).sort((a, b) => (b.at || 0) - (a.at || 0));
}
async function saveBrief(b) {
  const { marketBriefs = [] } = await chrome.storage.local.get('marketBriefs');
  const i = marketBriefs.findIndex((x) => x.id === b.id);
  const out = { ...b, updatedAt: Date.now() };
  if (i >= 0) marketBriefs[i] = out; else marketBriefs.push(out);
  await chrome.storage.local.set({ marketBriefs: marketBriefs.sort((a, c) => (c.at || 0) - (a.at || 0)).slice(0, 24) });
  return out;
}
// your own results by industry and track (what replies, what converts)
export function ownResults(leads, deals, now = Date.now()) {
  const since = now - 180 * DAY;
  const rows = {};
  for (const l of leads) {
    const sent = (l.emailsSent || []).filter((e) => (typeof e.date === 'number' ? e.date : Date.parse(e.date)) >= since);
    if (!sent.length) continue;
    const ind = INDUSTRIES[detectIndustry(l)]?.label || 'Other';
    const track = crm.contactType(l) === 'FC-Prospect' ? 'Full Cycle' : 'Sourcer';
    const k = `${track} · ${ind}`;
    const r = rows[k] || (rows[k] = { contacted: 0, replied: 0, won: 0 });
    r.contacted++;
    if (l.repliedAt) r.replied++;
    if (deals.some((d) => d.leadId === l.id && d.status === 'won')) r.won++;
  }
  return Object.entries(rows).sort((a, b) => b[1].contacted - a[1].contacted).slice(0, 14)
    .map(([k, r]) => `${k}: ${r.contacted} contacted, ${r.replied} replied (${Math.round((r.replied / r.contacted) * 100)}%), ${r.won} won`).join('\n');
}
export const monthId = (t = Date.now()) => ymd(t).slice(0, 7);

export async function marketBrief({ force = false } = {}) {
  const { leads, deals, s } = await loadData();
  const id = 'mb-' + monthId();
  const have = (await getBriefs()).find((b) => b.id === id);
  if (have && !force) return have;
  const { year, three } = activePlans(await getPlans());
  const system = `You are a market analyst for ${who(s)}. Research the current market with web search (staffing & recruiting, RPO, offshore recruiting support, US/Canada hiring demand by industry, competitor offshore sourcer pricing, new services clients buy). Then combine it with the company's own outreach results to say where the business should focus to grow. Be specific, cite real recent facts (with the source name and month), never invent numbers. Final answer: JSON only.`;
  const user = `Today: ${new Date().toDateString()}\n\nTheir plan:\n${planContext(year, three, { leads, deals }, s.currency) || '(no plan yet)'}\n\nTheir own results (last 6 months, by track and industry):\n${ownResults(leads, deals) || '(not enough outreach data yet)'}\n\nReturn {"summary":"<5-7 sentence brief: what's happening in the market that matters to them, with sources>","signals":["<4-6 short market facts with source + month>"],"opportunities":[{"title":"<max 10 words>","why":"<max 35 words, combine market + their results>","impact":"high|medium|low","effort":"high|medium|low"}],"avoid":"<one thing to stop or avoid, max 30 words>"}`;
  const text = await claude(s, { system, user, maxTokens: 2500, model: s.aiModel || 'claude-sonnet-5-5', tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }] });
  const j = jsonOf(text);
  return saveBrief({
    id, month: monthId(), at: Date.now(),
    summary: String(j.summary || ''), signals: (j.signals || []).slice(0, 8).map(String),
    opportunities: (j.opportunities || []).slice(0, 6).map((o) => ({ id: uid(), title: String(o.title || ''), why: String(o.why || ''), impact: String(o.impact || 'medium'), effort: String(o.effort || 'medium') })),
    avoid: String(j.avoid || ''),
    text: [j.summary, ...(j.signals || [])].join('\n'),
  });
}

// ---------------- background: runs every hour ----------------
// One laptop does the weekly / monthly AI work; the others see the result through sync.
async function claim(key, sync, deviceId) {
  const cur = await getState(key);
  if (cur?.by && cur.by !== deviceId && Date.now() - (cur.at || 0) < 30 * 60000) return false;
  await setState(key, { by: deviceId, at: Date.now() });
  await sync?.syncNow?.().catch(() => {});
  await new Promise((r) => setTimeout(r, 12000));
  await sync?.syncNow?.().catch(() => {});
  return (await getState(key))?.by === deviceId;
}
export async function tick({ sync, deviceId } = {}) {
  const s = await store.getSettings();
  if (!s.anthropicKey) return;
  const now = new Date();
  if (now.getHours() < 8) return; // not before 8 am
  const plans = await getPlans();
  const { year, three } = activePlans(plans);
  const plan = year || three;
  if (plan) {
    const wk = weekKey();
    const coach = await getState(plan.id + ':coach');
    if (coach?.week !== wk && await claim(`lock:${plan.id}:coach:${wk}`, sync, deviceId)) await weeklyFocus().catch(() => {});
    if (year && year.autoTasks !== false && s.todoistToken && now.getDay() >= 1 && now.getDay() <= 5 && Date.now() >= periodOf(year).from - 31 * DAY) {
      const st = await getState(year.id + ':todoist');
      if (!st?.weeks?.[wk]?.tasks?.length && await claim(`lock:${year.id}:tasks:${wk}`, sync, deviceId)) await planTasks(year.id, { deviceId }).catch(() => {});
      else refreshTaskStatus(year.id).catch(() => {});
    }
  }
  // market brief: once a month, on a weekday
  if (now.getDay() >= 1 && now.getDay() <= 5 && s.marketBrief !== false) {
    const id = 'mb-' + monthId();
    if (!(await getBriefs()).some((b) => b.id === id) && await claim(`lock:${id}`, sync, deviceId)) await marketBrief().catch((e) => setState('brief:error', { msg: e.message, at: Date.now() }));
  }
}
