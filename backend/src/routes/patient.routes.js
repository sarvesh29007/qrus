'use strict';

/** Patient portal API. Everything here requires role = 'patient'. */

const router = require('express').Router();
const patient = require('../controllers/patient.controller');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');

const {
  idParam,
  createAppointmentSchema,
  cancelSchema,
  rescheduleSchema,
  listAppointmentsSchema,
  joinWaitlistSchema,
  createReviewSchema,
} = patient.schemas;

// Scoped to this router's own path prefixes: a bare `router.use(...)` here
// would also intercept every path Express falls through to (login, /events
// and unknown routes), which would 403 the doctor portal's SSE stream.
router.use(['/appointments', '/waitlist', '/reviews'], authenticate, requireRole('patient'));

// --- appointments -----------------------------------------------------------
router.get('/appointments', validate({ query: listAppointmentsSchema }), patient.listAppointments);
router.post('/appointments', validate({ body: createAppointmentSchema }), patient.createAppointment);
router.get('/appointments/:id', validate({ params: idParam }), patient.getAppointment);
router.post(
  '/appointments/:id/cancel',
  validate({ params: idParam, body: cancelSchema }),
  patient.cancelAppointment
);
router.post(
  '/appointments/:id/reschedule',
  validate({ params: idParam, body: rescheduleSchema }),
  patient.rescheduleAppointment
);

// --- waitlist ---------------------------------------------------------------
router.get('/waitlist', patient.myWaitlist);
router.post('/waitlist', validate({ body: joinWaitlistSchema }), patient.joinWaitlist);
router.delete('/waitlist/:id', validate({ params: idParam }), patient.leaveWaitlist);

// --- verified reviews -------------------------------------------------------
router.get('/reviews/eligible', patient.reviewableAppointments);
router.get('/reviews/mine', patient.myReviews);
router.post('/reviews', validate({ body: createReviewSchema }), patient.createReview);

module.exports = router;
