// Cloud reports: a Google Apps Script in the user's own Google account sends the daily and weekly
// reports at report time, so they arrive even when the laptop is off. The extension keeps the
// script fed with the latest "day so far" and "week so far" summaries.
import * as store from './store.js';
import * as tracker from './tracker.js';
import * as report from './report.js';
import * as periods from './periods.js';

const URL_RE = /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]+\/exec$/;

export async function getStatus() {
  const { cloudStatus } = await chrome.storage.local.get('cloudStatus');
  return { lastPush: 0, lastError: '', lastErrorAt: 0, lastRun: 0, version: '', ...(cloudStatus || {}) };
}
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
  await store.saveSettings({ cloudUrl: url, cloudSecret: secret, cloudAccount: r.account || '' });
  await setStatus({ lastError: '', version: r.version || '' });
  await push({ force: true });
  return r;
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
      const r = await call(s.cloudUrl, { type: 'push', secret: s.cloudSecret, ...(await payload(s)) });
      await absorb(r.reports);
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
