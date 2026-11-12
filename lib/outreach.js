// Outreach: pull new leads + drafts from the "Pitchbird Leads" Google Sheet (via your cloud script)
// and write back where each one stands (Sent, Replied, …) so the sheet doubles as the daily log.
import * as store from './store.js';
import * as cloud from './cloud.js';
import * as li from './leadimport.js';
import { deviceId } from './followups.js';

export async function getStatus() {
  const { outreachStatus } = await chrome.storage.local.get('outreachStatus');
  return { lastPull: 0, lastError: '', lastAdded: 0, url: '', ...(outreachStatus || {}) };
}
async function setStatus(p) { const st = { ...(await getStatus()), ...p }; await chrome.storage.local.set({ outreachStatus: st }); return st; }

let pulling = null;
export async function pull({ force = false } = {}) {
  if (pulling) return pulling;
  pulling = (async () => {
    const s = await store.getSettings();
    if (!s.cloudUrl || !s.cloudSecret || s.outreachSheetSync === false) return getStatus();
    const st = await getStatus();
    if (!force && Date.now() - (st.lastPull || 0) < 25 * 60000) return st;
    try {
      const r = await cloud.request('leads-pull', { device: await deviceId() });
      const rows = (r.rows || []).map((o) => li.normalizeRow(o, { track: o.Track }));
      const res = await li.apply(rows.filter(Boolean), { source: 'sheet' });
      // confirm, so other laptops don't import the same rows
      const leads = await store.getLeads();
      const items = leads.filter((l) => l.sheetId && res.sheetIds.includes(l.sheetId)).map(li.sheetStatus);
      const skipped = res.sheetIds.filter((id) => !items.some((x) => x.id === id)).map((id) => ({ id, status: 'Skipped (do not contact)' }));
      if (items.length || skipped.length) await cloud.request('leads-status', { items: [...items, ...skipped] });
      await markReported(items);
      return setStatus({ lastPull: Date.now(), lastError: '', lastAdded: res.added, lastDrafts: res.drafts, url: r.url || st.url, inbox: r.inbox || null });
    } catch (e) {
      const unsupported = /unknown-request/.test(e.message);
      return setStatus({ lastPull: Date.now(), lastError: unsupported ? 'Update your cloud script (Code.gs) to use the leads sheet.' : e.message });
    } finally { pulling = null; }
  })();
  return pulling;
}

async function markReported(items) {
  if (!items.length) return;
  const leads = await store.getLeads();
  const by = Object.fromEntries(items.map((x) => [x.id, x.status + '|' + x.sentAt + '|' + x.repliedAt]));
  let changed = false;
  for (const l of leads) if (l.sheetId && by[l.sheetId] && l.sheetReported !== by[l.sheetId]) { l.sheetReported = by[l.sheetId]; changed = true; }
  if (changed) await chrome.storage.local.set({ leads });
}

// Write back any status that changed since we last told the sheet.
export async function pushStatuses() {
  const s = await store.getSettings();
  if (!s.cloudUrl || !s.cloudSecret || s.outreachSheetSync === false) return 0;
  const items = (await store.getLeads()).filter((l) => l.sheetId).map(li.sheetStatus);
  const leads = await store.getLeads();
  const changed = items.filter((x) => { const l = leads.find((y) => y.sheetId === x.id); return l && l.sheetReported !== x.status + '|' + x.sentAt + '|' + x.repliedAt; });
  if (!changed.length) return 0;
  try { await cloud.request('leads-status', { items: changed }); await markReported(changed); } catch (e) { await setStatus({ lastError: e.message }); }
  return changed.length;
}

export const importText = li.importText;

// ---------- "Find leads for these jobs" ----------
// Turn pasted text into job rows. One job per line; understands
//   a job link on its own · "Role at Company, Location" · "Role - Company - Location" · tab-separated rows copied from a sheet
export function parseJobs(text) {
  const out = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    const url = (line.match(/https?:\/\/\S+/) || [''])[0].replace(/[),.;]+$/, '');
    let rest = line.replace(url, ' ').replace(/\s+/g, ' ').trim().replace(/^[-–—•*\d.)\s]+/, '').replace(/[-–—|,\s]+$/, '');
    let role = '', company = '', location = '';
    if (/\t/.test(line)) {
      const parts = line.split('\t').map((x) => x.trim()).filter((x) => x && x !== url && !/^https?:/.test(x));
      [role, company, location] = parts;
    } else if (/\s(?:at|@)\s/i.test(rest)) {
      const [r, c] = rest.split(/\s(?:at|@)\s/i);
      role = r; [company, ...location] = c.split(/\s*[,|–—]\s*|\s+-\s+/); location = location.join(', ');
    } else if (rest) {
      const parts = rest.split(/\s*[|–—]\s*|\s+-\s+/).map((x) => x.trim()).filter(Boolean);
      [role, company, ...location] = parts; location = location.join(', ');
    }
    out.push({ role: (role || '').trim(), company: (company || '').trim(), location: (location || '').trim(), url });
  }
  return out;
}

export async function addJobs(items, { track = 'auto', notes = '' } = {}) {
  const rows = items.filter((x) => x && (x.url || x.company || x.role)).map((x) => ({ ...x, track: x.track || track, notes: x.notes || notes }));
  if (!rows.length) throw new Error('Add at least one job (a link, or role + company).');
  try {
    const r = await cloud.request('jobs-add', { items: rows });
    await chrome.storage.local.set({ outreachJobs: { at: Date.now(), url: r.url } });
    return r;
  } catch (e) {
    if (/unknown-request/.test(e.message)) throw new Error('Update your cloud script (Code.gs) first — job requests need the new version.');
    throw e;
  }
}
export async function listJobs() {
  try {
    const r = await cloud.request('jobs-list', { max: 40 });
    await chrome.storage.local.set({ outreachJobs: { at: Date.now(), url: r.url, jobs: r.jobs } });
    return r;
  } catch (e) {
    if (/unknown-request/.test(e.message)) return { jobs: [], needsUpdate: true };
    throw e;
  }
}
