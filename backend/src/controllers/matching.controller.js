'use strict';

const { z } = require('zod');
const { query, queryOne } = require('../config/db');
const { ApiError, asyncHandler } = require('../utils/errors');
const { matchSymptoms } = require('../services/symptomMatcher');
const { availabilitySummary, getDaySlots } = require('../services/schedulingEngine');

const matchSchema = z.object({
  symptoms: z
    .union([z.string().trim().min(2).max(1200), z.array(z.string().trim().min(1).max(200)).min(1).max(20)])
    .refine(
      (v) => (Array.isArray(v) ? v.join(' ').length >= 2 : v.length >= 2),
      'Describe your symptoms in at least a couple of words.'
    ),
  includeTriage: z.coerce.boolean().default(true),
});

const searchSchema = z.object({
  specialtyId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sort: z.enum(['rating', 'experience', 'fee']).default('rating'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  availabilityDays: z.coerce.number().int().min(1).max(30).default(14),
});

// ---------------------------------------------------------------------------
// POST /api/match/symptoms  — intelligent symptom -> specialty routing
// ---------------------------------------------------------------------------
const match = asyncHandler(async (req, res) => {
  const { symptoms, includeTriage } = req.body;
  const result = await matchSymptoms(symptoms, { withTriage: includeTriage });
  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/specialties
// ---------------------------------------------------------------------------
const specialties = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.slug, s.name, s.description, s.icon,
            COUNT(r.id)::int AS rule_count,
            COUNT(dp.user_id)::int AS doctor_count
       FROM specialties s
       LEFT JOIN symptom_rules r ON r.specialty_id = s.id AND r.is_active
       LEFT JOIN doctor_profiles dp ON dp.specialty_id = s.id
       LEFT JOIN users u ON u.id = dp.user_id AND u.status = 'active'
      WHERE s.is_active
      GROUP BY s.id
      ORDER BY s.name`
  );
  res.json({ specialties: rows });
});

// ---------------------------------------------------------------------------
// GET /api/doctors  — directory search with availability summary
// ---------------------------------------------------------------------------
const searchDoctors = asyncHandler(async (req, res) => {
  const { specialtyId, q, city, minRating, sort, page, limit, availabilityDays } = req.query;

  const orderBy = {
    rating: 'dp.rating_avg DESC NULLS LAST, dp.rating_count DESC, u.full_name ASC',
    experience: 'dp.years_experience DESC, dp.rating_avg DESC NULLS LAST',
    fee: 'dp.consultation_fee ASC, dp.rating_avg DESC NULLS LAST',
  }[sort];

  const { rows } = await query(
    `SELECT u.id, u.full_name AS name, dp.bio, dp.clinic_name, dp.city,
            dp.years_experience, dp.consultation_fee, dp.rating_avg, dp.rating_count,
            dp.accepting_new_patients, dp.languages,
            s.id AS specialty_id, s.name AS specialty_name, s.slug AS specialty_slug,
            s.icon AS specialty_icon,
            (SELECT COUNT(*) FROM reviews rv
              WHERE rv.doctor_id = u.id AND rv.status = 'approved')::int AS approved_reviews
       FROM doctor_profiles dp
       JOIN users u ON u.id = dp.user_id
       JOIN specialties s ON s.id = dp.specialty_id
      WHERE u.status = 'active'
        AND ($1::bigint IS NULL OR dp.specialty_id = $1)
        AND ($2::text    IS NULL OR u.full_name ILIKE '%' || $2 || '%'
                               OR dp.clinic_name ILIKE '%' || $2 || '%')
        AND ($3::text    IS NULL OR lower(dp.city) = lower($3))
        AND ($4::numeric IS NULL OR dp.rating_avg >= $4)
      ORDER BY ${orderBy}
      LIMIT $5 OFFSET $6`,
    [specialtyId || null, q || null, city || null, minRating ?? null, limit, (page - 1) * limit]
  );

  const doctors = await Promise.all(
    rows.map(async (doctor) => {
      const summary = await availabilitySummary(doctor.id, { days: availabilityDays });
      const nextAvailable = summary.find((d) => d.open > 0) || null;
      return {
        ...doctor,
        nextAvailableDate: nextAvailable?.date || null,
        openDays: summary.filter((d) => d.open > 0).length,
        nextSevenDays: summary.slice(0, 7),
      };
    })
  );

  res.json({ doctors, page, limit, sort });
});

// ---------------------------------------------------------------------------
// GET /api/doctors/:doctorId  — profile, upcoming availability, public reviews
// ---------------------------------------------------------------------------
const doctorDetail = asyncHandler(async (req, res) => {
  const { doctorId } = req.params;

  const doctor = await queryOne(
    `SELECT u.id, u.full_name AS name, dp.bio, dp.clinic_name, dp.city,
            dp.years_experience, dp.consultation_fee, dp.rating_avg, dp.rating_count,
            dp.accepting_new_patients, dp.languages, dp.license_number,
            s.id AS specialty_id, s.name AS specialty_name, s.slug AS specialty_slug,
            s.description AS specialty_description, s.icon AS specialty_icon
       FROM doctor_profiles dp
       JOIN users u ON u.id = dp.user_id
       JOIN specialties s ON s.id = dp.specialty_id
      WHERE dp.user_id = $1 AND u.status = 'active'`,
    [doctorId]
  );
  if (!doctor) throw ApiError.notFound('Doctor not found.');

  const [summary, reviews] = await Promise.all([
    availabilitySummary(doctor.id, { days: 21 }),
    query(
      `SELECT r.id, r.rating, r.comment, r.created_at,
              regexp_replace(p.full_name, '\\s.*$', '') AS patient_first_name,
              a.scheduled_date AS visited_on
         FROM reviews r
         JOIN users p ON p.id = r.patient_id
         JOIN appointments a ON a.id = r.appointment_id
        WHERE r.doctor_id = $1 AND r.status = 'approved'
        ORDER BY r.created_at DESC
        LIMIT 8`,
      [doctorId]
    ),
  ]);

  res.json({
    doctor,
    availability: summary,
    reviews: reviews.rows,
    canBook: doctor.accepting_new_patients,
  });
});

// ---------------------------------------------------------------------------
// GET /api/doctors/:doctorId/slots?date=YYYY-MM-DD
// ---------------------------------------------------------------------------
const doctorSlots = asyncHandler(async (req, res) => {
  const { doctorId } = req.params;
  const { date } = req.query;

  const exists = await queryOne(
    `SELECT dp.user_id, dp.accepting_new_patients FROM doctor_profiles dp
       JOIN users u ON u.id = dp.user_id
      WHERE dp.user_id = $1 AND u.status = 'active'`,
    [doctorId]
  );
  if (!exists) throw ApiError.notFound('Doctor not found.');

  const slots = await getDaySlots(doctorId, date, { patientId: req.user?.id });

  res.json({ doctorId: Number(doctorId), date, slots, accepting: exists.accepting_new_patients });
});

module.exports = {
  match,
  specialties,
  searchDoctors,
  doctorDetail,
  doctorSlots,
  schemas: { matchSchema, searchSchema },
};
