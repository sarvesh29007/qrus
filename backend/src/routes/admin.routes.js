/** Admin console API. Everything here requires role = 'admin'. */

'use strict';

const router = require('express').Router();
const admin = require('../controllers/admin.controller');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { z } = require('zod');

const {
  listUsersSchema,
  statusSchema,
  roleSchema,
  createUserSchema,
  auditSchema,
  moderationSchema,
} = admin.schemas;

const idParam = z.object({ id: z.coerce.number().int().positive() });

router.use(authenticate, requireRole('admin'));

// --- overview ---------------------------------------------------------------
router.get('/stats', admin.stats);

// --- user access management -------------------------------------------------
router.get('/users', validate({ query: listUsersSchema }), admin.listUsers);
router.post('/users', validate({ body: createUserSchema }), admin.createUser);
router.patch('/users/:id/status', validate({ params: idParam, body: statusSchema }), admin.updateUserStatus);
router.patch('/users/:id/role', validate({ params: idParam, body: roleSchema }), admin.updateUserRole);

// --- audit trail ------------------------------------------------------------
router.get('/audit-logs', validate({ query: auditSchema }), admin.auditLogs);

// --- review moderation ------------------------------------------------------
router.get('/reviews', admin.listReviews);
router.patch('/reviews/:id', validate({ params: idParam, body: moderationSchema }), admin.moderateReview);

// --- queue maintenance ------------------------------------------------------
router.post('/waitlist/sweep', admin.sweepWaitlist);

module.exports = router;
