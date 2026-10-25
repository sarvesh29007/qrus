/** Doctor portal API. Everything here requires role = 'doctor'. */

'use strict';

const router = require('express').Router();
const doctor = require('../controllers/doctor.controller');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { z } = require('zod');

const {
  scheduleSchema,
  overrideSchema,
  listSchema,
  acceptSchema,
  declineSchema,
  completeSchema,
  doctorRescheduleSchema,
  profileSchema,
} = doctor.schemas;

const idParam = z.object({ id: z.coerce.number().int().positive() });
const scheduleIdParam = z.object({ id: z.coerce.number().int().positive() });

router.use(authenticate, requireRole('doctor'));

// --- dashboard --------------------------------------------------------------
router.get('/dashboard', doctor.dashboard);

// --- recurring schedule + date overrides -----------------------------------
router.get('/schedule', doctor.getSchedule);
router.put('/schedule', validate({ body: scheduleSchema }), doctor.upsertSchedule);
router.delete('/schedule/:id', validate({ params: scheduleIdParam }), doctor.deleteSchedule);
router.post('/overrides', validate({ body: overrideSchema }), doctor.createOverride);
router.delete('/overrides/:id', validate({ params: scheduleIdParam }), doctor.deleteOverride);

// --- appointment queue (symptoms are audited on read) -----------------------
router.get('/appointments', validate({ query: listSchema }), doctor.listAppointments);
router.get('/appointments/:id', validate({ params: idParam }), doctor.getAppointment);
router.get(
  '/appointments/:id/intake',
  validate({ params: idParam }),
  doctor.getAppointmentIntake
);
router.post(
  '/appointments/:id/accept',
  validate({ params: idParam, body: acceptSchema }),
  doctor.acceptAppointment
);
router.post(
  '/appointments/:id/decline',
  validate({ params: idParam, body: declineSchema }),
  doctor.declineAppointment
);
router.post(
  '/appointments/:id/complete',
  validate({ params: idParam, body: completeSchema }),
  doctor.completeAppointment
);
router.post('/appointments/:id/no-show', validate({ params: idParam }), doctor.noShow);
router.post(
  '/appointments/:id/reschedule',
  validate({ params: idParam, body: doctorRescheduleSchema }),
  doctor.rescheduleAppointment
);

// --- waitlist, reviews, profile --------------------------------------------
router.get('/waitlist', doctor.waitlistQueue);
router.get('/reviews', doctor.reviews);
router.patch('/profile', validate({ body: profileSchema }), doctor.updateProfile);

module.exports = router;
