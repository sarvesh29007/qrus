'use strict';

/**
 * Route registry — order matters.
 *
 *   1. auth     (/auth/login, /auth/register, /auth/refresh, /auth/me)
 *   2. catalog  (public reads: /specialties, /doctors, /match, /reviews/doctor)
 *   3. patient  (role 'patient': /appointments, /waitlist, /reviews)
 *   4. doctor   (role 'doctor':   /doctor/*)
 *   5. admin    (role 'admin':    /admin/*)
 *   6. events   (SSE stream)
 *   7. chat     (any signed-in role; handlers re-check ownership per row)
 *
 * Each mount stacks authenticate + requireRole, so a patient token can never
 * reach a doctor or admin handler even if a path were mis-typed: the role gate
 * runs before route matching resolves to a controller.
 */

const router = require('express').Router();

// Auth must be first: /auth/login and /auth/register are public, and mounting
// them before the role-gated routers keeps them out of any fall-through guard.
router.use('/auth', require('./auth.routes'));
router.use(require('./catalog.routes'));
router.use(require('./patient.routes'));
router.use('/doctor', require('./doctor.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/events', require('./events.routes'));
// Chat is mounted last: it is a consumer of every service above, never a
// bypass of them. authenticate runs inside the router, so no chat path is
// reachable anonymously even though it is not under a role-specific prefix.
router.use('/chat', require('./chat.routes'));

module.exports = router;
