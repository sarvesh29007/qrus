'use strict';

const { ZodError } = require('zod');
const { ApiError } = require('../utils/errors');

/**
 * Express exposes `req.query` as a prototype getter with no setter, so a plain
 * assignment would throw in strict mode. Shadow it with an own property.
 */
function assignPart(req, part, value) {
  if (part === 'query') {
    Object.defineProperty(req, part, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } else {
    req[part] = value;
  }
}

/**
 * validate({ body, query, params }) — parses each request part with its zod
 * schema and replaces it with the *parsed* value, so controllers only ever see
 * coerced, trimmed, whitelisted data (zod strips unknown keys by default).
 */
function validate(schemas = {}) {
  const parts = ['body', 'query', 'params'].filter((part) => schemas[part]);

  return (req, res, next) => {
    const issues = [];
    for (const part of parts) {
      const result = schemas[part].safeParse(req[part]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({ path: `${part}.${issue.path.join('.')}`, message: issue.message });
        }
      } else {
        assignPart(req, part, result.data);
      }
    }

    if (issues.length) {
      return next(new ApiError(422, 'VALIDATION_ERROR', 'Invalid request payload.', issues));
    }
    return next();
  };
}

/** Translate a raw ZodError thrown inside a handler into an ApiError. */
function toApiError(err) {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return new ApiError(422, 'VALIDATION_ERROR', 'Invalid request payload.', issues);
  }
  return null;
}

module.exports = { validate, toApiError };
