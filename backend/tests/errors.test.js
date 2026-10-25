'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ApiError, asyncHandler } = require('../src/utils/errors');

test('ApiError factories map to stable status codes and machine codes', () => {
  const cases = [
    [ApiError.badRequest('x'), 400, 'BAD_REQUEST'],
    [ApiError.unauthorized(), 401, 'UNAUTHORIZED'],
    [ApiError.forbidden(), 403, 'FORBIDDEN'],
    [ApiError.notFound(), 404, 'NOT_FOUND'],
    [ApiError.conflict('x'), 409, 'CONFLICT'],
    [ApiError.unprocessable('x'), 422, 'UNPROCESSABLE'],
    [ApiError.tooMany(), 429, 'RATE_LIMITED'],
  ];
  for (const [err, status, code] of cases) {
    assert.ok(err instanceof ApiError);
    assert.ok(err instanceof Error);
    assert.equal(err.statusCode, status);
    assert.equal(err.code, code);
    assert.equal(typeof err.message, 'string');
  }
});

test('ApiError carries structured details for the client envelope', () => {
  const err = ApiError.conflict('Slot taken.', { appointmentId: 7 });
  assert.deepEqual(err.details, { appointmentId: 7 });
});

test('asyncHandler forwards rejections to next()', async () => {
  const boom = new Error('async failure');
  const handler = asyncHandler(async () => {
    throw boom;
  });

  let captured = null;
  await handler({}, {}, (err) => {
    captured = err;
  });
  assert.equal(captured, boom);
});

test('asyncHandler passes through successful handlers', async () => {
  const handler = asyncHandler(async (req, res) => {
    res.done = true;
  });
  const res = {};
  let nextCalled = false;
  await handler({}, res, () => {
    nextCalled = true;
  });
  assert.equal(res.done, true);
  assert.equal(nextCalled, false);
});
