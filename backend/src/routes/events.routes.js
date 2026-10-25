'use strict';

/**
 * Server-Sent Events stream: real-time appointment availability.
 *
 * The scheduling engine publishes `slot_changed` on every book / cancel /
 * reschedule / block. This route fans it out to every connected portal so
 * slot grids and dashboards update without polling.
 *
 * Each event carries `doctorId` + `slotDate`; clients filter to what they are
 * looking at. A comment line is sent every 25s to defeat idle-proxy timeouts.
 */

const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { onSlotChange, SLOT_CHANGED } = require('../services/eventBus');

const HEARTBEAT_MS = 25_000;

router.get('/slots', authenticate, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering so events are flushed immediately.
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  res.write(`event: ready\ndata: ${JSON.stringify({ connected: true, at: Date.now() })}\n\n`);

  const send = (payload) => {
    try {
      res.write(`event: ${SLOT_CHANGED}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      cleanup();
    }
  };

  const unsubscribe = onSlotChange(send);
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch (err) {
      cleanup();
    }
  }, HEARTBEAT_MS);

  function cleanup() {
    unsubscribe();
    clearInterval(heartbeat);
    try {
      res.end();
    } catch (err) {
      /* connection already gone */
    }
  }

  req.on('close', cleanup);
  res.on('close', cleanup);
});

module.exports = router;
