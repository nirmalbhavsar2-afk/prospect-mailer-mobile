// Activity tracker: where the day went, minute by minute.
// - Websites in Chrome (grouped into categories)
// - Other apps: you're active but Chrome isn't the front window
// - Idle: no keyboard/mouse on the whole computer for a few minutes (away, on the phone)
// - Locked / Off: screen locked, or the computer asleep / Chrome closed
import * as store from './store.js';
import { deviceId } from './followups.js';

// ---------- categories ----------
export const CATEGORIES = {
  'Outreach & sourcing': 'productive',
  'Email': 'productive',
  'CRM': 'productive',
  'Marketing': 'productive',
  'Meetings': 'productive',
  'Work tools': 'productive',
  'Research & learning': 'productive',
  'Messaging': 'neutral',
  'Other': 'neutral',
  'Social media': 'distracting',
  'Entertainment': 'distracting',
  'Shopping': 'distracting',
  'News': 'distracting',
};

const RULES = [
  ['Outreach & sourcing', ['salesql.com', 'apollo.io', 'lusha.com', 'contactout.com', 'rocketreach.co', 'hunter.io', 'seamless.ai', 'signalhire.com', 'naukri.com', 'indeed.com', 'monster.com', 'dice.com', 'wellfound.com', 'zoominfo.com', 'snov.io', 'kaspr.io']],
  ['Email', ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.zoho.com', 'mail.zoho.in', 'mail.yahoo.com', 'mail.proton.me']],
  ['CRM', ['bigin.zoho.com', 'bigin.zoho.in', 'crm.zoho.com', 'crm.zoho.in', 'hubspot.com', 'salesforce.com', 'lightning.force.com', 'pipedrive.com', 'bullhorn.com', 'ceipal.com', 'jobdiva.com', 'recruitcrm.io', 'zoho.com/recruit']],
  ['Marketing', ['canva.com', 'buffer.com', 'hootsuite.com', 'later.com', 'mailchimp.com', 'wordpress.com', 'wix.com', 'business.facebook.com', 'adsmanager.facebook.com', 'ads.google.com', 'analytics.google.com', 'search.google.com', 'semrush.com', 'ahrefs.com', 'substack.com', 'figma.com', 'brevo.com', 'lemlist.com', 'instantly.ai', 'godaddy.com', 'hostinger.com', 'shopify.com']],
  ['Meetings', ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com', 'whereby.com', 'webex.com', 'calendly.com']],
  ['Work tools', ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'slides.google.com', 'calendar.google.com', 'notion.so', 'trello.com', 'asana.com', 'slack.com', 'app.slack.com', 'claude.ai', 'chatgpt.com', 'chat.openai.com', 'gemini.google.com', 'github.com', 'office.com', 'sharepoint.com', 'onedrive.live.com', 'dropbox.com', 'todoist.com', 'clickup.com', 'monday.com', 'airtable.com', 'zoho.com', 'zoho.in']],
  ['Research & learning', ['google.com', 'bing.com', 'duckduckgo.com', 'wikipedia.org', 'stackoverflow.com', 'coursera.org', 'udemy.com', 'glassdoor.com', 'glassdoor.co.in', 'crunchbase.com', 'g2.com', 'perplexity.ai', 'ambitionbox.com']],
  ['Messaging', ['web.whatsapp.com', 'web.telegram.org', 'messenger.com', 'discord.com']],
  ['Social media', ['facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'reddit.com', 'threads.net', 'snapchat.com', 'pinterest.com', 'quora.com', 'tumblr.com', 'sharechat.com']],
  ['Entertainment', ['youtube.com', 'netflix.com', 'primevideo.com', 'hotstar.com', 'jiocinema.com', 'spotify.com', 'twitch.tv', 'cricbuzz.com', 'espncricinfo.com', 'sonyliv.com', 'zee5.com', 'gaana.com', 'jiosaavn.com', 'mxplayer.in', 'disneyplus.com', 'tiktok.com']],
  ['Shopping', ['amazon.', 'flipkart.com', 'myntra.com', 'meesho.com', 'ajio.com', 'swiggy.com', 'zomato.com', 'blinkit.com', 'bigbasket.com', 'nykaa.com', 'tatacliq.com', 'ebay.com', 'etsy.com', 'zeptonow.com']],
  ['News', ['news.google.com', 'timesofindia.indiatimes.com', 'indiatimes.com', 'ndtv.com', 'hindustantimes.com', 'indianexpress.com', 'moneycontrol.com', 'economictimes.indiatimes.com', 'livemint.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'theguardian.com', 'reuters.com', 'news.ycombinator.com', 'inshorts.com']],
];

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const suffixMatch = (host, pattern) => (pattern.endsWith('.') ? host.includes(pattern) : host === pattern || host.endsWith('.' + pattern));

// → { host, cat }
export function categorize(url, custom = {}) {
  if (!url) return { host: 'new tab', cat: 'Other' };
  if (url.startsWith('chrome-extension://' + chrome.runtime.id)) return { host: 'Prospect Mailer', cat: 'CRM' };
  if (/^(chrome|edge|about|chrome-extension|devtools):/.test(url)) return { host: 'browser pages', cat: 'Other' };
  const host = hostOf(url);
  if (!host) return { host: 'other', cat: 'Other' };
  for (const [h, cat] of Object.entries(custom || {})) if (suffixMatch(host, h)) return { host, cat };
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    const p = (() => { try { return new URL(url).pathname; } catch { return '/'; } })();
    if (/^\/(in|sales|talent|recruiter|messaging|mynetwork|search|company|pub)\b/.test(p)) return { host: 'linkedin.com', cat: 'Outreach & sourcing' };
    if (/^\/(jobs|learning|pulse)\b/.test(p)) return { host: 'linkedin.com', cat: 'Research & learning' };
    if (/^\/(post|article)\/new|^\/campaignmanager|^\/ads/.test(p)) return { host: 'linkedin.com', cat: 'Marketing' };
    return { host: 'linkedin.com (feed)', cat: 'Social media' };
  }
  for (const [cat, hosts] of RULES) if (hosts.some((h) => suffixMatch(host, h))) return { host, cat };
  return { host, cat: 'Other' };
}
export const kindOfCat = (cat) => CATEGORIES[cat] || 'neutral';

// ---------- minute codes ----------
// P productive site · N neutral site · D distracting site · O other app · I idle · L locked · . off/nothing
const RANK = { '.': 0, L: 1, I: 2, O: 3, D: 4, N: 5, P: 6 };
const EMPTY_DAY = '.'.repeat(1440);
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

function codeFor(seg) {
  if (seg.kind === 'site') return { productive: 'P', neutral: 'N', distracting: 'D' }[kindOfCat(seg.cat)];
  return { other: 'O', idle: 'I', locked: 'L', off: '.' }[seg.kind] || '.';
}

// Pure: add a span to a set of day aggregates ({ [date]: agg }).
export function addSpan(days, seg, from, to) {
  if (!(to > from)) return days;
  let t = from;
  while (t < to) {
    const ds = dayStart(t);
    const de = ds + 864e5;
    const end = Math.min(to, de);
    const key = dayKey(t);
    const agg = days[key] || (days[key] = { date: key, sites: {}, mins: EMPTY_DAY, profiles: [], first: 0, last: 0, updatedAt: 0 });
    const secs = (end - t) / 1000;
    if (seg.kind === 'site') {
      const s = agg.sites[seg.host] || (agg.sites[seg.host] = { s: 0, c: seg.cat });
      s.s += secs;
      s.c = seg.cat;
    }
    const code = codeFor(seg);
    if (code !== '.') {
      const m0 = Math.floor((t - ds) / 60000), m1 = Math.min(1439, Math.floor((end - 1 - ds) / 60000));
      const arr = agg.mins.split('');
      for (let m = m0; m <= m1; m++) if (RANK[code] > RANK[arr[m]]) arr[m] = code;
      agg.mins = arr.join('');
      if (code !== 'I' && code !== 'L') {
        agg.first = agg.first ? Math.min(agg.first, t) : t;
        agg.last = Math.max(agg.last, end);
      }
    }
    agg.updatedAt = Date.now();
    t = end;
  }
  return days;
}

// Combine several devices' aggregates of the same day into one.
export function combine(aggs) {
  const out = { sites: {}, mins: EMPTY_DAY.split(''), profiles: new Set(), first: 0, last: 0 };
  for (const a of aggs.filter(Boolean)) {
    for (const [h, v] of Object.entries(a.sites || {})) {
      const s = out.sites[h] || (out.sites[h] = { s: 0, c: v.c });
      s.s += v.s;
    }
    const m = a.mins || EMPTY_DAY;
    for (let i = 0; i < 1440; i++) if (RANK[m[i]] > RANK[out.mins[i]]) out.mins[i] = m[i];
    (a.profiles || []).forEach((p) => out.profiles.add(p));
    if (a.first) out.first = out.first ? Math.min(out.first, a.first) : a.first;
    out.last = Math.max(out.last, a.last || 0);
  }
  out.mins = out.mins.join('');
  out.profiles = [...out.profiles];
  return out;
}

const hm = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

// Totals in minutes for a combined day, within the work window and overall.
export function summarize(day, { workStart = '09:00', workEnd = '19:00', upTo = 1440 } = {}) {
  const ws = hm(workStart), we = hm(workEnd);
  const count = (from, to) => {
    const c = { P: 0, N: 0, D: 0, O: 0, I: 0, L: 0, '.': 0 };
    for (let i = from; i < Math.min(to, upTo); i++) c[day.mins[i]]++;
    return c;
  };
  const all = count(0, 1440), work = count(ws, we);
  const cats = {};
  for (const [h, v] of Object.entries(day.sites)) cats[v.c] = (cats[v.c] || 0) + v.s / 60;
  const hours = [];
  for (let h = 0; h < 24; h++) hours.push(count(h * 60, h * 60 + 60));
  const active = all.P + all.N + all.D + all.O;
  return {
    productive: all.P, neutral: all.N, distracting: all.D, otherApps: all.O, idle: all.I, locked: all.L,
    active, onComputer: active + all.I + all.L,
    workWindow: { start: workStart, end: workEnd, minutes: Math.max(0, Math.min(we, upTo) - ws),
      productive: work.P, neutral: work.N, distracting: work.D, otherApps: work.O, idle: work.I, locked: work.L, off: work['.'] },
    focusPct: active ? Math.round((all.P / active) * 100) : 0,
    cats: Object.entries(cats).map(([cat, m]) => ({ cat, kind: kindOfCat(cat), minutes: Math.round(m) })).sort((a, b) => b.minutes - a.minutes),
    sites: Object.entries(day.sites).map(([host, v]) => ({ host, cat: v.c, kind: kindOfCat(v.c), minutes: Math.round(v.s / 60) }))
      .filter((s) => s.minutes > 0).sort((a, b) => b.minutes - a.minutes),
    hours,
    firstActive: day.first, lastActive: day.last,
    profilesViewed: day.profiles.length,
    longestIdle: longestRun(day.mins, 'IL'),
    longestFocus: longestRun(day.mins, 'P'),
  };
}
function longestRun(mins, codes) {
  let best = { len: 0, start: 0 }, cur = 0, st = 0;
  for (let i = 0; i < mins.length; i++) {
    if (codes.includes(mins[i])) { if (!cur) st = i; cur++; if (cur > best.len) best = { len: cur, start: st }; } else cur = 0;
  }
  return best;
}

// ---------- the live engine (background only) ----------
const KEEP_DAYS = 31;

async function getActivity() {
  const { activity } = await chrome.storage.local.get('activity');
  return activity || {};
}
export async function getDays(date) {
  const act = await getActivity();
  return Object.values(act).map((dev) => dev[date]).filter(Boolean);
}
export async function getCombinedDay(date) {
  return combine(await getDays(date));
}

async function settings() {
  const s = await store.getSettings();
  return { on: s.trackingEnabled !== false, idleMin: Math.max(1, Number(s.idleMinutes) || 3), custom: s.siteCategories || {} };
}

async function state() {
  const { trk } = await chrome.storage.local.get('trk');
  return trk || { cur: null, lastBeat: 0, idle: 'active' };
}

async function record(seg, from, to) {
  const me = await deviceId();
  const act = await getActivity();
  const mine = act[me] || {};
  addSpan(mine, seg, from, to);
  // drop old days
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 864e5);
  for (const k of Object.keys(mine)) if (k < cutoff) delete mine[k];
  act[me] = mine;
  await chrome.storage.local.set({ activity: act });
}

async function noteProfile(url) {
  const m = (url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return;
  const me = await deviceId();
  const act = await getActivity();
  const mine = act[me] || (act[me] = {});
  const key = dayKey(Date.now());
  const agg = mine[key] || (mine[key] = { date: key, sites: {}, mins: EMPTY_DAY, profiles: [], first: 0, last: 0, updatedAt: Date.now() });
  const slug = decodeURIComponent(m[1]).toLowerCase();
  if (!agg.profiles.includes(slug) && agg.profiles.length < 500) { agg.profiles.push(slug); agg.updatedAt = Date.now(); await chrome.storage.local.set({ activity: act }); }
}

const MEETING_CATS = ['Meetings', 'Work tools', 'Research & learning'];

// What is the person doing right now?
async function current(st, cfg) {
  if (st.idle === 'locked') return { kind: 'locked' };
  let win;
  try { win = await chrome.windows.getLastFocused({ populate: true }); } catch { win = null; }
  const tab = win?.tabs?.find((t) => t.active);
  const site = tab ? (tab.incognito ? { kind: 'site', host: 'private window', cat: 'Other' } : { kind: 'site', ...categorize(tab.url || tab.pendingUrl, cfg.custom) }) : null;
  if (st.idle === 'idle') {
    // watching a meeting or video call without touching the keyboard still counts as that site
    if (site && tab.audible && MEETING_CATS.includes(site.cat)) return site;
    return { kind: 'idle' };
  }
  if (!win || !win.focused) return { kind: 'other' };
  return site || { kind: 'other' };
}
const same = (a, b) => a && b && a.kind === b.kind && a.host === b.host && a.cat === b.cat;

let busy = Promise.resolve();
function serial(fn) { busy = busy.then(fn, fn); return busy; }

// Close the running segment at `now` and start the next one.
export function refresh(reason = '') {
  return serial(async () => {
    const cfg = await settings();
    const st = await state();
    const now = Date.now();
    if (!cfg.on) { await chrome.storage.local.set({ trk: { ...st, cur: null, lastBeat: now } }); return; }
    // Missed heartbeats → computer was asleep or Chrome was closed
    if (st.cur && st.lastBeat && now - st.lastBeat > 150000) {
      await record(st.cur.seg, st.cur.start, st.lastBeat + 60000);
      st.cur = null;
    }
    const next = await current(st, cfg);
    if (st.cur && same(st.cur.seg, next)) {
      await record(st.cur.seg, st.cur.start, now);
      st.cur.start = now;
    } else {
      if (st.cur) await record(st.cur.seg, st.cur.start, now);
      st.cur = { seg: next, start: now };
    }
    st.lastBeat = now;
    await chrome.storage.local.set({ trk: st });
  });
}

export async function setIdle(stateName) {
  await serial(async () => {
    const st = await state();
    st.idle = stateName;
    await chrome.storage.local.set({ trk: st });
  });
  return refresh('idle:' + stateName);
}

export async function applyIdleInterval() {
  const cfg = await settings();
  try { chrome.idle.setDetectionInterval(cfg.idleMin * 60); } catch { /* ignore */ }
}

// Registered synchronously at the top of the service worker.
export function listen() {
  chrome.idle.onStateChanged.addListener((s) => setIdle(s));
  chrome.tabs.onActivated.addListener(() => refresh('tab'));
  chrome.tabs.onUpdated.addListener((id, info, tab) => {
    if (info.url && tab.active) { refresh('url'); noteProfile(info.url); }
    else if (info.status === 'complete' && tab.active && tab.url) noteProfile(tab.url);
  });
  chrome.windows.onFocusChanged.addListener(() => refresh('focus'));
}
export async function heartbeat() {
  // re-read the real idle state in case an event was missed while the worker slept
  const cfg = await settings();
  try {
    const s = await chrome.idle.queryState(cfg.idleMin * 60);
    const st = await state();
    if (s !== st.idle) return setIdle(s);
  } catch { /* ignore */ }
  return refresh('beat');
}
