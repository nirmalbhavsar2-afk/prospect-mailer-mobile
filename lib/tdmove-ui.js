// "Move to" picker for Todoist tasks — the same list Todoist shows: My Projects, each team with its
// folders, sub-projects indented and sections under their project. Plain DOM, used by the dashboard and the phone.
import { moveTargets } from './todoist.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let open = null;

const CSS = `
.tdm-pop { position: fixed; z-index: 2147483000; width: 320px; max-width: calc(100vw - 24px); max-height: min(460px, calc(100vh - 24px)); display: flex; flex-direction: column;
  background: #fff; color: #1d2226; border: 1px solid #e3e6ea; border-radius: 12px; box-shadow: 0 12px 32px rgba(15,23,42,.18); font: 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
.tdm-pop.sheet { left: 0 !important; right: 0; bottom: 0; top: auto !important; width: auto; max-width: none; max-height: 75vh; border-radius: 16px 16px 0 0; }
.tdm-top { padding: 10px 10px 6px; border-bottom: 1px solid #eef0f2; }
.tdm-title { font-size: 12px; color: #6b7280; margin: 0 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tdm-search { width: 100%; box-sizing: border-box; border: 1px solid #d9dde3; border-radius: 8px; padding: 7px 10px; font: inherit; outline: none; }
.tdm-search:focus { border-color: #3461ff; box-shadow: 0 0 0 3px rgba(52,97,255,.12); }
.tdm-list { overflow: auto; padding: 4px 0 8px; }
.tdm-group { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6b7280; padding: 10px 14px 4px; }
.tdm-item { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: none; text-align: left; font: inherit; color: inherit; padding: 7px 14px; cursor: pointer; }
.tdm-item:hover, .tdm-item.kb { background: #f2f5ff; }
.tdm-item[disabled] { cursor: default; color: #9aa3ad; background: none; }
.tdm-item .ic { width: 14px; text-align: center; color: #8a94a0; flex: none; }
.tdm-item .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tdm-item .cur { font-size: 11px; color: #3461ff; }
.tdm-folder { padding: 7px 14px; color: #6b7280; font-weight: 600; display: flex; gap: 8px; }
.tdm-none { padding: 14px; color: #6b7280; font-size: 13px; }
.tdm-busy { opacity: .55; pointer-events: none; }
.tdm-shade { position: fixed; inset: 0; z-index: 2147482999; background: rgba(15,23,42,.25); }
@media (prefers-color-scheme: dark) {
  .tdm-pop.auto { background: #1f2329; color: #e7eaee; border-color: #343a42; }
  .tdm-pop.auto .tdm-top { border-color: #2c3239; }
  .tdm-pop.auto .tdm-search { background: #15181c; color: inherit; border-color: #3a414a; }
  .tdm-pop.auto .tdm-item:hover, .tdm-pop.auto .tdm-item.kb { background: #2a3140; }
  .tdm-pop.auto .tdm-item[disabled] { color: #6b7480; }
}
`;
function ensureCss() {
  if (document.getElementById('tdm-css')) return;
  const st = document.createElement('style'); st.id = 'tdm-css'; st.textContent = CSS; document.head.appendChild(st);
}

export function closeMovePicker() {
  if (!open) return;
  open.pop.remove(); open.shade?.remove();
  document.removeEventListener('keydown', open.onKey, true);
  document.removeEventListener('mousedown', open.onOutside, true);
  open = null;
}

// task: { id, content, projectId, sectionId }; onMove({ projectId, sectionId, label }) does the API call and may throw.
export function openMovePicker(anchor, task, cache, onMove, { sheet = false, autoDark = false } = {}) {
  closeMovePicker();
  ensureCss();
  const groups = moveTargets(cache);
  const pop = document.createElement('div');
  pop.className = 'tdm-pop' + (sheet ? ' sheet' : '') + (autoDark ? ' auto' : '');
  pop.innerHTML = `<div class="tdm-top"><div class="tdm-title">Move “${esc(task.content)}” to…</div>
    <input class="tdm-search" type="search" placeholder="Type a project, team or section" autocomplete="off"></div>
    <div class="tdm-list"></div>`;
  const shade = sheet ? Object.assign(document.createElement('div'), { className: 'tdm-shade' }) : null;
  if (shade) { document.body.appendChild(shade); shade.addEventListener('click', closeMovePicker); }
  document.body.appendChild(pop);
  const list = pop.querySelector('.tdm-list'), search = pop.querySelector('.tdm-search');

  const isCurrent = (it) => (it.kind === 'section' ? it.id === task.sectionId : it.kind === 'project' && it.id === task.projectId && !task.sectionId);
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const html = groups.map((g) => {
      const items = g.items.filter((it) => !q || it.name.toLowerCase().includes(q) || (it.project || '').toLowerCase().includes(q) || g.group.toLowerCase().includes(q));
      if (!items.length) return '';
      return `<div class="tdm-group">${esc(g.group)}</div>` + items.map((it) => {
        const pad = 14 + (q ? 0 : it.depth * 16);
        if (it.kind === 'folder') return q ? '' : `<div class="tdm-folder" style="padding-left:${pad}px"><span class="ic">▸</span>${esc(it.name)}</div>`;
        const cur = isCurrent(it);
        const icon = it.kind === 'section' ? '§' : it.inbox ? '📥' : '#';
        return `<button class="tdm-item" type="button" style="padding-left:${pad}px" data-kind="${it.kind}" data-id="${esc(it.id)}" data-project="${esc(it.projectId || it.id)}" data-label="${esc(it.kind === 'section' ? `${it.project} / ${it.name}` : it.name)}" ${cur ? 'disabled' : ''}>
          <span class="ic">${icon}</span><span class="nm">${esc(it.name)}${it.kind === 'section' && q ? ` <span style="color:#8a94a0">· ${esc(it.project)}</span>` : ''}</span>${cur ? '<span class="cur">current</span>' : ''}</button>`;
      }).join('');
    }).join('');
    list.innerHTML = html || `<div class="tdm-none">${groups.length ? 'No match.' : 'No projects loaded yet — refresh Todoist and try again.'}</div>`;
  };
  draw();
  search.addEventListener('input', draw);

  // place under the button (or as a bottom sheet on the phone)
  if (!sheet) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(Math.max(12, r.right - w), window.innerWidth - w - 12);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  setTimeout(() => search.focus({ preventScroll: true }), 0);

  list.addEventListener('click', async (e) => {
    const b = e.target.closest('.tdm-item');
    if (!b || b.disabled) return;
    const target = b.dataset.kind === 'section' ? { sectionId: b.dataset.id, projectId: b.dataset.project } : { projectId: b.dataset.id };
    pop.classList.add('tdm-busy');
    try { await onMove({ ...target, label: b.dataset.label }); closeMovePicker(); }
    catch (err) { pop.classList.remove('tdm-busy'); alert(err.message || String(err)); }
  });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMovePicker(); return; }
    const items = [...list.querySelectorAll('.tdm-item:not([disabled])')];
    if (!items.length) return;
    let i = items.findIndex((x) => x.classList.contains('kb'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[i]?.classList.remove('kb');
      i = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      items[i].classList.add('kb'); items[i].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && document.activeElement === search) {
      e.preventDefault(); (items[Math.max(0, i)]).click();
    }
  };
  const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) closeMovePicker(); };
  document.addEventListener('keydown', onKey, true);
  if (!sheet) document.addEventListener('mousedown', onOutside, true);
  open = { pop, shade, onKey, onOutside };
}
