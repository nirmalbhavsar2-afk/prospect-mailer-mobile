// "Today's focus": Claude picks the 3 Todoist tasks that matter most today, using your tasks plus
// what's going on in the CRM (open deals, follow-ups due, people who replied).
import * as store from './store.js';
import * as crm from './crm.js';
import * as todoist from './todoist.js';

const DAY = 864e5;
const prio = (p) => ({ 4: 'P1', 3: 'P2', 2: 'P3' }[p] || 'P4');

export async function getFocus() {
  const { todoistFocus } = await chrome.storage.local.get('todoistFocus');
  return todoistFocus || null;
}

// Tasks that need attention today: overdue + due today (the headline counts these).
export function todayList(pending) {
  return pending.filter((t) => t.overdueDays || t.dueToday);
}

export function fallbackPicks(pending) {
  return todoist.rankPending(pending).slice(0, 3).map((t) => ({
    id: t.id,
    why: t.overdueDays ? `Overdue ${t.overdueDays} day${t.overdueDays === 1 ? '' : 's'}${t.priority >= 3 ? ', marked high priority' : ''}.`
      : t.dueToday ? 'Due today.' : `Waiting ${t.ageDays} days.`,
  }));
}

// (pure, so the phone app can use it with its own copy of the data)
export function crmContextFrom(s, leads, deals) {
  const m = crm.metrics({ leads, deals, stages: crm.stagesOf(s) });
  const name = (l) => [l.firstName, l.lastName].filter(Boolean).join(' ') || l.email || '';
  return {
    open_deals: deals.filter((d) => d.status === 'open').slice(0, 15).map((d) => `${d.title} (${crm.money(d.amount, s.currency || 'USD')})`),
    follow_ups_due: m.attention.dueFollowUps.slice(0, 10).map((f) => `${name(f.lead)}${f.lead.company ? ' at ' + f.lead.company : ''}`),
    replied_no_deal: m.attention.repliedNoDeal.slice(0, 10).map((l) => `${name(l)}${l.company ? ' at ' + l.company : ''}`),
  };
}

async function crmContext() {
  const s = await store.getSettings();
  const [leads, deals] = await Promise.all([store.getLeads(), crm.getDeals()]);
  return crmContextFrom(s, leads, deals);
}

// Today's tasks first, then the longest-waiting undated ones.
export function candidates(pending) {
  return [...todayList(pending), ...todoist.rankPending(pending).filter((t) => !t.overdueDays && !t.dueToday)].slice(0, 60);
}

export async function askClaude(s, tasks, ctx) {
  const system = `You help ${s.senderName || 'a busy founder'} (recruiting / RPO / KPO business owner) decide what to do first today. From their Todoist tasks, pick exactly the 3 that deserve attention first. Weigh: business impact (revenue, clients, deals, hiring partners), how overdue it is, priority (P1 highest), how long it has waited, deadlines, and links to the CRM context. Prefer tasks that unblock other people or money. Do not pick vague routine tasks over important overdue ones. Reply with JSON only.`;
  const user = `Today: ${new Date().toDateString()}
Tasks (id | task | project | priority | status):
${tasks.map((t) => `${t.id} | ${t.content} | ${t.project || '-'} | ${prio(t.priority)} | ${t.overdueDays ? `overdue ${t.overdueDays}d` : t.dueToday ? 'due today' : t.due ? 'due ' + t.dueLabel : 'no date'}${t.ageDays != null ? `, open ${t.ageDays}d` : ''}${t.recurring ? ', repeats' : ''}`).join('\n')}

CRM context: ${JSON.stringify(ctx)}

Return: {"picks":[{"id":"<task id>","why":"<max 16 words, specific reason>"}], "headline":"<max 10 words on today's task load>"}`;
  const model = s.aiModel || 'claude-sonnet-5-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model, max_tokens: 500, system, messages: [{ role: 'user', content: user }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'Claude API key was rejected.' : 'Claude: ' + (body.error?.message || res.status));
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const ids = new Set(tasks.map((t) => t.id));
  const picks = (j.picks || []).filter((p) => p && ids.has(String(p.id))).slice(0, 3).map((p) => ({ id: String(p.id), why: String(p.why || '').slice(0, 160) }));
  if (!picks.length) throw new Error('Claude did not pick any tasks.');
  return { picks, note: String(j.headline || '').slice(0, 90) };
}

// Rebuild only when the task list changed and it's been a while (new tabs open often).
let busy = null;
export async function refresh({ force = false } = {}) {
  if (busy) return busy;
  busy = (async () => {
    const s = await store.getSettings();
    if (!s.todoistToken) return null;
    const view = s.todoistView || todoist.DEFAULT_VIEW;
    const cache = todoist.applyView(await todoist.refresh(), view);
    const pending = cache.pending || [];
    const today = todayList(pending);
    // candidates: today's tasks first, then the longest-waiting undated ones
    const cands = candidates(pending);
    const key = view + '|' + cands.map((t) => t.id).sort().join(',');
    const prev = await getFocus();
    const fresh = prev && prev.key === key && Date.now() - prev.at < 6 * 3600e3 && new Date(prev.at).toDateString() === new Date().toDateString();
    const recent = prev && prev.view === view && Date.now() - prev.at < 20 * 60000 && new Date(prev.at).toDateString() === new Date().toDateString();
    if (!force && (fresh || recent)) return prev;
    let out = { picks: fallbackPicks(pending), note: '', by: 'rules' };
    if (s.anthropicKey && cands.length) {
      try { out = { ...(await askClaude(s, cands, await crmContext())), by: 'claude' }; } catch (e) { out.error = e.message; }
    }
    const byId = Object.fromEntries(pending.map((t) => [t.id, t]));
    const focus = {
      at: Date.now(), key, view, by: out.by, error: out.error || '', note: out.note || '',
      dueToday: pending.filter((t) => t.dueToday).length,
      overdue: pending.filter((t) => t.overdueDays).length,
      open: pending.length,
      picks: out.picks.filter((p) => byId[p.id]).map((p) => ({ ...p, task: byId[p.id] })),
    };
    await chrome.storage.local.set({ todoistFocus: focus });
    return focus;
  })().finally(() => { busy = null; });
  return busy;
}
