// Productivity score (0–100) per working day, from data Pitchbird already has:
//   focus time on work sites (activity tracker) · Todoist tasks completed · outreach touches · low distraction.
// Parts with no data source (tracker off, Todoist not connected) are left out and the rest is scaled up to 100.
import * as tracker from './tracker.js';

export const DEFAULT_TARGETS = { focusH: 6, tasks: 6, touches: 25, distractPct: 5 };
const W = { focus: 40, tasks: 25, touches: 25, calm: 10 };

const clamp = (x) => Math.max(0, Math.min(1, x));
const ts = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);

// the last n Mon–Fri day keys ending today (or the last weekday), oldest first
export function workingDays(n, from = Date.now()) {
  const out = [];
  const d = new Date(from); d.setHours(12, 0, 0, 0);
  while (out.length < n) {
    if (d.getDay() !== 0 && d.getDay() !== 6) out.unshift(tracker.dayKey(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

// outreach you did yourself that day: first emails (not automatic follow-ups) + logged calls, meetings, LinkedIn, notes
export function touchesByDay(leads) {
  const by = {};
  const add = (t) => { if (t) { const k = tracker.dayKey(t); by[k] = (by[k] || 0) + 1; } };
  for (const l of leads) {
    for (const e of l.emailsSent || []) if (!e.followUp) add(ts(e.date));
    for (const a of l.activities || []) add(ts(a.at));
  }
  return by;
}

export function scoreDay({ sum, tasks, touches }, t = DEFAULT_TARGETS, has = { tracker: true, todoist: true }) {
  const parts = {};
  if (has.tracker && sum && sum.active > 0) {
    parts.focus = { pts: W.focus * clamp(sum.productive / (t.focusH * 60)), max: W.focus, value: sum.productive };
    const pct = sum.active ? (sum.distracting / sum.active) * 100 : 0;
    parts.calm = { pts: W.calm * clamp((20 - pct) / Math.max(1, 20 - t.distractPct)), max: W.calm, value: Math.round(pct) };
  } else if (has.tracker) {
    parts.focus = { pts: 0, max: W.focus, value: 0 };
    parts.calm = { pts: 0, max: W.calm, value: null };
  }
  if (has.todoist) parts.tasks = { pts: W.tasks * clamp(tasks / t.tasks), max: W.tasks, value: tasks };
  parts.touches = { pts: W.touches * clamp(touches / t.touches), max: W.touches, value: touches };
  const max = Object.values(parts).reduce((a, p) => a + p.max, 0);
  const got = Object.values(parts).reduce((a, p) => a + p.pts, 0);
  return { score: max ? Math.round((got / max) * 100) : 0, parts };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Everything the strip shows. `days` = 10 shown + 10 before them for the trend.
export async function build({ leads, todoist, settings }) {
  const t = { ...DEFAULT_TARGETS, ...(settings.prodTargets || {}) };
  const has = { tracker: settings.trackingEnabled !== false, todoist: !!settings.todoistToken && !!todoist?.at };
  const keys = workingDays(20);
  const touches = touchesByDay(leads);
  const today = tracker.dayKey(Date.now());
  const opts = { workStart: settings.workStart || '09:00', workEnd: settings.workEnd || '19:00' };
  const rows = [];
  for (const k of keys) {
    let sum = null;
    if (has.tracker) {
      const day = await tracker.getCombinedDay(k);
      const upTo = k === today ? new Date().getHours() * 60 + new Date().getMinutes() : 1440;
      sum = tracker.summarize(day, { ...opts, upTo });
    }
    const tasks = (todoist?.doneByDay || {})[k] || 0;
    const r = scoreDay({ sum, tasks, touches: touches[k] || 0 }, t, has);
    const top = sum?.cats?.find((c) => c.kind === 'productive');
    rows.push({ key: k, today: k === today, ...r, focusMin: sum?.productive || 0, tasks, touches: touches[k] || 0,
      distractPct: sum && sum.active ? Math.round((sum.distracting / sum.active) * 100) : null, top: top ? `${top.cat} ${(top.minutes / 60).toFixed(1)} h` : '' });
  }
  const cur = rows.slice(10), prev = rows.slice(0, 10);
  // today is still in progress: leave it out of averages and streaks until it beats yesterday's pace
  const done = cur.filter((r) => !r.today);
  const stat = (list, f) => avg(list.map(f));
  const s = {
    avg: Math.round(stat(done, (r) => r.score)), prevAvg: Math.round(stat(prev, (r) => r.score)),
    focusH: stat(done, (r) => r.focusMin) / 60, prevFocusH: stat(prev, (r) => r.focusMin) / 60,
    tasks: stat(done, (r) => r.tasks), prevTasks: stat(prev, (r) => r.tasks),
    touches: stat(done, (r) => r.touches), prevTouches: stat(prev, (r) => r.touches),
    distract: stat(done.filter((r) => r.distractPct != null), (r) => r.distractPct), prevDistract: stat(prev.filter((r) => r.distractPct != null), (r) => r.distractPct),
  };
  let streak = 0;
  for (const r of [...cur].reverse()) { if (r.today && r.score < 60) continue; if (r.score >= 60) streak++; else break; }
  const best = done.reduce((b, r) => (!b || r.score > b.score ? r : b), null);
  return { rows: cur, ...s, streak, best, has, targets: t };
}
