// Cloud reports: a Google Apps Script in the user's own Google account sends the daily and weekly
// reports at report time, so they arrive even when the laptop is off. The extension keeps the
// script fed with the latest "day so far" and "week so far" summaries.
import * as store from './store.js';
import * as tracker from './tracker.js';
import * as report from './report.js';
import * as periods from './periods.js';
// follow-up helpers are handed in by background.js (importing followups.js here would make an import loop,
// which stops the extension's background from starting)
const followups = { cloudJobs: async () => [], absorbCloudResults: async () => 0 };
export function useFollowUps(f) { Object.assign(followups, f); }

const URL_RE = /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]+\/exec$/;

export async function getStatus() {
  const { cloudStatus } = await chrome.storage.local.get('cloudStatus');
  return { lastPush: 0, lastError: '', lastErrorAt: 0, lastRun: 0, version: '', senders: {}, ...(cloudStatus || {}) };
}

// ---------- which cloud script sends follow-ups for which Gmail address ----------
const low = (e) => (e || '').toLowerCase();
export function sendersOf(s) {
  const out = {};
  for (const [email, v] of Object.entries(s.cloudSenders || {})) if (v && v.url && v.secret) out[low(email)] = { url: v.url, secret: v.secret, main: false };
  if (s.cloudUrl && s.cloudSecret && s.cloudAccount) out[low(s.cloudAccount)] = { url: s.cloudUrl, secret: s.cloudSecret, main: true };
  return out;
}
// Only scripts that have confirmed they can send follow-ups count (an older reports-only script doesn't).
export async function senderFor(email) {
  const snd = sendersOf(await store.getSettings())[low(email)];
  if (!snd) return null;
  const st = (await getStatus()).senders[low(email)] || {};
  return st.fu === true ? snd : null;
}
export async function hasSender(email) { return !!(await senderFor(email)); }
async function setStatus(patch) {
  const st = { ...(await getStatus()), ...patch };
  await chrome.storage.local.set({ cloudStatus: st });
  return st;
}

async function configFor(s) {
  return {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: (self.navigator && navigator.language) || 'en-US',
    reportTime: s.reportTime || '20:00',
    reportEnabled: s.reportEnabled !== false,
    reportWeekends: !!s.reportWeekends,
    reportWeekly: s.reportWeekly !== false,
    reportWeekday: Number(s.reportWeekday ?? 6),
    to: s.reportTo || s.defaultSender || '',
    owner: s.senderName || '',
    aiModel: s.aiModel || 'claude-sonnet-5-5',
    anthropicKey: s.anthropicKey || '',
  };
}

async function call(url, body) {
  let res;
  try {
    // text/plain keeps it a "simple" request; Apps Script answers via a redirect that fetch follows
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
  } catch (e) {
    throw new Error('Could not reach your cloud script — check your internet connection.');
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    if (/<html|<!doctype/i.test(text)) throw new Error('The script URL answered with a web page, not the app. Check that it is the Web app URL ending in /exec and that "Who has access" is set to Anyone.');
    throw new Error('Unexpected answer from the cloud script.');
  }
  if (!json.ok) {
    const map = {
      'bad-secret': 'This script is already connected to a different Prospect Mailer. Create a new deployment, or disconnect the other one.',
      'not-connected': 'The script is not connected yet — click Connect again.',
    };
    throw new Error(map[json.error] || json.error || 'Cloud script error');
  }
  return json;
}

const rand = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function connect(url) {
  url = (url || '').trim();
  if (!URL_RE.test(url)) throw new Error('Paste the Web app URL from Apps Script — it looks like https://script.google.com/macros/s/…/exec');
  const s = await store.getSettings();
  const secret = s.cloudUrl === url && s.cloudSecret ? s.cloudSecret : rand();
  const r = await call(url, { type: 'connect', secret, config: await configFor(s) });
  await store.saveSettings({ cloudUrl: url, cloudSecret: secret, cloudAccount: low(r.account || '') });
  await setStatus({ lastError: '', version: r.version || '' });
  await push({ force: true });
  return r;
}

// Another Gmail account's own copy of the script (follow-ups from that address only).
export async function connectSender(email, url) {
  url = (url || '').trim();
  if (!URL_RE.test(url)) throw new Error('Paste the Web app URL from Apps Script — it looks like https://script.google.com/macros/s/…/exec');
  const s = await store.getSettings();
  const cur = (s.cloudSenders || {})[low(email)];
  const secret = cur && cur.url === url && cur.secret ? cur.secret : rand();
  const r = await call(url, { type: 'connect', secret, config: { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, reportEnabled: false, reportWeekly: false } });
  if (low(r.account) !== low(email)) {
    await call(url, { type: 'disconnect', secret }).catch(() => {});
    throw new Error(`That script runs as ${r.account}, not ${email}. Open script.new while signed in to ${email} and set it up there.`);
  }
  if (r.gmail === false) throw new Error('The script is missing the Gmail permission. In the script editor pick "setup", click Run, and allow access — then Deploy ▸ Manage deployments ▸ New version.');
  await store.saveSettings({ cloudSenders: { ...(s.cloudSenders || {}), [low(email)]: { url, secret } } });
  await pushFollowUps({ force: true });
  return r;
}
export async function disconnectSender(email) {
  const s = await store.getSettings();
  const cur = (s.cloudSenders || {})[low(email)];
  if (cur) await call(cur.url, { type: 'disconnect', secret: cur.secret }).catch(() => {});
  const next = { ...(s.cloudSenders || {}) };
  delete next[low(email)];
  await store.saveSettings({ cloudSenders: next });
  const st = await getStatus();
  delete st.senders[low(email)];
  await chrome.storage.local.set({ cloudStatus: st });
}

// The laptop is about to send a follow-up itself. Returns { claimed } or { result } if the cloud already handled it.
export async function claim(email, fuId) {
  const snd = await senderFor(email);
  if (!snd) return { claimed: true, local: true };
  const r = await call(snd.url, { type: 'fu-claim', secret: snd.secret, id: fuId });
  return { claimed: !!r.claimed, result: r.result || null };
}
export async function release(email, fuId) {
  const snd = await senderFor(email);
  if (snd) await call(snd.url, { type: 'fu-release', secret: snd.secret, id: fuId });
}
export async function cancel(email, ids) {
  const snd = await senderFor(email);
  if (snd) await call(snd.url, { type: 'fu-cancel', secret: snd.secret, ids });
}

// Send each script the follow-ups it should handle, and bring back what it did.
let fuPushing = null;
export async function pushFollowUps({ force = false, skipMain = false } = {}) {
  if (fuPushing) return fuPushing;
  fuPushing = (async () => {
    const s = await store.getSettings();
    const st = await getStatus();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const [email, snd] of Object.entries(sendersOf(s))) {
      if (skipMain && snd.main) continue;
      const prev = st.senders[email] || {};
      if (!force && Date.now() - (prev.lastPush || 0) < 60000) continue;
      try {
        const body = { type: 'push', secret: snd.secret, account: email, followUps: await followups.cloudJobs(email) };
        if (!snd.main) body.config = { tz, reportEnabled: false, reportWeekly: false };
        const r = await call(snd.url, body);
        await followups.absorbCloudResults(r.fuResults);
        st.senders[email] = { lastPush: Date.now(), lastError: '', queued: body.followUps.length, version: r.version || '', fu: r.fuResults !== undefined };
      } catch (e) {
        st.senders[email] = { ...prev, lastError: e.message, lastErrorAt: Date.now() };
      }
    }
    await chrome.storage.local.set({ cloudStatus: { ...(await getStatus()), senders: st.senders } });
  })().finally(() => { fuPushing = null; });
  return fuPushing;
}

export async function disconnect() {
  const s = await store.getSettings();
  if (s.cloudUrl && s.cloudSecret) await call(s.cloudUrl, { type: 'disconnect', secret: s.cloudSecret }).catch(() => {});
  await store.saveSettings({ cloudUrl: '', cloudSecret: '', cloudAccount: '' });
  await chrome.storage.local.remove('cloudStatus');
}

async function payload(s) {
  const today = tracker.dayKey(Date.now());
  const day = await report.buildDayData(today);
  const weeks = [await periods.buildPeriod('week', today)];
  // on the weekly-report day, also make sure the week that just ended is up there
  if (new Date().getDay() === 1) weeks.push(await periods.buildPeriod('week', tracker.dayKey(Date.now() - 864e5)));
  return { day, weeks, config: await configFor(s) };
}

// Merge reports the cloud sent into the local history so My Day shows them.
async function absorb(reports = {}) {
  const daily = await report.getReports();
  const per = await periods.getPeriodReports();
  let dChanged = false, pChanged = false;
  for (const [k, r] of Object.entries(reports)) {
    if (k.startsWith('day:')) {
      const date = k.slice(4);
      const cur = daily[date];
      if (r.ai && (!cur || !cur.sentAt || (r.sentAt || 0) > (cur.sentAt || 0))) {
        daily[date] = { ...(cur || {}), date, ai: r.ai, aiError: r.aiError || '', sentAt: r.sentAt, sentTo: r.sentTo, by: 'cloud', updatedAt: Date.now() };
        dChanged = true;
      } else if (r.sendError && (!cur || !cur.sentAt)) {
        daily[date] = { ...(cur || {}), date, sendError: 'Cloud: ' + r.sendError, updatedAt: Date.now() };
        dChanged = true;
      }
    } else if (k.startsWith('week:') && r.ai) {
      const cur = per[k];
      if (!cur || (r.sentAt || 0) > (cur.sentAt || 0)) { per[k] = { ...(cur || {}), ...r, id: k, updatedAt: Date.now() }; pChanged = true; }
    }
  }
  if (dChanged) await chrome.storage.local.set({ dailyReports: daily });
  if (pChanged) await chrome.storage.local.set({ periodReports: per });
}

let pushing = null;
export async function push({ force = false } = {}) {
  if (pushing) return pushing;
  pushing = (async () => {
    const s = await store.getSettings();
    if (!s.cloudUrl || !s.cloudSecret) return null;
    const st = await getStatus();
    if (!force && Date.now() - (st.lastPush || 0) < 4 * 60000) return st;
    try {
      const p = await payload(s);
      if (s.cloudAccount) { p.account = low(s.cloudAccount); p.followUps = await followups.cloudJobs(s.cloudAccount); }
      const r = await call(s.cloudUrl, { type: 'push', secret: s.cloudSecret, ...p });
      await absorb(r.reports);
      if (r.fuResults) await followups.absorbCloudResults(r.fuResults);
      const st = await getStatus();
      if (s.cloudAccount) st.senders[low(s.cloudAccount)] = { lastPush: Date.now(), lastError: '', queued: (p.followUps || []).length, version: r.version || '', fu: r.fuResults !== undefined };
      await chrome.storage.local.set({ cloudStatus: st });
      pushFollowUps({ skipMain: true }).catch(() => {});
      return setStatus({ lastPush: Date.now(), lastError: '', lastErrorAt: 0, lastRun: Number(r.lastRun) || 0, version: r.version || '' });
    } catch (e) {
      return setStatus({ lastError: e.message, lastErrorAt: Date.now() });
    } finally {
      pushing = null;
    }
  })();
  return pushing;
}

export async function sendTest() {
  const s = await store.getSettings();
  if (!s.cloudUrl) throw new Error('Connect the cloud script first.');
  const p = await payload(s);
  const r = await call(s.cloudUrl, { type: 'test', secret: s.cloudSecret, day: p.day, weeks: p.weeks, config: p.config });
  await absorb({ ['day:' + p.day.date]: r.report });
  return r;
}

export async function isConnected() {
  const s = await store.getSettings();
  return !!(s.cloudUrl && s.cloudSecret);
}

// a few minutes before report time, push the final numbers so the cloud email is complete
export function nextPrePush(reportTime, now = Date.now()) {
  return report.nextReportTime(reportTime, now + 5 * 60000) - 5 * 60000;
}
