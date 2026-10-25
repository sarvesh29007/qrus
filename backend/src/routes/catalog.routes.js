'use strict';

/**
 * Catalog + matching routes. Reading doctor availability is public so a
 * visitor can browse before creating an account; when a token *is* present it
 * is decoded so the slot grid can highlight the caller's own bookings.
 * Booking itself lives in patient.routes.js and always requires auth.
 */

const router = require('express').Router();
const { z } = require('zod');
const catalog = require('../controllers/matching.controller');
const patient = require('../controllers/patient.controller');
const { maybeAuthenticate, authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { requireRole } = require('../middleware/rbac');

const { matchSchema, searchSchema } = catalog.schemas;

const doctorIdParam = z.object({ doctorId: z.coerce.number().int().positive() });

router.get('/specialties', catalog.specialties);

router.get('/doctors', maybeAuthenticate, validate({ query: searchSchema }), catalog.searchDoctors);
router.get(
  '/doctors/:doctorId',
  maybeAuthenticate,
  validate({ params: doctorIdParam }),
  catalog.doctorDetail
);
router.get(
  '/doctors/:doctorId/slots',
  maybeAuthenticate,
  validate({ params: doctorIdParam }),
  catalog.doctorSlots
);

// Intelligent symptom -> specialty routing. Authenticated to keep a cap on
// abuse, available to any signed-in user (patients see the recommendation,
// doctors/admins can call it as a reference tool).
router.post(
  '/match/symptoms',
  authenticate,
  requireRole('patient', 'doctor', 'admin'),
  validate({ body: matchSchema }),
  catalog.match
);

// Approved-only public reviews for a doctor.
router.get('/reviews/doctor/:doctorId', patient.publicDoctorReviews);

module.exports = router;
