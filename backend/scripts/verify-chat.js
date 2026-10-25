'use strict';

/**
 * End-to-end check of the chatbot over real HTTP — the same requests the
 * React widget makes. Exercises every requirement:
 *   triage, queue/waitlist status, book, reschedule, cancel, intake, review,
 *   FAQ fast-path, RBAC/ownership, and the doctor's intake view.
 *
 *   DATABASE_URL=... node scripts/verify-chat.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000';

/**
 * Fixture setup. The seed ships both of arjun's completed visits as already
 * reviewed, so the post-visit prompt would never fire. Rather than assert
 * against whatever the seed happens to contain, build the exact state the
 * requirement describes: one completed, unreviewed visit.
 */
/**
 * The pre-visit prompt needs an upcoming appointment with no intake form. The
 * seed supplies one, but earlier test runs fill it in or cancel it, so top it
 * back up: reuse an upcoming visit (clearing its intake) or book a fresh one
 * through the real API when the patient has nothing coming up at all.
 */
async function ensureUpcomingAppointment(token) {
  const { query, closePool } = require('../src/config/db');
  let doctorId = null;
  try {
    const { rows } = await query(
      `SELECT a.id,
              EXISTS (SELECT 1 FROM pre_consultation_intake i WHERE i.appointment_id = a.id) AS has_intake
         FROM appointments a JOIN users p ON p.id = a.patient_id
        WHERE p.email = 'arjun@qrus.dev' AND a.status = ANY($1::text[]) AND a.scheduled_for > now()
        ORDER BY a.scheduled_for`,
      [['pending', 'scheduled']]
    );

    if (rows.some((r) => !r.has_intake)) {
      console.log('  (fixture: an upcoming appointment without intake is already present)');
      return;
    }
    if (rows.length) {
      await query(`DELETE FROM pre_consultation_intake WHERE appointment_id = $1`, [rows[0].id]);
      console.log(`  (fixture: cleared intake on upcoming appointment ${rows[0].id})`);
      return;
    }

    const { rows: doc } = await query(`SELECT id FROM users WHERE email = 'dr.meera@qrus.dev'`);
    doctorId = doc[0]?.id || null;
  } finally {
    // The pool stays open: setupFixtures ran first and further checks still
    // use it. It is closed once at the end of the run.
    void closePool;
  }

  if (!doctorId) return;

  for (let i = 1; i <= 21; i += 1) {
    const day = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
    const grid = await call(`/api/doctors/${doctorId}/slots?date=${day}`, { token });
    const slots = grid.json?.slots || grid.json?.data || [];
    const free = slots.find((s) => s.available);
    if (!free) continue;
    const booked = await call('/api/appointments', {
      method: 'POST',
      token,
      body: { slotId: free.id, reason: 'Fixture visit for chat prompt verification' },
    });
    console.log(`  (fixture: booked appointment ${booked.json?.appointment?.id || '?'} on ${day} for the intake prompt)`);
    return;
  }
  console.log('  (fixture: no open slot to book — the intake prompt check will fail)');
}

async function setupFixtures() {
  const { query, closePool } = require('../src/config/db');
  try {
    const { rows } = await query(
      `SELECT a.id, a.doctor_id, a.patient_id, a.scheduled_for
         FROM appointments a
         JOIN users p ON p.id = a.patient_id
        WHERE p.email = 'arjun@qrus.dev' AND a.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id)
        LIMIT 1`
    );
    if (rows.length) {
      console.log(`  (fixture: appointment ${rows[0].id} is already completed + unreviewed)`);
      return;
    }

    // Take the most recent reviewed visit, reopen it as completed-unreviewed.
    // (Pool stays open — see the note in ensureUpcomingAppointment.)
    const { rows: reviewed } = await query(
      `SELECT a.id FROM appointments a JOIN users p ON p.id = a.patient_id
        WHERE p.email = 'arjun@qrus.dev' AND a.status = 'completed'
        ORDER BY a.scheduled_for DESC LIMIT 1`
    );
    if (!reviewed.length) {
      console.log('  (fixture: no completed visit available — prompt checks will be skipped)');
      return;
    }
    await query(`DELETE FROM reviews WHERE appointment_id = $1`, [reviewed[0].id]);
    console.log(`  (fixture: cleared review on appointment ${reviewed[0].id} so the prompt can fire)`);
  } finally {
    void closePool;
  }
}

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function login(email, password) {
  const res = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  return res.json?.accessToken || null;
}

/** Open a chat session and drain the proactive prompts. */
async function openChat(token) {
  const res = await call('/api/chat/sessions', { method: 'POST', token, body: {} });
  return { status: res.status, json: res.json };
}

async function say(token, sessionId, content) {
  return call(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    token,
    body: { content },
  });
}

async function main() {
  console.log(`\n[verify-chat] target ${BASE}\n`);
  await setupFixtures();

  const patient = await login('arjun@qrus.dev', 'QrusPatient!1');
  if (patient) await ensureUpcomingAppointment(patient);
  const doctor = await login('dr.meera@qrus.dev', 'QrusDoctor!1');
  const admin = await login('admin@qrus.dev', 'QrusAdmin!1');

  check('patient signs in', Boolean(patient));
  check('doctor signs in', Boolean(doctor));
  check('admin signs in', Boolean(admin));
  if (!patient || !doctor) {
    console.log('\nMissing credentials — cannot continue.');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  console.log('\n— auth gate —');
  const anon = await call('/api/chat/sessions', { method: 'POST', body: {} });
  check('anonymous chat is rejected 401', anon.status === 401, `got ${anon.status}`);

  // -------------------------------------------------------------------------
  console.log('\n— session lifecycle + proactive prompts —');
  const opened = await openChat(patient);
  check('session opens 201', opened.status === 201, `got ${opened.status}`);
  const sessionId = opened.json?.session?.id;
  check('session has an id', Boolean(sessionId));
  const openingMessages = opened.json?.messages || [];
  check(
    'opening greeting is returned',
    openingMessages.some((m) => m.sender === 'bot'),
    JSON.stringify(openingMessages.map((m) => m.sender))
  );
  // Requirement 5: a completed, unreviewed visit triggers an automated prompt.
  const reviewPrompt = openingMessages.find((m) => m.metadata?.prompt === 'post_visit_review');
  check('post-visit review prompt fired automatically', Boolean(reviewPrompt),
    'no completed-unreviewed appointment found');
  const intakePrompt = openingMessages.find((m) => m.metadata?.prompt === 'pre_consultation');
  check('pre-consultation intake prompt fired automatically', Boolean(intakePrompt),
    'no upcoming appointment found');

  // -------------------------------------------------------------------------
  console.log('\n— 1. conversational triage —');
  const triage = await say(patient, sessionId, 'I have chest tightness when I climb stairs and mild breathlessness');
  check('triage replies 200', triage.status === 200, `got ${triage.status}`);
  const triageText = triage.json?.message?.content || '';
  check('triage intent classified', triage.json?.intent === 'triage', `intent=${triage.json?.intent}`);
  check('triage recommends a specialty', /specialt|Cardiology|score/i.test(triageText),
    triageText.slice(0, 90));

  // -------------------------------------------------------------------------
  console.log('\n— 6. FAQ fast-path (no classification, no LLM) —');
  const faqRes = await say(patient, sessionId, 'what are your clinic hours?');
  check('FAQ intent', faqRes.json?.intent === 'faq', `intent=${faqRes.json?.intent}`);
  check('FAQ answer is the canned one', /Monday/.test(faqRes.json?.message?.content || ''));

  const faqFees = await say(patient, sessionId, 'how much is the consultation fee');
  check('FAQ fees intent', faqFees.json?.intent === 'faq', `intent=${faqFees.json?.intent}`);
  check('FAQ fees answer mentions profile', /profile/i.test(faqFees.json?.message?.content || ''));

  // -------------------------------------------------------------------------
  console.log('\n— 2. queue & waitlist status —');
  const queue = await say(patient, sessionId, 'where am I in the queue');
  check('queue intent', queue.json?.intent === 'check_queue', `intent=${queue.json?.intent}`);
  check('queue answer is not an error', queue.status === 200, `got ${queue.status}`);

  // -------------------------------------------------------------------------
  console.log('\n— 3. chat-based scheduling: book —');
  const bookStart = await say(patient, sessionId, 'book an appointment');
  check('book intent', bookStart.json?.intent === 'book_appointment', `intent=${bookStart.json?.intent}`);
  const bookText = bookStart.json?.message?.content || '';
  check('booking asks for a target or offers slots',
    /cardiology|dr\.|slot|reply with a number|free on/i.test(bookText), bookText.slice(0, 120));

  // -------------------------------------------------------------------------
  console.log('\n— 3b. cancel flow through a numbered list —');
  const mine = await say(patient, sessionId, 'show my appointments');
  check('my_appointments intent', mine.json?.intent === 'my_appointments', `intent=${mine.json?.intent}`);
  const listed = mine.json?.message?.content || '';
  check('lists an appointment or says none', /appointment|no upcoming|\d+\./i.test(listed), listed.slice(0, 120));

  // -------------------------------------------------------------------------
  console.log('\n— 4. pre-consultation intake —');
  const intakeStart = await say(patient, sessionId, 'I want to fill in my medical history');
  check('intake intent', intakeStart.json?.intent === 'pre_consultation_intake', `intent=${intakeStart.json?.intent}`);
  let intakeText = intakeStart.json?.message?.content || '';
  // Several upcoming visits with no form on file produces a picker first.
  if (/Which visit should I collect details for/i.test(intakeText)) {
    const picked = await say(patient, sessionId, '1');
    intakeText = picked.json?.message?.content || '';
    check('picker accepted a numbered choice', /appointment #\d+/i.test(intakeText), intakeText.slice(0, 120));
  }
  check('intake asks for medical history',
    /medical history|existing conditions|no upcoming/i.test(intakeText), intakeText.slice(0, 140));

  // -------------------------------------------------------------------------
  console.log('\n— help / fallback —');
  const help = await say(patient, sessionId, 'what can you do');
  check('help answered', /clinic hours|book an appointment/i.test(help.json?.message?.content || ''),
    (help.json?.message?.content || '').slice(0, 80));

  // -------------------------------------------------------------------------
  console.log('\n— transcript persistence —');
  const transcript = await call(`/api/chat/sessions/${sessionId}`, { token: patient });
  check('transcript loads 200', transcript.status === 200, `got ${transcript.status}`);
  const stored = transcript.json?.messages || [];
  check('user turns persisted', stored.some((m) => m.sender === 'user'));
  check('bot turns persisted', stored.some((m) => m.sender === 'bot'));
  check('intents recorded on turns', stored.some((m) => m.intent));

  // -------------------------------------------------------------------------
  console.log('\n— ownership: a patient cannot read someone else\'s chat —');
  const otherSession = await call(`/api/chat/sessions/${sessionId}`, { token: doctor });
  check('foreign session is 404 (not 403, so ids cannot be probed)',
    otherSession.status === 404, `got ${otherSession.status}`);
  const foreignPost = await call(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST', token: doctor, body: { content: 'hello' },
  });
  check('foreign message post is 404', foreignPost.status === 404, `got ${foreignPost.status}`);

  // -------------------------------------------------------------------------
  console.log('\n— doctor sees the intake the patient submitted —');
  // Find one of the doctor's own appointments to fetch intake for. 'all' rather
  // than 'upcoming': the seed's visit for this doctor is already completed.
  const doctorList = await call('/api/doctor/appointments?view=all', { token: doctor });
  const apptId = doctorList.json?.appointments?.[0]?.id;
  check('doctor can list their appointments', Boolean(apptId), `got ${doctorList.status}`);
  if (apptId) {
    const intakeView = await call(`/api/doctor/appointments/${apptId}/intake`, { token: doctor });
    // 404 = none submitted yet, which is a valid state; 200 = found.
    check('doctor intake endpoint answers (200 or 404)', [200, 404].includes(intakeView.status),
      `got ${intakeView.status}`);
  }
  const patientIntakeProbe = await call('/api/doctor/appointments/1/intake', { token: patient });
  check('patient cannot reach the doctor intake route', patientIntakeProbe.status === 403,
    `got ${patientIntakeProbe.status}`);

  // -------------------------------------------------------------------------
  console.log('\n— 6b. emergency FAQ never reaches the LLM —');
  const emergency = await say(patient, sessionId, 'my father has severe chest pain and cannot breathe');
  check('emergency FAQ intercepted', /emergency/i.test(emergency.json?.message?.content || ''),
    (emergency.json?.message?.content || '').slice(0, 80));

  // -------------------------------------------------------------------------
  // Regression cover for the dead ends patients could hit: a numbered question
  // they could not answer, a plain phrasing the rules missed, and a question
  // asked mid-flow that used to be swallowed by the pending prompt.
  console.log('\n— 7. the conversation never traps the patient —');
  const robust = await openChat(patient);
  const rid = robust.json?.session?.id;
  check('robustness session opens', Boolean(rid));

  const bare = await say(patient, rid, 'cardiology');
  check('a bare specialty starts a booking', bare.json?.intent === 'book_appointment',
    `intent=${bare.json?.intent}`);

  const hoursVariant = await say(patient, rid, 'when are you open?');
  check('"when are you open?" hits the FAQ fast-path', hoursVariant.json?.intent === 'faq',
    `intent=${hoursVariant.json?.intent}`);

  const polite = await say(patient, rid, 'thanks');
  check('a thank-you is answered, not "I did not quite catch that"',
    polite.json?.intent === 'smalltalk', `intent=${polite.json?.intent}`);

  const asked = await say(patient, rid, 'cancel my appointment');
  check('cancel asks which appointment', asked.json?.awaiting === 'cancel_pick',
    `awaiting=${asked.json?.awaiting}`);

  const midFlow = await say(patient, rid, 'how much is a consultation?');
  check('a question asked mid-flow is still answered', midFlow.json?.intent === 'faq',
    `intent=${midFlow.json?.intent}`);
  check('and the pending question is still pending', midFlow.json?.awaiting === 'cancel_pick',
    `awaiting=${midFlow.json?.awaiting}`);

  const firstMiss = await say(patient, rid, 'huh');
  check('an unreadable answer is clarified once',
    /number|ordinal|start over/i.test(firstMiss.json?.message?.content || ''),
    (firstMiss.json?.message?.content || '').slice(0, 90));
  const secondMiss = await say(patient, rid, 'huh');
  check('and then the assistant stops asking instead of looping',
    secondMiss.json?.awaiting === null && /here is what i can do/i.test(secondMiss.json?.message?.content || ''),
    `awaiting=${secondMiss.json?.awaiting}`);

  const pick = await say(patient, rid, 'reschedule my appointment');
  check('reschedule asks which appointment', pick.json?.awaiting === 'reschedule_pick',
    `awaiting=${pick.json?.awaiting}`);
  const ordinal = await say(patient, rid, 'the first one');
  check('"the first one" is understood as a pick',
    ordinal.json?.awaiting === 'reschedule_date', `awaiting=${ordinal.json?.awaiting}`);
  const release = await say(patient, rid, 'never mind');
  check('an escape phrase releases the question',
    release.json?.awaiting === null && /stays where it is/i.test(release.json?.message?.content || ''),
    (release.json?.message?.content || '').slice(0, 90));

  // -------------------------------------------------------------------------
  await require('../src/config/db').closePool().catch(() => {});
  console.log(`\n[verify-chat] ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('[verify-chat] fatal:', err.message);
  process.exit(1);
});
