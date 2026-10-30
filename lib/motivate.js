// One motivating line for the top of the dashboard, written by Claude from your real numbers:
// yesterday and last week (focus time, outreach, score), your Todoist load, what you planned for today,
// and the pipeline. Refreshed a couple of times a day, not on every new tab.
import * as store from './store.js';
import * as crm from './crm.js';
import * as report from './report.js';
import * as periods from './periods.js';
import * as todoist from './todoist.js';

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const h = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m || 0)}m`);

export async function get() {
  const { motivation } = await chrome.storage.local.get('motivation');
  return motivation || null;
}

async function gather() {
  const s = await store.getSettings();
  const [leads, deals] = await Promise.all([store.getLeads(), crm.getDeals()]);
  const sums = await periods.getSummaries().catch(() => ({}));
  const reports = await report.getReports().catch(() => ({}));
  const tdc = s.todoistToken ? await todoist.viewed() : null;
  return gatherFrom({ s, leads, deals, sums, reports, tdView: tdc && tdc.at ? tdc : null });
}

// Pure: build the facts Claude writes from (also used by the phone app with its own data).
export function gatherFrom({ s, leads, deals, sums = {}, reports = {}, tdView = null }) {
  const now = Date.now();
  const yKey = dayKey(now - 864e5), today = dayKey(now);
  const y = sums[yKey];
  const week = [];
  for (let i = 1; i <= 7; i++) { const k = dayKey(now - i * 864e5); if (sums[k] && sums[k].active) week.push(sums[k]); }
  const tot = (f) => week.reduce((a, d) => a + (f(d) || 0), 0);
  const m = crm.metrics({ leads, deals, stages: crm.stagesOf(s) });
  const td = tdView ? todoist.digest(tdView) : null;
  const yRep = reports[yKey];
  return {
    name: (s.senderName || '').split(' ')[0] || '',
    business: (s.aiPitch || '').slice(0, 400),
    today_weekday: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    yesterday: y ? { productive: h(y.productive), focus_pct: y.focusPct, off_focus: h(y.distracting), emails: y.work?.emailsSent, follow_ups: y.work?.followUpsSent, calls: y.work?.calls, score: y.score } : null,
    yesterday_headline: yRep?.ai?.headline || '',
    planned_for_today: yRep?.ai?.tomorrow || [],
    last_7_days: week.length ? { days_tracked: week.length, productive_total: h(tot((d) => d.productive)), avg_focus_pct: Math.round(tot((d) => d.focusPct) / week.length), emails: tot((d) => d.work?.emailsSent), follow_ups: tot((d) => d.work?.followUpsSent), replies: tot((d) => d.work?.repliesReceived), deals_won: tot((d) => d.work?.dealsWon) } : null,
    today_so_far: sums[today] ? { productive: h(sums[today].productive), emails: sums[today].work?.emailsSent } : null,
    todoist: td ? { open: td.open, overdue: td.overdue, due_today: td.dueToday, done_today: td.doneToday, done_last_7_days: td.done7, oldest_waiting: td.waiting.slice(0, 3).map((t) => t.content) } : null,
    pipeline: { open_deals: m.openCount, open_value: crm.money(m.openValue, s.currency || 'USD'), follow_ups_due: m.attention.dueFollowUps.length, replied_no_deal: m.attention.repliedNoDeal.length },
  };
}

function fallback(d) {
  if (d.todoist?.overdue) return `${d.todoist.overdue} overdue task${d.todoist.overdue === 1 ? '' : 's'} — clear one before lunch and the rest of the day gets lighter.`;
  if (d.pipeline.follow_ups_due) return `${d.pipeline.follow_ups_due} follow-up${d.pipeline.follow_ups_due === 1 ? '' : 's'} waiting — every reply starts with the next email you send.`;
  if (d.yesterday) return `Yesterday: ${d.yesterday.productive} of focused work. Beat it by one good hour today.`;
  return 'Small, steady outreach wins clients. Start with one message.';
}

let busy = null;
export async function refresh({ force = false } = {}) {
  if (busy) return busy;
  busy = (async () => {
    const prev = await get();
    const today = dayKey(Date.now());
    const s = await store.getSettings();
    // keep today's line for 5 hours — unless it was a stand-in written before a Claude key was added
    const upgrade = prev && prev.by !== 'claude' && s.anthropicKey && !(prev.error && Date.now() - prev.at < 20 * 60000);
    if (!force && prev && prev.date === today && Date.now() - prev.at < 5 * 3600e3 && !upgrade) return prev;
    const d = await gather();
    const { line, by, error } = await writeLine(s, d);
    const out = { date: today, at: Date.now(), line, by, error };
    await chrome.storage.local.set({ motivation: out });
    return out;
  })().finally(() => { busy = null; });
  return busy;
}

// Claude writes the line (falls back to a simple one). Pure apart from the API call.
export async function writeLine(s, d) {
  let line = fallback(d), by = 'rules', error = '';
  if (s.anthropicKey) {
    try {
      const system = 'You write one short, personal line of motivation for the top of a business owner\'s dashboard. It must be grounded in their real numbers below (yesterday, last week, tasks, plan, pipeline): celebrate a real win or name the one thing that matters most today, and push them forward. Warm, direct, specific, like a good coach. Max 24 words. No hashtags, no emojis, no quotation marks, no generic platitudes, no made-up facts. Reply with JSON only: {"line":"..."}';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: s.aiModel || 'claude-sonnet-5-5', max_tokens: 200, system, messages: [{ role: 'user', content: JSON.stringify(d) }] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 401 ? 'Claude API key was rejected.' : 'Claude: ' + (body.error?.message || res.status));
      const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      const l = String(j.line || '').replace(/^["“”']+|["“”']+$/g, '').trim();
      if (l) { line = l.slice(0, 220); by = 'claude'; }
    } catch (e) { error = e.message; }
  }
  return { line, by, error };
}
