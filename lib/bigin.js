// Zoho Bigin API v2, authorised with a Self Client refresh token.
import { getSettings, saveSettings } from './store.js';

export const REGIONS = {
  com: { label: 'US (zoho.com)', accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com', console: 'https://api-console.zoho.com' },
  in: { label: 'India (zoho.in)', accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in', console: 'https://api-console.zoho.in' },
  eu: { label: 'Europe (zoho.eu)', accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu', console: 'https://api-console.zoho.eu' },
  'com.au': { label: 'Australia (zoho.com.au)', accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au', console: 'https://api-console.zoho.com.au' },
  jp: { label: 'Japan (zoho.jp)', accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp', console: 'https://api-console.zoho.jp' },
  ca: { label: 'Canada (zohocloud.ca)', accounts: 'https://accounts.zohocloud.ca', api: 'https://www.zohoapis.ca', console: 'https://api-console.zohocloud.ca' },
};
export const SCOPE = 'ZohoBigin.modules.ALL';

const region = (s) => REGIONS[s.biginRegion] || REGIONS.com;

async function tokenRequest(s, params) {
  const url = new URL(region(s).accounts + '/oauth/v2/token');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || res.statusText;
    const hint = e === 'invalid_code' ? ' — the grant code expired or was already used; generate a new one.'
      : e === 'invalid_client' ? ' — check Client ID / Secret and that the region matches your account.' : '';
    throw new Error('Zoho: ' + e + hint);
  }
  return body;
}

// One-time: swap the Self Client grant code for a long-lived refresh token.
export async function connect({ code }) {
  const s = await getSettings();
  if (!s.biginClientId || !s.biginClientSecret) throw new Error('Enter the Self Client ID and Secret first.');
  const body = await tokenRequest(s, {
    grant_type: 'authorization_code',
    client_id: s.biginClientId,
    client_secret: s.biginClientSecret,
    code: code.trim(),
  });
  if (!body.refresh_token) throw new Error('Zoho did not return a refresh token. Generate a new grant code and try again.');
  await saveSettings({ biginRefreshToken: body.refresh_token, biginApiDomain: body.api_domain || '' });
  await chrome.storage.session.set({ biginToken: { token: body.access_token, exp: Date.now() + ((body.expires_in || 3600) - 120) * 1000 } });
  return true;
}

export async function disconnect() {
  await saveSettings({ biginRefreshToken: '', biginApiDomain: '' });
  await chrome.storage.session.remove('biginToken');
}

async function accessToken(force = false) {
  const { biginToken } = await chrome.storage.session.get('biginToken');
  if (!force && biginToken && biginToken.exp > Date.now()) return biginToken.token;
  const s = await getSettings();
  if (!s.biginRefreshToken) throw new Error('Bigin is not connected. Open the dashboard → Settings → Zoho Bigin.');
  const body = await tokenRequest(s, {
    grant_type: 'refresh_token',
    client_id: s.biginClientId,
    client_secret: s.biginClientSecret,
    refresh_token: s.biginRefreshToken,
  });
  await chrome.storage.session.set({ biginToken: { token: body.access_token, exp: Date.now() + ((body.expires_in || 3600) - 120) * 1000 } });
  return body.access_token;
}

async function api(method, path, body, retry = true) {
  const s = await getSettings();
  const base = (s.biginApiDomain || region(s).api) + '/bigin/v2';
  const token = await accessToken();
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    await chrome.storage.session.remove('biginToken');
    return api(method, path, body, false);
  }
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = (json.data && json.data[0]) || json;
    throw new Error('Bigin: ' + (d.message || d.code || res.statusText));
  }
  return json;
}

const crit = (v) => String(v).replace(/[(),\\]/g, (c) => '\\' + c);

function firstResult(json) {
  const d = json && json.data && json.data[0];
  if (!d) return null;
  if (d.status === 'error') {
    if (d.code === 'DUPLICATE_DATA' && d.details && (d.details.id || (d.details.duplicate_record && d.details.duplicate_record.id))) {
      return d.details.id || d.details.duplicate_record.id;
    }
    throw new Error('Bigin: ' + (d.message || d.code));
  }
  return (d.details && d.details.id) || d.id || null;
}

async function findOrCreateCompany(name) {
  const found = await api('GET', '/Accounts/search?criteria=' + encodeURIComponent(`(Account_Name:equals:${crit(name)})`));
  if (found && found.data && found.data[0]) return found.data[0].id;
  return firstResult(await api('POST', '/Accounts', { data: [{ Account_Name: name }] }));
}

async function findContact(lead) {
  if (lead.biginId) return lead.biginId;
  if (!lead.email) return null;
  const found = await api('GET', '/Contacts/search?email=' + encodeURIComponent(lead.email));
  return (found && found.data && found.data[0] && found.data[0].id) || null;
}

// Create or update a contact for this lead. Returns the Bigin contact id.
export async function upsertContact(lead) {
  const record = {
    First_Name: lead.firstName || undefined,
    Last_Name: lead.lastName || lead.firstName || 'Unknown',
    Email: lead.email || undefined,
    Title: lead.title || undefined,
    Mobile: lead.phone || undefined,
    Description: [lead.linkedinUrl && 'LinkedIn: ' + lead.linkedinUrl, lead.location && 'Location: ' + lead.location, lead.notes]
      .filter(Boolean).join('\n') || undefined,
  };
  if (lead.company) {
    try {
      const companyId = await findOrCreateCompany(lead.company);
      if (companyId) record.Account_Name = { id: companyId };
    } catch (e) {
      record.Description = [record.Description, 'Company: ' + lead.company].filter(Boolean).join('\n');
    }
  }
  const existing = await findContact(lead);
  if (existing) {
    try {
      firstResult(await api('PUT', '/Contacts', { data: [{ id: existing, ...record }] }));
      return existing;
    } catch (e) {
      if (!/INVALID_DATA|not found|invalid/i.test(e.message)) throw e;
      // stored id no longer valid — fall through and create a fresh contact
    }
  }
  return firstResult(await api('POST', '/Contacts', { data: [record] }));
}

export async function addNote(contactId, title, content) {
  return api('POST', `/Contacts/${contactId}/Notes`, { data: [{ Note_Title: title, Note_Content: content }] });
}

export async function test() {
  await api('GET', '/Contacts?fields=Last_Name&per_page=1');
  return true;
}
