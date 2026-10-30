// Home screen extras: motivation line, Claude's top 3, New York ⇄ India time, and Todoist tasks.
import * as D from './data.js';
import { rankPending, viewOptions } from './lib/todoist.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let showAll = false;
let tzPinned = null; // minutes past midnight in New York chosen with the slider (null = now)

// ---------- time zones ----------
const NY = 'America/New_York', IN = 'Asia/Kolkata';
function parts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { min: Number(p.hour) * 60 + Number(p.minute), day: `${p.year}-${p.month}-${p.day}` };
}
const tfmt = (d, tz) => d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
const tday = (d, tz) => d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
function nyMomentAt(min) { const now = new Date(); return new Date(now.getTime() + (min - parts(now, NY).min) * 60000 - now.getSeconds() * 1000); }
function trackCss() {
  const off = (parts(new Date(), IN).min - parts(new Date(), NY).min + 1440) % 1440;
  const st = [];
  for (let m = 0; m < 1440; m += 30) {
    const ny = m / 60, ind = ((m + off) % 1440) / 60;
    st.push(`${ny >= 9 && ny < 18 ? (ind >= 9 && ind < 22 ? '#3461ff' : '#a9bcff') : 'var(--line)'} ${(m / 1440) * 100}% ${((m + 30) / 1440) * 100}%`);
  }
  return `linear-gradient(90deg, ${st.join(',')})`;
}
function tzFill(box) {
  const at = tzPinned == null ? new Date() : nyMomentAt(tzPinned);
  const ny = parts(at, NY), ind = parts(at, IN);
  box.querySelector('[data-ny]').textContent = tfmt(at, NY);
  box.querySelector('[data-in]').textContent = tfmt(at, IN);
  box.querySelector('[data-ny-day]').textContent = tday(at, NY);
  box.querySelector('[data-in-day]').textContent = tday(at, IN) + (ind.day > ny.day ? ' · next day' : ind.day < ny.day ? ' · previous day' : '');
  box.querySelector('[data-note]').textContent = tzPinned == null ? 'Now · drag to pick a New York time' : `${tfmt(at, NY)} New York = ${tfmt(at, IN)} India${ind.day !== ny.day ? (ind.day > ny.day ? ' (next day)' : ' (previous day)') : ''}`;
  box.querySelector('[data-now]').hidden = tzPinned == null;
  const sl = box.querySelector('input[type=range]');
  if (tzPinned == null) sl.value = String(Math.floor(ny.min / 15) * 15);
}

// ---------- html ----------
export function extrasHtml() {
  const s = D.settings();
  const q = D.T.quote;
  const tz = `<div class="card tzc" id="h-tz">
      <div class="tz-row"><div><span class="tz-name">New York</span><b data-ny>—</b><span class="tz-day" data-ny-day></span></div>
      <span class="tz-arrow">⇄</span>
      <div class="r"><span class="tz-name">India</span><b data-in>—</b><span class="tz-day" data-in-day></span></div></div>
      <input type="range" min="0" max="1425" step="15" aria-label="New York time — drag to convert to India time" style="--tz-track:${trackCss()}">
      <div class="tz-scale"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span></div>
      <div class="tz-foot"><span data-note></span><button class="link" data-now hidden>Now</button></div>
    </div>`;
  if (!s.todoistToken) return `${q?.line ? quoteHtml(q) : ''}${tz}`;
  const v = D.todoistViewed();
  return `${q?.line ? quoteHtml(q) : ''}${focusHtml(v)}${tz}${todoistHtml(v)}`;
}
function quoteHtml(q) {
  return `<div class="mq" id="h-mq"><span>✨</span><span class="mq-line">${esc(q.line)}</span><button class="icon-btn mq-redo" data-mq-redo aria-label="New line">↻</button></div>`;
}
function viewSelect(id) {
  const raw = D.T.cache || { projects: [] };
  return `<select class="td-view" id="${id}" aria-label="Todoist board">${viewOptions(raw).map(([val, n]) => `<option value="${esc(val)}" ${val === D.todoistView() ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
}
function ageOf(t) {
  if (t.overdueDays) return `<span class="age over">overdue ${t.overdueDays}d</span>`;
  if (t.dueToday) return '<span class="age today">due today</span>';
  if (t.ageDays == null) return '';
  return `<span class="age ${t.ageDays >= 14 ? 'old' : ''}">waiting ${t.ageDays}d</span>`;
}
function focusHtml(v) {
  const f = D.T.focus;
  if (!v) return D.T.error ? `<div class="card"><h3>Today's focus</h3><div class="muted small">${esc(D.T.error)}</div></div>` : '<div class="card"><h3>Today\'s focus</h3><div class="spinner"></div></div>';
  const open = new Map((v.pending || []).map((t) => [t.id, t]));
  const picks = (f?.picks || []).filter((p) => open.has(p.id)).map((p) => ({ ...p, task: open.get(p.id) }));
  const dueToday = v.pending.filter((t) => t.dueToday).length, overdue = v.pending.filter((t) => t.overdueDays).length;
  return `<div class="card fx" id="h-focus">
    <div class="fx-head"><b class="fx-big">${dueToday} due today</b>${overdue ? `<span class="pill lost">${overdue} overdue</span>` : ''}<span class="spacer"></span><button class="icon-btn" data-fx-redo aria-label="Ask Claude again">↻</button></div>
    <div class="fx-sub">${viewSelect('h-fx-view')}<span class="muted small">${f?.by === 'claude' ? '✨ Top 3 by Claude' : 'Top 3'}</span></div>
    ${picks.length ? `<ol class="fx-list ${f && f.view !== D.todoistView() ? 'stale' : ''}">${picks.map((p) => `<li><button class="td-check p${p.task.priority}" data-td-close="${esc(p.id)}" aria-label="Mark done"></button><div><a href="${esc(p.task.url)}" target="_blank" rel="noopener">${esc(p.task.content)}</a><span class="fx-why">${esc(p.why)}</span></div></li>`).join('')}</ol>`
      : f ? '<div class="muted small">All caught up for today 🎉</div>' : '<div class="spinner"></div>'}
  </div>`;
}
function todoistHtml(v) {
  if (!v) return '';
  const isProject = String(v.view || '').startsWith('p:');
  const sortAll = (a) => [...a].sort((x, y) => (y.overdueDays - x.overdueDays) || (Number(y.dueToday) - Number(x.dueToday)) || ((x.due || 9e15) - (y.due || 9e15)) || ((y.ageDays || 0) - (x.ageDays || 0)));
  const list = showAll || isProject ? sortAll(v.pending) : rankPending(v.pending);
  const doneToday = (v.doneByDay || {})[new Date().toLocaleDateString('en-CA')] || 0;
  return `<div class="card" id="h-todoist">
    <h3>Todoist ${viewSelect('h-td-view')}</h3>
    <div class="muted small" style="margin:-4px 0 6px">${doneToday} done today · ${v.pending.length} open${isProject ? '' : ` · <button class="link" data-td-all>${showAll ? 'Show urgent only' : 'Show all'}</button>`}</div>
    <ul class="td-list">${list.slice(0, showAll || isProject ? 30 : 6).map((t) => `<li><button class="td-check p${t.priority}" data-td-close="${esc(t.id)}" aria-label="Mark done"></button><div class="m"><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.content)}</a><div class="meta">${ageOf(t)}${t.project && t.project !== 'Inbox' && !isProject ? `<span>${esc(t.project)}</span>` : ''}</div></div></li>`).join('') || `<li class="muted small">${v.pending.length ? 'Nothing overdue or due today 🎉' : 'No open tasks.'}</li>`}</ul>
    <form class="td-add" data-td-add><input name="t" placeholder="Add a task…" enterkeyhint="next"><input name="w" class="when" placeholder="When?" enterkeyhint="done"><button class="btn primary sm">Add</button></form>
    ${D.T.error ? `<div class="muted small" style="color:var(--danger)">${esc(D.T.error)}</div>` : ''}
  </div>`;
}

// ---------- behaviour ----------
export function wireExtras(v, toast) {
  const tz = v.querySelector('#h-tz');
  if (tz) {
    tzFill(tz);
    const sl = tz.querySelector('input[type=range]');
    sl.addEventListener('input', () => { tzPinned = Number(sl.value); tzFill(tz); });
    tz.querySelector('[data-now]').onclick = () => { tzPinned = null; tzFill(tz); };
  }
  v.querySelector('[data-mq-redo]')?.addEventListener('click', (e) => { e.currentTarget.classList.add('spin'); D.quoteLoad({ force: true }).catch(() => {}); });
  v.querySelector('[data-fx-redo]')?.addEventListener('click', (e) => { e.currentTarget.classList.add('spin'); D.focusLoad({ force: true }).catch(() => {}); });
  v.querySelectorAll('.td-view').forEach((sel) => sel.addEventListener('change', () => {
    showAll = false;
    D.setTodoistView(sel.value);
    sel.blur();
    D.focusLoad({ force: true }).catch(() => {});
  }));
  v.querySelector('[data-td-all]')?.addEventListener('click', () => { showAll = !showAll; D.T.cache = { ...D.T.cache }; v.querySelector('#h-todoist').outerHTML = todoistHtml(D.todoistViewed()); wireExtras(v, toast); });
  v.querySelectorAll('[data-td-close]').forEach((b) => b.addEventListener('click', async () => {
    b.classList.add('done'); b.disabled = true;
    try { await D.todoistClose(b.dataset.tdClose); D.focusLoad({ force: true }).catch(() => {}); toast('Done ✓'); }
    catch (e) { toast(e.message); b.classList.remove('done'); b.disabled = false; }
  }));
  v.querySelector('[data-td-add]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = e.target.querySelector('[name=t]'), when = e.target.querySelector('[name=w]'), btn = e.target.querySelector('button');
    const text = inp.value.trim();
    if (!text) return;
    btn.disabled = true;
    const view = D.todoistView();
    try { await D.todoistAdd(text, when.value.trim(), view.startsWith('p:') ? view.slice(2) : ''); inp.value = ''; when.value = ''; document.activeElement?.blur(); toast('Task added'); }
    catch (err) { toast(err.message); }
    btn.disabled = false;
  });
  // fetch in the background; each finishes by re-rendering Home
  if (D.settings().todoistToken) D.todoistLoad().then(() => { D.focusLoad().catch(() => {}); D.quoteLoad().catch(() => {}); }).catch(() => {});
  else D.quoteLoad().catch(() => {});
}
