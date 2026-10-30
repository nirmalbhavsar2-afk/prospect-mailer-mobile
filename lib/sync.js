// Keeps settings, templates and leads in step across laptops via a private file
// in the signed-in Google account's Drive app folder (drive.appdata scope).
import * as store from './store.js';
import * as google from './google.js';

const FILE = 'prospect-mailer-sync.json';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

// ---------- merge (pure) ----------
const sentKey = (e) => `${e.date}|${e.subject}`;

function mergeLeadPair(a, b) {
  const [older, newer] = (a.updatedAt || 0) <= (b.updatedAt || 0) ? [a, b] : [b, a];
  const out = { ...older, ...newer };
  const sent = new Map();
  for (const e of [...(older.emailsSent || []), ...(newer.emailsSent || [])]) sent.set(sentKey(e), e);
  out.emailsSent = [...sent.values()].sort((x, y) => x.date - y.date);
  out.allEmails = [...new Set([...(older.allEmails || []), ...(newer.allEmails || [])])];
  // follow-ups: each one by id, its newest version wins
  const fus = new Map();
  for (const f of [...(older.followUps || []), ...(newer.followUps || [])]) {
    const cur = fus.get(f.id);
    if (!cur || (f.updatedAt || 0) >= (cur.updatedAt || 0)) fus.set(f.id, f);
  }
  out.followUps = [...fus.values()];
  // logged activities and type changes: union
  const acts = new Map();
  for (const a of [...(older.activities || []), ...(newer.activities || [])]) acts.set(a.id, a);
  out.activities = [...acts.values()].sort((x, y) => x.at - y.at);
  const th = new Map();
  for (const t of [...(older.typeHistory || []), ...(newer.typeHistory || [])]) th.set(`${t.at}|${t.type}`, t);
  out.typeHistory = [...th.values()].sort((x, y) => x.at - y.at);
  for (const k of ['email', 'phone', 'biginId', 'notes', 'title', 'company', 'firstName', 'lastName', 'location']) {
    if (!out[k] && older[k]) out[k] = older[k];
  }
  out.createdAt = Math.min(a.createdAt || Infinity, b.createdAt || Infinity);
  return out;
}

const KEEP_FILLED = new Set(['salesqlKey', 'anthropicKey', 'biginClientId', 'biginClientSecret', 'biginRefreshToken', 'cloudUrl', 'cloudSecret', 'googleClientId', 'signature', 'senderName', 'aiPitch', 'aiExample', 'todoistToken']);
export function merge(local, remote) {
  if (!remote) return local;
  const tombstones = { ...(remote.tombstones || {}) };
  for (const [id, t] of Object.entries(local.tombstones || {})) tombstones[id] = Math.max(t, tombstones[id] || 0);
  const alive = (x) => !(tombstones[x.id] >= (x.updatedAt || 0));

  // settings: field by field, newest change wins; a blank never beats a real value of the same age
  const lm = local.settingsMeta || {}, rm = remote.settingsMeta || {};
  const settings = { ...store.DEFAULT_SETTINGS };
  const settingsMeta = {};
  const keys = new Set([...Object.keys(local.settings || {}), ...Object.keys(remote.settings || {})]);
  for (const k of keys) {
    const lt = lm[k] || 0, rt = rm[k] || 0;
    const lv = local.settings?.[k], rv = remote.settings?.[k];
    const blank = (v) => v === undefined || v === '' || (Array.isArray(v) && !v.length);
    let useRemote = rt > lt || (rt === lt && blank(lv) && !blank(rv));
    // keys and connections are never wiped by a newer blank (e.g. a fresh Chrome profile saving an empty form before its first sync)
    if (KEEP_FILLED.has(k)) { if (useRemote && blank(rv) && !blank(lv)) useRemote = false; else if (!useRemote && blank(lv) && !blank(rv)) useRemote = true; }
    settings[k] = useRemote ? rv : lv;
    settingsMeta[k] = Math.max(lt, rt);
    if (settings[k] === undefined) delete settings[k];
  }
  // sender accounts: union of both laptops, minus accounts removed on either
  const accts = new Map();
  const older = (rm.gmailAccounts || 0) > (lm.gmailAccounts || 0) ? local : remote;
  const newer = older === local ? remote : local;
  for (const a of [...(older.settings?.gmailAccounts || []), ...(newer.settings?.gmailAccounts || [])]) {
    accts.set(a.email, { ...(accts.get(a.email) || {}), ...a });
  }
  settings.gmailAccounts = [...accts.values()].filter((a) => !(tombstones['acct:' + a.email] >= (a.addedAt || 0)));
  if (!settings.gmailAccounts.some((a) => a.email === settings.defaultSender)) {
    settings.defaultSender = settings.gmailAccounts[0]?.email || '';
  }

  // templates: by id, newest wins
  const tmap = new Map();
  for (const t of [...(remote.templates || []), ...(local.templates || [])]) {
    const cur = tmap.get(t.id);
    if (!cur || (t.updatedAt || 0) > (cur.updatedAt || 0)) tmap.set(t.id, t);
  }
  const templates = [...tmap.values()].filter(alive);

  // leads: by id, then fold duplicates of the same person (same LinkedIn URL or email)
  const lmap = new Map();
  for (const l of [...(remote.leads || []), ...(local.leads || [])]) {
    lmap.set(l.id, lmap.has(l.id) ? mergeLeadPair(lmap.get(l.id), l) : l);
  }
  let leads = [...lmap.values()].filter(alive);
  const byPerson = new Map();
  const remap = {};
  for (const l of leads) {
    const k = l.linkedinUrl || (l.email ? 'mail:' + l.email.toLowerCase() : 'id:' + l.id);
    if (byPerson.has(k)) {
      const keep = byPerson.get(k);
      const merged = mergeLeadPair(keep, l);
      const keepId = (keep.createdAt || 0) <= (l.createdAt || 0) ? keep.id : l.id;
      const dropId = keepId === keep.id ? l.id : keep.id;
      merged.id = keepId;
      tombstones[dropId] = Date.now();
      remap[dropId] = keepId;
      byPerson.set(k, merged);
    } else byPerson.set(k, l);
  }
  leads = [...byPerson.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const l of leads) if (l.activities) l.activities = l.activities.filter((a) => !tombstones[a.id]);

  // deals: by id, newest wins; contacts folded above keep their deals pointing at the kept id
  const dmap = new Map();
  for (const d of [...(remote.deals || []), ...(local.deals || [])]) {
    const cur = dmap.get(d.id);
    if (!cur || (d.updatedAt || 0) > (cur.updatedAt || 0)) dmap.set(d.id, d);
  }
  const deals = [...dmap.values()].filter(alive)
    .map((d) => (remap[d.leadId] ? { ...d, leadId: remap[d.leadId] } : d))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // forget tombstones older than 90 days
  const cutoff = Date.now() - 90 * 864e5;
  for (const [id, t] of Object.entries(tombstones)) if (t < cutoff) delete tombstones[id];

  // activity: each laptop owns its own days; the newest copy of each device-day wins
  const activity = {};
  for (const src of [remote.activity || {}, local.activity || {}]) {
    for (const [dev, days] of Object.entries(src)) {
      const outDev = activity[dev] || (activity[dev] = {});
      for (const [date, agg] of Object.entries(days || {})) {
        if (!outDev[date] || (agg.updatedAt || 0) > (outDev[date].updatedAt || 0)) outDev[date] = agg;
      }
    }
  }
  const cutoffDay = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
  for (const days of Object.values(activity)) for (const d of Object.keys(days)) if (d < cutoffDay) delete days[d];
  // daily reports: keep whichever was sent (or generated) last
  const dailyReports = { ...(remote.dailyReports || {}) };
  for (const [d, r] of Object.entries(local.dailyReports || {})) {
    if (!dailyReports[d] || (r.updatedAt || 0) > (dailyReports[d].updatedAt || 0)) dailyReports[d] = r;
  }
  const newest = (a = {}, b = {}) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) if (!out[k] || (v.updatedAt || 0) > (out[k].updatedAt || 0)) out[k] = v;
    return out;
  };
  const daySummaries = newest(remote.daySummaries, local.daySummaries); // kept forever (~1 KB a day)
  const periodReports = newest(remote.periodReports, local.periodReports);
  return { ...local, settings, settingsMeta, templates, leads, deals, tombstones, activity, dailyReports, daySummaries, periodReports };
}

// ---------- Drive ----------
async function drive(path, opts = {}, email) {
  const token = await google.getToken('drive', email, { interactive: !!opts.interactive });
  const res = await fetch(path, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  if (res.status === 401) { await google.forget('drive', email); throw new Error('needs-signin'); }
  if (res.status === 403) {
    const b = await res.json().catch(() => ({}));
    const m = b.error?.message || 'access denied';
    throw new Error(/has not been used|disabled/i.test(m) ? 'Google Drive API is not enabled in your Google Cloud project (see Setup guide).' : 'Drive: ' + m);
  }
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(`Google Drive error ${res.status}${b.error?.message ? ': ' + b.error.message : ''}`);
  }
  return res;
}

async function findFile(email, interactive) {
  const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name='${FILE}'`, fields: 'files(id,modifiedTime)' });
  const res = await drive(`${API}?${q}`, { interactive }, email);
  const files = (await res.json()).files || [];
  // if two laptops ever created the file at once, use the newest copy
  return files.sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1))[0] || null;
}

async function upload(email, fileId, data) {
  const body = JSON.stringify(data);
  if (fileId) {
    await drive(`${UPLOAD}/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }, email);
    return fileId;
  }
  const boundary = 'pm' + Math.random().toString(36).slice(2);
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: FILE, parents: ['appDataFolder'] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await drive(`${UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
  }, email);
  return (await res.json()).id;
}

// ---------- daily backups (kept 30 days) ----------
const BACKUP_PREFIX = 'prospect-mailer-backup-';
const KEEP = 30;

async function createFile(email, name, data) {
  const boundary = 'pm' + Math.random().toString(36).slice(2);
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: ['appDataFolder'] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
  const res = await drive(`${UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
  }, email);
  return (await res.json()).id;
}

export async function listBackups(email) {
  email = email || (await getConfig()).email;
  if (!email) return [];
  const q = new URLSearchParams({
    spaces: 'appDataFolder', q: `name contains '${BACKUP_PREFIX}'`,
    fields: 'files(id,name,modifiedTime,size)', orderBy: 'name desc', pageSize: '100',
  });
  const res = await drive(`${API}?${q}`, {}, email);
  return ((await res.json()).files || []).sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function dailyBackup(email, day, data) {
  const existing = await listBackups(email);
  if (!existing.some((f) => f.name === `${BACKUP_PREFIX}${day}.json`)) {
    await createFile(email, `${BACKUP_PREFIX}${day}.json`, { ...data, exportedAt: Date.now() });
  }
  for (const old of existing.slice(KEEP - 1)) {
    await drive(`${API}/${old.id}`, { method: 'DELETE' }, email).catch(() => {});
  }
}

// Bring back everything in a backup. Items added since then are kept.
export async function restoreBackup(fileId) {
  const { email } = await getConfig();
  if (!email) throw new Error('Sign in to sync first.');
  const res = await drive(`${API}/${fileId}?alt=media`, { interactive: true }, email);
  const data = await res.json();
  const now = Date.now();
  const restoredIds = new Set([...(data.templates || []), ...(data.leads || [])].map((x) => x.id));
  data.templates = (data.templates || []).map((t) => ({ ...t, updatedAt: now }));
  data.leads = (data.leads || []).map((l) => ({ ...l, updatedAt: now }));
  data.settingsMeta = Object.fromEntries(Object.keys(data.settings || {}).map((k) => [k, now]));
  const local = await store.snapshot();
  local.tombstones = Object.fromEntries(Object.entries(local.tombstones || {}).filter(([id]) => !restoredIds.has(id)));
  data.tombstones = {};
  const merged = merge(local, data);
  await store.applySnapshot(merged);
  await syncNow();
  return { templates: merged.templates.length, leads: merged.leads.length };
}

// ---------- engine ----------
export async function getConfig() {
  const { syncConfig } = await chrome.storage.local.get('syncConfig');
  return { email: '', lastSync: 0, status: '', error: '', ...(syncConfig || {}) };
}
async function setConfig(patch) {
  const c = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ syncConfig: c });
  return c;
}

let running = null;
export let applying = false; // true while sync writes local data (so it doesn't re-trigger itself)

export async function syncNow({ interactive = false, fresh = false, email: forEmail = '' } = {}) {
  // `fresh`: a sync that started before sign-in finished would report "not signed in" — wait for it, then run again
  if (running && fresh) await running.catch(() => {});
  if (running) return running;
  const run = (async () => {
    const cfg = await getConfig();
    // right after sign-in the account is passed in directly, so a slow or lost settings write can't stop the first sync
    if (forEmail && cfg.email !== forEmail) { cfg.email = forEmail; await setConfig({ email: forEmail }); }
    if (!cfg.email) return { ...cfg, status: cfg.status || 'off' };
    let step = 'connecting to Google Drive';
    try {
      const file = await findFile(cfg.email, interactive);
      let remote = null;
      if (file) {
        step = 'downloading your data from Drive';
        const res = await drive(`${API}/${file.id}?alt=media`, {}, cfg.email);
        const raw = await res.text();
        try { remote = raw ? JSON.parse(raw) : null; } catch { throw new Error(`the sync file on Drive could not be read (${Math.round(raw.length / 1024)} KB) — restore a daily backup instead`); }
      }
      step = 'combining with this browser';
      const local = await store.snapshot();
      const merged = merge(local, remote);
      step = 'saving to this browser';
      applying = true;
      try { await store.applySnapshot(merged); } finally { setTimeout(() => { applying = false; }, 1500); }
      step = 'uploading to Drive';
      await upload(cfg.email, file?.id, { ...merged, exportedAt: Date.now() });
      const today = new Date().toISOString().slice(0, 10);
      if (cfg.lastBackupDay !== today) {
        try { await dailyBackup(cfg.email, today, merged); await setConfig({ lastBackupDay: today }); } catch (e) { /* retried next sync */ }
      }
      return setConfig({ email: cfg.email, lastSync: Date.now(), status: 'ok', error: '' });
    } catch (e) {
      const msg = (e && (e.message || String(e))) || 'Unknown error';
      console.error('[Prospect Mailer] sync failed while ' + step, e);
      const needs = msg === 'needs-signin';
      return setConfig({ email: cfg.email, status: needs ? 'signin' : 'error', error: needs ? 'Google sign-in for Drive expired — click Sign in with Google again.' : `${msg} (while ${step})` });
    }
  })();
  // always clear, whatever path the run took (an early "not signed in yet" return used to leave it stuck,
  // so every later sync — including the one right after sign-in — got that stale "off" answer)
  running = run.finally(() => { if (running === wrapped) running = null; });
  const wrapped = running;
  return running;
}

export async function enable() {
  const { email } = await google.signIn('drive');
  if (!email) throw new Error('Google did not say which account you signed in with — please try again.');
  await setConfig({ email, status: '', error: '' });
  const saved = (await getConfig()).email;
  if (saved !== email) console.warn('[Prospect Mailer] sync account did not save', { email, saved });
  let c = await syncNow({ interactive: true, fresh: true, email });
  // retry: the first Drive calls right after a sign-in sometimes fail, or another sync was still running
  for (let i = 0; i < 2 && c.status !== 'ok' && c.status !== 'signin'; i++) {
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    c = await syncNow({ interactive: true, fresh: true, email });
  }
  if (c.status !== 'ok' && !c.error) c = await setConfig({ status: 'error', error: `sync stopped before finishing (signed in as ${email}; saved account: ${(await getConfig()).email || 'none'}; state: ${c.status || 'blank'})` });
  return c;
}

export async function disable() {
  const cfg = await getConfig();
  if (cfg.email) await google.revoke('drive', cfg.email);
  await chrome.storage.local.set({ syncConfig: { email: '', lastSync: 0, status: '', error: '' } });
}

// ---------- backup file ----------
export async function importBackup(json) {
  let data;
  try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new Error('That file is not a Prospect Mailer backup.'); }
  if (!data || data.app !== 'prospect-mailer') throw new Error('That file is not a Prospect Mailer backup.');
  if (!data.settingsMeta || !Object.keys(data.settingsMeta).length) {
    // backups without timestamps: treat every filled field as set when the file was made
    data.settingsMeta = Object.fromEntries(Object.keys(data.settings || {}).map((k) => [k, data.exportedAt || 1]));
  }
  const merged = merge(await store.snapshot(), data);
  await store.applySnapshot(merged);
  return { templates: merged.templates.length, leads: merged.leads.length };
}
