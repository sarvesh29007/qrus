'use strict';

const { randomUUID } = require('crypto');

/**
 * Attaches a correlation id and request metadata used by every audit record.
 * A caller-supplied X-Request-Id is echoed only when it looks sane, so a
 * hostile client cannot poison the audit trail with megabytes of text.
 */
function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  const safe = typeof incoming === 'string' && /^[\w.:-]{8,64}$/.test(incoming);
  req.id = safe ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  req.ctx = {
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: (req.get('user-agent') || '').slice(0, 300),
    requestId: req.id,
  };
  next();
}

module.exports = { requestContext };
