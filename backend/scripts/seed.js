'use strict';

/**
 * Idempotent demo seeder.
 *
 *   npm run migrate && npm run seed
 *
 * Creates three roles' worth of accounts, real weekly schedules, materialised
 * slots and a spread of appointments that exercise every workflow:
 *   - a completed appointment with NO review   -> verified-review demo
 *   - a completed appointment with an approved review -> doctor rating
 *   - a completed appointment with a pending review    -> admin moderation
 *   - a scheduled (accepted) upcoming appointment
 *   - a pending appointment waiting for the doctor to accept/decline
 *   - a waitlist entry that the decline action should slot in automatically
 *
 * The seeder never deletes users: audit_logs is append-only and references
 * them, so rows are upserted instead.
 */

const bcrypt = require('bcryptjs');
const config = require('../src/config/env');
const { pool, query, queryOne, closePool } = require('../src/config/db');
const engine = require('../src/services/schedulingEngine');
const { todayInTz, addDays } = require('../src/utils/time');
const fs = require('fs');
const path = require('path');

const HASH_ROUNDS = 10;
const PASSWORDS = {
  admin: 'QrusAdmin!1',
  doctor: 'QrusDoctor!1',
  patient: 'QrusPatient!1',
};

const DOCTORS = [
  { email: 'dr.meera@qrus.dev',  name: 'Dr Meera Iyer',    slug: 'cardiology',       fee: 800, city: 'Pune',    exp: 14, license: 'MED-CARD-1001' },
  { email: 'dr.rohan@qrus.dev',  name: 'Dr Rohan Deshmukh', slug: 'dermatology',     fee: 600, city: 'Pune',    exp: 9,  license: 'MED-DERM-1002' },
  { email: 'dr.kavya@qrus.dev',  name: 'Dr Kavya Nair',    slug: 'orthopedics',      fee: 700, city: 'Mumbai',  exp: 12, license: 'MED-ORTH-1003' },
  { email: 'dr.arun@qrus.dev',   name: 'Dr Arun Bose',     slug: 'neurology',        fee: 950, city: 'Kolkata', exp: 17, license: 'MED-NEUR-1004' },
  { email: 'dr.sana@qrus.dev',   name: 'Dr Sana Qureshi',  slug: 'pediatrics',       fee: 550, city: 'Delhi',   exp: 8,  license: 'MED-PEDS-1005' },
  { email: 'dr.vikram@qrus.dev', name: 'Dr Vikram Rao',    slug: 'psychiatry',       fee: 900, city: 'Hyderabad', exp: 11, license: 'MED-PSYC-1006' },
  { email: 'dr.nisha@qrus.dev',  name: 'Dr Nisha Menon',   slug: 'general-medicine', fee: 400, city: 'Kochi',   exp: 6,  license: 'MED-GENM-1007' },
  { email: 'dr.ishaan@qrus.dev', name: 'Dr Ishaan Khan',   slug: 'gastroenterology', fee: 750, city: 'Lucknow', exp: 10, license: 'MED-GAST-1008' },
];

const PATIENTS = [
  { email: 'priya@qrus.dev', name: 'Priya Shah', phone: '+919000000001' },
  { email: 'arjun@qrus.dev', name: 'Arjun Mehta', phone: '+919000000002' },
];

const ADMIN = { email: 'admin@qrus.dev', name: 'Qrus Administrator' };

const WEEKDAY_WINDOWS = [
  { weekday: 1, startTime: '09:00', endTime: '12:00', slotMinutes: 20 },
  { weekday: 1, startTime: '14:00', endTime: '17:00', slotMinutes: 20 },
  { weekday: 2, startTime: '09:00', endTime: '12:00', slotMinutes: 20 },
  { weekday: 2, startTime: '14:00', endTime: '17:00', slotMinutes: 20 },
  { weekday: 3, startTime: '09:00', endTime: '12:00', slotMinutes: 30 },
  { weekday: 3, startTime: '14:00', endTime: '17:00', slotMinutes: 30 },
  { weekday: 4, startTime: '09:00', endTime: '12:00', slotMinutes: 20 },
  { weekday: 4, startTime: '14:00', endTime: '17:00', slotMinutes: 20 },
  { weekday: 5, startTime: '09:00', endTime: '12:00', slotMinutes: 20 },
  { weekday: 5, startTime: '14:00', endTime: '17:00', slotMinutes: 20 },
  // Saturday clinic — only Dr Meera works it.
  { weekday: 6, startTime: '10:00', endTime: '13:00', slotMinutes: 30, only: 'dr.meera@qrus.dev' },
];

// ---------------------------------------------------------------------------
async function runFile(filename) {
  const file = path.join(config.paths.database, filename);
  await pool.query(fs.readFileSync(file, 'utf8'));
  process.stdout.write(`  -> ${filename} ok\n`);
}

async function ensureUser({ email, name, password, role, phone }) {
  const existing = await queryOne(`SELECT id, email, role, status FROM users WHERE lower(email) = lower($1)`, [email]);
  if (existing) return existing;

  const hash = await bcrypt.hash(password, HASH_ROUNDS);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, phone, role, status)
     VALUES ($1,$2,$3,$4,$5,'active')
     RETURNING id, email, role, status`,
    [email.toLowerCase(), hash, name, phone || null, role]
  );
  return rows[0];
}

async function ensureDoctor(doctor) {
  const user = await ensureUser({
    email: doctor.email,
    name: doctor.name,
    password: PASSWORDS.doctor,
    role: 'doctor',
  });

  const specialty = await queryOne(`SELECT id FROM specialties WHERE slug = $1`, [doctor.slug]);
  if (!specialty) throw new Error(`Unknown specialty slug in seed data: ${doctor.slug}`);

  const existingProfile = await queryOne(
    `SELECT user_id FROM doctor_profiles WHERE user_id = $1`,
    [user.id]
  );
  if (!existingProfile) {
    await query(
      `INSERT INTO doctor_profiles
         (user_id, specialty_id, license_number, bio, years_experience, consultation_fee,
          clinic_name, city, languages)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{"English","Hindi"}')`,
      [
        user.id,
        specialty.id,
        doctor.license,
        `${doctor.name} specialises in ${doctor.slug.replace('-', ' ')} care with a focus on
          evidence-based treatment and clear patient communication.`,
        doctor.exp,
        doctor.fee,
        `${doctor.name.split(' ').slice(1).join(' ')} Family Clinic`,
        doctor.city,
      ]
    );
  }

  // Weekly recurring schedule (idempotent upsert).
  for (const w of WEEKDAY_WINDOWS) {
    if (w.only && w.only !== doctor.email) continue;
    await query(
      `INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time, slot_minutes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (doctor_id, weekday, start_time)
       DO UPDATE SET end_time = EXCLUDED.end_time, slot_minutes = EXCLUDED.slot_minutes`,
      [user.id, w.weekday, w.startTime, w.endTime, w.slotMinutes]
    );
  }

  return { ...user, specialtyId: specialty.id };
}

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** The doctor's next genuinely bookable slot (beyond the min-lead window). */
async function findFutureSlot(doctorId) {
  return queryOne(
    `SELECT * FROM appointment_slots
      WHERE doctor_id = $1 AND status = 'open'
        AND starts_at_tz > now() + make_interval(mins => ${config.booking.minLeadMinutes + 30})
        AND starts_at_tz < now() + make_interval(days => ${config.booking.maxHorizonDays - 1})
      ORDER BY starts_at_tz
      LIMIT 1`,
    [doctorId]
  );
}

/** Unused historical slots for a doctor, most recent first. */
async function findPastSlots(doctorId, limit = 4) {
  const { rows } = await query(
    `SELECT * FROM appointment_slots
      WHERE doctor_id = $1 AND status = 'open'
        AND starts_at_tz < now() - interval '6 hours'
      ORDER BY starts_at_tz DESC
      LIMIT $2`,
    [doctorId, limit]
  );
  return rows;
}

async function ensureAppointment({ patientId, doctorId, slot, status, note }) {
  if (!slot) {
    process.stdout.write(`    ! no usable slot for doctor ${doctorId} — skipped\n`);
    return null;
  }

  const existing = await queryOne(
    `SELECT id FROM appointments WHERE slot_id = $1`,
    [slot.id]
  );
  if (existing) return { id: existing.id, skipped: true };

  const specialty = await queryOne(
    `SELECT specialty_id FROM doctor_profiles WHERE user_id = $1`,
    [doctorId]
  );

  const startedPast = new Date(slot.starts_at_tz) < new Date();
  const { rows } = await query(
    `INSERT INTO appointments
       (patient_id, doctor_id, slot_id, specialty_id, status, reason, symptoms,
        scheduled_for, scheduled_date, scheduled_time, accepted_at, completed_at, doctor_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      patientId,
      doctorId,
      slot.id,
      specialty.specialty_id,
      status,
      note.reason || 'General consultation',
      note.symptoms || '',
      slot.starts_at_tz,
      slot.slot_date,
      slot.starts_at,
      status === 'pending' ? null : slot.starts_at_tz,
      status === 'completed' ? new Date(new Date(slot.starts_at_tz).getTime() + 20 * 60_000) : null,
      note.doctorNote || null,
    ]
  );

  await query(`UPDATE appointment_slots SET status = 'booked' WHERE id = $1`, [slot.id]);
  return { id: rows[0].id, skipped: false, startedPast };
}

async function ensureReview({ doctorId, patientId, appointmentId, rating, comment, status }) {
  const existing = await queryOne(`SELECT id FROM reviews WHERE appointment_id = $1`, [appointmentId]);
  if (existing) return existing.id;

  const { rows } = await query(
    `INSERT INTO reviews (doctor_id, patient_id, appointment_id, rating, comment, status, moderated_at)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6 = 'approved' THEN now() END)
     RETURNING id`,
    [doctorId, patientId, appointmentId, rating, comment, status]
  );

  // Keep the doctor's public rating in sync with approved reviews.
  await query(
    `UPDATE doctor_profiles dp
        SET rating_avg = sub.avg_rating, rating_count = sub.rating_count
       FROM (SELECT COALESCE(AVG(rating), 0)::numeric(3,2) AS avg_rating,
                    COUNT(*)::int AS rating_count
               FROM reviews WHERE doctor_id = $1 AND status = 'approved') sub
      WHERE dp.user_id = $1`,
    [doctorId]
  );

  return rows[0].id;
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('[qrus] seeding demo data');
  await runFile('schema.sql');
  await runFile('seed.sql');

  const today = todayInTz(config.appTz);

  // --- people ---------------------------------------------------------------
  const admin = await ensureUser({
    email: ADMIN.email,
    name: ADMIN.name,
    password: PASSWORDS.admin,
    role: 'admin',
  });
  const patients = [];
  for (const p of PATIENTS) {
    patients.push(await ensureUser({ ...p, password: PASSWORDS.patient, role: 'patient' }));
  }
  const doctors = [];
  for (const d of DOCTORS) doctors.push(await ensureDoctor(d));

  // --- materialise slots ----------------------------------------------------
  const doctorIds = doctors.map((d) => d.id);
  for (let i = -14; i <= 14; i += 1) {
    const date = addDays(today, i);
    if (weekdayOf(date) === 0) continue; // nobody works Sundays in this dataset
    for (const doctorId of doctorIds) {
      await engine.ensureSlotsForDate(doctorId, date);
    }
  }
  process.stdout.write(`  -> slots materialised for ${today} +/- 14 days\n`);

  const [priya, arjun] = patients;
  const meera = doctors.find((d) => d.email === 'dr.meera@qrus.dev');
  const kavya = doctors.find((d) => d.email === 'dr.kavya@qrus.dev');
  const rohan = doctors.find((d) => d.email === 'dr.rohan@qrus.dev');

  // --- encounter history ----------------------------------------------------
  // Each historical visit needs a real slot in the past; slots are materialised
  // for today +/- 14 days above, so these queries always find candidates.
  const meeraPast = await findPastSlots(meera.id, 4);
  const rohanPast = await findPastSlots(rohan.id, 4);

  const completed1 = await ensureAppointment({
    patientId: priya.id, doctorId: meera.id, slot: meeraPast[0], status: 'completed',
    note: { reason: 'Chest tightness while climbing stairs', symptoms: 'chest tightness, mild breathlessness on exertion' },
  });
  const completed2 = await ensureAppointment({
    patientId: arjun.id, doctorId: meera.id, slot: meeraPast[1], status: 'completed',
    note: { reason: 'Blood pressure follow-up', symptoms: 'high blood pressure, occasional palpitations' },
  });
  const completed3 = await ensureAppointment({
    patientId: arjun.id, doctorId: rohan.id, slot: rohanPast[0], status: 'completed',
    note: { reason: 'Persistent itchy rash', symptoms: 'skin rash, itching on forearms' },
  });

  // completed1 (Priya) deliberately gets NO review — that is the account used
  // to demonstrate the "review only after a completed visit" gate.
  if (completed2) {
    await ensureReview({
      doctorId: meera.id, patientId: arjun.id, appointmentId: completed2.id,
      rating: 5,
      comment: 'Listened carefully, explained the reports and adjusted my medication.',
      status: 'approved', // feeds Dr Meera's public rating
    });
  }
  if (completed3) {
    await ensureReview({
      doctorId: rohan.id, patientId: arjun.id, appointmentId: completed3.id,
      rating: 2,
      comment: 'Consultation was rushed and I left with more questions than answers.',
      status: 'pending', // sits in the admin moderation queue
    });
  }

  // --- live appointments ----------------------------------------------------
  await ensureAppointment({
    patientId: priya.id, doctorId: kavya.id,
    slot: await findFutureSlot(kavya.id),
    status: 'scheduled',
    note: { reason: 'Lower back pain', symptoms: 'lower back pain, stiffness in the morning' },
  });
  await ensureAppointment({
    patientId: arjun.id, doctorId: kavya.id,
    slot: await findFutureSlot(kavya.id),
    status: 'pending', // not accepted yet — demonstrates the accept/decline flow
    note: { reason: 'Knee pain after a run', symptoms: 'knee pain, swollen joint' },
  });

  // --- waitlist queue -------------------------------------------------------
  const ortho = await queryOne(`SELECT id FROM specialties WHERE slug = 'orthopedics'`);
  const existingWait = await queryOne(
    `SELECT id FROM waitlist_entries WHERE patient_id = $1 AND status = 'waiting'`,
    [priya.id]
  );
  if (!existingWait) {
    await query(
      `INSERT INTO waitlist_entries
         (patient_id, doctor_id, specialty_id, symptoms, urgency, preferred_date_from,
          preferred_date_to, expires_at)
       VALUES ($1,$2,$3,$4,'urgent',$5,$6,$7)`,
      [
        priya.id,
        kavya.id,
        ortho.id,
        'Severe lower back pain, difficulty standing up straight',
        addDays(today, 1),
        addDays(today, 7),
        addDays(today, config.waitlist.ttlDays),
      ]
    );
  }

  console.log('\n[qrus] demo credentials (development only):\n');
  console.log('  ADMIN    admin@qrus.dev     / ' + PASSWORDS.admin);
  console.log('  PATIENT  priya@qrus.dev     / ' + PASSWORDS.patient + '  (completed visit, no review yet)');
  console.log('  PATIENT  arjun@qrus.dev     / ' + PASSWORDS.patient + '  (pending appointment + reviews)');
  for (const d of DOCTORS) console.log('  DOCTOR   ' + d.email.padEnd(20) + '/ ' + PASSWORDS.doctor);
  console.log('\n[qrus] seed complete\n');
}

main()
  .catch((err) => {
    console.error('[qrus] seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
