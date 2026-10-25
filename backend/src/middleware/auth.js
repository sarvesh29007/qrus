'use strict';

const { ApiError, asyncHandler } = require('../utils/errors');
const { verify } = require('../utils/jwt');
const { queryOne } = require('../config/db');

const USER_SQL = `
  SELECT id, email, full_name, phone, role, status, last_login_at, created_at
  FROM users
  WHERE id = $1
`;

/**
 * Verifies the bearer access token and reloads the user from the database on
 * every request. Reloading is deliberate: role changes and suspensions take
 * effect immediately instead of surviving until the token expires.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw ApiError.unauthorized('Missing access token.');
  }

  let payload;
  try {
    payload = verify(token, 'access');
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new ApiError(401, 'TOKEN_EXPIRED', 'Access token expired.');
    }
    throw ApiError.unauthorized('Invalid access token.');
  }

  const user = await queryOne(USER_SQL, [payload.sub]);
  if (!user) throw ApiError.unauthorized('Account no longer exists.');
  if (user.status === 'suspended') throw ApiError.forbidden('This account has been suspended.');
  if (user.status === 'pending') {
    throw new ApiError(403, 'ACCOUNT_PENDING', 'This account is awaiting administrator approval.');
  }

  req.user = user;
  next();
});

/** Attach req.user when a valid token is present, but never reject the request. */
const maybeAuthenticate = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return next();
  try {
    return await authenticate(req, res, next);
  } catch (err) {
    return next(); // anonymous access is fine for public doctor search
  }
});

module.exports = { authenticate, maybeAuthenticate };
