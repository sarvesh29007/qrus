'use strict';

/**
 * Patient portal API: appointments, waitlist membership and verified reviews.
 * Every handler assumes `authenticate` + `requireRole('patient')` already ran
 * (wired in routes/patient.routes.js) and every resource access is re-checked
 * against req.user so a valid token still cannot reach someone else's record.
 */

const { z } = require('zod');
const { query, queryOne, withTransaction } = require('../config/db');
const { ApiError, asyncHandler } = require('../utils/errors');
const { loadOwnedAppointment } = require('../middleware/rbac');
const engine = require('../services/schedulingEngine');
const waitlist = require('../services/waitlistQueue');
const { audit, ACTIONS } = require('../services/audit.service');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const idParam = z.object({ id: z.coerce.number().int().positive() });

const createAppointmentSchema = z.object({
  slotId: z.coerce.number().int().positive(),
  reason: z.string().trim().max(500).default(''),
  symptoms: z.string().trim().max(2000).default(''),
});

const cancelSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

const rescheduleSchema = z.object({
  slotId: z.coerce.number().int().positive(),
  reason: z.string().trim().max(300).optional(),
});

const listAppointmentsSchema = z.object({
  view: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const joinWaitlistSchema = z
  .object({
    doctorId: z.coerce.number().int().positive().optional(),
    specialtyId: z.coerce.number().int().positive().optional(),
    symptoms: z.string().trim().min(2).max(2000),
    urgency: z.enum(['routine', 'soon', 'urgent']).default('routine'),
    preferredDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    preferredDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    preferredStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    preferredEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  })
  .refine((v) => v.doctorId || v.specialtyId, {
    message: 'Choose a doctor or a specialty to waitlist for.',
  })
  .refine(
    (v) => !v.preferredDateFrom || !v.preferredDateTo || v.preferredDateTo >= v.preferredDateFrom,
    { message: 'The end date must be on or after the start date.' }
  );

const createReviewSchema = z.object({
  appointmentId: z.coerce.number().int().positive(),
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1200).default(''),
});

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
const listAppointments = asyncHandler(async (req, res) => {
  const { view, limit } = req.query;
  const now = new Date().toISOString();

  const statusFilter =
    view === 'upcoming'
      ? `AND a.status IN ('pending','scheduled') AND a.scheduled_for >= now()`
      : view === 'past'
        ? `AND (a.scheduled_for < now() OR a.status NOT IN ('pending','scheduled'))`
        : '';

  const { rows } = await query(
    `SELECT a.id, a.status, a.reason, a.symptoms, a.scheduled_for, a.scheduled_date,
            a.scheduled_time, a.created_at, a.cancellation_reason, a.reschedule_count,
            a.completed_at, a.accepted_at,
            d.id AS doctor_id, d.full_name AS doctor_name,
            sp.id AS specialty_id, sp.name AS specialty_name, sp.slug AS specialty_slug,
            dp.clinic_name, dp.city, dp.consultation_fee,
            rv.id AS review_id, rv.status AS review_status,
            (a.scheduled_for > now()) AS is_future
       FROM appointments a
       JOIN users d ON d.id = a.doctor_id
       JOIN specialties sp ON sp.id = a.specialty_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = a.doctor_id
       LEFT JOIN reviews rv ON rv.appointment_id = a.id
      WHERE a.patient_id = $1 ${statusFilter}
      ORDER BY a.scheduled_for ${view === 'upcoming' ? 'ASC' : 'DESC'}
      LIMIT $2`,
    [req.user.id, limit]
  );

  res.json({ appointments: rows, view, now });
});

const getAppointment = asyncHandler(async (req, res) => {
  const appointment = await loadOwnedAppointment(req, req.params.id, 'patient');

  const detail = await queryOne(
    `SELECT a.*, d.full_name AS doctor_name, sp.name AS specialty_name,
            sp.slug AS specialty_slug, dp.clinic_name, dp.city, dp.consultation_fee,
            s.starts_at AS slot_start, s.ends_at AS slot_end,
            rv.id AS review_id, rv.status AS review_status, rv.rating AS review_rating
       FROM appointments a
       JOIN users d ON d.id = a.doctor_id
       JOIN specialties sp ON sp.id = a.specialty_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = a.doctor_id
       LEFT JOIN appointment_slots s ON s.id = a.slot_id
       LEFT JOIN reviews rv ON rv.appointment_id = a.id
      WHERE a.id = $1`,
    [appointment.id]
  );

  res.json({ appointment: detail });
});

const createAppointment = asyncHandler(async (req, res) => {
  const appointment = await engine.bookAppointment({
    req,
    patientId: req.user.id,
    slotId: req.body.slotId,
    reason: req.body.reason,
    symptoms: req.body.symptoms,
  });

  res.status(201).json({ appointment });
});

const cancelAppointment = asyncHandler(async (req, res) => {
  const existing = await loadOwnedAppointment(req, req.params.id, 'patient');

  const result = await engine.cancelAppointment({
    req,
    appointmentId: existing.id,
    reason: req.body.reason,
    actorRole: 'patient',
  });

  res.json({
    appointment: result.appointment,
    waitlistFilled: Boolean(result.filled),
    filledForPatientId: result.filled?.patientId ?? null,
  });
});

const rescheduleAppointment = asyncHandler(async (req, res) => {
  const existing = await loadOwnedAppointment(req, req.params.id, 'patient');

  const result = await engine.rescheduleAppointment({
    req,
    appointmentId: existing.id,
    newSlotId: req.body.slotId,
    actorRole: 'patient',
    reason: req.body.reason,
  });

  res.json({ appointment: result.appointment, waitlistFilled: Boolean(result.filled) });
});

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------
const myWaitlist = asyncHandler(async (req, res) => {
  const entries = await waitlist.myEntries(req.user.id);
  res.json({ entries });
});

const joinWaitlist = asyncHandler(async (req, res) => {
  const result = await waitlist.joinWaitlist({ req, patientId: req.user.id, input: req.body });
  res.status(201).json({
    entry: result.entry,
    matchedImmediately: Boolean(result.immediateAppointment),
    appointment: result.immediateAppointment || null,
    message: result.immediateAppointment
      ? 'Good news — a slot was already free and has been booked for you.'
      : 'You are on the waitlist. We will book you automatically as soon as a slot opens.',
  });
});

const leaveWaitlist = asyncHandler(async (req, res) => {
  const entry = await waitlist.leaveWaitlist({
    req,
    patientId: req.user.id,
    entryId: req.params.id,
  });
  res.json({ entry });
});

// ---------------------------------------------------------------------------
// Reviews  (verified: completed appointment only, one per appointment)
// ---------------------------------------------------------------------------
const createReview = asyncHandler(async (req, res) => {
  const { appointmentId, rating, comment } = req.body;

  const review = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT a.id, a.patient_id, a.doctor_id, a.status, a.scheduled_for,
              (r.id IS NOT NULL) AS already_reviewed
         FROM appointments a
         LEFT JOIN reviews r ON r.appointment_id = a.id
        WHERE a.id = $1 AND a.patient_id = $2`,
      [appointmentId, req.user.id]
    );
    const appointment = rows[0];

    // 404 rather than 403: a patient must not be able to probe other ids.
    if (!appointment) throw ApiError.notFound('Appointment not found.');

    if (appointment.already_reviewed) {
      throw ApiError.conflict('You have already reviewed this appointment.');
    }

    if (appointment.status !== 'completed' || new Date(appointment.scheduled_for) > new Date()) {
      throw new ApiError(
        403,
        'REVIEW_NOT_VERIFIED',
        'You can only review a doctor after the appointment has been completed.'
      );
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO reviews (doctor_id, patient_id, appointment_id, rating, comment, status)
       VALUES ($1,$2,$3,$4,$5,'pending')
       RETURNING *`,
      [appointment.doctor_id, appointment.patient_id, appointment.id, rating, comment]
    );

    await audit(
      req,
      {
        action: ACTIONS.REVIEW_CREATED,
        entityType: 'review',
        entityId: inserted[0].id,
        patientId: appointment.patient_id,
        metadata: { doctorId: appointment.doctor_id, appointmentId, rating },
      },
      client
    );

    return inserted[0];
  });

  res.status(201).json({
    review,
    message: 'Thanks! Your review is verified and will appear once an administrator approves it.',
  });
});

/** Appointments that are completed and still unreviewed — the review CTA list. */
const reviewableAppointments = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.scheduled_date, a.scheduled_for, d.id AS doctor_id,
            d.full_name AS doctor_name, sp.name AS specialty_name
       FROM appointments a
       JOIN users d ON d.id = a.doctor_id
       JOIN specialties sp ON sp.id = a.specialty_id
      WHERE a.patient_id = $1
        AND a.status = 'completed'
        AND a.scheduled_for <= now()
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id)
      ORDER BY a.scheduled_for DESC
      LIMIT 50`,
    [req.user.id]
  );
  res.json({ appointments: rows });
});

const myReviews = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.rating, r.comment, r.status, r.created_at, r.moderation_note,
            a.id AS appointment_id, a.scheduled_date,
            d.id AS doctor_id, d.full_name AS doctor_name, sp.name AS specialty_name
       FROM reviews r
       JOIN appointments a ON a.id = r.appointment_id
       JOIN users d ON d.id = r.doctor_id
       JOIN specialties sp ON sp.id = a.specialty_id
      WHERE r.patient_id = $1
      ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.json({ reviews: rows });
});

/** Public, approved-only reviews for a doctor (never exposes patient ids). */
const publicDoctorReviews = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 10, 50);

  const { rows } = await query(
    `SELECT r.id, r.rating, r.comment, r.created_at,
            regexp_replace(p.full_name, '\\s.*$', '') AS patient_first_name,
            a.scheduled_date AS visited_on
       FROM reviews r
       JOIN users p ON p.id = r.patient_id
       JOIN appointments a ON a.id = r.appointment_id
      WHERE r.doctor_id = $1 AND r.status = 'approved'
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3`,
    [req.params.doctorId, limit, (page - 1) * limit]
  );

  const stats = await queryOne(
    `SELECT COUNT(*)::int AS count, COALESCE(AVG(rating), 0)::float AS average
       FROM reviews WHERE doctor_id = $1 AND status = 'approved'`,
    [req.params.doctorId]
  );

  res.json({ reviews: rows, stats });
});

module.exports = {
  listAppointments,
  getAppointment,
  createAppointment,
  cancelAppointment,
  rescheduleAppointment,
  myWaitlist,
  joinWaitlist,
  leaveWaitlist,
  createReview,
  reviewableAppointments,
  myReviews,
  publicDoctorReviews,
  schemas: {
    idParam,
    createAppointmentSchema,
    cancelSchema,
    rescheduleSchema,
    listAppointmentsSchema,
    joinWaitlistSchema,
    createReviewSchema,
  },
};
