// Sending through the Gmail API from one of several connected Gmail accounts.
import { getSettings, saveSettings, senderProfile, addTombstone } from './store.js';
import * as google from './google.js';

export const redirectUri = google.redirectUri;

// Add (or re-authorise) a Gmail account. Returns its email.
export async function addAccount() {
  const { email, name } = await google.signIn('gmail');
  if (!email) throw new Error('Could not read the Google account email.');
  const s = await getSettings();
  const accounts = [...s.gmailAccounts];
  if (!accounts.some((a) => a.email === email)) accounts.push({ email, name: name || '', signature: '', addedAt: Date.now() });
  await saveSettings({ gmailAccounts: accounts, defaultSender: s.defaultSender || email });
  return email;
}

export async function removeAccount(email) {
  await google.revoke('gmail', email);
  await addTombstone('acct:' + email);
  const s = await getSettings();
  const accounts = s.gmailAccounts.filter((a) => a.email !== email);
  await saveSettings({
    gmailAccounts: accounts,
    defaultSender: s.defaultSender === email ? accounts[0]?.email || '' : s.defaultSender,
  });
}

// ---------- MIME helpers ----------
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64url = (s) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');

export function textToHtml(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linked = esc.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family:Verdana,Geneva,sans-serif;font-size:12px;line-height:1.5;color:#222">${linked.replace(/\r?\n/g, '<br>')}</div>`;
}

export function buildMime({ to, subject, text, html, fromName, fromEmail, inReplyTo }) {
  const boundary = 'pm_' + Math.random().toString(36).slice(2);
  const headers = [];
  if (fromEmail) headers.push(`From: ${fromName ? `"${encWord(fromName).replace(/"/g, '')}" ` : ''}<${fromEmail}>`);
  headers.push(`To: ${to}`);
  headers.push(`Subject: ${encWord(subject)}`);
  if (inReplyTo) { headers.push(`In-Reply-To: ${inReplyTo}`); headers.push(`References: ${inReplyTo}`); }
  headers.push('MIME-Version: 1.0');
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return (
    headers.join('\r\n') + '\r\n\r\n' +
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(text))}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(html || textToHtml(text)))}\r\n` +
    `--${boundary}--`
  );
}

// Sends `text` (signature already appended by caller) from account `from`.
export async function sendEmail({ from, to, subject, text, html, threadId, inReplyTo, interactive = true }) {
  const s = await getSettings();
  const sender = from || s.defaultSender;
  if (!sender || !s.gmailAccounts.some((a) => a.email === sender)) {
    throw new Error('No Gmail account connected. Open the dashboard → Settings → Gmail → Add Gmail account.');
  }
  const prof = senderProfile(s, sender);
  const token = await google.getToken('gmail', sender, { interactive });
  const raw = b64url(buildMime({ to, subject, text, html, fromName: prof.name, fromEmail: sender, inReplyTo }));
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  if (res.status === 401) {
    await google.forget('gmail', sender);
    throw new Error(`Gmail sign-in for ${sender} expired — click Send again to reconnect.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Gmail: ' + ((body.error && body.error.message) || res.statusText));
  return { ...body, from: sender };
}

// ---------- reading headers (gmail.metadata scope) ----------
async function gget(sender, path, interactive = false) {
  const token = await google.getToken('gmail', sender, { interactive });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) { await google.forget('gmail', sender); throw new Error('needs-signin'); }
  if (res.status === 403) throw new Error('needs-signin'); // token without the metadata permission yet
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Gmail error ' + res.status);
  return res.json();
}
const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

// RFC Message-ID of a message we sent, so a follow-up can thread under it.
export async function getMessageId(sender, id) {
  try {
    const m = await gget(sender, `messages/${id}?format=metadata&metadataHeaders=Message-ID`);
    return m ? header(m, 'Message-ID') : '';
  } catch { return ''; }
}

// Has anyone other than us written in this thread? Returns { replied, bounced, at }.
export async function threadStatus(sender, threadId) {
  const t = await gget(sender, `threads/${threadId}?format=metadata&metadataHeaders=From`);
  if (!t) return { replied: false, bounced: false, missing: true };
  let replied = false, bounced = false, at = 0;
  for (const m of t.messages || []) {
    const from = header(m, 'From').toLowerCase();
    const labels = m.labelIds || [];
    // ours = carries the SENT label (covers aliases); anything else arrived from someone else
    const ours = labels.length ? labels.includes('SENT') : from.includes(sender.toLowerCase());
    if (ours || labels.includes('DRAFT')) continue;
    if (/mailer-daemon|postmaster|mail delivery/.test(from)) bounced = true;
    else { replied = true; at = Math.max(at, Number(m.internalDate) || 0); }
  }
  return { replied, bounced, at, messages: (t.messages || []).length };
}
