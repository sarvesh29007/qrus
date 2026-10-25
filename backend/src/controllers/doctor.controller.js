'use strict';

/**
 * Doctor portal API: schedule management, the appointment queue with patient
 * symptoms, accept / decline / reschedule / complete transitions, and the
 * doctor's view of the waitlist.
 *
 * Every read of clinical detail (symptoms, notes) is written to audit_logs —
 * that is the "who opened this patient's record" trail healthcare auditing
 * expects.
 */

const { z } = require('zod');
const config = require('../config/env');
const { query, queryOne, withTransaction } = require('../config/db');
const { ApiError, asyncHandler } = require('../utils/errors');
const { loadOwnedAppointment } = require('../middleware/rbac');
const { audit, ACTIONS } = require('../services/audit.service');
const engine = require('../services/schedulingEngine');
const waitlist = require('../services/waitlistQueue');
const { publishSlotChange } = require('../services/eventBus');
const { todayInTz, addDays } = require('../utils/time');
const { invalidateRuleCache } = require('../services/symptomMatcher');

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

const timeRe = /^\d{2}:\d{2}$/;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const scheduleSchema = z
  .object({
    id: z.coerce.number().int().positive().optional(),
    weekday: z.coerce.number().int().min(0).max(6),
    startTime: z.string().regex(timeRe, 'Use HH:MM.'),
    endTime: z.string().regex(timeRe, 'Use HH:MM.'),
    slotMinutes: z.coerce.number().int().min(5).max(240).default(20),
  })
  .refine((v) => v.endTime > v.startTime, {
    message: 'End time must be after start time.',
  });

const overrideSchema = z
  .object({
    date: z.string().regex(dateRe, 'Use YYYY-MM-DD.'),
    isAvailable: boolish,
    startTime: z.string().regex(timeRe).optional(),
    endTime: z.string().regex(timeRe).optional(),
    reason: z.string().trim().max(200).default(''),
  })
  .refine((v) => Boolean(v.startTime) === Boolean(v.endTime), {
    message: 'Provide both a start and an end time, or neither.',
  })
  .refine((v) => !v.startTime || v.endTime > v.startTime, {
    message: 'End time must be after start time.',
  })
  .refine((v) => v.isAvailable || Boolean(v.startTime) || v.reason, {
    message: 'Blocking a whole day requires a reason.',
  });

const listSchema = z.object({
  date: z.string().regex(dateRe).optional(),
  view: z.enum(['day', 'upcoming', 'all']).default('day'),
  status: z.enum(['pending', 'scheduled', 'completed', 'no_show', 'cancelled', 'active']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const acceptSchema = z.object({ note: z.string().trim().max(500).optional() });
const declineSchema = z.object({ reason: z.string().trim().max(300).default('') });
const completeSchema = z.object({ note: z.string().trim().max(2000).default('') });
const doctorRescheduleSchema = z.object({
  slotId: z.coerce.number().int().positive(),
  reason: z.string().trim().max(300).default(''),
});
const profileSchema = z.object({
  acceptingNewPatients: boolish.optional(),
  bio: z.string().trim().max(1000).optional(),
  consultationFee: z.coerce.number().min(0).max(100000).optional(),
  clinicName: z.string().trim().max(120).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  languages: z.array(z.string().trim().max(40)).max(10).optional(),
});

const APPOINTMENT_SELECT = `
  SELECT a.id, a.status, a.reason, a.symptoms, a.doctor_note, a.scheduled_for,
         a.scheduled_date, a.scheduled_time, a.created_at, a.accepted_at,
         a.completed_at, a.cancellation_reason, a.reschedule_count,
         p.id AS patient_id, p.full_name AS patient_name, p.email AS patient_email,
         p.phone AS patient_phone,
         sp.name AS specialty_name, sp.slug AS specialty_slug,
         rv.id AS review_id, rv.rating AS review_rating, rv.status AS review_status
    FROM appointments a
    JOIN users p ON p.id = a.patient_id
    JOIN specialties sp ON sp.id = a.specialty_id
    LEFT JOIN reviews rv ON rv.appointment_id = a.id
`;

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
const dashboard = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const today = todayInTz(config.appTz);

  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*) FROM appointments
         WHERE doctor_id = $1 AND scheduled_date = $2::date
           AND status IN ('pending','scheduled'))::int AS today_count,
       (SELECT COUNT(*) FROM appointments
         WHERE doctor_id = $1 AND status = 'pending')::int AS pending_requests,
       (SELECT COUNT(*) FROM appointments
         WHERE doctor_id = $1 AND scheduled_for > now()
           AND status IN ('pending','scheduled'))::int AS upcoming,
       (SELECT COUNT(*) FROM appointments
         WHERE doctor_id = $1 AND status = 'completed'
           AND completed_at >= date_trunc('month', now()))::int AS completed_this_month,
       (SELECT COUNT(*) FROM waitlist_entries
         WHERE status = 'waiting'
           AND (doctor_id = $1
                OR (doctor_id IS NULL AND specialty_id =
                    (SELECT specialty_id FROM doctor_profiles WHERE user_id = $1))))::int AS waiting,
       (SELECT COUNT(*) FROM reviews WHERE doctor_id = $1 AND status = 'pending')::int AS pending_reviews,
       (SELECT COALESCE(AVG(rating), 0) FROM reviews
         WHERE doctor_id = $1 AND status = 'approved')::float AS rating_average`,
    [doctorId, today]
  );

  const todays = await query(
    `${APPOINTMENT_SELECT}
      WHERE a.doctor_id = $1 AND a.scheduled_date = $2::date
        AND a.status IN ('pending','scheduled')
      ORDER BY a.scheduled_time ASC`,
    [doctorId, today]
  );

  res.json({ stats: rows[0], todaysAppointments: todays.rows, today });
});

// ---------------------------------------------------------------------------
// Schedule (recurring weekly windows)
// ---------------------------------------------------------------------------
const getSchedule = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const from = todayInTz(config.appTz);
  const to = addDays(from, 60);

  const [windows, overrides, profile] = await Promise.all([
    query(
      `SELECT id, weekday, to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time, slot_minutes
         FROM doctor_schedules WHERE doctor_id = $1
         ORDER BY weekday, start_time`,
      [doctorId]
    ),
    query(
      `SELECT id, override_date, is_available,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time, reason
         FROM schedule_overrides
        WHERE doctor_id = $1 AND override_date BETWEEN $2 AND $3
        ORDER BY override_date`,
      [doctorId, from, to]
    ),
    queryOne(
      `SELECT specialty_id, accepting_new_patients, consultation_fee, bio, clinic_name, city, languages
         FROM doctor_profiles WHERE user_id = $1`,
      [doctorId]
    ),
  ]);

  res.json({ windows: windows.rows, overrides: overrides.rows, profile });
});

const upsertSchedule = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const { id, weekday, startTime, endTime, slotMinutes } = req.body;

  await withTransaction(async (client) => {
    if (id) {
      const { rowCount } = await client.query(
        `UPDATE doctor_schedules
            SET weekday = $3, start_time = $4, end_time = $5, slot_minutes = $6
          WHERE id = $1 AND doctor_id = $2`,
        [id, doctorId, weekday, startTime, endTime, slotMinutes]
      );
      if (!rowCount) throw ApiError.notFound('Schedule window not found.');
    } else {
      await client.query(
        `INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time, slot_minutes)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (doctor_id, weekday, start_time)
         DO UPDATE SET end_time = EXCLUDED.end_time, slot_minutes = EXCLUDED.slot_minutes`,
        [doctorId, weekday, startTime, endTime, slotMinutes]
      );
    }

    await audit(
      req,
      {
        action: ACTIONS.SCHEDULE_UPDATED,
        entityType: 'doctor_schedule',
        entityId: id || null,
        metadata: { weekday, startTime, endTime, slotMinutes, op: id ? 'update' : 'upsert' },
      },
      client
    );
  });

  const refreshed = await regenerateWeekday(doctorId, weekday);
  res.json({ ok: true, regeneratedDates: refreshed });
});

const deleteSchedule = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const row = await queryOne(`SELECT * FROM doctor_schedules WHERE id = $1 AND doctor_id = $2`, [
    req.params.id,
    doctorId,
  ]);
  if (!row) throw ApiError.notFound('Schedule window not found.');

  await query(`DELETE FROM doctor_schedules WHERE id = $1`, [row.id]);
  await audit(req, {
    action: ACTIONS.SCHEDULE_UPDATED,
    entityType: 'doctor_schedule',
    entityId: row.id,
    metadata: { op: 'delete', weekday: row.weekday, startTime: row.start_time },
  });

  const refreshed = await regenerateWeekday(doctorId, row.weekday);
  res.json({ ok: true, regeneratedDates: refreshed });
});

/** Re-materialise every upcoming date that uses this weekday. */
async function regenerateWeekday(doctorId, weekday) {
  const from = todayInTz(config.appTz);
  const dates = [];
  for (let i = 0; i <= config.booking.maxHorizonDays; i += 1) {
    const date = addDays(from, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === weekday) dates.push(date);
  }

  const changed = [];
  for (const date of dates) {
    const result = await engine.ensureSlotsForDate(doctorId, date);
    if (result.changed) {
      changed.push(date);
      publishSlotChange({ doctorId, slotId: null, slotDate: date, status: 'open', reason: 'schedule_updated' });
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Date overrides (day off / extra clinic window)
// ---------------------------------------------------------------------------
const createOverride = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const { date, isAvailable, startTime, endTime, reason } = req.body;

  // Warn (do not silently destroy) about appointments the block would strand.
  if (!isAvailable) {
    const affected = await query(
      `SELECT id, patient_id, scheduled_time FROM appointments
        WHERE doctor_id = $1 AND scheduled_date = $2 AND status IN ('pending','scheduled')
          AND ($3::time IS NULL OR (scheduled_time >= $3::time AND scheduled_time < $4::time))
        ORDER BY scheduled_time`,
      [doctorId, date, startTime || null, endTime || null]
    );
    if (affected.rows.length && !startTime) {
      // whole-day block with live bookings: caller must decline/move them first
      return res.status(409).json({
        error: {
          code: 'APPOINTMENTS_EXIST',
          message:
            'This day still has booked appointments. Reschedule or decline them before blocking the whole day.',
          details: { appointments: affected.rows },
          requestId: req.id,
        },
      });
    }
    if (affected.rows.length) {
      return res.status(409).json({
        error: {
          code: 'APPOINTMENTS_EXIST',
          message: 'That window still has booked appointments. Move them before blocking it.',
          details: { appointments: affected.rows },
          requestId: req.id,
        },
      });
    }
  }

  const created = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO schedule_overrides (doctor_id, override_date, is_available, start_time, end_time, reason)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (doctor_id, override_date, start_time)
       DO UPDATE SET is_available = EXCLUDED.is_available,
                     end_time = EXCLUDED.end_time,
                     reason = EXCLUDED.reason
       RETURNING *`,
      [doctorId, date, isAvailable, startTime || null, endTime || null, reason]
    );

    await audit(
      req,
      {
        action: ACTIONS.SCHEDULE_OVERRIDE_CREATED,
        entityType: 'schedule_override',
        entityId: rows[0].id,
        metadata: { date, isAvailable, startTime, endTime, reason },
      },
      client
    );
    return rows[0];
  });

  const regeneration = await engine.ensureSlotsForDate(doctorId, date);
  publishSlotChange({
    doctorId,
    slotId: null,
    slotDate: date,
    status: isAvailable ? 'open' : 'blocked',
    reason: 'override',
  });

  res.status(201).json({ override: created, regenerated });
});

const deleteOverride = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const row = await queryOne(
    `SELECT * FROM schedule_overrides WHERE id = $1 AND doctor_id = $2`,
    [req.params.id, doctorId]
  );
  if (!row) throw ApiError.notFound('Override not found.');

  await query(`DELETE FROM schedule_overrides WHERE id = $1`, [row.id]);
  await audit(req, {
    action: ACTIONS.SCHEDULE_OVERRIDE_DELETED,
    entityType: 'schedule_override',
    entityId: row.id,
    metadata: { date: row.override_date, isAvailable: row.is_available },
  });

  await engine.ensureSlotsForDate(doctorId, row.override_date);
  publishSlotChange({
    doctorId,
    slotId: null,
    slotDate: row.override_date,
    status: 'open',
    reason: 'override_removed',
  });

  res.json({ ok: true, date: row.override_date });
});

// ---------------------------------------------------------------------------
// Appointment queue
// ---------------------------------------------------------------------------
const listAppointments = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const { date, view, status, limit } = req.query;

  const conditions = ['a.doctor_id = $1'];
  const params = [doctorId];

  if (view === 'day') {
    // `date` is optional, so default to today in the app timezone. Binding NULL
    // here would compare scheduled_date against NULL and silently return an
    // empty queue for a doctor who is fully booked.
    params.push(date || todayInTz(config.appTz));
    conditions.push(`a.scheduled_date = $${params.length}::date`);
  } else if (view === 'upcoming') {
    conditions.push(`a.scheduled_for >= now() AND a.status IN ('pending','scheduled')`);
  }

  if (status === 'active') {
    conditions.push(`a.status IN ('pending','scheduled')`);
  } else if (status) {
    params.push(status);
    conditions.push(`a.status = $${params.length}`);
  }

  params.push(limit);

  const { rows } = await query(
    `${APPOINTMENT_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.scheduled_for ASC
      LIMIT $${params.length}`,
    params
  );

  // Break-glass logging: this list carries symptoms and contact details.
  if (rows.length) {
    await audit(req, {
      action: ACTIONS.SYMPTOMS_VIEWED,
      entityType: 'appointment',
      metadata: {
        view,
        date: date || null,
        count: rows.length,
        patientIds: [...new Set(rows.map((r) => r.patient_id))].slice(0, 25),
      },
    });
  }

  res.json({ appointments: rows, view, date: date || null });
});

const getAppointment = asyncHandler(async (req, res) => {
  const appointment = await loadOwnedAppointment(req, req.params.id, 'doctor');
  const detail = await queryOne(`${APPOINTMENT_SELECT} WHERE a.id = $1`, [appointment.id]);
  const intake = await queryOne(
    `SELECT id, medical_history, current_medications, status, submitted_via, submitted_at, updated_at
       FROM pre_consultation_intake WHERE appointment_id = $1`,
    [appointment.id]
  );

  await audit(req, {
    action: ACTIONS.SYMPTOMS_VIEWED,
    entityType: 'appointment',
    entityId: appointment.id,
    patientId: appointment.patient_id,
    metadata: { view: 'detail', intake: Boolean(intake) },
  });

  res.json({ appointment: detail, intake });
});

/**
 * GET /api/doctor/appointments/:id/intake — the pre-consultation form the
 * patient filled in through chat. Reading it is a break-glass visibility event
 * like any other read of a patient's clinical detail, so it is audited with
 * INTAKE_VIEWED.
 */
const getAppointmentIntake = asyncHandler(async (req, res) => {
  const appointment = await loadOwnedAppointment(req, req.params.id, 'doctor');

  const intake = await queryOne(
    `SELECT i.id, i.appointment_id, i.medical_history, i.current_medications,
            i.status, i.submitted_via, i.submitted_at, i.updated_at,
            p.full_name AS patient_name
       FROM pre_consultation_intake i
       JOIN users p ON p.id = i.patient_id
      WHERE i.appointment_id = $1 AND i.doctor_id = $2`,
    [appointment.id, req.user.id]
  );

  await audit(req, {
    action: ACTIONS.INTAKE_VIEWED,
    entityType: 'pre_consultation_intake',
    entityId: intake ? intake.id : appointment.id,
    patientId: appointment.patient_id,
    metadata: { appointmentId: appointment.id, found: Boolean(intake) },
  });

  if (!intake) throw ApiError.notFound('No intake form has been submitted for this appointment.');
  res.json({ intake });
});

/** pending -> scheduled */
const acceptAppointment = asyncHandler(async (req, res) => {
  const appointment = await loadOwnedAppointment(req, req.params.id, 'doctor');
  if (appointment.status !== 'pending') {
    throw ApiError.conflict(`Only a pending appointment can be accepted (it is '${appointment.status}').`);
  }

  const updated = await queryOne(
    `UPDATE appointments SET status = 'scheduled', accepted_at = now()
      WHERE id = $1 RETURNING *`,
    [appointment.id]
  );

  await audit(req, {
    action: ACTIONS.APPOINTMENT_ACCEPTED,
    entityType: 'appointment',
    entityId: appointment.id,
    patientId: appointment.patient_id,
    metadata: { scheduledFor: appointment.scheduled_for },
  });

  res.json({ appointment: updated });
});

/** pending|scheduled -> cancelled_by_doctor, slot released, waitlist notified */
const declineAppointment = asyncHandler(async (req, res) => {
  const appointment = await loadOwnedAppointment(req, req.params.id, 'doctor');

  const result = await engine.cancelAppointment({
    req,
    appointmentId: appointment.id,
    reason: req.body.reason || 'Declined by doctor',
    actorRole: 'doctor',
  });

  res.json({ appointment: result.appointment, waitlistFilled: Boolean(result.filled) });
});

/** scheduled -> completed (opens the verified-review window) */
const completeAppointment = asyncHandler(async (req, res) => {
  const appointment = await loadOwnedAppointment(req, req.params.id, 'doctor');
  if (appointment.status !== 'scheduled') {
    throw ApiError.conflict(`Only a scheduled appointment can be completed (it is '${appointment.status}').`);
  }
  if (new Date(appointment.scheduled_for) > new Date()) {
    throw ApiError.conflict('This appointment has not started yet.');
  }

  const updated = await queryOne(
    `UPDATE appointments SET status = 'completed', completed_at = now(), doctor_note = $2
      WHERE id = $1 RETURNING *`,
    [appointment.id, req.body.note || appointment.doctor_note]
  );

  await audit(req, {
    action: ACTIONS.APPOINTMENT_COMPLETED,
    entityType: 'appointment',
    entityId: appointment.id,
    patientId: appointment.patient_id,
    metadata: { scheduledFor: appointment.scheduled_for, hasNote: Boolean(req.body.note) },
  });

  res.json({ appointment: updated });
});

/** scheduled -> no_show */
const noShow = asyncHandler(async (req, res) => {
  const appointment = await loadOwnedAppointment(req, req.params.id, 'doctor');
  if (appointment.status !== 'scheduled') {
    throw ApiError.conflict(`Only a scheduled appointment can be marked no-show (it is '${appointment.status}').`);
  }

  const updated = await queryOne(
    `UPDATE appointments SET status = 'no_show' WHERE id = $1 RETURNING *`,
    [appointment.id]
  );

  await audit(req, {
    action: ACTIONS.APPOINTMENT_NO_SHOW,
    entityType: 'appointment',
    entityId: appointment.id,
    patientId: appointment.patient_id,
    metadata: { scheduledFor: appointment.scheduled_for },
  });

  res.json({ appointment: updated });
});

/** Move an existing appointment to another free slot (doctor-initiated). */
const rescheduleAppointment = asyncHandler(async (req, res) => {
  const appointment = await loadOwnedAppointment(req, req.params.id, 'doctor');

  const result = await engine.rescheduleAppointment({
    req,
    appointmentId: appointment.id,
    newSlotId: req.body.slotId,
    actorRole: 'doctor',
    reason: req.body.reason,
  });

  res.json({ appointment: result.appointment, waitlistFilled: Boolean(result.filled) });
});

// ---------------------------------------------------------------------------
// Waitlist + reviews + profile
// ---------------------------------------------------------------------------
const waitlistQueue = asyncHandler(async (req, res) => {
  const entries = await waitlist.queueForDoctor(req.user.id);
  res.json({ entries });
});

const reviews = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const status = req.query.status;

  const { rows } = await query(
    `SELECT r.id, r.rating, r.comment, r.status, r.created_at, r.moderation_note,
            a.scheduled_date AS visited_on,
            regexp_replace(p.full_name, '\\s.*$', '') AS patient_first_name
       FROM reviews r
       JOIN users p ON p.id = r.patient_id
       JOIN appointments a ON a.id = r.appointment_id
      WHERE r.doctor_id = $1 AND ($2::text IS NULL OR r.status = $2)
      ORDER BY r.created_at DESC
      LIMIT 100`,
    [doctorId, status || null]
  );

  const stats = await queryOne(
    `SELECT COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
            COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            COALESCE(AVG(rating) FILTER (WHERE status = 'approved'), 0)::float AS average
       FROM reviews WHERE doctor_id = $1`,
    [doctorId]
  );

  res.json({ reviews: rows, stats });
});

const updateProfile = asyncHandler(async (req, res) => {
  const fields = [];
  const params = [req.user.id];
  const map = {
    acceptingNewPatients: 'accepting_new_patients',
    bio: 'bio',
    consultationFee: 'consultation_fee',
    clinicName: 'clinic_name',
    city: 'city',
    languages: 'languages',
  };

  for (const [key, column] of Object.entries(map)) {
    if (req.body[key] !== undefined) {
      params.push(req.body[key]);
      fields.push(`${column} = $${params.length}`);
    }
  }
  if (!fields.length) throw ApiError.badRequest('Nothing to update.');

  const updated = await queryOne(
    `UPDATE doctor_profiles SET ${fields.join(', ')} WHERE user_id = $1 RETURNING *`,
    params
  );

  await audit(req, {
    action: 'doctor.profile_updated',
    entityType: 'doctor_profile',
    entityId: req.user.id,
    metadata: { fields: Object.keys(req.body) },
  });

  res.json({ profile: updated });
});

module.exports = {
  dashboard,
  getSchedule,
  upsertSchedule,
  deleteSchedule,
  createOverride,
  deleteOverride,
  listAppointments,
  getAppointment,
  getAppointmentIntake,
  acceptAppointment,
  declineAppointment,
  completeAppointment,
  noShow,
  rescheduleAppointment,
  waitlistQueue,
  reviews,
  updateProfile,
  schemas: {
    scheduleSchema,
    overrideSchema,
    listSchema,
    acceptSchema,
    declineSchema,
    completeSchema,
    doctorRescheduleSchema,
    profileSchema,
  },
};
