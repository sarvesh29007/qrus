'use strict';

/**
 * Admin console API: user access management, the immutable audit trail,
 * review moderation and waitlist maintenance.
 * Every route behind this controller requires role = 'admin'.
 */

const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query, queryOne, withTransaction } = require('../config/db');
const { ApiError, asyncHandler } = require('../utils/errors');
const { audit, ACTIONS } = require('../services/audit.service');
const waitlist = require('../services/waitlistQueue');

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const listUsersSchema = z.object({
  role: z.enum(['patient', 'doctor', 'admin']).optional(),
  status: z.enum(['active', 'pending', 'suspended']).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const statusSchema = z.object({
  status: z.enum(['active', 'pending', 'suspended']),
  reason: z.string().trim().max(300).default(''),
});

const roleSchema = z.object({ role: z.enum(['patient', 'doctor', 'admin']) });

const createUserSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional(),
  role: z.enum(['patient', 'doctor', 'admin']),
  specialtyId: z.coerce.number().int().positive().optional(),
  licenseNumber: z.string().trim().min(3).max(60).optional(),
  yearsExperience: z.coerce.number().int().min(0).max(60).optional(),
  consultationFee: z.coerce.number().min(0).max(100000).optional(),
  clinicName: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
});

const auditSchema = z.object({
  action: z.string().trim().max(60).optional(),
  actorId: z.coerce.number().int().positive().optional(),
  patientId: z.coerce.number().int().positive().optional(),
  entityType: z.string().trim().max(40).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const moderationSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).default(''),
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
const stats = asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*) FROM users)::int AS total_users,
      (SELECT COUNT(*) FROM users WHERE role = 'patient')::int AS patients,
      (SELECT COUNT(*) FROM users WHERE role = 'doctor')::int AS doctors,
      (SELECT COUNT(*) FROM users WHERE status = 'pending')::int AS pending_approvals,
      (SELECT COUNT(*) FROM users WHERE status = 'suspended')::int AS suspended,
      (SELECT COUNT(*) FROM appointments WHERE status IN ('pending','scheduled'))::int AS active_appointments,
      (SELECT COUNT(*) FROM appointments WHERE scheduled_date = CURRENT_DATE)::int AS appointments_today,
      (SELECT COUNT(*) FROM appointments WHERE status = 'completed')::int AS completed_appointments,
      (SELECT COUNT(*) FROM appointments WHERE status LIKE 'cancelled%')::int AS cancelled_appointments,
      (SELECT COUNT(*) FROM waitlist_entries WHERE status = 'waiting')::int AS waiting,
      (SELECT COUNT(*) FROM reviews WHERE status = 'pending')::int AS pending_reviews,
      (SELECT COUNT(*) FROM reviews WHERE status = 'approved')::int AS approved_reviews,
      (SELECT COUNT(*) FROM audit_logs WHERE created_at > now() - interval '24 hours')::int AS audit_last_24h
  `);

  const recentAudit = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.outcome, a.created_at,
            a.actor_role, u.full_name AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC
      LIMIT 8`
  );

  res.json({ stats: rows[0], recentAudit: recentAudit.rows });
});

// ---------------------------------------------------------------------------
// User access management
// ---------------------------------------------------------------------------
const listUsers = asyncHandler(async (req, res) => {
  const { role, status, q, page, limit } = req.query;

  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.status,
            u.created_at, u.last_login_at,
            s.name AS specialty_name,
            dp.license_number, dp.city, dp.rating_avg, dp.rating_count,
            (SELECT COUNT(*) FROM appointments ap WHERE ap.patient_id = u.id)::int AS patient_appointments,
            (SELECT COUNT(*) FROM appointments ap WHERE ap.doctor_id = u.id)::int AS doctor_appointments
       FROM users u
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
       LEFT JOIN specialties s ON s.id = dp.specialty_id
      WHERE ($1::text IS NULL OR u.role = $1)
        AND ($2::text IS NULL OR u.status = $2)
        AND ($3::text IS NULL OR u.full_name ILIKE '%' || $3 || '%' OR u.email ILIKE '%' || $3 || '%')
      ORDER BY u.created_at DESC
      LIMIT $4 OFFSET $5`,
    [role || null, status || null, q || null, limit, (page - 1) * limit]
  );

  const counts = await query(
    `SELECT role, status, COUNT(*)::int AS count FROM users GROUP BY role, status`
  );

  res.json({ users: rows, page, limit, counts: counts.rows });
});

const createUser = asyncHandler(async (req, res) => {
  const body = req.body;

  const existing = await queryOne(`SELECT id FROM users WHERE lower(email) = lower($1)`, [
    body.email,
  ]);
  if (existing) throw ApiError.conflict('An account with that email already exists.');

  if (body.role === 'doctor' && (!body.specialtyId || !body.licenseNumber)) {
    throw ApiError.badRequest('Doctor accounts need a specialty and a license number.');
  }

  const passwordHash = await bcrypt.hash(body.password, 12);

  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, full_name, phone, role, status)
       VALUES ($1,$2,$3,$4,$5,'active')
       RETURNING id, email, full_name, role, status, created_at`,
      [body.email.toLowerCase(), passwordHash, body.fullName, body.phone || null, body.role]
    );
    const created = rows[0];

    if (body.role === 'doctor') {
      await client.query(
        `INSERT INTO doctor_profiles
           (user_id, specialty_id, license_number, years_experience, consultation_fee, clinic_name, city)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          created.id,
          body.specialtyId,
          body.licenseNumber,
          body.yearsExperience || 0,
          body.consultationFee || 0,
          body.clinicName || null,
          body.city || null,
        ]
      );
    }

    await audit(
      req,
      {
        action: ACTIONS.USER_REGISTERED,
        entityType: 'user',
        entityId: created.id,
        metadata: { role: created.role, provisionedBy: 'admin' },
      },
      client
    );

    return created;
  });

  res.status(201).json({ user });
});

const updateUserStatus = asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  const { status, reason } = req.body;

  if (targetId === req.user.id && status !== 'active') {
    throw ApiError.badRequest('You cannot suspend or deactivate your own account.');
  }

  const target = await queryOne(`SELECT id, role, status FROM users WHERE id = $1`, [targetId]);
  if (!target) throw ApiError.notFound('User not found.');

  const updated = await queryOne(
    `UPDATE users SET status = $2 WHERE id = $1 RETURNING id, email, full_name, role, status`,
    [targetId, status]
  );

  // A suspended account must lose its live sessions immediately, not when its
  // access token happens to expire.
  if (status !== 'active') {
    await query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [targetId]
    );
  }

  await audit(req, {
    action: ACTIONS.USER_STATUS_CHANGED,
    entityType: 'user',
    entityId: targetId,
    metadata: { from: target.status, to: status, reason, targetRole: target.role },
  });

  res.json({ user: updated });
});

const updateUserRole = asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  const { role } = req.body;

  if (targetId === req.user.id) throw ApiError.badRequest('You cannot change your own role.');

  const target = await queryOne(`SELECT id, role FROM users WHERE id = $1`, [targetId]);
  if (!target) throw ApiError.notFound('User not found.');

  const updated = await queryOne(
    `UPDATE users SET role = $2 WHERE id = $1 RETURNING id, email, full_name, role, status`,
    [targetId, role]
  );

  await query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [targetId]
  );

  await audit(req, {
    action: ACTIONS.USER_ROLE_CHANGED,
    entityType: 'user',
    entityId: targetId,
    metadata: { from: target.role, to: role },
  });

  res.json({ user: updated });
});

// ---------------------------------------------------------------------------
// Audit trail (read-only; the table itself forbids UPDATE/DELETE)
// ---------------------------------------------------------------------------
const auditLogs = asyncHandler(async (req, res) => {
  const { action, actorId, patientId, entityType, outcome, from, to, page, limit } = req.query;

  const { rows } = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.outcome, a.metadata,
            a.ip_address, a.user_agent, a.request_id, a.created_at,
            a.actor_id, a.actor_role, u.full_name AS actor_name, u.email AS actor_email,
            a.patient_id, pu.full_name AS patient_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN users pu ON pu.id = a.patient_id
      WHERE ($1::text  IS NULL OR a.action = $1)
        AND ($2::bigint IS NULL OR a.actor_id = $2)
        AND ($3::bigint IS NULL OR a.patient_id = $3)
        AND ($4::text  IS NULL OR a.entity_type = $4)
        AND ($5::text  IS NULL OR a.outcome = $5)
        AND ($6::date  IS NULL OR a.created_at >= $6::date)
        AND ($7::date  IS NULL OR a.created_at <  ($7::date + interval '1 day'))
      ORDER BY a.created_at DESC
      LIMIT $8 OFFSET $9`,
    [
      action || null,
      actorId || null,
      patientId || null,
      entityType || null,
      outcome || null,
      from || null,
      to || null,
      limit,
      (page - 1) * limit,
    ]
  );

  const total = await queryOne(`SELECT COUNT(*)::int AS count FROM audit_logs`);
  const actions = await query(
    `SELECT action, COUNT(*)::int AS count FROM audit_logs
      GROUP BY action ORDER BY count DESC LIMIT 30`
  );

  res.json({ logs: rows, total: total.count, page, limit, knownActions: actions.rows });
});

// ---------------------------------------------------------------------------
// Review moderation  (also recalculates the doctor's public rating)
// ---------------------------------------------------------------------------
const listReviews = asyncHandler(async (req, res) => {
  const status = req.query.status || null;

  const { rows } = await query(
    `SELECT r.id, r.rating, r.comment, r.status, r.created_at, r.moderation_note,
            r.appointment_id, r.moderated_at,
            d.id AS doctor_id, d.full_name AS doctor_name,
            p.id AS patient_id, p.full_name AS patient_name,
            sp.name AS specialty_name, a.scheduled_date AS visited_on
       FROM reviews r
       JOIN users d ON d.id = r.doctor_id
       JOIN users p ON p.id = r.patient_id
       JOIN appointments a ON a.id = r.appointment_id
       JOIN specialties sp ON sp.id = a.specialty_id
      WHERE ($1::text IS NULL OR r.status = $1)
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC
      LIMIT 200`,
    [status]
  );

  const counts = await query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(AVG(rating),0)::float AS average
       FROM reviews GROUP BY status`
  );

  res.json({ reviews: rows, counts: counts.rows });
});

const moderateReview = asyncHandler(async (req, res) => {
  const reviewId = Number(req.params.id);
  const { status, note } = req.body;

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM reviews WHERE id = $1 FOR UPDATE`, [
      reviewId,
    ]);
    const review = rows[0];
    if (!review) throw ApiError.notFound('Review not found.');
    if (review.status === status) {
      throw ApiError.conflict(`Review is already '${status}'.`);
    }

    const { rows: updated } = await client.query(
      `UPDATE reviews
          SET status = $2, moderation_note = $3, moderated_by = $4, moderated_at = now()
        WHERE id = $1
        RETURNING *`,
      [reviewId, status, note || null, req.user.id]
    );

    // Public rating reflects approved reviews only.
    await client.query(
      `UPDATE doctor_profiles dp
          SET rating_avg = sub.avg_rating, rating_count = sub.rating_count
         FROM (SELECT COALESCE(AVG(rating), 0)::numeric(3,2) AS avg_rating,
                      COUNT(*)::int AS rating_count
                 FROM reviews WHERE doctor_id = $2 AND status = 'approved') sub
        WHERE dp.user_id = $1`,
      [review.doctor_id, review.doctor_id]
    );

    await audit(
      req,
      {
        action: ACTIONS.REVIEW_MODERATED,
        entityType: 'review',
        entityId: reviewId,
        patientId: review.patient_id,
        metadata: { from: review.status, to: status, doctorId: review.doctor_id, note: note || '' },
      },
      client
    );

    return updated[0];
  });

  res.json({ review: result });
});

// ---------------------------------------------------------------------------
// Waitlist maintenance
// ---------------------------------------------------------------------------
const sweepWaitlist = asyncHandler(async (req, res) => {
  const matched = await waitlist.sweep({ req, limit: 100 });
  const expired = await waitlist.expireStale();

  res.json({
    matched: matched.map((m) => ({
      entryId: m.entryId,
      appointmentId: m.appointment.id,
      patientId: m.patientId,
      scheduledFor: m.appointment.scheduled_for,
    })),
    matchedCount: matched.length,
    expiredCount: expired,
  });
});

module.exports = {
  stats,
  listUsers,
  createUser,
  updateUserStatus,
  updateUserRole,
  auditLogs,
  listReviews,
  moderateReview,
  sweepWaitlist,
  schemas: {
    listUsersSchema,
    statusSchema,
    roleSchema,
    createUserSchema,
    auditSchema,
    moderationSchema,
  },
};
