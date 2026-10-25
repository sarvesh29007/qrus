'use strict';

/**
 * Smart Healthcare Chatbot — conversation controller.
 *
 * One endpoint drives the whole dialog: POST /chat/sessions/:id/messages.
 * Each turn is:
 *
 *   persist user msg  ->  FAQ fast-path  ->  classify (rules, then LLM)
 *                        ->  dispatch to the SAME services the REST portal
 *                            uses -> persist bot msg -> reply
 *
 * Design rules that matter here:
 *   * The chat never reimplements scheduling. Booking, cancelling and
 *     rescheduling go through schedulingEngine, so its row locks, partial
 *     unique indexes and waitlist cascade stay authoritative. A chat user
 *     cannot double-book any more than a portal user can.
 *   * Every state-changing handler calls audit() with the same action codes
 *     the portal uses, so the immutable log does not care which surface the
 *     action came from.
 *   * Dialog state lives in chat_sessions.context (JSONB). It holds ids and
 *     slots only — never clinical text — so a leaked context row is not a
 *     leaked chart.
 */

const { z } = require('zod');
const { query, queryOne, withTransaction } = require('../config/db');
const { ApiError, asyncHandler } = require('../utils/errors');
const { audit, ACTIONS } = require('../services/audit.service');
const engine = require('../services/schedulingEngine');
const waitlist = require('../services/waitlistQueue');
const { matchSymptoms } = require('../services/symptomMatcher');
const faq = require('../services/chatFaq');
const { classify, INTENTS } = require('../services/chatIntents');
const llm = require('../services/llm.service');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const createSessionSchema = z.object({
  subject: z.string().trim().max(120).default(''),
});

const messageSchema = z.object({
  content: z.string().trim().min(1).max(2000),
});

const sessionIdParam = z.object({ id: z.coerce.number().int().positive() });

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Specialty aliases the classifier emits -> canonical `specialties.name`. */
const SPECIALTY_ALIASES = {
  cardiologist: 'Cardiology', cardiology: 'Cardiology', heart: 'Cardiology',
  dermatologist: 'Dermatology', dermatology: 'Dermatology', skin: 'Dermatology',
  orthoped: 'Orthopedics', orthopaed: 'Orthopedics', bone: 'Orthopedics', joint: 'Orthopedics',
  pediatric: 'Pediatrics', paediatric: 'Pediatrics', child: 'Pediatrics', children: 'Pediatrics',
  gynaecolog: "Obstetrics & Gynecology", gynecolog: "Obstetrics & Gynecology",
  neurolog: 'Neurology', nerve: 'Neurology', brain: 'Neurology',
  ent: 'ENT', ear: 'ENT', nose: 'ENT', throat: 'ENT',
  ophthalmolog: 'Ophthalmology', eye: 'Ophthalmology',
  dentist: 'Dental', dental: 'Dental', teeth: 'Dental',
  psychiatrist: 'Psychiatry', mental: 'Psychiatry',
  physician: 'General Medicine', 'general physician': 'General Medicine',
};

async function resolveSpecialty(name) {
  if (!name) return null;
  const key = String(name).toLowerCase();
  const canonical = SPECIALTY_ALIASES[key] || Object.entries(SPECIALTY_ALIASES)
    .find(([alias]) => key.includes(alias))?.[1];

  const { rows } = await query(
    `SELECT id, name FROM specialties
      WHERE is_active AND (lower(name) = lower($1) OR lower(name) LIKE '%' || $1 || '%')
      ORDER BY length(name) LIMIT 1`,
    [canonical || name]
  );
  return rows[0] || null;
}

/** Resolve a doctor by "dr meera" / "meera sharma" / "meera". */
async function resolveDoctor(name) {
  if (!name) return null;
  const cleaned = String(name).replace(/^dr\.?\s+/i, '').trim();
  if (!cleaned) return null;
  const { rows } = await query(
    `SELECT u.id, u.full_name, dp.consultation_fee, dp.clinic_name,
            s.name AS specialty_name
       FROM doctor_profiles dp
       JOIN users u ON u.id = dp.user_id
       JOIN specialties s ON s.id = dp.specialty_id
      WHERE u.status = 'active' AND u.role = 'doctor'
        AND (u.full_name ILIKE $1 OR u.full_name ILIKE $1 || '%'
             OR split_part(u.full_name, ' ', 1) ILIKE $1)
      ORDER BY u.full_name LIMIT 1`,
    [`%${cleaned}%`]
  );
  return rows[0] || null;
}

/** Turn "tomorrow" / "friday" / "2026-11-02" into a YYYY-MM-DD the engine accepts. */
/**
 * Doctor names are stored as "Dr Meera Iyer", so prefixing another "Dr." gives
 * "Dr. Dr Meera Iyer". Normalise once here rather than at every call site.
 */
function docName(name) {
  const clean = String(name || '')
    .trim()
    .replace(/^dr\.?\s+/i, '');
  return clean ? `Dr. ${clean}` : 'your doctor';
}

function resolveDate(value) {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^today$/i.test(value)) return iso(now);
  if (/^tomorrow$/i.test(value)) return iso(new Date(now.getTime() + 86400000));
  if (/^next week$/i.test(value)) return iso(new Date(now.getTime() + 7 * 86400000));

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const idx = days.indexOf(String(value).toLowerCase());
  if (idx >= 0) {
    let delta = (idx - now.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "friday" on a Friday means next Friday
    return iso(new Date(now.getTime() + delta * 86400000));
  }
  return null;
}

/** First names of a patient's upcoming appointments, for "which one?" prompts. */
async function upcomingAppointments(patientId, limit = 5) {
  const { rows } = await query(
    `SELECT a.id, a.status, a.scheduled_date,
            to_char(a.scheduled_time, 'HH24:MI') AS scheduled_time,
            d.full_name AS doctor_name, sp.name AS specialty_name,
            EXISTS (SELECT 1 FROM pre_consultation_intake i WHERE i.appointment_id = a.id) AS has_intake
       FROM appointments a
       JOIN users d ON d.id = a.doctor_id
       JOIN specialties sp ON sp.id = a.specialty_id
      WHERE a.patient_id = $1
        AND a.status IN ('pending', 'scheduled')
        AND a.scheduled_for >= now()
      ORDER BY a.scheduled_for ASC LIMIT $2`,
    [patientId, limit]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Dialog state
// ---------------------------------------------------------------------------
function readContext(session) {
  return {
    awaiting: null,        // which answer we are waiting for next
    doctorId: null,
    date: null,
    appointmentId: null,
    offeredSlots: [],      // [{ id, start }] rendered as numbered choices
    offeredAppointments: [], // [{ id, label }]
    triage: null,          // last recommendation, so "book that" has a target
    intake: null,          // { appointmentId, medicalHistory }
    prompted: [],          // proactive prompts already shown this session
    ...(session.context || {}),
  };
}

async function writeContext(sessionId, context) {
  await query(`UPDATE chat_sessions SET context = $2::jsonb WHERE id = $1`, [
    sessionId,
    JSON.stringify(context),
  ]);
}

/** Persist a bot turn. Returns the row so it can be echoed to the client. */
async function say(session, user, content, { intent = null, metadata = {} } = {}) {
  const { rows } = await query(
    `INSERT INTO chat_messages (session_id, user_id, sender, content, intent, metadata)
     VALUES ($1, $2, 'bot', $3, $4, $5::jsonb)
     RETURNING id, sender, content, intent, metadata, created_at`,
    [session.id, user.id, content, intent, JSON.stringify(metadata)]
  );
  await query(`UPDATE chat_sessions SET last_message_at = now(), last_intent = $2 WHERE id = $1`, [
    session.id,
    intent,
  ]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Proactive prompts (requirements 4 and 5)
// ---------------------------------------------------------------------------

/**
 * Fired when a patient opens a chat:
 *   * post-visit  — a completed, unreviewed appointment gets a review prompt
 *   * pre-visit   — an upcoming appointment with no intake gets an intake prompt
 * Each is shown at most once per session, tracked in context.prompted.
 */
async function proactivePrompts(session, user, context) {
  const out = [];
  const prompted = new Set(context.prompted || []);

  // --- post-visit review -------------------------------------------------
  const { rows: completed } = await query(
    `SELECT a.id, a.scheduled_date, d.full_name AS doctor_name, sp.name AS specialty_name
       FROM appointments a
       JOIN users d ON d.id = a.doctor_id
       JOIN specialties sp ON sp.id = a.specialty_id
      WHERE a.patient_id = $1 AND a.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id)
      ORDER BY a.scheduled_for DESC LIMIT 1`,
    [user.id]
  );

  if (completed.length && !prompted.has(`review:${completed[0].id}`)) {
    const appt = completed[0];
    out.push(
      await say(
        session,
        user,
        `Hi ${user.full_name?.split(' ')[0] || 'there'} — hope your visit with ${docName(appt.doctor_name)} on ${appt.scheduled_date} went well.\n\n` +
          `Would you mind leaving a quick rating? Reply with a number from 1 to 5 (5 = best), and optionally a sentence about it.`,
        { intent: INTENTS.REVIEW, metadata: { appointmentId: appt.id, prompt: 'post_visit_review' } }
      )
    );
    prompted.add(`review:${appt.id}`);
    context.awaiting = 'review_rating';
    context.appointmentId = appt.id;
  }

  // --- pre-consultation intake -------------------------------------------
  const upcoming = await upcomingAppointments(user.id, 5);
  const needingIntake = upcoming.find((a) => !a.has_intake);
  if (needingIntake && !prompted.has(`intake:${needingIntake.id}`)) {
    out.push(
      await say(
        session,
        user,
        `I see you're seeing ${needingIntake.specialty_name} on ${needingIntake.scheduled_date} at ${needingIntake.scheduled_time}.\n\n` +
          `To save time at the desk, I can take your medical history and current medications now — the doctor sees them before you walk in.\n\n` +
          `Reply "intake" to start, or "no thanks" to skip it.`,
        { intent: INTENTS.INTAKE, metadata: { appointmentId: needingIntake.id, prompt: 'pre_consultation' } }
      )
    );
    prompted.add(`intake:${needingIntake.id}`);
  }

  context.prompted = [...prompted];
  return out;
}

// ---------------------------------------------------------------------------
// Intent handlers
// ---------------------------------------------------------------------------
// Each returns the bot reply text. They receive (session, user, context, entities).

const HELP_TEXT =
  'Here is what I can do:\n' +
  '• Describe your symptoms — I will suggest the right specialty\n' +
  '• "book an appointment" — pick a doctor and time with me\n' +
  '• "reschedule" or "cancel" an appointment\n' +
  '• "where am I in the queue" or "my waitlist position"\n' +
  '• "my appointments"\n' +
  '• "intake" — give your history and medicines ahead of the visit\n' +
  '• "review" — rate a completed visit\n' +
  '• Clinic hours, fees, parking, location, documents\n\n' +
  'Try any of those in your own words.';

// ---------------------------------------------------------------------------
// Keeping the patient out of dead ends
// ---------------------------------------------------------------------------

/**
 * Intents clear enough to interrupt the current step with. Triage is
 * deliberately absent from the capture set: a patient typing "chest pain since
 * Tuesday" into the history box should have it saved as history, not re-routed.
 */
const INTERRUPTS = new Set([
  INTENTS.HELP,
  INTENTS.GREETING,
  INTENTS.MY_APPOINTMENTS,
  INTENTS.CANCEL_APPOINTMENT,
  INTENTS.RESCHEDULE_APPOINTMENT,
  INTENTS.BOOK_APPOINTMENT,
  INTENTS.QUEUE_STATUS,
  INTENTS.REVIEW,
]);

/** Free-text capture steps, where the patient's own words *are* the payload. */
const FREE_TEXT_CAPTURE = new Set(['intake_history', 'intake_medications']);

/** A numbered list is interruptible too — "my stomach hurts" is a new request,
 *  not an answer to "which appointment would you like to cancel?". */
const PICK_INTERRUPTS = new Set([...INTERRUPTS, INTENTS.TRIAGE, INTENTS.INTAKE]);

/** Which request each dialog state belongs to. A message belonging to a
 *  different request is a change of topic, not an answer to the prompt. */
const OWNING_INTENT = {
  book_date: INTENTS.BOOK_APPOINTMENT,
  book_slot: INTENTS.BOOK_APPOINTMENT,
  book_doctor_choice: INTENTS.BOOK_APPOINTMENT,
  cancel_pick: INTENTS.CANCEL_APPOINTMENT,
  reschedule_pick: INTENTS.RESCHEDULE_APPOINTMENT,
  reschedule_date: INTENTS.RESCHEDULE_APPOINTMENT,
  reschedule_slot: INTENTS.RESCHEDULE_APPOINTMENT,
  intake_pick: INTENTS.INTAKE,
  intake_history: INTENTS.INTAKE,
  intake_medications: INTENTS.INTAKE,
  review_pick: INTENTS.REVIEW,
  review_rating: INTENTS.REVIEW,
  triage_next: INTENTS.TRIAGE,
};

/** The numbered-pick states — the only ones a patient can be trapped inside. */
const PICK_STATES = new Set([
  'book_doctor_choice',
  'book_slot',
  'cancel_pick',
  'reschedule_pick',
  'intake_pick',
  'review_pick',
]);

/** "no thanks" / "never mind" — release a question without answering it. Only
 *  matched on short messages, so "stop this pain in my chest" is still triage.
 *
 *  Split in two on purpose: "no" only ever means "get me out" when a numbered
 *  list is on screen — when a date has just been proposed, "no" means "that
 *  day does not work" and must stay in the booking flow.
 */
const ESCAPE_ANY =
  /^(?:actually\s+)?(?:never\s*mind|nevermind|forget (?:it|that)|stop|start over|start again|go back|back out|exit|quit|let'?s not)\b/i;
const ESCAPE_PICK =
  /^(?:actually\s+)?(?:no|nope|nah|keep (?:it|them)(?:\s+all)?|leave (?:it|that)|nothing|none|back|don'?t)\b/i;

const ESCAPE_ACK = {
  cancel_pick: 'No problem — nothing was cancelled.',
  reschedule_pick: 'No problem — that appointment stays where it is.',
  reschedule_date: 'No problem — that appointment stays where it is.',
  reschedule_slot: 'No problem — that appointment stays where it is.',
  review_pick: 'No problem — we can rate that visit another time.',
  intake_pick: 'No problem — you can fill the intake form in any time before the visit.',
  book_doctor_choice: 'No problem — just tell me a specialty or a doctor name instead.',
  book_date: 'No problem — no slot was booked.',
  book_slot: 'No problem — no slot was booked.',
};

/** "yes" / "that one", valid when exactly one option is on screen. */
const AFFIRMATIVE =
  /^(?:yes|y|yeah|yep|yup|sure|ok|okay|do it|go ahead|confirm|book it|that one|this one|the first one|please)\b/i;

/** "a" or "an" — "a ENT doctor" reads like a typo in a medical product. */
function article(word) {
  return /^[aeiou]/i.test(String(word || '').trim()) ? 'an' : 'a';
}

/** Spell out what a numbered list accepts, instead of asking the same thing. */
function clarifyPending(context) {
  const slots = context.offeredSlots.length;
  const count = slots || context.offeredAppointments.length;
  const noun = slots ? 'slot' : 'appointment';
  if (!count) return `Tell me which ${noun} you mean, or say "start over".`;
  if (count === 1) {
    return `There is only one ${noun} on the list — reply with 1 to pick it, or "start over" to drop this.`;
  }
  const bits = [`a number from 1 to ${count}`];
  if (count > 1) bits.push('an ordinal like "the first one"');
  bits.push('"start over" to drop this');
  return `I did not catch which ${noun} you meant — reply with ${bits.join(', ')}.`;
}

/** "thanks" / "bye" — warm, and deliberately leaves the pending question alone. */
function handleSmalltalk(rawText) {
  if (/\b(bye|goodbye|good night|goodnight|take care|see you later)\b/i.test(rawText)) {
    return 'Take care — your appointments are always in Appointments, and I am here whenever you need me.';
  }
  return 'You are welcome. Anything else I can help with — booking, rescheduling, your queue position, or clinic info?';
}

async function handleTriage(session, user, context, entities) {
  const symptoms = entities.symptoms?.length
    ? entities.symptoms.join(', ')
    : null;

  if (!symptoms) {
    return 'Tell me what you are feeling — for example "chest tightness when I climb stairs, mild breathlessness" — and I will point you to the right specialty.';
  }

  const result = await matchSymptoms(symptoms, { withTriage: true });
  const top = result.matches?.slice(0, 3) || [];

  if (!top.length) {
    return (
      `I could not confidently match "${symptoms}" to a specialty from our routing table.\n\n` +
      `For anything you are worried about, a General Medicine doctor is a good first stop. ` +
      `Want me to show General Medicine doctors?`
    );
  }

  // Patients are routed by symptom, not by a routing score — so show the
  // specialties and why they matched, never the internal number.
  const lines = top.map(
    (m, i) =>
      `${i + 1}. ${m.specialty.name}${
        m.matchedTerms?.length ? ` — matched ${m.matchedTerms.slice(0, 3).join(', ')}` : ''
      }`
  );

  const triageNote = result.triage
    ? `\n\n⚠️ Triage (${result.triage.level}): ${result.triage.advice}`
    : '';

  const recommended = top[0].specialty;
  // Never promise a booking the clinic cannot honour: the seed roster and a
  // real clinic both have specialties with nobody taking new patients.
  const { rows: staffed } = await query(
    `SELECT COUNT(*)::int AS n
       FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id
      WHERE dp.specialty_id = $1 AND u.status = 'active' AND dp.accepting_new_patients`,
    [recommended.id]
  );
  const staffedCount = staffed[0]?.n || 0;

  // Remember it so "book that" / "show me a cardiologist" needs no repeat —
  // and so the appointment carries the symptoms the patient described.
  context.triage = {
    specialtyId: recommended.id,
    specialtyName: recommended.name,
    symptoms,
    staffed: staffedCount,
  };
  // Follow-ups like "what should I do?" should restate this, not bounce off a
  // generic "I did not quite catch that".
  context.awaiting = 'triage_next';

  const nextStep = staffedCount
    ? `Reply "book" and I will find you the next open slot with ${article(recommended.name)} ${recommended.name} doctor. Or name a different specialty.`
    : `There is no ${recommended.name} doctor taking bookings right now. Say "join the waitlist for ${recommended.name}" and I will book you the moment one opens — or name a different specialty.`;

  return (
    `Based on "${symptoms}", the best matches are:\n${lines.join('\n')}${triageNote}\n\n` +
    nextStep
  );
}

async function handleQueue(session, user, context, entities) {
  const entries = await waitlist.myEntries(user.id);

  // OPD queue: today's running order at the patient's own doctor(s).
  const { rows: opd } = await query(
    `SELECT a.id, a.scheduled_date, to_char(a.scheduled_time, 'HH24:MI') AS scheduled_time,
            d.full_name AS doctor_name,
            (SELECT COUNT(*) + 1
               FROM appointments a2
              WHERE a2.doctor_id = a.doctor_id
                AND a2.scheduled_date = a.scheduled_date
                AND a2.status IN ('pending', 'scheduled')
                AND (a2.scheduled_time, a2.id) < (a.scheduled_time, a.id)) AS opd_position,
            (SELECT COUNT(*) FROM appointments a3
              WHERE a3.doctor_id = a.doctor_id
                AND a3.scheduled_date = a.scheduled_date
                AND a3.status IN ('pending', 'scheduled')) AS opd_total
       FROM appointments a
       JOIN users d ON d.id = a.doctor_id
      WHERE a.patient_id = $1
        AND a.status IN ('pending', 'scheduled')
        AND a.scheduled_date >= CURRENT_DATE
      ORDER BY a.scheduled_for ASC LIMIT 3`,
    [user.id]
  );

  if (!entries.length && !opd.length) {
    return (
      'You are not in any queue right now and have no upcoming appointment.\n\n' +
      'If you would like to be seen sooner, I can put you on the waitlist — just say "join the waitlist for <specialty>".'
    );
  }

  const parts = [];

  for (const a of opd) {
    if (a.opd_position <= a.opd_total) {
      parts.push(
        `🏥 OPD queue — ${docName(a.doctor_name)}, ${a.scheduled_date} ${a.scheduled_time}:\n` +
          `   you are number ${a.opd_position} of ${a.opd_total} in today's list.`
      );
    }
  }

  for (const e of entries) {
    const target = e.doctor_name ? docName(e.doctor_name) : e.specialty_name;
    if (e.status === 'waiting') {
      parts.push(
        `⏳ Waitlist for ${target}:\n` +
          `   position ${e.position} of ${e.queue_length} · urgency ${e.urgency}\n` +
          `   joined ${String(e.joined_at).slice(0, 10)}${e.expires_at ? ` · expires ${String(e.expires_at).slice(0, 10)}` : ''}`
      );
    } else if (e.status === 'matched') {
      parts.push(`✅ Waitlist for ${target} — matched to an appointment.`);
    } else {
      parts.push(`✖️ Waitlist for ${target} — ${e.status}.`);
    }
  }

  parts.push('\nPositions are computed live from the queue, so this is current as of right now.');
  return parts.join('\n\n');
}

async function handleMyAppointments(session, user, context, entities) {
  const upcoming = await upcomingAppointments(user.id, 5);

  if (!upcoming.length) {
    return 'You have no upcoming appointments. Say "book an appointment" and I will set one up.';
  }

  context.offeredAppointments = upcoming.map((a) => ({
    id: a.id,
    label: `${a.specialty_name} with ${docName(a.doctor_name)} on ${a.scheduled_date} at ${a.scheduled_time}`,
  }));

  const lines = upcoming.map(
    (a, i) =>
      `${i + 1}. ${a.specialty_name} — ${docName(a.doctor_name)}\n   ${a.scheduled_date} at ${a.scheduled_time} (${a.status})${a.has_intake ? '' : '\n   ⚠️ intake form not filled in yet'}`
  );

  return (
    `Your upcoming appointments:\n${lines.join('\n\n')}\n\n` +
    `Reply with a number to act on one ("cancel 2", "reschedule 1"), or say "book" for a new one.`
  );
}

async function handleBook(session, user, context, entities) {
  // --- resolve the doctor ------------------------------------------------
  let doctor = entities.doctorId ? null : await resolveDoctor(entities.doctorName);
  if (!doctor && entities.doctorId) {
    doctor = await queryOne(
      `SELECT u.id, u.full_name, dp.consultation_fee, s.name AS specialty_name
         FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id
         JOIN specialties s ON s.id = dp.specialty_id
        WHERE u.id = $1 AND u.status = 'active'`,
      [entities.doctorId]
    );
  }

  // "yes" to a proposed date sends no doctor entity at all — carry the one we
  // already settled on, or the conversation restarts from "who would you like
  // to see" halfway through booking.
  if (!doctor && context.doctorId) {
    doctor = await queryOne(
      `SELECT u.id, u.full_name, dp.consultation_fee, s.name AS specialty_name
         FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id
         JOIN specialties s ON s.id = dp.specialty_id
        WHERE u.id = $1 AND u.status = 'active'`,
      [context.doctorId]
    );
  }

  if (!doctor && entities.specialty) {
    const specialty = await resolveSpecialty(entities.specialty);
    if (specialty) {
      const { rows } = await query(
        `SELECT u.id, u.full_name, dp.consultation_fee, s.name AS specialty_name
           FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id
           JOIN specialties s ON s.id = dp.specialty_id
          WHERE dp.specialty_id = $1 AND u.status = 'active' AND dp.accepting_new_patients
          ORDER BY dp.rating_avg DESC NULLS LAST, dp.years_experience DESC LIMIT 5`,
        [specialty.id]
      );
      if (rows.length === 1) doctor = rows[0];
      else if (rows.length > 1) {
        context.awaiting = 'book_doctor_choice';
        context.offeredAppointments = rows.map((d) => ({
          id: d.id,
          label: `${d.full_name} — ${d.specialty_name}`,
        }));
        return (
          `${rows.length} ${specialty.name} doctors are taking bookings:\n` +
          rows.map((d, i) => `${i + 1}. ${docName(d.full_name)}`).join('\n') +
          `\n\nReply with a number to pick one.`
        );
      }
    }
  }

  // Fall back to the specialty we just triaged.
  let triagedButUnstaffed = null;
  if (!doctor && context.triage?.specialtyId) {
    const { rows } = await query(
      `SELECT u.id, u.full_name, s.name AS specialty_name
         FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id
         JOIN specialties s ON s.id = dp.specialty_id
        WHERE dp.specialty_id = $1 AND u.status = 'active' AND dp.accepting_new_patients
        ORDER BY dp.rating_avg DESC NULLS LAST LIMIT 1`,
      [context.triage.specialtyId]
    );
    if (rows.length) doctor = rows[0];
    else triagedButUnstaffed = context.triage;
  }

  if (!doctor) {
    if (triagedButUnstaffed) {
      // Recommending a specialty and then asking "who would you like to see?"
      // is a dead end — say why, and offer the two things that actually work.
      const { rows: others } = await query(
        `SELECT s.name, COUNT(*)::int AS doctors
           FROM doctor_profiles dp
           JOIN users u ON u.id = dp.user_id
           JOIN specialties s ON s.id = dp.specialty_id
          WHERE u.status = 'active' AND dp.accepting_new_patients
          GROUP BY s.name ORDER BY doctors DESC, s.name LIMIT 4`,
        []
      );
      const list = others.map((o) => `• ${o.name} (${o.doctors})`).join('\n');
      return (
        `There is no ${triagedButUnstaffed.specialtyName} doctor taking bookings right now.\n\n` +
        `Specialties with doctors available today:\n${list}\n\n` +
        `Say a specialty, or "join the waitlist for ${triagedButUnstaffed.specialtyName}" and I will book you the moment one opens.`
      );
    }
    return (
      'Who would you like to see? You can say a specialty ("cardiology"), a doctor\'s name ("Dr. Meera"), ' +
      `or "find care" to browse the full directory.`
    );
  }

  context.doctorId = doctor.id;

  // --- resolve the date --------------------------------------------------
  const date = resolveDate(entities.date) || context.date;
  if (!date) {
    const summary = await engine.availabilitySummary(doctor.id, { days: 14 });
    const next = summary.find((d) => d.open > 0);
    if (!next) {
      return (
        `${docName(doctor.full_name)} has no open slots in the next two weeks.\n\n` +
        `I can put you on the waitlist for ${doctor.specialty_name} and book you automatically the moment a slot opens. Say "join the waitlist".`
      );
    }
    context.date = next.date;
    context.awaiting = 'book_date';
    return `${docName(doctor.full_name)} is next free on ${next.date} (${next.open} slots open).\n\nDoes ${next.date} work? Reply "yes" or give me another date.`;
  }

  context.date = date;

  // --- list open slots ---------------------------------------------------
  const slots = await engine.getDaySlots(doctor.id, date, { patientId: user.id });
  const open = slots.filter((s) => s.available);

  if (!open.length) {
    const summary = await engine.availabilitySummary(doctor.id, { from: date, days: 14 });
    // `date` was just checked and has nothing, so never offer it back as "the
    // next opening" — look strictly after it.
    const next = summary.find((d) => d.open > 0 && d.date > date);
    if (next) {
      context.date = next.date;
      return `${docName(doctor.full_name)} has no free slot on ${date}. The next opening is ${next.date} with ${next.open} slots.\n\nReply "yes" for ${next.date}, or name another day.`;
    }
    return `${docName(doctor.full_name)} is fully booked from ${date} onward. Say "join the waitlist" and I will book you as soon as anything opens.`;
  }

  const shown = open.slice(0, 6);
  context.offeredSlots = shown.map((s) => ({ id: s.id, start: s.start }));
  context.awaiting = 'book_slot';

  return (
    `${docName(doctor.full_name)} on ${date} — ${open.length} slot(s) free:\n` +
    shown.map((s, i) => `${i + 1}. ${s.start}–${s.end}`).join('\n') +
    `\n\nReply with a number to book it. ${doctor.consultation_fee ? `Consultation fee: ₹${doctor.consultation_fee}.` : ''}`
  );
}

async function handleCancel(session, user, context, entities) {
  let appointmentId = entities.appointmentId;

  if (!appointmentId && context.offeredAppointments.length) {
    // A bare number in reply to a numbered list picks that appointment.
    const n = Number(entities.rawNumber);
    if (Number.isInteger(n) && n >= 1 && n <= context.offeredAppointments.length) {
      appointmentId = context.offeredAppointments[n - 1].id;
    }
  }

  if (!appointmentId) {
    const upcoming = await upcomingAppointments(user.id, 5);
    if (!upcoming.length) return 'You have no upcoming appointments to cancel.';
    context.offeredAppointments = upcoming.map((a) => ({
      id: a.id,
      label: `${a.specialty_name} with ${docName(a.doctor_name)} on ${a.scheduled_date} at ${a.scheduled_time}`,
    }));
    context.awaiting = 'cancel_pick';
    return (
      `Which appointment would you like to cancel?\n` +
      upcoming.map((a, i) => `${i + 1}. ${a.specialty_name} — ${docName(a.doctor_name)}, ${a.scheduled_date} ${a.scheduled_time}`).join('\n') +
      `\n\nReply with a number, or "keep them all" to back out.`
    );
  }

  const owned = await queryOne(
    `SELECT id, status, doctor_id FROM appointments WHERE id = $1 AND patient_id = $2`,
    [appointmentId, user.id]
  );
  // 404 not 403: a chat user must not be able to probe other patients' ids.
  if (!owned) throw ApiError.notFound('That appointment does not exist.');
  if (!['pending', 'scheduled'].includes(owned.status)) {
    return `Appointment #${appointmentId} is already ${owned.status}, so there is nothing to cancel.`;
  }

  const result = await engine.cancelAppointment({
    req: { user, ctx: { ip: null, userAgent: null, requestId: null } },
    appointmentId,
    reason: 'Cancelled via chat assistant',
    actorRole: 'patient',
  });

  context.appointmentId = null;
  context.awaiting = null;

  return (
    `Done — appointment #${appointmentId} is cancelled and the slot has been released.\n` +
    (result.filled
      ? 'A waitlist patient has been moved into it automatically.'
      : 'It is back in the pool, so anyone on the waitlist can now take it.')
  );
}

async function handleReschedule(session, user, context, entities) {
  let appointmentId = entities.appointmentId;

  if (!appointmentId && context.offeredAppointments.length) {
    const n = Number(entities.rawNumber);
    if (Number.isInteger(n) && n >= 1 && n <= context.offeredAppointments.length) {
      appointmentId = context.offeredAppointments[n - 1].id;
    }
  }

  if (!appointmentId) {
    const upcoming = await upcomingAppointments(user.id, 5);
    if (!upcoming.length) return 'You have no upcoming appointments to move.';
    context.offeredAppointments = upcoming.map((a) => ({
      id: a.id,
      label: `${a.specialty_name} with ${docName(a.doctor_name)} on ${a.scheduled_date} at ${a.scheduled_time}`,
    }));
    context.awaiting = 'reschedule_pick';
    return (
      `Which appointment should I move?\n` +
      upcoming.map((a, i) => `${i + 1}. ${a.specialty_name} — ${docName(a.doctor_name)}, ${a.scheduled_date} ${a.scheduled_time}`).join('\n') +
      `\n\nReply with a number, then tell me the new day or time you would prefer.`
    );
  }

  const owned = await queryOne(
    `SELECT id, status, doctor_id, slot_id FROM appointments WHERE id = $1 AND patient_id = $2`,
    [appointmentId, user.id]
  );
  if (!owned) throw ApiError.notFound('That appointment does not exist.');
  if (!['pending', 'scheduled'].includes(owned.status)) {
    return `Appointment #${appointmentId} is ${owned.status}, so it cannot be moved.`;
  }

  const date = resolveDate(entities.date);
  if (!date) {
    context.appointmentId = appointmentId;
    context.awaiting = 'reschedule_date';
    return 'What day would you prefer? You can say "tomorrow", "friday", or give a date like 2026-11-02.';
  }

  const slots = await engine.getDaySlots(owned.doctor_id, date, { patientId: user.id });
  const open = slots.filter((s) => s.available);
  if (!open.length) {
    return `That doctor has no free slot on ${date}. Try another day.`;
  }

  const shown = open.slice(0, 6);
  context.appointmentId = appointmentId;
  context.date = date;
  context.offeredSlots = shown.map((s) => ({ id: s.id, start: s.start }));
  context.awaiting = 'reschedule_slot';

  return (
    `Free slots on ${date}:\n` +
    shown.map((s, i) => `${i + 1}. ${s.start}–${s.end}`).join('\n') +
    `\n\nReply with a number and I will move appointment #${appointmentId} there.`
  );
}

async function handleIntake(session, user, context, entities) {
  let appointmentId = entities.appointmentId || context.intake?.appointmentId || context.appointmentId;

  if (!appointmentId) {
    const upcoming = await upcomingAppointments(user.id, 5);
    const needing = upcoming.filter((a) => !a.has_intake);
    if (!needing.length) {
      return upcoming.length
        ? 'All of your upcoming appointments already have an intake form on file. Nothing more needed.'
        : 'You have no upcoming appointment, so there is nothing to fill in yet.';
    }
    if (needing.length === 1) {
      appointmentId = needing[0].id;
    } else {
      context.offeredAppointments = needing.map((a) => ({
        id: a.id,
        label: `${a.specialty_name} on ${a.scheduled_date} at ${a.scheduled_time}`,
      }));
      context.awaiting = 'intake_pick';
      return (
        `Which visit should I collect details for?\n` +
        needing.map((a, i) => `${i + 1}. ${a.specialty_name} — ${a.scheduled_date} ${a.scheduled_time}`).join('\n') +
        `\n\nReply with a number.`
      );
    }
  }

  const owned = await queryOne(
    `SELECT id, patient_id, doctor_id, scheduled_date FROM appointments WHERE id = $1 AND patient_id = $2`,
    [appointmentId, user.id]
  );
  if (!owned) throw ApiError.notFound('That appointment does not exist.');

  context.intake = { appointmentId, medicalHistory: context.intake?.medicalHistory || null };
  context.appointmentId = appointmentId;
  context.awaiting = 'intake_history';

  return (
    `Great — this goes straight onto appointment #${appointmentId} for your doctor to review.\n\n` +
    `First: any medical history I should pass on? Existing conditions, past surgeries, family history, allergies.\n` +
    `Reply "none" if there is nothing to add.`
  );
}

async function handleIntakeHistory(session, user, context, text) {
  const history = /^none$/i.test(text.trim()) ? '' : text.trim();
  context.intake = { ...(context.intake || {}), medicalHistory: history };
  context.awaiting = 'intake_medications';
  return 'Thank you. Now — what medications are you currently taking? Include doses if you know them. Reply "none" if you take nothing.';
}

async function handleIntakeMedications(session, user, context, text) {
  const medications = /^none$/i.test(text.trim()) ? '' : text.trim();
  const { appointmentId, medicalHistory } = context.intake || {};
  if (!appointmentId) {
    context.awaiting = null;
    return 'Something went wrong with the intake draft — please say "intake" to start again.';
  }

  const appt = await queryOne(
    `SELECT id, doctor_id, patient_id FROM appointments WHERE id = $1 AND patient_id = $2`,
    [appointmentId, user.id]
  );
  if (!appt) throw ApiError.notFound('That appointment no longer exists.');

  const req = { user, ctx: { ip: null, userAgent: null, requestId: null } };

  const row = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO pre_consultation_intake
         (appointment_id, patient_id, doctor_id, medical_history, current_medications,
          status, submitted_via, submitted_at)
       VALUES ($1,$2,$3,$4,$5,'submitted','chat', now())
       ON CONFLICT (appointment_id) DO UPDATE
         SET medical_history     = EXCLUDED.medical_history,
             current_medications = EXCLUDED.current_medications,
             status              = 'submitted',
             submitted_via       = 'chat',
             submitted_at        = now()
       RETURNING *`,
      [appointmentId, appt.patient_id, appt.doctor_id, medicalHistory || '', medications]
    );

    await audit(
      req,
      {
        action: ACTIONS.INTAKE_SUBMITTED,
        entityType: 'pre_consultation_intake',
        entityId: rows[0].id,
        patientId: appt.patient_id,
        metadata: { appointmentId, via: 'chat', hasHistory: Boolean(medicalHistory), hasMedications: Boolean(medications) },
      },
      client
    );

    return rows[0];
  });

  context.intake = null;
  context.awaiting = null;
  context.appointmentId = null;

  return (
    `✅ Saved to appointment #${appointmentId} — your doctor will see this before your visit.\n\n` +
    `• Medical history: ${row.medical_history ? 'recorded' : 'none given'}\n` +
    `• Current medications: ${row.current_medications ? 'recorded' : 'none given'}\n\n` +
    `You can update it any time by saying "intake" again.`
  );
}

async function handleReview(session, user, context, entities) {
  let appointmentId = entities.appointmentId || context.appointmentId;
  let rating = entities.rating;

  // A bare number right after the review prompt is the rating itself.
  if (!rating && context.awaiting === 'review_rating') {
    const n = Number(entities.rawNumber);
    if (Number.isInteger(n) && n >= 1 && n <= 5) rating = n;
  }

  if (!appointmentId) {
    const { rows } = await query(
      `SELECT a.id, a.scheduled_date, d.full_name AS doctor_name
         FROM appointments a JOIN users d ON d.id = a.doctor_id
        WHERE a.patient_id = $1 AND a.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id)
        ORDER BY a.scheduled_for DESC LIMIT 5`,
      [user.id]
    );
    if (!rows.length) return 'There are no completed visits waiting for a review. Thanks anyway!';
    if (rows.length === 1) {
      appointmentId = rows[0].id;
    } else {
      context.offeredAppointments = rows.map((a) => ({
        id: a.id,
        label: `${a.doctor_name} on ${a.scheduled_date}`,
      }));
      context.awaiting = 'review_pick';
      return (
        `Which visit would you like to rate?\n` +
        rows.map((a, i) => `${i + 1}. ${docName(a.doctor_name)} — ${a.scheduled_date}`).join('\n') +
        `\n\nReply with a number, then your rating from 1 to 5.`
      );
    }
  }

  if (!rating) {
    context.appointmentId = appointmentId;
    context.awaiting = 'review_rating';
    return 'How would you rate that visit? A number from 1 (poor) to 5 (excellent).';
  }

  const req = { user, ctx: { ip: null, userAgent: null, requestId: null } };
  const review = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT a.id, a.patient_id, a.doctor_id, a.status, a.scheduled_for,
              (r.id IS NOT NULL) AS already_reviewed
         FROM appointments a
         LEFT JOIN reviews r ON r.appointment_id = a.id
        WHERE a.id = $1 AND a.patient_id = $2`,
      [appointmentId, user.id]
    );
    const appointment = rows[0];
    if (!appointment) throw ApiError.notFound('Appointment not found.');
    if (appointment.already_reviewed) throw ApiError.conflict('You have already reviewed this visit.');
    if (appointment.status !== 'completed') {
      throw new ApiError(403, 'REVIEW_NOT_VERIFIED', 'You can only review a visit once it is completed.');
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO reviews (doctor_id, patient_id, appointment_id, rating, comment, status)
       VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
      [appointment.doctor_id, appointment.patient_id, appointment.id, rating, entities.comment || '']
    );

    await audit(
      req,
      {
        action: ACTIONS.REVIEW_CREATED,
        entityType: 'review',
        entityId: inserted[0].id,
        patientId: appointment.patient_id,
        metadata: { doctorId: appointment.doctor_id, appointmentId, rating, via: 'chat' },
      },
      client
    );

    return inserted[0];
  });

  context.awaiting = null;
  context.appointmentId = null;

  return `Thank you — your ${review.rating}-star review for appointment #${appointmentId} is recorded and will appear once an administrator approves it.`;
}

// ---------------------------------------------------------------------------
// Turn resolution: pick the handler for the classified intent
// ---------------------------------------------------------------------------

/** A numbered reply to a list we just showed. */
function pickFromOffered(context, entities, rawText = '') {
  let n = Number(entities.rawNumber);
  // With exactly one option on screen, "yes" / "that one" is an unambiguous
  // pick — demanding a digit there is pedantry, not safety.
  const singleOffer = context.offeredSlots.length + context.offeredAppointments.length === 1;
  if ((!Number.isInteger(n) || n < 1) && singleOffer && AFFIRMATIVE.test(String(rawText).trim())) {
    n = 1;
  }
  if (!Number.isInteger(n) || n < 1) return null;
  if (context.offeredSlots.length && n <= context.offeredSlots.length) {
    return { kind: 'slot', value: context.offeredSlots[n - 1] };
  }
  if (context.offeredAppointments.length && n <= context.offeredAppointments.length) {
    return { kind: 'appointment', value: context.offeredAppointments[n - 1] };
  }
  return null;
}

/**
 * Handle the turn we were already waiting on, if any. Returns null if not.
 *
 * Order matters: an escape phrase releases the question, a request for
 * something else *ends* it and is dispatched normally, and only then does the
 * pending question get an answer. Without the first two, a patient who types
 * the wrong thing is asked the same question forever.
 */
async function resolvePending(session, user, context, entities, rawText, classification) {
  const pending = context.awaiting;
  const intent = classification?.intent;
  const trimmed = String(rawText).trim();

  // 1. "no thanks" / "never mind" — getting out must always be possible.
  if (
    pending &&
    trimmed.split(/\s+/).length <= 5 &&
    (ESCAPE_ANY.test(trimmed) || (PICK_STATES.has(pending) && ESCAPE_PICK.test(trimmed)))
  ) {
    context.awaiting = null;
    context.offeredAppointments = [];
    context.offeredSlots = [];
    context.pendingMisses = 0;
    return ESCAPE_ACK[pending] || 'No problem — what would you like to do instead?';
  }

  // 2. A clear request for something else beats the pending question. Release
  //    it and let `respond` dispatch, so "how much is a consultation?" or
  //    "book me something anyway" work mid-flow instead of being ignored.
  if (
    pending &&
    !FREE_TEXT_CAPTURE.has(pending) &&
    PICK_INTERRUPTS.has(intent) &&
    OWNING_INTENT[pending] !== intent
  ) {
    context.awaiting = null;
    context.offeredAppointments = [];
    context.offeredSlots = [];
    context.pendingMisses = 0;
    return null;
  }

  // 3. An unreadable answer to a numbered list is handled *before* the pending
  //    question, because every pick handler's no-choice path re-renders the very
  //    same list — which is how a patient gets stuck being asked forever.
  //    Say what works once, then stop asking.
  if (
    pending &&
    PICK_STATES.has(pending) &&
    entities.rawNumber === null &&
    !entities.appointmentId &&
    (intent === INTENTS.FALLBACK || intent === INTENTS.GREETING)
  ) {
    const misses = (context.pendingMisses || 0) + 1;
    context.pendingMisses = misses;
    if (misses >= 2) {
      context.awaiting = null;
      context.offeredAppointments = [];
      context.offeredSlots = [];
      context.pendingMisses = 0;
      return `Okay — I have dropped that. ${HELP_TEXT}`;
    }
    return clarifyPending(context);
  }

  // 4. Otherwise let the pending question have the answer.
  const handled = await runPending(session, user, context, entities, rawText, intent);
  if (handled) {
    context.pendingMisses = 0;
    return handled;
  }

  return null;
}

/** The pending question's own handler. Returns null when it cannot use this turn. */
async function runPending(session, user, context, entities, rawText, intent) {
  switch (context.awaiting) {
    case 'book_date': {
      const answer = String(rawText).trim();
      if (/^(yes|y|yeah|sure|ok|okay|yep)$/i.test(answer)) {
        return handleBook(session, user, context, { ...entities, date: context.date });
      }
      // "no" here is not an escape — it is "that day does not work", and it
      // deserves an invitation to pick another one rather than a fallback.
      if (/^(?:no|nope|nah|not (?:that|this) (?:day|date|one))\b/i.test(answer)) {
        return `No problem — which day would you prefer? You can say "tomorrow", "friday", or give me a date like ${context.date || '2026-11-02'}.`;
      }
      return null;
    }

    case 'book_slot': {
      const picked = pickFromOffered(context, entities, rawText);
      if (picked?.kind !== 'slot') return null;
      const appointment = await engine.bookAppointment({
        req: { user, ctx: { ip: null, userAgent: null, requestId: null } },
        patientId: user.id,
        slotId: picked.value.id,
        reason: 'Booked via chat assistant',
        // Symptoms captured during triage travel with the booking, so the
        // doctor's queue shows why the patient is coming in.
        symptoms: context.triage?.symptoms || '',
      });
      const bookedDoctor = await queryOne(`SELECT full_name FROM users WHERE id = $1`, [
        appointment.doctor_id,
      ]);
      context.offeredSlots = [];
      context.awaiting = null;
      // The very next question offers an intake form "for this visit" — remember
      // which visit, or the reply to that offer asks the patient to pick again.
      // Held in `intake` (not `appointmentId`) so cancel/reschedule/review keep
      // asking for their own target instead of inheriting this booking.
      context.intake = { appointmentId: appointment.id, medicalHistory: null };
      return (
        `✅ Booked — appointment #${appointment.id} with ${docName(bookedDoctor?.full_name)} on ${appointment.scheduled_date} at ${String(appointment.scheduled_time).slice(0, 5)}.\n\n` +
        `Now, so your doctor is prepared: shall I take your medical history and current medications? Reply "intake" to do it now, or "no thanks".`
      );
    }

    case 'book_doctor_choice': {
      const picked = pickFromOffered(context, entities, rawText);
      if (picked?.kind !== 'appointment') return null;
      context.offeredAppointments = [];
      context.awaiting = null;
      return handleBook(session, user, context, { ...entities, doctorId: picked.value.id });
    }

    case 'cancel_pick': {
      if (/^(no|never mind|nevermind|keep|keep them all|back)$/i.test(rawText.trim())) {
        context.awaiting = null;
        context.offeredAppointments = [];
        return 'No problem — nothing was cancelled.';
      }
      return handleCancel(session, user, context, entities);
    }

    case 'reschedule_pick': {
      const picked = pickFromOffered(context, entities, rawText);
      if (picked?.kind !== 'appointment') {
        // "any time next week works" with one appointment on screen: the patient
        // is talking about that appointment, so take it and use their date
        // instead of asking which one they meant.
        if (
          context.offeredAppointments.length === 1 &&
          (entities.date || entities.time || entities.doctorName)
        ) {
          const only = context.offeredAppointments[0];
          context.offeredAppointments = [];
          return handleReschedule(session, user, context, { ...entities, appointmentId: only.id });
        }
        return null;
      }
      context.offeredAppointments = [];
      return handleReschedule(session, user, context, { ...entities, appointmentId: picked.value.id });
    }

    case 'reschedule_date': {
      const date = resolveDate(rawText) || resolveDate(entities.date);
      if (!date) {
        if (/^(?:no|nope|nah|not (?:that|this) (?:day|date|one))\b/i.test(String(rawText).trim())) {
          return 'No problem — which day would you prefer? You can say "tomorrow", "friday", or give me a date like 2026-11-02.';
        }
        return null;
      }
      const appt = await queryOne(
        `SELECT id, doctor_id, slot_id FROM appointments WHERE id = $1 AND patient_id = $2`,
        [context.appointmentId, user.id]
      );
      if (!appt) {
        context.awaiting = null;
        return 'That appointment is no longer available.';
      }
      const slots = await engine.getDaySlots(appt.doctor_id, date, { patientId: user.id });
      const open = slots.filter((s) => s.available);
      if (!open.length) {
        return `No free slots on ${date}. Try another day.`;
      }
      const shown = open.slice(0, 6);
      context.date = date;
      context.offeredSlots = shown.map((s) => ({ id: s.id, start: s.start }));
      context.awaiting = 'reschedule_slot';
      return (
        `Free slots on ${date}:\n` +
        shown.map((s, i) => `${i + 1}. ${s.start}–${s.end}`).join('\n') +
        `\n\nReply with a number to move appointment #${context.appointmentId} there.`
      );
    }

    case 'reschedule_slot': {
      const picked = pickFromOffered(context, entities, rawText);
      if (picked?.kind !== 'slot') return null;
      const result = await engine.rescheduleAppointment({
        req: { user, ctx: { ip: null, userAgent: null, requestId: null } },
        appointmentId: context.appointmentId,
        newSlotId: picked.value.id,
        actorRole: 'patient',
        reason: 'Moved via chat assistant',
      });
      context.offeredSlots = [];
      context.appointmentId = null;
      context.awaiting = null;
      return (
        `✅ Moved — appointment is now #${result.appointment.id} on ${result.appointment.scheduled_date} at ${String(result.appointment.scheduled_time).slice(0, 5)}.\n` +
        (result.filled ? 'The old slot has been offered to the waitlist.' : 'Your old slot is back in the pool.')
      );
    }

    case 'intake_pick': {
      const picked = pickFromOffered(context, entities, rawText);
      if (picked?.kind !== 'appointment') return null;
      context.offeredAppointments = [];
      context.awaiting = null;
      return handleIntake(session, user, context, { ...entities, appointmentId: picked.value.id });
    }

    case 'intake_history':
      return handleIntakeHistory(session, user, context, rawText);

    case 'intake_medications':
      return handleIntakeMedications(session, user, context, rawText);

    case 'review_pick': {
      const picked = pickFromOffered(context, entities, rawText);
      if (picked?.kind !== 'appointment') return null;
      context.offeredAppointments = [];
      return handleReview(session, user, context, { ...entities, appointmentId: picked.value.id });
    }

    case 'review_rating': {
      const trimmed = rawText.trim();

      if (/^skip$/i.test(trimmed)) {
        context.awaiting = null;
        context.appointmentId = null;
        return 'No problem — skipping the review. Anything else I can help with?';
      }

      // A rating must look like one: a bare 1-5, "4 stars", "rating 4".
      // Ordinals and list-answering language ("the first one") belong to a
      // numbered list elsewhere in the conversation — accepting them here
      // silently files a 1-star review of an unrelated visit.
      const ratingMatch =
        /^\s*(?:rating\s*)?([1-5])(?:\s*(?:out of 5|stars?|\/5))?\s*[.!?]*\s*$/i.exec(trimmed);

      // A bare out-of-range number is a genuine attempt to answer, so correct it.
      if (!ratingMatch && /^\s*\d{1,2}\s*[.!?]*\s*$/.test(trimmed)) {
        return 'Please reply with a number from 1 to 5, or "skip" if you would rather not.';
      }

      // Anything else is a new request, not a rating. Release the prompt and let
      // the normal dispatcher handle it, so asking about the queue while a
      // review is pending does not bounce off the rating prompt forever.
      if (!ratingMatch) {
        context.awaiting = null;
        context.appointmentId = null;
        return null;
      }

      const n = Number(ratingMatch[1]);
      return handleReview(session, user, context, { ...entities, rating: n });
    }

    case 'triage_next': {
      // "what should I do?" right after a recommendation: restate it instead
      // of bouncing to a generic "I did not quite catch that".
      if (entities.symptoms?.length) {
        context.awaiting = null;
        return handleTriage(session, user, context, entities);
      }
      if (intent === INTENTS.FALLBACK || intent === INTENTS.GREETING) {
        const rec = context.triage?.specialtyName;
        return (
          `Still about ${rec ? `the ${rec} suggestion` : 'those symptoms'}? ` +
          `You can say "book" to take the next open slot, name a different specialty, ` +
          `or describe the symptoms in more detail.`
        );
      }
      return null;
    }

    default:
      return null;
  }
}

/** Main dispatch. */
async function respond(session, user, context, entities, intent, rawText) {
  switch (intent) {
    case INTENTS.GREETING:
      context.awaiting = null;
      return `Hello${user.full_name ? ` ${user.full_name.split(' ')[0]}` : ''} — I'm the Qrus assistant. ${HELP_TEXT}`;

    case INTENTS.HELP:
      context.awaiting = null;
      return HELP_TEXT;

    case INTENTS.SMALLTALK:
      return handleSmalltalk(rawText);

    case INTENTS.TRIAGE:
      context.awaiting = null;
      return handleTriage(session, user, context, entities);

    case INTENTS.QUEUE_STATUS:
      context.awaiting = null;
      return handleQueue(session, user, context, entities);

    case INTENTS.MY_APPOINTMENTS:
      context.awaiting = null;
      return handleMyAppointments(session, user, context, entities);

    case INTENTS.BOOK_APPOINTMENT:
      return handleBook(session, user, context, entities);

    case INTENTS.CANCEL_APPOINTMENT:
      return handleCancel(session, user, context, entities);

    case INTENTS.RESCHEDULE_APPOINTMENT:
      return handleReschedule(session, user, context, entities);

    case INTENTS.INTAKE:
      if (/^(no thanks|no thank you|skip|later|not now)$/i.test(rawText.trim())) {
        context.awaiting = null;
        return 'Understood — you can always come back and say "intake" before your visit.';
      }
      return handleIntake(session, user, context, entities);

    case INTENTS.REVIEW:
      return handleReview(session, user, context, entities);

    default:
      // No intent matched and the LLM (if any) had nothing better to say.
      return (
        'I did not quite catch that. I am good with appointments, queues, waitlists, symptom triage, intake forms and reviews — plus clinic info like hours, fees and parking.\n\n' +
        'Type "help" to see the full list.'
      );
  }
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** POST /api/chat/sessions — open a conversation, emit any proactive prompts. */
const createSession = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `INSERT INTO chat_sessions (user_id, subject) VALUES ($1, $2) RETURNING *`,
    [req.user.id, req.body.subject || 'Chat with Qrus assistant']
  );
  const session = rows[0];
  const context = readContext(session);

  const opening = await say(
    session,
    req.user,
    `Hello${req.user.full_name ? ` ${req.user.full_name.split(' ')[0]}` : ''} — I'm the Qrus assistant. ${HELP_TEXT}`,
    { intent: INTENTS.GREETING }
  );

  const prompts = await proactivePrompts(session, req.user, context);
  await writeContext(session.id, context);

  res.status(201).json({
    session,
    messages: [opening, ...prompts],
    awaiting: context.awaiting,
  });
});

/** GET /api/chat/sessions — the caller's own conversations. */
const listSessions = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.status, s.subject, s.started_at, s.last_message_at, s.last_intent,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id)::int AS message_count
       FROM chat_sessions s
      WHERE s.user_id = $1
      ORDER BY s.last_message_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ sessions: rows });
});

/** GET /api/chat/sessions/:id — full transcript of the caller's own session. */
const getSession = asyncHandler(async (req, res) => {
  const session = await queryOne(`SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.id,
  ]);
  if (!session) throw ApiError.notFound('Chat session not found.');

  const { rows: messages } = await query(
    `SELECT id, sender, content, intent, created_at
       FROM chat_messages WHERE session_id = $1 ORDER BY id ASC`,
    [session.id]
  );

  res.json({ session, messages, awaiting: readContext(session).awaiting });
});

/** DELETE /api/chat/sessions/:id — close (never deletes history). */
const closeSession = asyncHandler(async (req, res) => {
  const session = await queryOne(`SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.id,
  ]);
  if (!session) throw ApiError.notFound('Chat session not found.');

  const updated = await queryOne(
    `UPDATE chat_sessions SET status = 'closed', closed_at = now() WHERE id = $1 RETURNING *`,
    [session.id]
  );
  res.json({ session: updated });
});

/**
 * POST /api/chat/sessions/:id/messages — one turn of the dialog.
 *
 * Order is deliberate: persist the patient's words first (so a crash mid-turn
 * never loses what they said), answer FAQs without any classification, and
 * only then classify — rules before LLM, so an unconfigured install costs
 * nothing and a patient's message is not shipped to a third party unless the
 * rules genuinely could not place it.
 */
const postMessage = asyncHandler(async (req, res) => {
  const session = await queryOne(
    `SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!session) throw ApiError.notFound('Chat session not found.');
  if (session.status !== 'open') throw ApiError.conflict('This conversation has been closed.');

  const text = req.body.content;
  const context = readContext(session);

  // 1. Persist the patient's message.
  await query(
    `INSERT INTO chat_messages (session_id, user_id, sender, content) VALUES ($1, $2, 'user', $3)`,
    [session.id, req.user.id, text]
  );

  // 2. FAQ fast-path — zero classification, zero provider calls.
  const faqHit = faq.match(text.toLowerCase());
  if (faqHit) {
    const botMsg = await say(session, req.user, faqHit.reply, {
      intent: INTENTS.FAQ,
      metadata: { faq: faqHit.id },
    });
    await writeContext(session.id, context);
    return res.json({ message: botMsg, intent: INTENTS.FAQ, awaiting: context.awaiting });
  }

  // 3. Classify: rules first, LLM only when the rules are unsure.
  const classification = await classify(text);
  const entities = { ...(classification.entities || {}) };
  // A bare number is the most common reply to a numbered list; "cancel 2"
  // carries the same choice inline, which the classifier lifts into `selection`.
  const bare = /^\s*(\d{1,2})\s*$/.exec(text);
  entities.rawNumber = bare
    ? Number(bare[1])
    : Number.isInteger(entities.selection)
      ? entities.selection
      : null;

  // 4. If we were waiting on a specific answer, that usually wins over a fresh
  // intent — but not during the free-text capture steps, where the patient's
  // own words *are* the payload. Asking "what can you do" while typing a
  // medication list must answer the question, not be filed as the medication.
  let reply = null;
  if (context.awaiting && FREE_TEXT_CAPTURE.has(context.awaiting) && INTERRUPTS.has(classification.intent)) {
    // Drop the half-finished capture and start the requested action clean.
    context.awaiting = null;
    context.intake = null;
    context.appointmentId = null;
  } else if (context.awaiting) {
    reply = await resolvePending(session, req.user, context, entities, text, classification);
  }

  if (!reply) {
    reply = await respond(session, req.user, context, entities, classification.intent, text);
  }

  const botMsg = await say(session, req.user, reply, {
    intent: classification.intent,
    metadata: { source: classification.source, confidence: classification.confidence },
  });

  // Record what we ended up waiting for, so the next turn has context.
  await writeContext(session.id, context);

  res.json({
    message: botMsg,
    intent: classification.intent,
    awaiting: context.awaiting,
    offered: {
      slots: context.offeredSlots.length,
      appointments: context.offeredAppointments.length,
    },
  });
});

module.exports = {
  createSession,
  listSessions,
  getSession,
  closeSession,
  postMessage,
  schemas: { createSessionSchema, messageSchema, sessionIdParam },
};
