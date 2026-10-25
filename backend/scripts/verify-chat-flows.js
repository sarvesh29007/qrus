'use strict';

/**
 * The state-changing half of the chatbot, exercised end to end:
 *
 *   book a real slot through conversation -> appointment exists in the DB
 *   -> refuse a double-booking of the same slot
 *   -> submit pre-consultation intake      -> row linked to the appointment
 *   -> the doctor reads that intake back   -> and the read is audited
 *   -> cancel through conversation         -> slot released, audit written
 *
 * Everything goes over HTTP against a running server, exactly as the widget
 * does it. Requires DATABASE_URL for the direct DB assertions.
 *
 *   DATABASE_URL=... node scripts/verify-chat-flows.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000';

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
  const { json } = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  return json?.accessToken || null;
}

async function main() {
  const { query, closePool } = require('../src/config/db');

  console.log(`\n[verify-chat-flows] target ${BASE}\n`);

  const patient = await login('arjun@qrus.dev', 'QrusPatient!1');
  const doctor = await login('dr.meera@qrus.dev', 'QrusDoctor!1');
  check('patient + doctor sign in', Boolean(patient && doctor));

  const open = await call('/api/chat/sessions', { method: 'POST', token: patient, body: {} });
  const sid = open.json?.session?.id;
  check('chat session opens', Boolean(sid));

  const say = (content) => call(`/api/chat/sessions/${sid}/messages`, { method: 'POST', token: patient, body: { content } });

  // -------------------------------------------------------------------------
  console.log('\n— book a real appointment through conversation —');
  const start = await say('book an appointment with Dr Meera');
  check('booking conversation starts', start.status === 200, `got ${start.status}`);
  const asked = start.json?.message?.content || '';
  check('bot resolves a doctor and a day', /Dr\. Meera Iyer/.test(asked) && /\d{4}-\d{2}-\d{2}/.test(asked),
    asked.slice(0, 140));
  check('no doubled "Dr. Dr" prefix', !/Dr\.\s*Dr\.?\s/.test(asked), asked.slice(0, 60));

  const dateMatch = /on (\d{4}-\d{2}-\d{2})/.exec(asked) || /(\d{4}-\d{2}-\d{2})/.exec(asked);
  const date = dateMatch ? dateMatch[1] : null;
  check('a date was resolved', Boolean(date), asked.slice(0, 140));

  // The first turn proposes a day; "yes" must keep the doctor and list times
  // rather than starting the conversation over.
  let slotsPrompt = asked;
  if (!/Reply with a number/.test(asked)) {
    const yes = await say('yes');
    slotsPrompt = yes.json?.message?.content || '';
  }
  check('"yes" carries the doctor forward into the slot list',
    /Reply with a number/.test(slotsPrompt), slotsPrompt.slice(0, 160));
  check('slot list shows real times', /\d\.\s*\d{2}:\d{2}[–-]\d{2}:\d{2}/.test(slotsPrompt),
    slotsPrompt.slice(0, 160));

  const beforeCount = await query(
    `SELECT COUNT(*)::int AS n FROM appointments a JOIN users p ON p.id = a.patient_id WHERE p.email = 'arjun@qrus.dev'`
  );

  const booked = await say('1');
  const bookedText = booked.json?.message?.content || '';
  check('slot 1 books successfully', /Booked/.test(bookedText), bookedText.slice(0, 160));

  const idMatch = /appointment #(\d+)/.exec(bookedText);
  const apptId = idMatch ? Number(idMatch[1]) : null;
  check('an appointment id came back', Boolean(apptId), bookedText.slice(0, 160));

  const afterCount = await query(
    `SELECT COUNT(*)::int AS n FROM appointments a JOIN users p ON p.id = a.patient_id WHERE p.email = 'arjun@qrus.dev'`
  );
  check('a row was actually inserted', afterCount.rows[0].n === beforeCount.rows[0].n + 1,
    `${beforeCount.rows[0].n} -> ${afterCount.rows[0].n}`);

  if (apptId) {
    const row = await query(`SELECT id, patient_id, doctor_id, slot_id, status FROM appointments WHERE id = $1`, [apptId]);
    check('appointment row is linked to a real slot', Boolean(row.rows[0]?.slot_id));

    // --- double-booking is refused -------------------------------------
    const slotId = row.rows[0].slot_id;
    const clash = await call('/api/appointments', {
      method: 'POST', token: patient, body: { slotId, reason: 'attempted double book' },
    });
    check('double-booking the same slot is refused', clash.status >= 400, `got ${clash.status}`);

    // --- audit trail ----------------------------------------------------
    const auditRows = await query(
      `SELECT action, patient_id FROM audit_logs WHERE entity_id = $1 AND action = 'appointment.booked'`,
      [String(apptId)]
    );
    check('booking wrote an audit_logs row', auditRows.rows.length >= 1,
      `no audit row for appointment ${apptId}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n— pre-consultation intake through conversation —');
  const intakeStart = await say('I want to fill in my medical history');
  const intakeText = intakeStart.json?.message?.content || '';
  check('intake flow starts', /history|intake/i.test(intakeText), intakeText.slice(0, 140));

  // If it asked which visit, pick the newest one (last in the list).
  let historyPrompt = intakeText;
  if (/Which visit should I collect details for/i.test(intakeText)) {
    const nums = [...intakeText.matchAll(/^(\d+)\./gm)];
    const pick = String(nums.length);
    const picked = await say(pick);
    historyPrompt = picked.json?.message?.content || '';
  }
  check('asks for medical history', /medical history|existing conditions/i.test(historyPrompt),
    historyPrompt.slice(0, 140));

  const meds = await say('Type 2 diabetes since 2019, no surgeries');
  const medsPrompt = meds.json?.message?.content || '';
  check('asks for medications next', /medications|medicines/i.test(medsPrompt), medsPrompt.slice(0, 140));

  const saved = await say('Metformin 500mg twice daily');
  const savedText = saved.json?.message?.content || '';
  check('intake confirms it saved', /Saved to appointment/.test(savedText), savedText.slice(0, 160));

  const savedApptMatch = /appointment #(\d+)/.exec(savedText);
  const intakeApptId = savedApptMatch ? Number(savedApptMatch[1]) : apptId;

  if (intakeApptId) {
    const intakeRow = await query(
      `SELECT id, appointment_id, patient_id, doctor_id, medical_history, current_medications, status, submitted_via
         FROM pre_consultation_intake WHERE appointment_id = $1`,
      [intakeApptId]
    );
    const intake = intakeRow.rows[0];
    check('intake row exists and is linked to the appointment', Boolean(intake),
      `no intake row for appointment ${intakeApptId}`);
    if (intake) {
      check('medical history persisted', /diabetes/i.test(intake.medical_history), intake.medical_history);
      check('medications persisted', /metformin/i.test(intake.current_medications), intake.current_medications);
      check('intake marks itself chat-sourced', intake.submitted_via === 'chat', intake.submitted_via);
      check('intake is marked submitted', intake.status === 'submitted', intake.status);

      const intakeAudit = await query(
        `SELECT action FROM audit_logs WHERE entity_type = 'pre_consultation_intake' AND entity_id = $1`,
        [String(intake.id)]
      );
      check('intake wrote an audit_logs row', intakeAudit.rows.length >= 1, 'no audit row');

      // --- doctor reads it back ----------------------------------------
      console.log('\n— doctor reads the intake back —');

      // The intake belongs to whichever doctor owns the appointment; another
      // doctor must be refused. Sign in as the owner to see it.
      const ownerRow = await query(
        `SELECT u.email FROM pre_consultation_intake i JOIN users u ON u.id = i.doctor_id WHERE i.appointment_id = $1`,
        [intakeApptId]
      );
      const ownerEmail = ownerRow.rows[0]?.email;
      // Reuse the session we already hold when it is the same doctor; extra
      // sign-ins just trip the auth rate limiter.
      const ownerToken =
        ownerEmail === 'dr.meera@qrus.dev'
          ? doctor
          : ownerEmail
            ? await login(ownerEmail, 'QrusDoctor!1')
            : null;
      check('owning doctor signs in', Boolean(ownerToken), ownerEmail);

      const stranger = await call(`/api/doctor/appointments/${intakeApptId}/intake`, { token: doctor });
      if (ownerEmail !== 'dr.meera@qrus.dev') {
        check('a different doctor is refused (RBAC)', stranger.status === 403 || stranger.status === 404,
          `got ${stranger.status}`);
      }

      const view = await call(`/api/doctor/appointments/${intakeApptId}/intake`, { token: ownerToken });
      check('owning doctor reads the intake', view.status === 200, `got ${view.status}`);
      check('doctor sees the history', /diabetes/i.test(view.json?.intake?.medical_history || ''),
        JSON.stringify(view.json).slice(0, 120));
      check('doctor sees the medications', /metformin/i.test(view.json?.intake?.current_medications || ''));

      const viewedAudit = await query(
        `SELECT id FROM audit_logs WHERE action = 'intake.viewed' AND entity_id = $1`,
        [String(view.json?.intake?.id ?? intake.id)]
      );
      check('doctor reading intake was audited', viewedAudit.rows.length >= 1, 'no intake.viewed row');
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n— cancel through conversation —');
  const mine = await say('show my appointments');
  const mineText = mine.json?.message?.content || '';
  check('lists upcoming appointments', /\d+\./.test(mineText), mineText.slice(0, 140));

  const nums = [...mineText.matchAll(/^(\d+)\./gm)];
  if (nums.length) {
    const cancelAsk = await say(`cancel ${nums[0][1]}`);
    const cancelText = cancelAsk.json?.message?.content || '';
    check('cancel confirms', /cancelled|Which appointment/i.test(cancelText), cancelText.slice(0, 160));

    // If it asked which one (bare "cancel"), pick the first.
    let finalCancel = cancelText;
    if (/Which appointment would you like to cancel/i.test(cancelText)) {
      const pick = await say('1');
      finalCancel = pick.json?.message?.content || '';
    }
    check('appointment actually cancelled', /cancelled and the slot has been released/.test(finalCancel),
      finalCancel.slice(0, 160));

    const cancelAudit = await query(
      `SELECT id FROM audit_logs WHERE action = 'appointment.cancelled' ORDER BY id DESC LIMIT 1`
    );
    check('cancellation wrote an audit_logs row', cancelAudit.rows.length >= 1);
  }

  // -------------------------------------------------------------------------
  console.log('\n— waitlist status through conversation —');
  const queue = await say('where am I in the queue');
  check('queue status answers', queue.status === 200, `got ${queue.status}`);

  await closePool().catch(() => {});
  console.log(`\n[verify-chat-flows] ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[verify-chat-flows] fatal:', err.message);
  process.exit(1);
});
