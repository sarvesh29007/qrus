'use strict';

const { ApiError } = require('../utils/errors');

/**
 * Low-level appointment/slot primitives shared by the scheduling engine and
 * the waitlist queue. Keeping them here means both paths write identical rows
 * and neither module has to require the other (no import cycles).
 */

/** Statuses that occupy a slot and block a competing booking. */
const ACTIVE_STATUSES = ['pending', 'scheduled'];

/**
 * Lock a slot row for the rest of the transaction.
 * Returns the slot or throws 404. Caller must already be inside a transaction.
 *
 * @param {import('pg').PoolClient} client
 * @param {number} slotId
 */
async function lockSlot(client, slotId) {
  const { rows } = await client.query(
    `SELECT s.id, s.doctor_id, s.slot_date, s.starts_at, s.ends_at,
            s.starts_at_tz, s.ends_at_tz, s.status,
            COALESCE(s.specialty_id, dp.specialty_id) AS specialty_id,
            dp.accepting_new_patients
       FROM appointment_slots s
       LEFT JOIN doctor_profiles dp ON dp.user_id = s.doctor_id
      WHERE s.id = $1
      FOR UPDATE OF s`,
    [slotId]
  );
  const slot = rows[0];
  if (!slot) throw ApiError.notFound('That time slot no longer exists.');
  return slot;
}

/**
 * Insert an appointment denormalised from its slot.
 * Unique partial indexes on (slot_id)/(doctor_id, scheduled_for)/(patient_id,
 * scheduled_for) are the final backstop against double-booking: if another
 * transaction won the race, Postgres raises 23505 -> 409.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} data
 * @returns {Promise<object>} the inserted row
 */
async function insertAppointment(client, data) {
  const { rows } = await client.query(
    `INSERT INTO appointments
       (patient_id, doctor_id, slot_id, specialty_id, status, reason, symptoms,
        scheduled_for, scheduled_date, scheduled_time, rescheduled_from_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.patientId,
      data.doctorId,
      data.slotId,
      data.specialtyId,
      data.status || 'pending',
      data.reason || '',
      data.symptoms || '',
      data.slot.starts_at_tz,
      data.slot.slot_date,
      data.slot.starts_at,
      data.rescheduledFromId || null,
    ]
  );
  return rows[0];
}

/** Mark a slot as taken/open inside the caller's transaction. */
async function setSlotStatus(client, slotId, status) {
  const { rows } = await client.query(
    `UPDATE appointment_slots SET status = $2 WHERE id = $1 RETURNING id, status`,
    [slotId, status]
  );
  return rows[0] || null;
}

module.exports = { ACTIVE_STATUSES, lockSlot, insertAppointment, setSlotStatus };
