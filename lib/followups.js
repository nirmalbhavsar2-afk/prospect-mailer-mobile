// Follow-ups: remind you, or send automatically as a reply in the same Gmail thread.
// Anything scheduled stops as soon as the person replies (checked via Gmail headers).
import * as store from './store.js';
import * as gmail from './gmail.js';

export const STOP_STATUSES = ['Replied', 'Interested', 'Not interested', 'Placed', 'Bounced'];
const OPEN = ['scheduled', 'due'];

// ---------- helpers ----------
export async function deviceId() {
  let { deviceId: id } = await chrome.storage.local.get('deviceId');
  if (!id) { id = 'dev-' + store.uid(); await chrome.storage.local.set({ deviceId: id }); }
  return id;
}

// N days after `from`, optionally skipping weekends, nudged into 9:00–18:00 local time.
export function computeDue(from, days, businessDays = true) {
  const d = new Date(from);
  let left = Math.max(0, Number(days) || 0);
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (!businessDays || (d.getDay() !== 0 && d.getDay() !== 6)) left--;
  }
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 9) d.setHours(9, 30, 0, 0);
  else if (h >= 18) { d.setDate(d.getDate() + 1); d.setHours(9, 30, 0, 0); }
  while (businessDays && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function fillTemplate(text, lead, senderName) {
  const v = {
    first_name: lead.firstName || '', last_name: lead.lastName || '',
    full_name: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
    title: lead.title || '', company: lead.company || '', email: lead.email || '', my_name: senderName || '',
  };
  return (text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => v[k.toLowerCase()] ?? '');
}

const reSubject = (s) => (/^re:/i.test(s || '') ? s : 'Re: ' + (s || ''));

async function notify(id, title, message) {
  try {
    await chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 1 });
  } catch { /* notifications are a nicety */ }
}

async function patchFollowUp(leadId, fuId, patch, leadPatch = {}) {
  const leads = await store.getLeads();
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) return null;
  const now = Date.now();
  lead.followUps = (lead.followUps || []).map((f) => (f.id === fuId ? { ...f, ...patch, updatedAt: now } : f));
  return store.updateLead(leadId, { ...leadPatch, followUps: lead.followUps });
}

// ---------- scheduling ----------
// `sent` = the email just sent: { from, to, subject, threadId, rfcId, date }
export async function schedule(leadId, { mode, days, templateId }, sent) {
  if (!mode || mode === 'none') return null;
  const s = await store.getSettings();
  const tpl = (await store.getTemplates()).find((t) => t.id === templateId);
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  if (!lead) return null;
  const now = Date.now();
  // one open follow-up per person: a new email replaces the old plan
  const followUps = (lead.followUps || []).map((f) => (OPEN.includes(f.status) ? { ...f, status: 'replaced', updatedAt: now } : f));
  const fu = {
    id: 'fu-' + store.uid(),
    mode, days: Number(days) || 3,
    due: computeDue(sent.date || now, days, s.followUpBusinessDays !== false),
    templateId: tpl?.id || '', templateName: tpl?.name || '',
    from: sent.from, to: sent.to, threadId: sent.threadId || '', inReplyTo: sent.rfcId || '', origSubject: sent.subject || '',
    status: 'scheduled', deviceId: await deviceId(), attempts: 0, createdAt: now, updatedAt: now,
  };
  followUps.push(fu);
  await store.updateLead(leadId, { followUps });
  return fu;
}

export async function cancel(leadId, fuId) {
  return patchFollowUp(leadId, fuId, { status: 'cancelled' });
}
export async function reschedule(leadId, fuId, due) {
  return patchFollowUp(leadId, fuId, { due, status: 'scheduled', error: '' });
}
// A reminder the person acted on (they sent the follow-up themselves from the panel).
export async function markDone(leadId, fuId) {
  return patchFollowUp(leadId, fuId, { status: 'done', sentAt: Date.now() });
}

export async function listAll() {
  const out = [];
  for (const l of await store.getLeads()) {
    for (const f of l.followUps || []) out.push({ ...f, lead: l });
  }
  return out.sort((a, b) => a.due - b.due);
}

// ---------- sending ----------
async function sendFollowUp(lead, fu, { interactive = false } = {}) {
  const s = await store.getSettings();
  const tpl = (await store.getTemplates()).find((t) => t.id === fu.templateId);
  if (!tpl) throw new Error(`Template “${fu.templateName || 'follow-up'}” no longer exists.`);
  const prof = store.senderProfile(s, fu.from);
  let text = fillTemplate(tpl.body, lead, prof.name);
  if (prof.signature) text += '\n\n' + prof.signature;
  const subject = fu.threadId ? reSubject(fu.origSubject) : fillTemplate(tpl.subject, lead, prof.name) || reSubject(fu.origSubject);
  const res = await gmail.sendEmail({
    from: fu.from, to: lead.email || fu.to, subject, text,
    threadId: fu.threadId || undefined, inReplyTo: fu.inReplyTo || undefined, interactive,
  });
  const rfcId = await gmail.getMessageId(res.from, res.id);
  const now = Date.now();
  const leads = await store.getLeads();
  const cur = leads.find((l) => l.id === lead.id) || lead;
  const followUps = (cur.followUps || []).map((f) => (f.id === fu.id ? { ...f, status: 'sent', sentAt: now, error: '', updatedAt: now } : f));
  const updated = await store.updateLead(lead.id, {
    followUps,
    emailsSent: [...(cur.emailsSent || []), { date: now, subject, templateName: tpl.name, messageId: res.id, threadId: res.threadId, rfcId, from: res.from, followUp: true }],
  });
  return { lead: updated, subject, text, from: res.from };
}

// Send one now (from the dashboard's "Send now").
export async function sendNow(leadId, fuId) {
  const lead = (await store.getLeads()).find((l) => l.id === leadId);
  const fu = lead?.followUps?.find((f) => f.id === fuId);
  if (!lead || !fu) throw new Error('Follow-up not found');
  if (!OPEN.includes(fu.status)) throw new Error('This follow-up is already ' + fu.status);
  return sendFollowUp(lead, fu, { interactive: true });
}

// ---------- reply detection ----------

export async function checkLeadReplied(lead) {
  const threads = new Map();
  for (const e of lead.emailsSent || []) if (e.threadId && e.from) threads.set(e.threadId, e.from);
  for (const f of lead.followUps || []) if (f.threadId && f.from) threads.set(f.threadId, f.from);
  for (const [threadId, from] of threads) {
    const st = await gmail.threadStatus(from, threadId);
    if (st.replied || st.bounced) return st;
  }
  return { replied: false, bounced: false };
}

async function stopForReply(lead, st) {
  const now = Date.now();
  const followUps = (lead.followUps || []).map((f) => (OPEN.includes(f.status) ? { ...f, status: st.replied ? 'stopped-replied' : 'stopped-bounced', updatedAt: now } : f));
  const status = st.replied ? (STOP_STATUSES.includes(lead.status) ? lead.status : 'Replied') : 'Bounced';
  const updated = await store.updateLead(lead.id, { followUps, status, repliedAt: st.at || lead.repliedAt || '' });
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email;
  if (st.replied) await notify('reply-' + lead.id, `${name} replied`, 'Follow-ups for them were stopped. Status set to Replied.');
  else await notify('bounce-' + lead.id, `Email to ${name} bounced`, `${lead.email} looks invalid — follow-ups stopped.`);
  return updated;
}

// ---------- the periodic job ----------
let running = false;
export async function tick({ beforeSend, onSent, force = false } = {}) {
  if (running) return;
  running = true;
  const result = { sent: 0, reminders: 0, stopped: 0, checked: 0, needsSignin: [], errors: [] };
  try {
    const me = await deviceId();
    const now = Date.now();
    const leads = await store.getLeads();
    const { replyChecks = {} } = await chrome.storage.session.get('replyChecks');

    // 1) reply detection for recently emailed people still waiting on an answer
    for (const lead of leads) {
      if (STOP_STATUSES.includes(lead.status)) continue;
      const lastSent = Math.max(0, ...(lead.emailsSent || []).map((e) => e.date || 0));
      const hasOpen = (lead.followUps || []).some((f) => OPEN.includes(f.status));
      if (!hasOpen && now - lastSent > 21 * 864e5) continue;
      const key = lead.id;
      if (!force && now - (replyChecks[key] || 0) < (hasOpen ? 10 : 30) * 60000) continue;
      replyChecks[key] = now;
      try {
        const st = await checkLeadReplied(lead);
        result.checked++;
        if (st.replied || st.bounced) { await stopForReply(lead, st); result.stopped++; }
      } catch (e) {
        if (e.message === 'needs-signin') result.needsSignin.push(...new Set((lead.emailsSent || []).map((x) => x.from).filter(Boolean)));
        else result.errors.push(e.message);
      }
    }

    await chrome.storage.session.set({ replyChecks });

    // 2) due follow-ups
    for (const lead of await store.getLeads()) {
      for (const fu of lead.followUps || []) {
        if (fu.status !== 'scheduled' || fu.due > now) continue;
        if (STOP_STATUSES.includes(lead.status)) {
          await patchFollowUp(lead.id, fu.id, { status: 'stopped-replied' });
          continue;
        }
        if (fu.mode === 'remind') {
          await patchFollowUp(lead.id, fu.id, { status: 'due' });
          const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
          await notify('due-' + fu.id, `Follow up with ${name}`, `${lead.company ? lead.company + ' · ' : ''}Open the dashboard or their LinkedIn profile — the follow-up template is ready.`);
          result.reminders++;
          continue;
        }
        // auto-send: the laptop that scheduled it sends; another laptop takes over if it's 6h overdue
        // scheduled from the phone ('any'): whichever laptop is on sends it (the Drive pull above prevents doubles)
        if (fu.deviceId !== 'any' && fu.deviceId !== me && now - fu.due < 6 * 3600e3) continue;
        if (beforeSend) {
          await beforeSend(); // pull from Drive first so two laptops never both send
          const fresh = (await store.getLeads()).find((l) => l.id === lead.id);
          const freshFu = fresh?.followUps?.find((f) => f.id === fu.id);
          if (!freshFu || freshFu.status !== 'scheduled' || STOP_STATUSES.includes(fresh.status)) continue;
        }
        try {
          // last check for a reply right before sending
          const st = await checkLeadReplied(lead).catch(() => ({}));
          if (st.replied || st.bounced) { await stopForReply(lead, st); result.stopped++; continue; }
          const r = await sendFollowUp(lead, fu, { interactive: false });
          result.sent++;
          result.lastSent = r;
          const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
          await notify('sent-' + fu.id, `Follow-up sent to ${name}`, r.subject);
          if (onSent) await onSent(r).catch(() => {});
        } catch (e) {
          if (e.message === 'needs-signin' || /sign-?in|expired|needs/i.test(e.message)) {
            result.needsSignin.push(fu.from);
            if (!fu.error) await notify('signin-' + fu.from, 'Follow-up waiting for sign-in', `Open Prospect Mailer → Settings and reconnect ${fu.from}.`);
            await patchFollowUp(lead.id, fu.id, { error: `Waiting for sign-in to ${fu.from}` });
          } else {
            const attempts = (fu.attempts || 0) + 1;
            await patchFollowUp(lead.id, fu.id, attempts >= 3 ? { status: 'failed', attempts, error: e.message } : { attempts, error: e.message });
          }
        }
      }
    }
  } finally {
    running = false;
    const needs = [...new Set(result.needsSignin.filter(Boolean))];
    await chrome.storage.session.set({ gmailNeedsSignin: needs });
  }
  return result;
}
