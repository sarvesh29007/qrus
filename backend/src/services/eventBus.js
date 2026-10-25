'use strict';

const { EventEmitter } = require('events');

/**
 * In-process event bus.
 *
 * The booking engine publishes `slot_changed` whenever a slot becomes
 * unavailable (booked) or available again (cancelled, rescheduled, blocked).
 * The SSE route fans these out to every connected browser so availability and
 * dashboards update without polling — this is the "real-time" half of the
 * scheduling engine.
 *
 * A single Node process keeps this in memory; scale-out would swap this for
 * Redis pub/sub behind the same two functions.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

const SLOT_CHANGED = 'slot_changed';

/**
 * @param {object} change
 * @param {number} change.doctorId
 * @param {number|null} change.slotId
 * @param {string} change.slotDate    'YYYY-MM-DD'
 * @param {'open'|'booked'|'blocked'} change.status
 * @param {string} change.reason      booked | cancelled | rescheduled | blocked | released
 * @param {number|null} [change.appointmentId]
 */
function publishSlotChange(change) {
  const payload = { ...change, at: new Date().toISOString() };
  bus.emit(SLOT_CHANGED, payload);
  bus.emit(`${SLOT_CHANGED}:${change.doctorId}`, payload);
}

function onSlotChange(listener) {
  bus.on(SLOT_CHANGED, listener);
  return () => bus.off(SLOT_CHANGED, listener);
}

module.exports = { bus, publishSlotChange, onSlotChange, SLOT_CHANGED };
