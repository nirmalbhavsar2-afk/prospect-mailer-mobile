// Check-in reminders: Chrome notifications at times you choose ("Did you start marketing?").
import * as store from './store.js';
import * as tracker from './tracker.js';
import * as report from './report.js';

export const DEFAULT_REMINDERS = [
  { id: 'rem-1600', time: '16:00', days: [1, 2, 3, 4, 5], message: 'Did you start marketing?', on: true },
];
const SNOOZE_MIN = 15;

export async function getReminders() {
  const s = await store.getSettings();
  return Array.isArray(s.reminders) ? s.reminders : DEFAULT_REMINDERS;
}

function nextAt(time, days, now = Date.now()) {
  const [h, m] = String(time || '16:00').split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    d.setHours(h || 0, m || 0, 0, 0);
    if (d.getTime() > now && (!days?.length || days.includes(d.getDay()))) return d.getTime();
  }
  return null;
}

export async function schedule() {
  const all = await chrome.alarms.getAll();
  for (const a of all) if (a.name.startsWith('rem:')) await chrome.alarms.clear(a.name);
  for (const r of await getReminders()) {
    if (!r.on) continue;
    const when = nextAt(r.time, r.days);
    if (when) chrome.alarms.create('rem:' + r.id, { when });
  }
}

async function log(date, entry) {
  const { checkins = {} } = await chrome.storage.local.get('checkins');
  (checkins[date] = checkins[date] || []).push(entry);
  for (const k of Object.keys(checkins)) if (k < tracker.dayKey(Date.now() - 90 * 864e5)) delete checkins[k];
  await chrome.storage.local.set({ checkins });
}

// How much outreach / marketing happened today so far — shown in the notification.
async function progress() {
  const day = await tracker.getCombinedDay(tracker.dayKey(Date.now()));
  const t = tracker.summarize(day, {});
  const cat = (c) => t.cats.find((x) => x.cat === c)?.minutes || 0;
  const leads = await store.getLeads();
  const today = tracker.dayKey(Date.now());
  const sent = leads.reduce((n, l) => n + (l.emailsSent || []).filter((e) => tracker.dayKey(e.date) === today).length, 0);
  return { marketing: cat('Marketing'), outreach: cat('Outreach & sourcing'), email: cat('Email'), emails: sent, profiles: day.profiles.length };
}

export async function fire(alarmName) {
  const snooze = alarmName.startsWith('snooze:');
  const id = alarmName.replace(/^(rem|snooze):/, '');
  const r = (await getReminders()).find((x) => x.id === id);
  if (!snooze) await schedule(); // book the next occurrence
  if (!r || !r.on) return;
  const p = await progress();
  const doneSomething = p.marketing + p.outreach > 0 || p.emails > 0;
  const body = doneSomething
    ? `So far today: ${report.fmtMin(p.outreach)} outreach, ${report.fmtMin(p.marketing)} marketing, ${p.emails} email${p.emails === 1 ? '' : 's'} sent, ${p.profiles} LinkedIn profiles viewed.`
    : 'Nothing logged yet today — no outreach, marketing or emails. A 30-minute block now still counts.';
  await chrome.notifications.create('rem-' + id + '-' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: r.message || 'Did you start marketing?',
    message: body,
    buttons: [{ title: 'Yes, on it' }, { title: `Snooze ${SNOOZE_MIN} min` }],
    requireInteraction: true,
    priority: 2,
  });
  await log(tracker.dayKey(Date.now()), { id, at: Date.now(), answer: 'shown', ...p });
}

export async function answer(notificationId, buttonIndex) {
  const m = notificationId.match(/^rem-(.+)-(\d+)$/);
  if (!m) return false;
  const [, id] = m;
  chrome.notifications.clear(notificationId);
  if (buttonIndex === 1) {
    chrome.alarms.create('snooze:' + id, { when: Date.now() + SNOOZE_MIN * 60000 });
    await log(tracker.dayKey(Date.now()), { id, at: Date.now(), answer: 'snooze' });
  } else {
    await log(tracker.dayKey(Date.now()), { id, at: Date.now(), answer: 'yes' });
  }
  return true;
}
