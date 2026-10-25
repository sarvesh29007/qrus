'use strict';

const router = require('express').Router();
const auth = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');

const { registerSchema, loginSchema, refreshSchema } = auth.schemas;

// Public — but throttled: registration and sign-in are credential endpoints.
router.post('/register', registerLimiter, validate({ body: registerSchema }), auth.register);
router.post('/login', loginLimiter, validate({ body: loginSchema }), auth.login);
router.post('/refresh', validate({ body: refreshSchema }), auth.refresh);

// Authenticated
router.post('/logout', authenticate, auth.logout);
router.get('/me', authenticate, auth.me);

module.exports = router;
