'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');

const ALGORITHM = 'HS256';

/** Short-lived access token: identity + role only, no PII payload. */
function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, typ: 'access' },
    config.jwt.secret,
    { algorithm: ALGORITHM, expiresIn: config.jwt.accessTtlSeconds, issuer: 'qrus' }
  );
}

/**
 * Long-lived refresh token. The raw token is shown to the client once; only
 * its SHA-256 is persisted (see refresh_tokens.token_hash), so a database
 * leak does not yield usable sessions.
 *
 * `jti` is mandatory: without a unique claim, two logins by the same user in
 * the same second sign a byte-identical JWT (same sub/role/typ/iat/exp), whose
 * SHA-256 collides on `refresh_tokens.token_hash` and makes login fail with a
 * confusing 409.
 */
function signRefreshToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, typ: 'refresh', jti: crypto.randomUUID() },
    config.jwt.secret,
    { algorithm: ALGORITHM, expiresIn: config.jwt.refreshTtlDays * 86400, issuer: 'qrus' }
  );
}

/** @returns {object} decoded payload  @throws {JsonWebTokenError|TokenExpiredError} */
function verify(token, expectedType) {
  const payload = jwt.verify(token, config.jwt.secret, {
    algorithms: [ALGORITHM],
    issuer: 'qrus',
  });
  if (expectedType && payload.typ !== expectedType) {
    const err = new Error('Wrong token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}

/** Opaque refresh token: the DB stores only its SHA-256, never the raw value. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { signAccessToken, signRefreshToken, verify, hashToken };
