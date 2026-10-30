// Todoist: your open tasks, tasks done per day, and a digest for the daily summary.
// Uses Todoist's API v1 with your personal API token (Todoist ▸ Settings ▸ Integrations ▸ Developer).
import * as store from './store.js';

const API = 'https://api.todoist.com/api/v1';
const DAY = 864e5;
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function call(token, path, { method = 'GET', body } = {}) {
  if (!token) throw new Error('Add your Todoist API token in Settings ▸ Todoist first.');
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('Could not reach Todoist — check your internet connection.'); }
  if (res.status === 401 || res.status === 403) throw new Error('Todoist rejected the API token — copy it again from Todoist ▸ Settings ▸ Integrations ▸ Developer.');
  if (res.status === 204) return {};
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* keep empty */ }
  if (!res.ok) throw new Error('Todoist: ' + (json.error || json.message || res.status));
  return json;
}

// Follow next_cursor pages (v1 returns { results | items, next_cursor }).
async function all(token, path, key) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 25; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await call(token, path + sep + 'limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    const items = r[key] || r.results || r.items || (Array.isArray(r) ? r : []);
    out.push(...items);
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  return out;
}

const tokenOf = async () => (await store.getSettings()).todoistToken || '';

export async function test(token) {
  const projects = await all(token, '/projects', 'results');
  return { projects: projects.length };
}

// The due day as a local timestamp (midnight), or 0.
function dueAt(t) {
  const d = t.due && (t.due.date || t.due.datetime);
  if (!d) return 0;
  const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, dd).getTime();
}

export function shapeTask(t, projects = {}, now = Date.now()) {
  const added = Date.parse(t.added_at || t.created_at || '') || 0;
  const due = dueAt(t);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return {
    id: String(t.id),
    content: String(t.content || '').slice(0, 300),
    project: projects[t.project_id] || '',
    projectId: String(t.project_id || ''),
    priority: Number(t.priority) || 1, // 4 = urgent (P1 in the app)
    added,
    ageDays: added ? Math.max(0, Math.floor((now - added) / DAY)) : null,
    due,
    dueLabel: t.due ? (t.due.string || String(t.due.date || '').slice(0, 10)) : '',
    overdueDays: due && due < today.getTime() ? Math.round((today.getTime() - due) / DAY) : 0,
    dueToday: due === today.getTime(),
    recurring: !!(t.due && t.due.is_recurring),
    url: `https://app.todoist.com/app/task/${t.id}`,
  };
}


// Pure: turn raw API v1 results into the cache the dashboard, top 3 and summary read (phone app uses it too).
export function buildCache({ projects = [], tasks = [], done = [] }, now = Date.now()) {
  const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const projList = projects.filter((p) => !p.is_archived && !p.is_deleted).map((p) => ({ id: String(p.id), name: p.name, inbox: !!(p.inbox_project || p.is_inbox_project) || (p.name === 'Inbox' && !p.parent_id) }));
  const doneByDay = {};
  const doneToday = [];
  const doneList = [];
  for (const d of done) {
    const at = Date.parse(d.completed_at || d.completed_date || '') || 0;
    if (!at) continue;
    const k = dayKey(at);
    doneByDay[k] = (doneByDay[k] || 0) + 1;
    if (k === dayKey(now)) doneToday.push(String(d.content || '').slice(0, 200));
    doneList.push({ at, projectId: String(d.project_id || ''), content: String(d.content || '').slice(0, 200), hadDue: !!(d.due && (d.due.date || d.due.datetime)) });
  }
  const inboxIds = new Set(projList.filter((p) => p.inbox).map((p) => p.id));
  const pending = tasks.filter((t) => !t.checked && !t.is_deleted).map((t) => ({ ...shapeTask(t, names, now), inbox: inboxIds.has(String(t.project_id)) }));
  return { at: now, pending, projects: projList, done: doneList, doneByDay, doneToday, error: '' };
}

// Pull everything and keep a local copy (dashboard + daily report read this).
let refreshing = null;
export async function refresh({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const token = await tokenOf();
    const cur = await getCache();
    if (!token) return cur;
    if (!force && Date.now() - (cur.at || 0) < 5 * 60000) return cur;
    try {
      const [projects, tasks] = await Promise.all([all(token, '/projects', 'results'), all(token, '/tasks', 'results')]);
      const now = Date.now();
      const start = new Date(now - 20 * DAY); start.setHours(0, 0, 0, 0);
      let done = [];
      try {
        done = await all(token, `/tasks/completed/by_completion_date?since=${encodeURIComponent(start.toISOString())}&until=${encodeURIComponent(new Date(now + 60000).toISOString())}`, 'items');
      } catch (e) { /* history is a nice-to-have; keep the task list */ }
      const cache = buildCache({ projects, tasks, done }, now);

      await chrome.storage.local.set({ todoist: cache });
      return cache;
    } catch (e) {
      const cache = { ...cur, error: e.message, errorAt: Date.now() };
      await chrome.storage.local.set({ todoist: cache });
      return cache;
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function getCache() {
  const { todoist } = await chrome.storage.local.get('todoist');
  return { at: 0, pending: [], doneByDay: {}, doneToday: [], error: '', ...(todoist || {}) };
}

export async function close(id) {
  await call(await tokenOf(), `/tasks/${encodeURIComponent(id)}/close`, { method: 'POST' });
  return refresh({ force: true });
}
export async function add(content, dueString, projectId) {
  const body = { content };
  if (dueString) body.due_string = dueString;
  if (projectId) body.project_id = projectId;
  await call(await tokenOf(), '/tasks', { method: 'POST', body });
  return refresh({ force: true });
}

// What needs attention, oldest first: overdue, due today, then undated tasks that have been sitting longest.
export function rankPending(pending) {
  const score = (t) => (t.overdueDays ? 3e6 + t.overdueDays * 1000 : t.dueToday ? 2e6 : !t.due ? 1e6 : 0) + (t.ageDays || 0) * 10 + t.priority * 15;
  return [...pending].filter((t) => t.overdueDays || t.dueToday || !t.due).sort((a, b) => score(b) - score(a));
}

// ---------- views: "Inbox + Today" (default), one project, or everything ----------
export const DEFAULT_VIEW = 'inbox-today';
export function viewOptions(cache) {
  const projects = (cache.projects || []).filter((p) => !p.inbox);
  return [['inbox-today', 'Inbox + Today'], ...projects.map((p) => ['p:' + p.id, p.name]), ['all', 'All projects']];
}
export function viewName(cache, view) {
  return (viewOptions(cache).find(([v]) => v === view) || viewOptions(cache)[0])[1];
}
// The same cache, narrowed to one view (tasks, tasks-done history and today's done list).
export function applyView(cache, view = DEFAULT_VIEW) {
  if (!cache || view === 'all') return cache;
  const inbox = new Set((cache.projects || []).filter((p) => p.inbox).map((p) => p.id));
  const hasProject = view.startsWith('p:') && (cache.projects || []).some((p) => 'p:' + p.id === view);
  const v = hasProject ? view : DEFAULT_VIEW;
  const keepTask = v === DEFAULT_VIEW ? (t) => t.inbox || t.overdueDays || t.dueToday : (t) => 'p:' + t.projectId === v;
  const keepDone = v === DEFAULT_VIEW ? (d) => inbox.has(d.projectId) || d.hadDue : (d) => 'p:' + d.projectId === v;
  const out = { ...cache, view: v, pending: (cache.pending || []).filter(keepTask) };
  if (Array.isArray(cache.done)) {
    const today = dayKey(Date.now());
    out.doneByDay = {};
    out.doneToday = [];
    for (const d of cache.done.filter(keepDone)) {
      const k = dayKey(d.at);
      out.doneByDay[k] = (out.doneByDay[k] || 0) + 1;
      if (k === today) out.doneToday.push(d.content);
    }
  }
  return out;
}
export async function viewed() {
  const s = await store.getSettings();
  const c = await getCache();
  return applyView(c, s.todoistView || DEFAULT_VIEW);
}

// Small, report-friendly summary (goes into the daily email and the cloud script).
export function digest(cache, now = Date.now()) {
  const p = cache.pending || [];
  const ranked = rankPending(p);
  const last7 = [];
  for (let i = 6; i >= 0; i--) { const k = dayKey(now - i * DAY); last7.push({ date: k, done: (cache.doneByDay || {})[k] || 0 }); }
  return {
    open: p.length,
    overdue: p.filter((t) => t.overdueDays).length,
    dueToday: p.filter((t) => t.dueToday).length,
    doneToday: (cache.doneByDay || {})[dayKey(now)] || 0,
    doneTodayList: (cache.doneToday || []).slice(0, 8),
    done7: last7.reduce((s, x) => s + x.done, 0),
    last7,
    waiting: ranked.slice(0, 10).map((t) => ({ content: t.content, project: t.project, ageDays: t.ageDays, overdueDays: t.overdueDays, dueToday: t.dueToday, dueLabel: t.dueLabel, priority: t.priority })),
    oldestDays: Math.max(0, ...p.map((t) => t.ageDays || 0)),
    updatedAt: cache.at || 0,
  };
}

export async function forReport() {
  const s = await store.getSettings();
  if (!s.todoistToken || s.todoistInReport === false) return null;
  const cache = await refresh();
  if (!cache.at) return null;
  const v = applyView(cache, s.todoistView || DEFAULT_VIEW);
  return { ...digest(v), view: viewName(cache, s.todoistView || DEFAULT_VIEW) };
}
