// Google OAuth for the extension (chrome.identity.launchWebAuthFlow, token flow).
// Tokens live only in session storage, one per (purpose, account).
import { getSettings } from './store.js';
import { GOOGLE_CLIENT_ID } from './config.js';

export const clientId = (s) => s.googleClientId || GOOGLE_CLIENT_ID;

export const SCOPES = {
  // gmail.metadata lets follow-ups see whether someone replied (headers only, never message bodies)
  gmail: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata email',
  drive: 'https://www.googleapis.com/auth/drive.appdata email',
};

export function redirectUri() {
  return chrome.identity.getRedirectURL(); // https://<extension-id>.chromiumapp.org/
}

const key = (purpose, email) => `${purpose}:${(email || '').toLowerCase()}`;

async function cache() {
  const { googleTokens } = await chrome.storage.session.get('googleTokens');
  return googleTokens || {};
}
async function remember(purpose, email, token, expiresIn) {
  const all = await cache();
  all[key(purpose, email)] = { token, exp: Date.now() + (Number(expiresIn || 3600) - 120) * 1000 };
  await chrome.storage.session.set({ googleTokens: all });
}
export async function forget(purpose, email) {
  const all = await cache();
  const t = all[key(purpose, email)];
  delete all[key(purpose, email)];
  await chrome.storage.session.set({ googleTokens: all });
  return t && t.token;
}

async function flow({ purpose, interactive, loginHint, chooseAccount }) {
  const s = await getSettings();
  if (!clientId(s)) throw new Error('Add your Google OAuth Client ID in the dashboard → Settings → Gmail.');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId(s));
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', SCOPES[purpose]);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  if (!interactive) url.searchParams.set('prompt', 'none');
  else if (chooseAccount) url.searchParams.set('prompt', 'select_account');
  let result;
  try {
    result = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive });
  } catch (e) {
    throw new Error(interactive ? 'Google sign-in was closed or failed: ' + e.message : 'needs-signin');
  }
  const params = new URLSearchParams(new URL(result).hash.slice(1));
  if (params.get('error')) throw new Error(interactive ? 'Google sign-in: ' + params.get('error') : 'needs-signin');
  const token = params.get('access_token');
  if (!token) throw new Error('Google did not return an access token.');
  const granted = params.get('scope') || '';
  const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const email = (info.email || '').toLowerCase();
  if (loginHint && email && email !== loginHint.toLowerCase()) {
    throw new Error(`You signed in as ${email}, but this needs ${loginHint}. Try again and pick ${loginHint}.`);
  }
  await remember(purpose, email || loginHint, token, params.get('expires_in'));
  const who = email || (loginHint || '').toLowerCase();
  if (purpose === 'gmail' && who) {
    // Google lets people untick individual permissions; remember if reply-checking was left off
    const { gmailNoMetadata = [] } = await chrome.storage.local.get('gmailNoMetadata');
    const missing = granted && !granted.includes('gmail.metadata');
    const next = missing ? [...new Set([...gmailNoMetadata, who])] : gmailNoMetadata.filter((x) => x !== who);
    await chrome.storage.local.set({ gmailNoMetadata: next });
  }
  return { token, email: who, name: info.name || '' };
}

// Sign in and let the person choose an account. Returns { token, email, name }.
export function signIn(purpose) {
  return flow({ purpose, interactive: true, chooseAccount: true });
}

// Token for a known account: cached → silent refresh → (optionally) a sign-in popup.
export async function getToken(purpose, email, { interactive = false } = {}) {
  const t = (await cache())[key(purpose, email)];
  if (t && t.exp > Date.now()) return t.token;
  try {
    return (await flow({ purpose, interactive: false, loginHint: email })).token;
  } catch (e) {
    if (!interactive) throw e;
    return (await flow({ purpose, interactive: true, loginHint: email })).token;
  }
}

export async function revoke(purpose, email) {
  const token = await forget(purpose, email);
  if (token) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => {});
}
