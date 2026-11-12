// "Write with AI": Claude drafts a personalised email from what's on the person's LinkedIn profile
// (headline, about, experience, recent posts) and any roles they're hiring for.
import * as store from './store.js';

// (kept here instead of importing report.js, so the phone app can use this file too)
function claudeError(status, message, model) {
  if (status === 401) return 'Claude API key was rejected — check it in Settings.';
  if (status === 404) return `Model not available on your account (${model}). Pick another in Settings.`;
  return 'Claude API: ' + message;
}

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

// Industry angles: "we have sourcers who know <industry> and have sourced/placed <roles>"
export const INDUSTRIES = {
  construction: { label: 'Construction', roles: ['Project Manager', 'Estimator', 'Superintendent', 'Project Engineer', 'Preconstruction Manager', 'Safety Manager', 'Scheduler', 'Field Engineer', 'MEP Coordinator'],
    know: 'construction terminology, GC vs subcontractor roles, bid/estimating and site-based work, OSHA/safety certifications',
    re: /construct|contractor|builder|civil|superintendent|estimator|precon|mep\b|hvac|electrical contractor|general contractor/i },
  robotics: { label: 'Robotics', roles: ['Robotics Engineer', 'Controls Engineer', 'Mechatronics Engineer', 'Embedded Software Engineer', 'Perception / Computer Vision Engineer', 'Applications Engineer', 'Field Service Technician', 'Test Engineer'],
    know: 'ROS, motion control, embedded C/C++, perception and vision stacks, and the hardware + software mix these teams need',
    re: /robot|mechatronic|autonomous|\bros\b|perception|computer vision|cobot|drone/i },
  automation: { label: 'Industrial Automation', roles: ['Controls Engineer', 'PLC Programmer', 'Automation Engineer', 'SCADA Engineer', 'Instrumentation Technician', 'Electrical Engineer', 'Field Service Engineer', 'Systems Integration Engineer'],
    know: 'PLC platforms (Allen-Bradley, Siemens), SCADA/HMI, instrumentation, system integrators and travel-heavy field roles',
    re: /automation|plc|scada|hmi|controls? engineer|instrumentation|system integrator|allen.?bradley|industrial/i },
  engineering: { label: 'Engineering', roles: ['Mechanical Engineer', 'Electrical Engineer', 'Civil / Structural Engineer', 'Design Engineer', 'Manufacturing Engineer', 'Quality Engineer', 'Process Engineer', 'CAD Designer', 'Project Engineer'],
    know: 'engineering disciplines, PE/EIT licensing, CAD tools (SolidWorks, AutoCAD, Revit) and design vs field roles',
    re: /engineer|engineering|structural|mechanical|solidworks|autocad|revit|\bpe\b/i },
  healthcare: { label: 'Healthcare', roles: ['Registered Nurse', 'LPN', 'CNA', 'Medical Assistant', 'Physical / Occupational Therapist', 'Nurse Practitioner / PA', 'Allied Health Technologist', 'Medical Coder', 'Practice Manager'],
    know: 'clinical specialties, licensure and state compact rules, shift patterns and credentialing',
    re: /health|hospital|clinic|medical|nurs|\brn\b|lpn|cna|therap|physician|patient|care\b|pharma|dental|behavioral/i },
  legal: { label: 'Legal', roles: ['Attorney / Associate', 'Paralegal', 'Legal Assistant', 'Litigation Support Specialist', 'Contracts Manager', 'Compliance Analyst', 'Legal Secretary', 'In-house Counsel'],
    know: 'practice areas, bar admissions, law-firm vs in-house roles and confidentiality expectations',
    re: /legal|law\b|law firm|attorney|lawyer|paralegal|counsel|litigation|compliance/i },
  it: { label: 'IT / Software', roles: ['Software Engineer', 'Java / .NET Developer', 'Data Engineer', 'DevOps / Cloud Engineer', 'QA Engineer', 'Business Analyst', 'Project Manager', 'Cybersecurity Analyst'],
    know: 'tech stacks, cloud platforms, contract vs full-time IT roles and visa/work-authorization screening',
    re: /software|developer|information technology|it services|it staffing|devops|cloud|data engineer|java|\.net|python|cyber|saas|technology/i },
  finance: { label: 'Finance & Accounting', roles: ['Staff / Senior Accountant', 'Controller', 'Financial Analyst', 'AP / AR Specialist', 'Payroll Specialist', 'Tax Associate', 'Bookkeeper', 'FP&A Manager'],
    know: 'CPA/CMA credentials, ERP systems (NetSuite, SAP, QuickBooks), close cycles and audit/tax seasons',
    re: /financ|accounting|accountant|cpa\b|controller|bookkeep|payroll|tax\b|audit|fp&a|bank/i },
  manufacturing: { label: 'Manufacturing', roles: ['Production Supervisor', 'Plant Manager', 'Manufacturing Engineer', 'Quality Inspector', 'Maintenance Technician', 'CNC Machinist', 'Supply Chain Planner', 'EHS Specialist'],
    know: 'plant and shift operations, lean / Six Sigma, CNC and maintenance trades, and quality systems (ISO, FDA)',
    re: /manufactur|plant\b|production|cnc|machinist|factory|assembly|lean|six sigma|fabricat/i },
};
export const INDUSTRY_ORDER = ['construction', 'robotics', 'automation', 'engineering', 'healthcare', 'legal', 'it', 'finance', 'manufacturing'];
// the order we test in: most specific first, so "controls engineer at a robotics company" → robotics, not engineering
const DETECT_ORDER = ['robotics', 'automation', 'construction', 'healthcare', 'legal', 'finance', 'manufacturing', 'it', 'engineering'];

// Which industry the email should speak to: the industry field first, then the roles they're hiring for, then title/company/headline
export function detectIndustry(person = {}, insights = {}) {
  const hiring = [...(insights.hiring || []).map((h) => h.title), ...(person.jobs || []).map((j) => j.role)].filter(Boolean).join(' ; ');
  const sources = [
    [person.industry, person.companyInfo?.industry].filter(Boolean).join(' '),
    hiring,
    [person.title, person.company, insights.headline, person.companyInfo?.description].filter(Boolean).join(' '),
  ];
  for (const text of sources) {
    if (!text) continue;
    for (const k of DETECT_ORDER) if (INDUSTRIES[k].re.test(text)) return k;
  }
  return '';
}

// Who we're writing to: a staffing agency (we supply sourcers/VAs to them) or a direct employer (we recruit for them)
export function audienceOf(person = {}, choice = 'auto') {
  if (choice === 'staffing' || choice === 'employer') return choice;
  if (person.track === 'Full Cycle' || person.type === 'FC-Prospect') return 'employer';
  if (person.track === 'Sourcer' || person.type === 'Prospect') return 'staffing';
  const t = [person.company, person.industry, person.companyInfo?.industry, person.title].filter(Boolean).join(' ');
  if (/staffing|recruit|talent solutions|search firm|placement|workforce solutions|\brpo\b/i.test(t)) return 'staffing';
  return 'staffing';
}

// ---------- variety: every email opens differently, so a batch never reads like a template ----------
export const OPENERS = {
  milestone: 'Open with a short warm greeting, then congratulate them on something real and recent in the data (a new project, expansion, new office, award, funding, anniversary, promotion, a post they wrote). Then link it to hiring.',
  company: 'Open by saying something specific you like or noticed about what the company does (its projects, sectors, clients, how long it has been around, where it operates — only what the data shows). Then bring in the open role(s).',
  person: 'Open about THEM: their role, how long they have been in it, their career path or something in their About. Make it a genuine one-line observation, then move to hiring.',
  question: 'Open with one short, relevant question about their hiring (e.g. how they are finding candidates for the role, whether the role is still open, how the team is handling the workload). No yes/no "quick question" cliché.',
  season: 'Open with a natural, timely greeting (time of year, end of quarter/year planning, a busy season for their industry) in one short line, then get to the role in the next sentence.',
  direct: 'Be direct: first line says plainly who you are and why you are writing to them specifically (their open role by name), in one sentence. No warm-up.',
  insight: 'Open with one short, honest observation about hiring for that kind of role in their industry (how in-demand those people are, what usually slows the search). General knowledge only — no invented numbers or statistics.',
};
const OPENER_KEYS = Object.keys(OPENERS);
// subject lines rotate too — never the same formula twice in a row
export const SUBJECTS = {
  question: 'a short question, e.g. "Quick question about your Estimator search" or "Still looking for a Project Engineer?"',
  news: 'their company news or milestone, e.g. "Congrats on the Dallas expansion" (only if the data has it)',
  name: 'starts with their first name, e.g. "Dana, a thought on your PE hiring"',
  offer: 'what you can give them, e.g. "Shortlist for your Controls Engineer role" or "Profiles for the RN openings"',
  curiosity: 'a short, honest, curious line, e.g. "Idea for the recruiting team" or "A thought on the Superintendent search" (never fake a reply with "Re:" or "Fwd:")',
  plain: 'plain and specific: role + company, e.g. "Estimator hiring at Brinkmann"',
  industry: 'their industry angle, e.g. "Construction sourcing help" or "Healthcare recruiters for your team"',
};
const SUBJECT_KEYS = Object.keys(SUBJECTS);
export function pickSubject(recent = [], rnd = Math.random) {
  const last = recent.slice(0, 4).map((r) => r.subjectStyle);
  const pool = SUBJECT_KEYS.filter((k) => !last.includes(k));
  return (pool.length ? pool : SUBJECT_KEYS)[Math.floor(rnd() * (pool.length || SUBJECT_KEYS.length))];
}
const BANNED_OPENINGS = ['Saw ', 'I saw', 'I noticed', 'Noticed ', 'I came across', 'I hope this email finds you well', 'Hope this finds you well', 'Quick question', 'I wanted to reach out', 'My name is'];
const RECENT_KEY = 'aiRecentOpeners';
async function recentOpeners() {
  try {
    if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(RECENT_KEY))[RECENT_KEY] || [];
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch { return []; }
}
async function rememberOpener(entry) {
  try {
    const list = [entry, ...(await recentOpeners())].slice(0, 12);
    if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [RECENT_KEY]: list });
    else localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* best effort */ }
}
// pick an opening style not used in the last few emails
export function pickOpener(recent = [], rnd = Math.random) {
  const lastStyles = recent.slice(0, 4).map((r) => r.style);
  const pool = OPENER_KEYS.filter((k) => !lastStyles.includes(k));
  const from = pool.length ? pool : OPENER_KEYS;
  return from[Math.floor(rnd() * from.length)];
}
export function firstLine(body = '') {
  const lines = String(body).split('\n').map((x) => x.trim()).filter(Boolean);
  const l = lines.find((x, i) => !(i === 0 && /^(hi|hello|hey|dear|good (morning|afternoon))\b/i.test(x) && x.length < 40)) || '';
  return l.split(/(?<=[.?!])\s/)[0].slice(0, 160);
}

export const PRICE_DEFAULT = '$1,000 per month for a dedicated, full-time sourcer / recruiting VA';

function industryRules({ person, insights, industry, audience, s }) {
  const key = industry && industry !== 'auto' ? industry : detectIndustry(person, insights);
  const ind = INDUSTRIES[key];
  const out = [];
  if (audience === 'staffing') {
    out.push('- The reader runs or leads a STAFFING / RECRUITING AGENCY. The sender (Nexellence) gives agencies dedicated offshore sourcers / recruiting VAs who work as part of the agency\'s own team (sourcing, screening, submittals, ATS updates) so their recruiters can spend time on clients and closing. Speak recruiter-to-recruiter.');
  } else {
    out.push('- The reader works at a DIRECT EMPLOYER (not an agency). The sender (Nexellence) runs full-cycle recruiting for employers: sourcing, screening and shortlisting through to offer, working alongside their HR / hiring managers. Talk about filling their roles faster with qualified, pre-screened candidates — never about supplying sourcers to an agency.');
  }
  if (ind) {
    const roles = ind.roles.slice(0, 6).join(', ');
    out.push(audience === 'staffing'
      ? `- Industry angle — ${ind.label}: say we have sourcers with solid ${ind.label} knowledge (${ind.know}) who have sourced and helped place roles like ${roles}. Where their open roles are listed, name THOSE roles first and say our sourcers work on exactly these.`
      : `- Industry angle — ${ind.label}: say our recruiters know ${ind.label} hiring (${ind.know}) and have sourced and placed roles like ${roles}. Where their open roles are listed, name THOSE roles first and say we recruit for exactly these.`);
  }
  const price = (s.aiPrice ?? PRICE_DEFAULT).trim();
  const when = s.aiPriceWhen || 'staffing';
  if (price && (when === 'always' || (when === 'staffing' && audience === 'staffing'))) {
    out.push(`- Pricing: you may mention, in one short plain sentence, that it is ${price} (it works well as the reason to reply). Never invent other prices, discounts or terms.`);
  } else {
    out.push('- Do not mention prices, rates or fees.');
  }
  return { rules: out, label: ind?.label || '' };
}

const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function buildPrompt({ person, insights = {}, goal = 'intro', base, history = [], sender, settings: s, industry = 'auto', audience = 'auto', opener = '', recent = [], subjectStyle = '' }) {
  const jobsHiring = (person.jobs || []).filter((j) => j && j.role).map((j) => ({ title: j.role, location: j.location }));
  const hiring = [...(insights.hiring || []), ...jobsHiring].filter((h) => h && h.title)
    .filter((h, i, a) => a.findIndex((x) => x.title.toLowerCase() === h.title.toLowerCase()) === i).slice(0, 8);
  const aud = audienceOf(person, audience);
  const ir = industryRules({ person, insights, industry, audience: aud, s });
  const system = [
    `You write short, personalised B2B emails for ${sender.name || 'the sender'}${s.aiPitch ? '' : ', who runs a recruiting / sourcing services business'}.`,
    s.aiPitch ? `What the sender offers, in their own words:\n"""${clip(s.aiPitch, 1500)}"""` : '',
    'Rules:',
    ...ir.rules,
    goal === 'followup' || !opener
      ? '- Open with one specific, genuine detail from the profile (the roles they are hiring for beat everything else; then a recent post, their company, their role or something from their About). Never invent facts that are not in the data.'
      : `- OPENING for this email (style "${opener}"): ${OPENERS[opener]} If the data has nothing for this style, use another style from this list that the data does support: ${Object.keys(OPENERS).filter((k) => k !== opener).join(', ')}. Never invent facts that are not in the data.`,
    '- Greeting: vary it naturally (e.g. "Hi [first name]," / "Hello [first name]," / "[first name]," / "Good morning [first name],"); do not always use the same one.',
    `- Never start the first sentence with: ${BANNED_OPENINGS.map((b) => `"${b.trim()}"`).join(', ')}. Avoid stock lines like "rarely apply to postings", "finding people one by one", "I hope you are doing well".`,
    recent.length ? `- My last emails opened like this — do NOT reuse their wording, structure or first words:\n${recent.slice(0, 6).map((r) => '  • ' + r.line).join('\n')}` : '',
    '- Vary the shape: sometimes 2 short paragraphs, sometimes 3; vary the call to action wording (e.g. a reply, a 15-minute call, "want me to send a few matching profiles?", "worth a conversation?"); an occasional one-line P.S. is fine. It must read like a person wrote it for this one reader.',
    '- If they are hiring, connect what the sender offers to those exact roles by name.',
    '- One clear, low-effort call to action (e.g. a reply or a 15-minute call). No pressure, no hype, no buzzwords, no emojis, no exclamation marks.',
    `- Tone: ${TONES[s.aiTone] || TONES.friendly}. Length of the body: ${LENGTHS[s.aiLength] || LENGTHS.short}.`,
    '- Plain text. Address them by first name. Short paragraphs.',
    sender.hasSignature ? '- End with a short closing line such as "Best regards," and NOTHING after it — no name, no signature (the sender\'s signature is added right below automatically).' : `- End with the sender's name: ${sender.name || ''}.`,
    '- Subject line: under 8 words, specific and natural, not clickbait. Sentence case: capital first letter, proper nouns and acronyms capitalised, no full stop at the end. If replying in an existing thread the subject is ignored.',
    subjectStyle ? `- Subject style for THIS email: ${SUBJECTS[subjectStyle]}. Never use the pattern "Your <role> opening" / "Your <role> openings".` : '- Never use the subject pattern "Your <role> opening".',
    recent.some((r) => r.subject) ? `- Recent subjects I used — make this one clearly different: ${recent.filter((r) => r.subject).slice(0, 6).map((r) => `"${r.subject}"`).join(', ')}` : '',
    s.aiExample ? `Match the style of this example email from the sender (style only — do not copy its facts):\n"""${clip(s.aiExample, 1500)}"""` : '',
    'Reply with JSON only: {"subject": "...", "body": "...", "hook": "one short line saying which profile detail you used"}',
  ].filter(Boolean).join('\n');

  const lines = [
    `Goal: ${GOALS[goal] || GOALS.intro}`,
    `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`,
    '',
    'PERSON',
    `Name: ${[person.firstName, person.lastName].filter(Boolean).join(' ')}`,
    person.title && `Title: ${person.title}`,
    person.company && `Company: ${person.company}`,
    (person.industry || person.companyInfo?.industry) && `Company industry: ${person.industry || person.companyInfo.industry}`,
    ir.label && `Industry to speak to: ${ir.label}`,
    `Reader is: ${aud === 'staffing' ? 'a staffing / recruiting agency' : 'a direct employer'}`,
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
  return { system, user: lines.join('\n'), industry: ir.label, audience: aud };
}

// "java + qa hiring at acme." → "Java + qa hiring at acme" (first letter capital, no quotes or trailing full stop)
export function tidySubject(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/^subject:\s*/i, '').replace(/\.+$/, '').trim();
  return t ? t.charAt(0).toLocaleUpperCase() + t.slice(1) : t;
}

export function parse(text) {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not return an email. Try again.');
  let j;
  try { j = JSON.parse(m[0]); } catch { throw new Error('Claude returned something unexpected. Try again.'); }
  if (!j.body) throw new Error('Claude returned an empty email. Try again.');
  return { subject: tidySubject(j.subject), body: String(j.body).trim(), hook: String(j.hook || '').trim() };
}

export async function write({ person, insights, goal, base, history, from, settings, industry, audience, bare }) {
  const s = settings || (await store.getSettings());
  if (!s.anthropicKey) throw new Error('Add your Claude API key first: dashboard → Settings → Activity tracking & daily report.');
  const prof = store.senderProfile(s, from || s.defaultSender);
  const recent = await recentOpeners();
  const opener = pickOpener(recent);
  const subjectStyle = pickSubject(recent);
  const { system, user, industry: indLabel, audience: aud } = buildPrompt({
    person, insights, goal, base, history, settings: s, industry: industry || 'auto', audience: audience || 'auto', opener, recent, subjectStyle,
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
  if (goal !== 'followup') rememberOpener({ style: opener, line: firstLine(out.body), subjectStyle, subject: out.subject, at: Date.now() });
  if (!bare) out.body = store.withSignature(out.body, prof.signature);
  out.industry = indLabel; out.audience = aud;
  return out;
}
