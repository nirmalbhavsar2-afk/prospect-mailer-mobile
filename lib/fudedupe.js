// Follow-ups can be planned on several browsers at once (two Macs, several Chrome profiles): each one that hears
// "step 1 was sent" plans step 2. These helpers make sure only one copy of each open step survives.
export const OPEN_FU = ['scheduled', 'remind', 'claimed'];

// the same step of the same conversation
export function stepKey(f) {
  return `${f.step || 1}|${f.threadId || ''}|${String(f.origSubject || '').toLowerCase()}|${String(f.to || '').toLowerCase()}`;
}

// keep one open follow-up per step (the earliest planned one, chosen the same way on every browser)
export function dedupeOpen(followUps = []) {
  const keep = new Map();
  for (const f of followUps) {
    if (!OPEN_FU.includes(f.status)) continue;
    const k = stepKey(f);
    const cur = keep.get(k);
    if (!cur || (f.createdAt || 0) < (cur.createdAt || 0) || ((f.createdAt || 0) === (cur.createdAt || 0) && String(f.id) < String(cur.id))) keep.set(k, f);
  }
  // a step that was already sent/stopped makes any open copy of that same step pointless
  const done = new Set(followUps.filter((f) => !OPEN_FU.includes(f.status) && f.status !== 'cancelled').map(stepKey));
  return followUps.filter((f) => !OPEN_FU.includes(f.status) || (keep.get(stepKey(f)) === f && !done.has(stepKey(f))));
}
