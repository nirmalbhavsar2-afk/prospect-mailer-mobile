// Google sign-in for the mobile app.
// Uses a full-page redirect (not a popup) because popups don't work in apps added to the iPhone home screen.
import { GOOGLE_CLIENT_ID } from './lib/config.js';

const MAIN_SCOPES = 'openid email https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';
const GMAIL_SCOPES = 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';
const TOKENS = 'pm_tokens';
const MAIN = 'pm_main';

export class NeedsAuth extends Error {
  constructor(email, purpose) { super('needs-auth'); this.email = email; this.purpose = purpose; }
}

const read = () => { try { return JSON.parse(localStorage.getItem(TOKENS) || '{}'); } catch { return {}; } };
const write = (t) => { try { localStorage.setItem(TOKENS, JSON.stringify(t)); } catch { /* storage full or blocked */ } };

export const mainEmail = () => { try { return localStorage.getItem(MAIN) || ''; } catch { return ''; } };
// The exact address Google sends you back to — must match an "Authorized redirect URI" in Google Cloud.
export const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

export function signIn({ purpose = 'main', email = '', choose = false } = {}) {
  const state = Math.random().toString(36).slice(2);
  const ret = location.hash && !location.hash.includes('access_token') ? location.hash : '#/home';
  sessionStorage.setItem('pm_auth', JSON.stringify({ purpose, email, ret, state, at: Date.now() }));
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'token');
  u.searchParams.set('scope', purpose === 'main' ? MAIN_SCOPES : GMAIL_SCOPES);
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  if (email) u.searchParams.set('login_hint', email);
  if (choose) u.searchParams.set('prompt', 'select_account');
  location.assign(u.toString());
}

// Call once at start-up. Returns null, { email, purpose } or { error }.
export async function handleRedirect() {
  const h = location.hash;
  if (!/access_token=|error=/.test(h)) return null;
  const p = new URLSearchParams(h.slice(1));
  let pending = {};
  try { pending = JSON.parse(sessionStorage.getItem('pm_auth') || '{}'); } catch { /* none */ }
  sessionStorage.removeItem('pm_auth');
  history.replaceState(null, '', redirectUri() + (pending.ret || '#/home'));
  if (p.get('error')) return { error: p.get('error') === 'access_denied' ? 'Google sign-in was cancelled or blocked.' : 'Google sign-in: ' + p.get('error') };
  if (pending.state && p.get('state') !== pending.state) return { error: 'Sign-in could not be verified — please try again.' };
  const token = p.get('access_token');
  const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const email = (info.email || pending.email || '').toLowerCase();
  if (!email) return { error: 'Google did not say which account you used — please try again.' };
  if (pending.email && email !== pending.email.toLowerCase()) {
    return { error: `You picked ${email}, but this needs ${pending.email}. Please try again and choose ${pending.email}.` };
  }
  const all = read();
  const granted = p.get('scope') || '';
  all[email] = {
    token,
    exp: Date.now() + (Number(p.get('expires_in') || 3600) - 120) * 1000,
    main: pending.purpose === 'main' || (all[email]?.main && granted.includes('drive.appdata')),
    drive: granted.includes('drive.appdata'),
    gmail: granted.includes('gmail.send'),
  };
  write(all);
  if (pending.purpose === 'main') localStorage.setItem(MAIN, email);
  return { email, purpose: pending.purpose || 'main' };
}

export function getToken(email, purpose = 'gmail') {
  const t = read()[(email || '').toLowerCase()];
  const ok = t && t.exp > Date.now() && (purpose === 'main' ? t.drive : t.gmail);
  if (ok) return t.token;
  throw new NeedsAuth(email, purpose);
}

export function hasToken(email, purpose = 'gmail') {
  try { getToken(email, purpose); return true; } catch { return false; }
}

export function forget(email) {
  const all = read();
  delete all[(email || '').toLowerCase()];
  write(all);
}

export function signOut() {
  const all = read();
  for (const t of Object.values(all)) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.token), { method: 'POST' }).catch(() => {});
  try { localStorage.removeItem(TOKENS); localStorage.removeItem(MAIN); } catch { /* ignore */ }
}
