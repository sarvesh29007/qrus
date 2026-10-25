'use strict';

/**
 * Application error with an HTTP status and a stable machine-readable code.
 * Anything thrown as an ApiError is rendered verbatim by the error handler;
 * everything else becomes an opaque 500 so internals never leak to clients.
 */
class ApiError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code       stable code the frontend can branch on
   * @param {string} message    safe, user-facing message
   * @param {unknown} [details] optional structured context (never secrets)
   */
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message, details) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required.') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have permission to perform this action.') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Resource not found.') {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(message, details) {
    return new ApiError(409, 'CONFLICT', message, details);
  }
  static unprocessable(message, details) {
    return new ApiError(422, 'UNPROCESSABLE', message, details);
  }
  static tooMany(message = 'Too many requests. Please slow down.') {
    return new ApiError(429, 'RATE_LIMITED', message);
  }
}

/** Wrap an async route handler so rejected promises reach the error middleware. */
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

module.exports = { ApiError, asyncHandler };
