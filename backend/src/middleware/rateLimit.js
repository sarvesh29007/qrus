'use strict';

const rateLimit = require('express-rate-limit');
const { ApiError } = require('../utils/errors');

const trustProxy = process.env.TRUST_PROXY === 'true';

function build({ windowMs, max, message, keyGeneratorName }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy,
    // Auth endpoints are keyed by credential, general traffic by user/IP.
    ...(keyGeneratorName ? { keyGenerator: keyGeneratorName } : {}),
    handler: (req, res, next) => {
      next(ApiError.tooMany(message));
    },
  });
}

/** Broad per-IP throttle across the whole API. */
const apiLimiter = build({
  windowMs: 60_000,
  max: 300,
  message: 'Too many requests from this address. Please slow down.',
});

/**
 * Credential stuffing guard. Keyed by email so an attacker rotating source
 * IPs still hits one bucket per target account — and so a victim's account
 * gets a breather without locking out the whole office.
 */
const loginLimiter = build({
  windowMs: 15 * 60_000,
  max: 8,
  message: 'Too many sign-in attempts. Try again in a few minutes.',
  keyGeneratorName: (req) => String(req.body?.email || req.ip).toLowerCase().slice(0, 120),
});

const registerLimiter = build({
  windowMs: 60 * 60_000,
  max: 10,
  message: 'Too many accounts created from this address.',
});

/**
 * Chat turns. A conversation is naturally chattier than a REST call — a
 * booking flow is 5-6 messages in a minute — so this gets its own generous
 * bucket rather than eating the general /api allowance.
 */
const chatLimiter = build({
  windowMs: 60_000,
  max: 60,
  message: 'You are sending messages too quickly. Please pause for a moment.',
});

module.exports = { apiLimiter, loginLimiter, registerLimiter, chatLimiter };
