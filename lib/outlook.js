// Outlook.com / Hotmail / Microsoft 365 accounts through Microsoft Graph.
// Sign-in is Microsoft's browser sign-in (chrome.identity.launchWebAuthFlow, token flow), like Gmail.
// Tokens live only in session storage, one per account. Sending happens on the laptop only
// (the Google cloud script cannot send from a Microsoft mailbox).
import { getSettings } from './store.js';

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
export const SCOPE = 'openid profile email User.Read Mail.ReadWrite Mail.Send';
// immutable ids: a draft keeps its id after it is sent and moved to Sent Items
const PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';

export const redirectUri = () => chrome.identity.getRedirectURL();
export const isOutlook = (s, email) => (s.gmailAccounts || []).some((a) => a.email === email && a.provider === 'outlook');
export const looksMicrosoft = (email) => /@(outlook|hotmail|live|msn)\.[a-z.]+$/i.test(email || '');

const key = (email) => 'outlook:' + (email || '').toLowerCase();
async function cache() { return (await chrome.storage.session.get('msTokens')).msTokens || {}; }
async function remember(email, token, expiresIn) {
  const all = await cache();
  all[key(email)] = { token, exp: Date.now() + (Number(expiresIn || 3600) - 120) * 1000 };
  await chrome.storage.session.set({ msTokens: all });
}
export async function forget(email) {
  const all = await cache();
  delete all[key(email)];
  await chrome.storage.session.set({ msTokens: all });
}

async function flow({ interactive, loginHint, chooseAccount }) {
  const s = await getSettings();
  if (!s.msClientId) throw new Error('Add your Microsoft Application (client) ID in Settings → Outlook / Hotmail first.');
  const url = new URL(AUTH);
  url.searchParams.set('client_id', s.msClientId);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('response_mode', 'fragment');
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  if (!interactive) url.searchParams.set('prompt', 'none');
  else if (chooseAccount) url.searchParams.set('prompt', 'select_account');
  let result;
  try {
    result = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive });
  } catch (e) {
    throw new Error(interactive ? 'Microsoft sign-in was closed or failed: ' + e.message : 'needs-signin');
  }
  const params = new URLSearchParams(new URL(result).hash.slice(1) || new URL(result).search.slice(1));
  if (params.get('error')) {
    if (!interactive) throw new Error('needs-signin');
    throw new Error('Microsoft sign-in: ' + (params.get('error_description') || params.get('error')).replace(/\+/g, ' ').slice(0, 300));
  }
  const token = params.get('access_token');
  if (!token) throw new Error('Microsoft did not return an access token.');
  const me = await fetch(GRAPH + '?$select=mail,userPrincipalName,displayName', { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const email = String(me.mail || me.userPrincipalName || loginHint || '').toLowerCase();
  if (loginHint && email && email !== loginHint.toLowerCase()) {
    throw new Error(`You signed in as ${email}, but this needs ${loginHint}. Try again and pick ${loginHint}.`);
  }
  await remember(email, token, params.get('expires_in'));
  return { token, email, name: me.displayName || '' };
}

export function signIn() { return flow({ interactive: true, chooseAccount: true }); }

export async function getToken(email, { interactive = false } = {}) {
  const t = (await cache())[key(email)];
  if (t && t.exp > Date.now()) return t.token;
  try {
    return (await flow({ interactive: false, loginHint: email })).token;
  } catch (e) {
    if (!interactive) throw e;
    return (await flow({ interactive: true, loginHint: email })).token;
  }
}

async function call(email, path, { method = 'GET', body, interactive = false } = {}) {
  const token = await getToken(email, { interactive });
  const res = await fetch(GRAPH + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, Prefer: PREFER, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { await forget(email); throw new Error('needs-signin'); }
  if (res.status === 404) return null;
  if (res.status === 202 || res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.statusText;
    if (/quota|limit|ErrorExceededMessageLimit|SubmissionQuotaExceeded/i.test(msg)) throw new Error(`Outlook daily sending limit reached for ${email} — try again tomorrow.`);
    throw new Error('Outlook: ' + msg);
  }
  return data;
}

const recipients = (to) => String(to || '').split(/[,;]\s*/).filter(Boolean).map((address) => ({ emailAddress: { address: address.trim() } }));

// every message in a conversation (inbox, sent, any folder), oldest first
async function conversation(email, conversationId, select) {
  const f = encodeURIComponent(`conversationId eq '${String(conversationId).replace(/'/g, "''")}'`);
  const r = await call(email, `/messages?$filter=${f}&$select=${select}&$top=50`);
  return (r?.value || []).sort((a, b) => new Date(a.receivedDateTime || a.sentDateTime || 0) - new Date(b.receivedDateTime || b.sentDateTime || 0));
}

// New email, or a reply in an existing conversation (threadId = Outlook conversationId).
export async function sendEmail({ from, to, subject, html, threadId, interactive = true }) {
  let draft = null;
  if (threadId) {
    const msgs = await conversation(from, threadId, 'id,receivedDateTime,sentDateTime,isDraft').catch(() => []);
    const last = msgs.filter((m) => !m.isDraft).pop();
    if (last) {
      draft = await call(from, `/messages/${last.id}/createReply`, { method: 'POST', body: {}, interactive });
      draft = await call(from, `/messages/${draft.id}`, { method: 'PATCH', body: { subject, body: { contentType: 'HTML', content: html }, toRecipients: recipients(to), ccRecipients: [] } });
    }
  }
  if (!draft) draft = await call(from, '/messages', { method: 'POST', body: { subject, body: { contentType: 'HTML', content: html }, toRecipients: recipients(to) }, interactive });
  await call(from, `/messages/${draft.id}/send`, { method: 'POST' });
  return { id: draft.id, threadId: draft.conversationId || threadId || '', rfcId: draft.internetMessageId || '', from };
}

export async function getMessageId(email, id) {
  try { return (await call(email, `/messages/${id}?$select=internetMessageId`))?.internetMessageId || ''; } catch { return ''; }
}

const addr = (m) => (m.from?.emailAddress?.address || '').toLowerCase();
const isBounce = (m) => /mailer-daemon|postmaster|microsoftexchange/i.test(addr(m)) || /^(undeliverable|delivery has failed|mail delivery)/i.test(m.subject || '');
const theirs = (email) => (m) => !m.isDraft && addr(m) !== email.toLowerCase();

export async function threadStatus(email, threadId) {
  const msgs = await conversation(email, threadId, 'from,subject,receivedDateTime,bodyPreview,isDraft');
  if (!msgs.length) return { replied: false, bounced: false, missing: true };
  let replied = false, bounced = false, at = 0, snippet = '';
  for (const m of msgs.filter(theirs(email))) {
    if (isBounce(m)) { bounced = true; continue; }
    replied = true;
    const ts = Date.parse(m.receivedDateTime) || 0;
    if (ts >= at) { at = ts; snippet = m.bodyPreview || ''; }
  }
  return { replied, bounced, at, snippet, messages: msgs.length };
}

export async function threadReplies(email, threadId, newText = (t) => t) {
  const msgs = await conversation(email, threadId, 'id,from,subject,receivedDateTime,bodyPreview,uniqueBody,isDraft');
  return msgs.filter(theirs(email)).map((m) => {
    const name = m.from?.emailAddress?.name;
    return {
      id: m.id,
      from: name ? `${name} <${addr(m)}>` : addr(m),
      at: Date.parse(m.receivedDateTime) || 0,
      snippet: newText(m.uniqueBody?.content || m.bodyPreview || ''),
      needsRead: false,
      bounce: isBounce(m),
    };
  });
}
