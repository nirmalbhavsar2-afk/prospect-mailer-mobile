// "Write with AI": Claude drafts a personalised email from what's on the person's LinkedIn profile
// (headline, about, experience, recent posts) and any roles they're hiring for.
import * as store from './store.js';
import { claudeError } from './report.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export const GOALS = {
  intro: 'First email — introduce myself and start a conversation',
  hiring: 'Offer to help fill the roles they are hiring for',
  followup: 'Follow up on my earlier email (they have not replied)',
  reengage: 'Re-engage someone I have worked with or spoken to before',
  meeting: 'Ask for a short call',
};
const TONES = {
  friendly: 'friendly and professional, like a peer writing to a peer',
  direct: 'direct and concise, no small talk',
  warm: 'warm and personal, still businesslike',
  formal: 'formal and polished',
};
const LENGTHS = { short: '60–90 words', medium: '100–140 words' };

const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function buildPrompt({ person, insights = {}, goal = 'intro', base, history = [], sender, settings: s }) {
  const hiring = (insights.hiring || []).filter((h) => h && h.title).slice(0, 8);
  const system = [
    `You write short, personalised B2B emails for ${sender.name || 'the sender'}${s.aiPitch ? '' : ', who runs a recruiting / sourcing services business'}.`,
    s.aiPitch ? `What the sender offers, in their own words:\n"""${clip(s.aiPitch, 1500)}"""` : '',
    'Rules:',
    '- Open with one specific, genuine detail from the profile (the roles they are hiring for beat everything else; then a recent post, their company, their role or something from their About). Never invent facts that are not in the data.',
    '- If they are hiring, connect what the sender offers to those exact roles by name.',
    '- One clear, low-effort call to action (e.g. a reply or a 15-minute call). No pressure, no hype, no buzzwords, no emojis, no exclamation marks.',
    `- Tone: ${TONES[s.aiTone] || TONES.friendly}. Length of the body: ${LENGTHS[s.aiLength] || LENGTHS.short}.`,
    '- Plain text. Address them by first name. Short paragraphs.',
    sender.hasSignature ? '- End with a short closing line such as "Best regards," and NOTHING after it — no name, no signature (the sender\'s signature is added right below automatically).' : `- End with the sender's name: ${sender.name || ''}.`,
    '- Subject line: under 8 words, specific, lowercase-ish and natural, not clickbait. If replying in an existing thread the subject is ignored.',
    s.aiExample ? `Match the style of this example email from the sender (style only — do not copy its facts):\n"""${clip(s.aiExample, 1500)}"""` : '',
    'Reply with JSON only: {"subject": "...", "body": "...", "hook": "one short line saying which profile detail you used"}',
  ].filter(Boolean).join('\n');

  const lines = [
    `Goal: ${GOALS[goal] || GOALS.intro}`,
    '',
    'PERSON',
    `Name: ${[person.firstName, person.lastName].filter(Boolean).join(' ')}`,
    person.title && `Title: ${person.title}`,
    person.company && `Company: ${person.company}`,
    insights.headline && `Headline: ${clip(insights.headline, 220)}`,
    person.location && `Location: ${person.location}`,
    insights.about && `About: ${clip(insights.about, 1200)}`,
    insights.experience?.length && `Recent experience: ${insights.experience.slice(0, 3).map((e) => clip(e, 140)).join(' | ')}`,
    hiring.length ? `HIRING NOW: ${hiring.map((h) => h.title + (h.location ? ` (${h.location})` : '')).join('; ')}` : (insights.hiringSignal ? `Hiring signal: ${clip(insights.hiringSignal, 200)}` : 'Hiring: no open roles found on the profile'),
    insights.posts?.length && `Recent posts:\n${insights.posts.slice(0, 3).map((p) => '- ' + clip(p, 300)).join('\n')}`,
    person.notes && `My notes about them: ${clip(person.notes, 400)}`,
    history.length && `Emails I already sent them: ${history.slice(-3).map((h) => `"${h.subject}" (${new Date(h.date).toLocaleDateString()})`).join(', ')}`,
    base && (base.subject || base.body) && `\nUse this template of mine as the starting point and keep its main offer, but personalise it:\nSubject: ${base.subject || ''}\n${clip(base.body, 1500)}`,
  ].filter(Boolean);
  return { system, user: lines.join('\n') };
}

export function parse(text) {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not return an email. Try again.');
  let j;
  try { j = JSON.parse(m[0]); } catch { throw new Error('Claude returned something unexpected. Try again.'); }
  if (!j.body) throw new Error('Claude returned an empty email. Try again.');
  return { subject: String(j.subject || '').trim(), body: String(j.body).trim(), hook: String(j.hook || '').trim() };
}

export async function write({ person, insights, goal, base, history, from }) {
  const s = await store.getSettings();
  if (!s.anthropicKey) throw new Error('Add your Claude API key first: dashboard → Settings → Activity tracking & daily report.');
  const prof = store.senderProfile(s, from || s.defaultSender);
  const { system, user } = buildPrompt({
    person, insights, goal, base, history, settings: s,
    sender: { name: prof.name, hasSignature: !!prof.signature },
  });
  const model = s.aiModel || 'claude-sonnet-5-5';
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': s.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 900, system, messages: [{ role: 'user', content: user }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(claudeError(res.status, body.error?.message || res.statusText, model));
  const out = parse((body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
  // show the signature in the draft so what you see is what gets sent
  out.body = store.withSignature(out.body, prof.signature);
  return out;
}
