// SalesQL REST API — https://salesql.com/docs/api
const BASE = 'https://api-public.salesql.com/v1';

async function call(path, key) {
  if (!key) throw new Error('Add your SalesQL API key in the dashboard → Settings.');
  const res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (res.status === 404) return null;
  if (!res.ok) {
    const msg = (body && (body.message || body.error || body.detail)) || res.statusText;
    if (res.status === 401) throw new Error('SalesQL rejected the API key (401). Check it in Settings.');
    if (res.status === 402 || res.status === 403) throw new Error('SalesQL: ' + (msg || 'out of credits or plan has no API access'));
    if (res.status === 429) throw new Error('SalesQL rate limit hit — wait a moment and try again.');
    throw new Error(`SalesQL error ${res.status}: ${msg}`);
  }
  return body;
}

// Returns a normalised person, or null when SalesQL has no match.
export async function enrichPerson({ linkedinUrl, fullName, company }, key) {
  const q = new URLSearchParams();
  if (linkedinUrl) q.set('linkedin_url', linkedinUrl);
  else {
    if (fullName) q.set('full_name', fullName);
    if (company) q.set('organization_name', company);
  }
  const p = await call('/persons/enrich?' + q.toString(), key);
  return normalizePerson(p);
}

// Shape SalesQL's raw answer (also used by the mobile app when the lookup goes through the cloud script).
export function normalizePerson(p) {
  if (!p) return null;
  const person = p.data && !p.emails ? p.data : p;
  const org = person.organization || person.company || {};
  const emails = (person.emails || [])
    .map((e) => (typeof e === 'string' ? { email: e } : e))
    .filter((e) => e && e.email)
    .map((e) => ({ email: e.email, type: e.type || '', status: e.status || '' }));
  // Valid work emails first, then other valid, then the rest.
  const rank = (e) => (/valid/i.test(e.status) && !/invalid/i.test(e.status) ? 0 : 2) + (/work/i.test(e.type) ? 0 : 1);
  emails.sort((a, b) => rank(a) - rank(b));
  const phones = (person.phones || [])
    .map((x) => (typeof x === 'string' ? { phone: x } : x))
    .filter((x) => x && x.phone);
  return {
    firstName: person.first_name || '',
    lastName: person.last_name || '',
    fullName: person.full_name || '',
    title: person.title || '',
    company: org.name || person.organization_name || person.company_name || '',
    location: person.location || '',
    emails,
    phones,
  };
}

export async function getAllowance(key) {
  return call('/allowance', key);
}
