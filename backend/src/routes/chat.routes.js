'use strict';

/**
 * Chatbot API. Any signed-in role may chat (triage, FAQs, clinic info are
 * useful to doctors and admins too), but every handler that touches clinical
 * data re-checks `req.user.id` against the row it is about to touch — a patient
 * token can never read or cancel another patient's appointment through the
 * conversation, exactly as in the REST portal.
 */

const router = require('express').Router();
const chat = require('../controllers/chatController');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { chatLimiter } = require('../middleware/rateLimit');

const { createSessionSchema, messageSchema, sessionIdParam } = chat.schemas;

router.use(authenticate);

router.post('/sessions', validate({ body: createSessionSchema }), chat.createSession);
router.get('/sessions', chat.listSessions);
router.get('/sessions/:id', validate({ params: sessionIdParam }), chat.getSession);
router.delete('/sessions/:id', validate({ params: sessionIdParam }), chat.closeSession);
router.post(
  '/sessions/:id/messages',
  // Chat turns get their own bucket: a booking flow is 5-6 messages in a
  // minute, which would eat the general /api allowance on its own.
  chatLimiter,
  validate({ params: sessionIdParam, body: messageSchema }),
  chat.postMessage
);

module.exports = router;
