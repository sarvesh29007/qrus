'use strict';

/**
 * Intent classification + entity extraction for the Qrus chatbot.
 *
 * Two tiers, in this exact order:
 *
 *   1. RULES (this file) — deterministic keyword/regex scoring. Free, instant,
 *      no PHI leaves the machine. Handles every structured intent the app
 *      already implements: triage, queue, book, cancel, reschedule, intake,
 *      review, FAQs.
 *
 *   2. LLM (llm.service) — consulted only when the rules are *uncertain*, to
 *      understand free-form phrasing the keyword table missed. It returns the
 *      same `{ intent, entities }` shape, so the handlers below never know
 *      which tier produced them. Falls back to `fallback` on any failure.
 *
 * The classifier never touches the database. Entity values that need lookup
 * (doctor names, specialty ids) are extracted as *strings* and resolved by the
 * handlers, which is what keeps this module safe to call on raw patient text.
 */

const llm = require('./llm.service');

/**
 * The public contract of the chatbot. Exported so the LLM prompt, the help
 * reply and the docs can never drift from what handlers actually implement.
 */
const INTENTS = Object.freeze({
  GREETING: 'greeting',
  FAQ: 'faq', // resolved by chatFaq before we ever get here
  TRIAGE: 'triage', // symptom -> specialty recommendation
  QUEUE_STATUS: 'check_queue', // OPD / waitlist position
  BOOK_APPOINTMENT: 'book_appointment',
  CANCEL_APPOINTMENT: 'cancel_appointment',
  RESCHEDULE_APPOINTMENT: 'reschedule_appointment',
  MY_APPOINTMENTS: 'my_appointments',
  INTAKE: 'pre_consultation_intake',
  REVIEW: 'submit_review',
  HELP: 'help',
  SMALLTALK: 'smalltalk', // thanks / bye — answered warmly, no action taken
  FALLBACK: 'fallback',
});

/**
 * Rule table: `patterns` are scored, `required` words must be present for the
 * intent to be eligible (stops "cancel my appointment" matching `book`).
 * Weights are relative; the highest scorer above `THRESHOLD` wins.
 */
const RULES = [
  {
    intent: INTENTS.GREETING,
    weight: 1,
    patterns: [/^(hi|hii?|hey|hello|yo|namaste|good (morning|afternoon|evening))\b/i],
  },
  {
    intent: INTENTS.HELP,
    weight: 2,
    patterns: [/\b(what can you do|help me|how does this work|options|commands|menu)\b/i],
  },
  {
    // "thank you" landing on "I did not quite catch that" is the single most
    // obviously-broken thing a bot can do. These carry no action of their own.
    intent: INTENTS.SMALLTALK,
    weight: 3,
    patterns: [
      /\b(thanks|thank you|thankyou|ta|cheers|much appreciated|appreciate it)\b/i,
      /\b(bye|goodbye|good night|goodnight|take care|see you later)\b/i,
    ],
    // "thanks, cancel the second one" is still a cancellation.
    veto: /\b(cancel\w*|reschedul\w*|book|schedule|appointment|slot|queue|waitlist)\b/i,
  },
  {
    intent: INTENTS.TRIAGE,
    weight: 4,
    // A symptom sentence is a *description*, not a command.
    patterns: [
      /\b(i (?:have|am having|feel|feel(?:ing)?|suffer(?:ing)? from)|my (?:child|wife|husband|mother|father) (?:has|is)|symptoms?|pain|ache|aching|hurt|hurting|unwell|sick|not feeling|under the weather|stomach|tummy|cramp|swollen|congestion|sneez|flu|infection|anxiety|stress|insomnia|fever|cough|rash|dizzy|nausea|vomit|breathless|breathlessness|swelling|inflammation|bleeding|itching|fatigue|weakness|sore throat|headache|migraine|palpitations|constipation|diarrh)/i,
    ],
    // "chest pain" must beat "book" — hence the boost for clinical nouns.
    boost: /\b(pain|ache|hurt|hurting|fever|symptom|rash|swelling|breathless|bleeding|dizzy|nausea)\b/i,
  },
  {
    intent: INTENTS.QUEUE_STATUS,
    weight: 5,
    patterns: [
      /\b(queue|wait(?:ing)? list|waitlist|my position|position in line|how many ahead|line)\b/i,
      /\b(where am i in|status of my (?:slot|appointment|turn))\b/i,
    ],
    required: /\b(queue|wait|position|line|turn|status)\b/i,
  },
  {
    intent: INTENTS.BOOK_APPOINTMENT,
    weight: 5,
    patterns: [
      /\b(book|booking|schedule|scheduling|fix|make|arrange|set up|reserve)\b.{0,20}\b(appointment|slot|visit|consult|doctor)\b/i,
      /\b(appointment|slot|consult|doctor)\b.{0,20}\b(book|schedule|available|availability)\b/i,
      /\bnew appointment\b/i,
      // "I need to see a doctor this week", "can I come in tomorrow" — plain
      // requests for care that name no booking verb at all.
      /\b(?:see|consult|meet|visit|get checked)\b[^.?!]{0,40}\b(?:a|an|the|some)?\s*(?:doctor|specialist|physician|gp|clinic)\b/i,
      /\b(?:need|want|would like|looking for|hoping for|got to|gotta|book me|get me)\b[^.?!]{0,40}\b(?:an?\s+)?(?:appointment|consult|slot|visit|check[- ]?up)\b/i,
      /\b(?:what|which|when)\s+(?:times|slots|openings|appointments|dates)\b/i,
      /\b(?:come|come in|walk in|walk-in)\b[^.?!]{0,30}\b(?:today|tomorrow|this week|soon|asap)\b/i,
      // "book me something anyway" — a booking verb with no object.
      /\b(?:book|schedule|reserve|arrange|set up)\b[^.?!]{0,25}\b(?:something|anything|one|a slot|a visit|a time)\b/i,
      // The assistant literally says `say a specialty ("cardiology")`, so a bare
      // specialty name has to count as a booking request — with or without the
      // verb patients reach for ("book cardiology", "show me dermatology").
      /^\s*(?:please\s+)?(?:(?:book|schedule|reserve|find|show me|give me|want|would like)\s+)?(?:i (?:want|would like|was hoping) (?:to see )?|with )?(?:an?\s+|the\s+)?(?:cardiolog\w*|dermatolog\w*|orthoped\w*|orthopaed\w*|pediatric\w*|paediatric\w*|gynaecolog\w*|gynecolog\w*|neurolog\w*|gastroenterolog\w*|endocrinolog\w*|ophthalmolog\w*|urolog\w*|psychiatr\w*|respiratory|general medicine|general physician|physician|dentist\w*|dental|eye care|mental health|ent)\s*(?:appointment|doctor|specialist|please)?\s*$/i,
      // "with Dr. Meera", "dr meera sharma" — a named doctor is a booking too.
      /^\s*(?:with\s+)?(?:dr\.?|doctor)\s+[a-z][a-z\s]{0,30}$/i,
      // After a triage suggestion the assistant literally says `Reply "book"`,
      // so the bare verb ("book", "book it", "book me in") must qualify.
      /^\s*(?:please\s+)?(book|schedule|reserve)\b(?:\s*(?:me|it|that|one|now|in|up|please|an? appointment))*\s*[.!?]*\s*$/i,
    ],
    // Must not hijack an explicit cancellation/reschedule.
    veto: /\b(cancel|reschedul|postpone|move (?:my|the) appointment)\b/i,
  },
  {
    intent: INTENTS.RESCHEDULE_APPOINTMENT,
    weight: 6,
    patterns: [
      /\b(reschedule|rescheduling|rescheduled|postpone|move|change|shift|push back|put off|another (?:day|time|slot)|different (?:day|time|slot|doctor))\b/i,
    ],
    // "reschedule 1" is the exact phrasing the assistant advertises after it
    // lists appointments, so a verb followed by a pick number must qualify.
    required:
      /\b(appointment|slot|visit|consult|booking|it|one)\b|\b(?:reschedul\w*|postpone|move|change|shift|push back|put off)(?:\s+(?:appointment|booking|visit|slot))?\s*#?\s*\d{1,3}\s*[.!?]*\s*$/i,
  },
  {
    intent: INTENTS.CANCEL_APPOINTMENT,
    weight: 6,
    patterns: [/\b(cancel|cancelling|canceled|cancelled|call off|scrap|drop)\b/i],
    // "please cancel" / "cancel that" are just as clear as "cancel my appointment",
    // so the verb standing alone at the end of a message still counts — and so
    // does "cancel 2", which is what we tell patients to type.
    required:
      /\b(appointment|slot|booking|visit|consult|it|one|that|this)\b|\b(?:cancel\w*|call off|scrap|drop)(?:\s+(?:appointment|booking|visit|slot))?\s*#?\s*\d{1,3}\s*[.!?]*\s*$/i,
  },
  {
    intent: INTENTS.MY_APPOINTMENTS,
    weight: 4,
    patterns: [
      /\b(my|show|list|see|check|what are|upcoming|next)\b.{0,20}\bappointments?\b/i,
      /\bappointments?\b.{0,20}\b(i have|do i have|mine)\b/i,
      /\b(upcoming visits|my visits|next visit)\b/i,
    ],
    veto: /\b(cancel|reschedul|book|schedule)\b/i,
  },
  {
    intent: INTENTS.INTAKE,
    weight: 6,
    patterns: [
      /\b(medical history|health history|past (?:history|illness|surgery)|pre[- ]?consult)/i,
      /\b(medicines?|medications?|meds|prescription|drugs? i take|tablets?)\b/i,
      /\b(allergies|allergic to)\b/i,
      /\b(intake form|intake|history and (?:my )?(?:medicines|medications))\b/i,
    ],
  },
  {
    intent: INTENTS.REVIEW,
    weight: 6,
    patterns: [
      /\b(review|rating|rate (?:the|my|dr|doctor)|feedback|stars?)\b/i,
      /\b(good|bad|excellent|poor|terrible|amazing|wonderful)\b.{0,15}\b(doctor|visit|consult)\b/i,
    ],
    required: /\b(review|rating|rate|feedback|stars?)\b/i,
  },
];

const THRESHOLD = 3;

/** Pull concrete values out of free text. Regex only — no DB, no network. */
function extractEntities(text) {
  const entities = {
    symptoms: [],
    doctorName: null,
    specialty: null,
    date: null,
    time: null,
    rating: null,
    appointmentId: null,
    selection: null,
  };

  // --- doctor name: "dr. meera", "with meera", "dr meera sharma" -----------
  const doctor = /\b(?:dr\.?|doctor)\s+([a-z][a-z\s]{1,40})/i.exec(text);
  if (doctor) {
    entities.doctorName = doctor[1].replace(/\s+(?:on|at|for|tomorrow|today)$/i, '').trim() || null;
  }

  // --- specialty, by plain name ("cardiologist", "dermatology") ------------
  const specialty =
    /\b(cardiolog\w*|dermatolog\w*|orthoped\w*|orthopaed\w*|pediatric\w*|paediatric\w*|gynaecolog\w*|gynecolog\w*|neurolog\w*|ent|ophthalmolog\w*|dentist\w*|dental|psychiatr\w*|general physician|physician)\b/i.exec(
      text
    );
  if (specialty) entities.specialty = specialty[1].toLowerCase();

  // --- date: ISO, "tomorrow", "today", weekday, "25 oct" ------------------
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso) entities.date = iso[1];
  else if (/\btomorrow\b/i.test(text)) entities.date = 'tomorrow';
  else if (/\btoday\b/i.test(text)) entities.date = 'today';
  else {
    const weekday =
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)\b/i.exec(text);
    if (weekday) entities.date = weekday[1].toLowerCase();
  }

  // --- time: "10:30", "10 am", "afternoon" --------------------------------
  const clock = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.exec(text);
  const hourOnly = /\b(\d{1,2})\s*(am|pm)\b/i.exec(text);
  if (clock) {
    entities.time = `${clock[1].padStart(2, '0')}:${clock[2]}${clock[3] ? clock[3].toLowerCase() : ''}`;
  } else if (hourOnly) {
    entities.time = `${hourOnly[1].padStart(2, '0')}:00${hourOnly[2].toLowerCase()}`;
  } else if (/\b(morning|forenoon)\b/i.test(text)) entities.time = 'morning';
  else if (/\b(afternoon|evening)\b/i.test(text)) entities.time = 'afternoon';

  // --- rating: "4 stars", "rating 5" --------------------------------------
  const stars = /\b([1-5])(?:\s*(?:out of 5|stars?|\/5))\b/i.exec(text) || /\brating\s*([1-5])\b/i.exec(text);
  if (stars) entities.rating = Number(stars[1]);

  // --- appointment reference: "appointment 12", "#12" ----------------------
  const appt = /\b(?:appointment|booking|visit|consult)\s*#?\s*(\d{1,9})\b/i.exec(text);
  if (appt) entities.appointmentId = Number(appt[1]);

  // --- pick from the last list: "cancel 2", "reschedule 1", "number 3" ----
  // Anchored at the end of the message so a number in passing ("move it 2
  // hours later") is not mistaken for a selection.
  const selection =
    /\b(?:cancel\w*|reschedul\w*|postpone|book|choose|pick|option|number)(?:\s+(?:appointment|booking|visit|slot))?\s*#?\s*(\d{1,3})\s*[.!?]*\s*$/i.exec(
      text
    );
  if (selection) entities.selection = Number(selection[1]);

  // --- words for numbers: "the first one", "second", "3rd", "two" ----------
  // Patients answer a numbered list the way people actually talk. Anchored to
  // the whole message so "move it first thing in the morning" is not a pick.
  if (!entities.selection) {
    const ORDINALS = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
      first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
    };
    const words = /^\s*(?:the\s+|yes\s+)?([a-z]+|\d{1,2})(?:st|nd|rd|th)?\s*(?:one|option|appointment|slot|item|please)?\s*[.!?]*\s*$/i.exec(
      text
    );
    if (words) {
      const token = words[1].toLowerCase();
      const n = /^\d+$/.test(token) ? Number(token) : ORDINALS[token];
      if (Number.isInteger(n) && n >= 1 && n <= 9) entities.selection = n;
    }
  }

  // --- symptoms: keep the clauses that read like a complaint --------------
  const symptomClauses = String(text)
    .split(/[,;.]| and then | also | plus /i)
    .map((clause) => clause.trim())
    .filter((clause) => /\b(pain|ache|aching|fever|cough|rash|dizzy|nausea|vomit|breathless|swelling|bleeding|itching|fatigue|weakness|sore|headache|migraine|palpitations|constipation|diarrh|burning|numbness|tightness|pressure|cramps?)\b/i.test(clause));
  entities.symptoms = symptomClauses.slice(0, 6);

  return entities;
}

/**
 * Deterministic tier. Returns `{ intent, entities, confidence }` where
 * `confidence` is 'high' (act now) or 'low' (let the LLM try).
 */
function classifyByRules(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { intent: INTENTS.FALLBACK, entities: {}, confidence: 'high' };

  let best = { intent: null, score: 0, confidence: 'low' };
  for (const rule of RULES) {
    if (rule.required && !rule.required.test(trimmed)) continue;
    if (rule.veto && rule.veto.test(trimmed)) continue;

    let score = 0;
    for (const pattern of rule.patterns) if (pattern.test(trimmed)) score += rule.weight;
    if (rule.boost && rule.boost.test(trimmed)) score += 2;

    if (score > best.score) best = { intent: rule.intent, score, confidence: score >= THRESHOLD ? 'high' : 'low' };
  }

  // Even with no intent, keep the extracted entities: while we are waiting on
  // a numbered list, "book 1" is a perfectly good answer to the pending
  // question even though it names no action of its own.
  if (!best.intent) {
    return { intent: INTENTS.FALLBACK, entities: extractEntities(trimmed), confidence: 'low' };
  }
  return { intent: best.intent, entities: extractEntities(trimmed), confidence: best.confidence };
}

// ---------------------------------------------------------------------------
// LLM tier
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the intent classifier for Qrus, a clinic scheduling assistant.
Read the patient's message and reply with ONLY a JSON object, no prose:

{"intent": "<one of the allowed intents>", "entities": { ... }}

Allowed intents: ${Object.values(INTENTS).join(', ')}.

Entity keys (include only those you are sure about):
  symptoms   : array of short symptom phrases, e.g. ["chest tightness"]
  doctorName : doctor first name, e.g. "Meera"
  specialty  : e.g. "cardiology"
  date       : "YYYY-MM-DD", "today", "tomorrow" or a weekday
  time       : "HH:MM", "morning", "afternoon"
  rating     : integer 1-5
  appointmentId : integer appointment number if the patient names one

Rules:
- Never invent entities the patient did not state.
- Never answer the patient, never give medical advice, never add commentary.
- A question about clinic hours, fees, parking, address or documents is "faq".
- If you cannot tell what the patient wants, use "fallback".`;

const ALLOWED = new Set(Object.values(INTENTS));

/** Free-form tier. Returns null when no provider is configured or it fails. */
async function classifyByLlm(text) {
  if (!llm.isConfigured()) return null;
  const reply = await llm.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: String(text).slice(0, 1200) }],
    json: true,
  });
  const parsed = llm.parseJson(reply);
  if (!parsed || !ALLOWED.has(parsed.intent)) return null;

  const entities = extractEntities(String(text)); // rules stay authoritative for values
  if (parsed.entities && typeof parsed.entities === 'object') {
    for (const key of ['doctorName', 'specialty', 'date', 'time']) {
      if (!entities[key] && typeof parsed.entities[key] === 'string') {
        entities[key] = String(parsed.entities[key]).slice(0, 80);
      }
    }
    if (!entities.rating && Number.isInteger(parsed.entities.rating)) {
      entities.rating = Math.min(5, Math.max(1, parsed.entities.rating));
    }
    if (!entities.appointmentId && Number.isInteger(parsed.entities.appointmentId)) {
      entities.appointmentId = parsed.entities.appointmentId;
    }
    if (!entities.symptoms.length && Array.isArray(parsed.entities.symptoms)) {
      entities.symptoms = parsed.entities.symptoms
        .filter((s) => typeof s === 'string')
        .map((s) => s.slice(0, 120))
        .slice(0, 6);
    }
  }
  return { intent: parsed.intent, entities, confidence: 'high', source: 'llm' };
}

/**
 * Classify one patient message.
 * @param {string} text
 * @returns {Promise<{ intent: string, entities: object, confidence: string, source: string }>}
 */
async function classify(text) {
  const ruled = classifyByRules(text);
  if (ruled.confidence === 'high') return { ...ruled, source: 'rules' };

  const fromLlm = await classifyByLlm(text);
  if (fromLlm) return fromLlm;

  return { ...ruled, source: 'rules' };
}

module.exports = { classify, classifyByRules, extractEntities, INTENTS };
