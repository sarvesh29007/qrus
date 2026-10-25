'use strict';

const { ApiError } = require('../utils/errors');
const { toApiError } = require('./validate');

/** PostgreSQL error codes we can map to something meaningful and safe. */
const RETRYABLE = {
  status: 409,
  code: 'WRITE_CONFLICT',
  message: 'Concurrent update detected. Please retry.',
};

const PG_CODE_MAP = {
  '23505': { status: 409, code: 'DUPLICATE', message: 'That record already exists.' },
  '23503': { status: 400, code: 'REFERENCE_INVALID', message: 'Referenced record is invalid.' },
  '23514': { status: 422, code: 'CONSTRAINT_VIOLATED', message: 'Value violates a business rule.' },
  '22007': { status: 422, code: 'INVALID_DATETIME', message: 'Malformed date or time value.' },
  '22008': { status: 422, code: 'INVALID_DATETIME', message: 'Malformed date or time value.' },
  '40001': RETRYABLE,
  '40P01': RETRYABLE,
};

function notFoundHandler(req, res, next) {
  next(new ApiError(404, 'NOT_FOUND', `No route matches ${req.method} ${req.path}.`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let error = toApiError(err);

  if (!error && err && err.code && PG_CODE_MAP[err.code]) {
    const mapped = PG_CODE_MAP[err.code];
    // Unique violations carry an index name — useful, non-sensitive context.
    error = new ApiError(mapped.status, mapped.code, mapped.message, {
      constraint: err.constraint || err.detail?.match(/on table "([^"]+)"/)?.[1] || undefined,
    });
  } else if (!error && !(err instanceof ApiError)) {
    // eslint-disable-next-line no-console
    console.error(`[qrus] ${req.id} unhandled error:`, err);
    error = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.');
  } else if (err instanceof ApiError) {
    error = err;
  }

  const status = error.statusCode || 500;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(`[qrus] ${req.id} ${req.method} ${req.originalUrl} -> ${status}`, err);
  }

  res.status(status).json({
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || 'Unexpected error.',
      details: error.details || undefined,
      requestId: req.id,
    },
  });
}

module.exports = { errorHandler, notFoundHandler };
