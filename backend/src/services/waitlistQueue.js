'use strict';

/**
 * =============================================================================
 * Smart waitlist priority queue
 * =============================================================================
 *
 * Ordering rule (stable, index-backed, never stored so it cannot drift):
 *
 *     urgency DESC  ->  joined_at ASC
 *
 * i.e. urgent patients jump the queue, and inside a band it is strictly
 * first-come-first-served. `position` is derived on read.
 *
 * Auto-fill contract: whenever the scheduling engine releases a slot
 * (cancellation, reschedule, un-block) it calls `fillSlot()` inside the very
 * same transaction. The candidate row is locked with FOR UPDATE SKIP LOCKED so
 * two concurrent releases can never hand the same slot to two patients, and
 * the appointment insert is still protected by the partial unique indexes.
 */

const { query, withTransaction } = require('../config/db');
const { ApiError } = require('../utils/errors');
const config = require('../config/env');
const { todayInTz, addDays } = require('../utils/time');
const { audit, ACTIONS } = require('./audit.service');
const { lockSlot, insertAppointment, setSlotStatus, ACTIVE_STATUSES } = require('./appointmentStore');

function rankSql(alias = 'w') {
  return `(CASE ${alias}.urgency WHEN 'urgent' THEN 3 WHEN 'soon' THEN 2 ELSE 1 END)`;
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Highest-priority waiting patient eligible for this exact slot.
 * Must be called with a transaction client; row is locked so a concurrent
 * sweep cannot race us.
 */
async function pickCandidate(client, slot) {
  const specialtyId = slot.specialty_id || -1;

  const { rows } = await client.query(
    `SELECT w.id, w.patient_id, w.urgency, w.symptoms, w.joined_at,
            ${rankSql('w')} AS urgency_rank
       FROM waitlist_entries w
      WHERE w.status = 'waiting'
        AND (w.expires_at IS NULL OR w.expires_at > now())
        AND ( (w.doctor_id IS NOT NULL AND w.doctor_id = $1)
           OR (w.doctor_id IS NULL AND w.specialty_id = $2) )
        AND (w.preferred_date_from IS NULL OR w.preferred_date_from <= $3)
        AND (w.preferred_date_to   IS NULL OR w.preferred_date_to   >= $3)
        AND (w.preferred_start IS NULL OR w.preferred_start <= $4)
        AND (w.preferred_end   IS NULL OR w.preferred_end   >= $4)
        AND NOT EXISTS (
              SELECT 1 FROM appointments a
               WHERE a.patient_id = w.patient_id
                 AND a.scheduled_for = $5
                 AND a.status = ANY($6::text[])
            )
      ORDER BY urgency_rank DESC, w.joined_at ASC
      LIMIT 1
      FOR UPDATE OF w SKIP LOCKED`,
    [slot.doctor_id, specialtyId, slot.slot_date, slot.starts_at, slot.starts_at_tz, ACTIVE_STATUSES]
  );

  return rows[0] || null;
}

/** Turn a locked, available slot into a confirmed appointment for `entry`. */
async function assignSlot({ client, slot, entry, req, reason, status = 'scheduled' }) {
  const appointment = await insertAppointment(client, {
    patientId: entry.patient_id,
    doctorId: slot.doctor_id,
    slotId: slot.id,
    specialtyId: slot.specialty_id,
    status,
    reason: `Waitlist auto-match (${reason})`,
    symptoms: entry.symptoms || '',
    slot,
  });

  await setSlotStatus(client, slot.id, 'booked');

  await client.query(
    `UPDATE waitlist_entries
        SET status = 'matched', matched_appointment_id = $2, matched_at = now()
      WHERE id = $1`,
    [entry.id, appointment.id]
  );

  await audit(
    req,
    {
      action: ACTIONS.WAITLIST_FILLED,
      entityType: 'waitlist_entry',
      entityId: entry.id,
      patientId: entry.patient_id,
      metadata: {
        appointmentId: appointment.id,
        slotId: slot.id,
        doctorId: slot.doctor_id,
        scheduledFor: slot.starts_at_tz,
        urgency: entry.urgency,
        trigger: reason,
      },
    },
    client
  );

  return { entryId: entry.id, appointment, patientId: entry.patient_id };
}

/**
 * Offer a freshly released slot to the queue.
 * Called by the scheduling engine inside its transaction.
 * @returns {Promise<{entryId:number, appointment:object}|null>}
 */
async function fillSlot({ req, slot, client, reason = 'slot_released' }) {
  if (slot.status === 'blocked') return null;

  const entry = await pickCandidate(client, slot);
  if (!entry) return null;

  return assignSlot({ client, slot, entry, req, reason });
}

// ---------------------------------------------------------------------------
// Waitlist as a patient-facing resource
// ---------------------------------------------------------------------------
async function resolveTarget({ doctorId, specialtyId }) {
  if (doctorId) {
    const doctor = await query(
      `SELECT u.id, dp.specialty_id
         FROM users u
         JOIN doctor_profiles dp ON dp.user_id = u.id
        WHERE u.id = $1 AND u.role = 'doctor' AND u.status = 'active'
          AND dp.accepting_new_patients`,
      [doctorId]
    );
    if (!doctor.rows[0]) {
      throw ApiError.badRequest('That doctor is not available for waitlisting.');
    }
    return { doctorId: doctor.rows[0].id, specialtyId: doctor.rows[0].specialty_id };
  }

  if (!specialtyId) throw ApiError.badRequest('Choose a doctor or a specialty.');
  const spec = await query(`SELECT id FROM specialties WHERE id = $1 AND is_active`, [specialtyId]);
  if (!spec.rows[0]) throw ApiError.badRequest('Unknown specialty.');
  return { doctorId: null, specialtyId: spec.rows[0].id };
}

/**
 * Join the queue. A fresh entry is immediately tested against slots that are
 * already open (so the patient does not wait for a cancellation that may never
 * come); otherwise it waits for the scheduling engine to release one.
 */
async function joinWaitlist({ req, patientId, input }) {
  const target = await resolveTarget(input);

  const expiresAt = addDays(todayInTz(config.appTz), config.waitlist.ttlDays);

  const entry = await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT id FROM waitlist_entries
        WHERE patient_id = $1 AND COALESCE(doctor_id, 0) = $2 AND specialty_id = $3
          AND status = 'waiting'`,
      [patientId, target.doctorId || 0, target.specialtyId]
    );
    if (existing.rows[0]) {
      throw ApiError.conflict('You are already on this waitlist.', {
        entryId: existing.rows[0].id,
      });
    }

    const { rows } = await client.query(
      `INSERT INTO waitlist_entries
         (patient_id, doctor_id, specialty_id, symptoms, urgency,
          preferred_date_from, preferred_date_to, preferred_start, preferred_end, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date)
       RETURNING *`,
      [
        patientId,
        target.doctorId,
        target.specialtyId,
        input.symptoms,
        input.urgency || 'routine',
        input.preferredDateFrom || null,
        input.preferredDateTo || null,
        input.preferredStart || null,
        input.preferredEnd || null,
        expiresAt,
      ]
    );

    await audit(
      req,
      {
        action: ACTIONS.WAITLIST_JOINED,
        entityType: 'waitlist_entry',
        entityId: rows[0].id,
        patientId,
        metadata: {
          doctorId: target.doctorId,
          specialtyId: target.specialtyId,
          urgency: rows[0].urgency,
          preferences: {
            from: rows[0].preferred_date_from,
            to: rows[0].preferred_date_to,
            start: rows[0].preferred_start,
            end: rows[0].preferred_end,
          },
        },
      },
      client
    );

    return rows[0];
  });

  // Opportunistic first match against slots that are open right now.
  const immediate = await tryMatchEntry({ entryId: entry.id });

  return { entry, immediateAppointment: immediate ? immediate.appointment : null };
}

async function leaveWaitlist({ req, patientId, entryId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM waitlist_entries WHERE id = $1 AND patient_id = $2 FOR UPDATE`,
      [entryId, patientId]
    );
    const entry = rows[0];
    if (!entry) throw ApiError.notFound('Waitlist entry not found.');
    if (entry.status !== 'waiting') {
      throw ApiError.conflict(`This entry is already '${entry.status}'.`);
    }

    const { rows: updated } = await client.query(
      `UPDATE waitlist_entries SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [entryId]
    );

    await audit(
      req,
      {
        action: ACTIONS.WAITLIST_LEFT,
        entityType: 'waitlist_entry',
        entityId: entryId,
        patientId,
        metadata: { urgency: entry.urgency, waitedHours: hoursSince(entry.joined_at) },
      },
      client
    );

    return updated[0];
  });
}

/** The caller's own queue entries with a live 1-based position. */
async function myEntries(patientId) {
  const { rows } = await query(
    `SELECT w.id, w.status, w.urgency, w.symptoms, w.joined_at, w.expires_at,
            w.matched_at, w.matched_appointment_id,
            w.doctor_id, d.full_name AS doctor_name,
            w.specialty_id, sp.name AS specialty_name, sp.slug AS specialty_slug,
            w.preferred_date_from, w.preferred_date_to, w.preferred_start, w.preferred_end,
            ${rankSql('w')} AS urgency_rank,
            (SELECT COUNT(*) + 1
               FROM waitlist_entries w2
              WHERE w2.status = 'waiting'
                AND ( (w2.doctor_id IS NOT NULL AND w2.doctor_id = w.doctor_id)
                   OR (w2.doctor_id IS NULL AND w.doctor_id IS NULL
                       AND w2.specialty_id = w.specialty_id) )
                AND ROW(${rankSql('w2')}, w2.joined_at)
                    < ROW(${rankSql('w')}, w.joined_at)) AS position,
            (SELECT COUNT(*)
               FROM waitlist_entries w3
              WHERE w3.status = 'waiting'
                AND ( (w3.doctor_id IS NOT NULL AND w3.doctor_id = w.doctor_id)
                   OR (w3.doctor_id IS NULL AND w.doctor_id IS NULL
                       AND w3.specialty_id = w.specialty_id))) AS queue_length
       FROM waitlist_entries w
       LEFT JOIN users d ON d.id = w.doctor_id
       JOIN specialties sp ON sp.id = w.specialty_id
      WHERE w.patient_id = $1
      ORDER BY (w.status = 'waiting') DESC, w.joined_at DESC`,
    [patientId]
  );
  return rows;
}

/**
 * The doctor's own queue: every waiting patient who could be slotted into this
 * doctor's calendar (direct requests plus specialty-wide requests).
 */
async function queueForDoctor(doctorId) {
  const { rows: profile } = await query(
    `SELECT specialty_id FROM doctor_profiles WHERE user_id = $1`,
    [doctorId]
  );
  const specialtyId = profile[0]?.specialty_id || -1;

  const { rows } = await query(
    `SELECT w.id, w.urgency, w.symptoms, w.joined_at, w.expires_at,
            w.preferred_date_from, w.preferred_date_to, w.preferred_start, w.preferred_end,
            ${rankSql('w')} AS urgency_rank,
            ROW_NUMBER() OVER (ORDER BY ${rankSql('w')} DESC, w.joined_at ASC)::int AS position,
            EXTRACT(EPOCH FROM (now() - w.joined_at)) / 3600.0 AS waiting_hours,
            p.id AS patient_id, p.full_name AS patient_name, p.email AS patient_email,
            (w.doctor_id IS NOT NULL) AS requested_me
       FROM waitlist_entries w
       JOIN users p ON p.id = w.patient_id
      WHERE w.status = 'waiting'
        AND (w.expires_at IS NULL OR w.expires_at > now())
        AND ( (w.doctor_id = $1) OR (w.doctor_id IS NULL AND w.specialty_id = $2) )
      ORDER BY urgency_rank DESC, w.joined_at ASC`,
    [doctorId, specialtyId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Opportunistic matching
// ---------------------------------------------------------------------------
const SLOT_SCAN_DAYS = 14;
const SLOT_SCAN_LIMIT = 50;

/** Earliest open slot this entry could legally take right now. */
async function findOpenSlotForEntry(client, entry) {
  const minLeadSeconds = config.booking.minLeadMinutes * 60;
  const horizonDays = config.booking.maxHorizonDays;

  const { rows } = await client.query(
    `SELECT s.id
       FROM appointment_slots s
       JOIN doctor_profiles dp ON dp.user_id = s.doctor_id
      WHERE s.status = 'open'
        AND dp.accepting_new_patients
        AND s.starts_at_tz > now() + make_interval(secs => $1::int)
        AND s.starts_at_tz < now() + make_interval(days => $2::int)
        AND ( ($3::bigint IS NOT NULL AND s.doctor_id = $3)
           OR ($3::bigint IS NULL AND s.specialty_id = $4) )
        AND s.slot_date >= COALESCE($5::date, CURRENT_DATE)
        AND s.slot_date <= COALESCE($6::date, CURRENT_DATE + make_interval(days => $2::int))
        AND s.starts_at >= COALESCE($7::time, '00:00')
        AND s.starts_at <= COALESCE($8::time, '23:59')
      ORDER BY s.starts_at_tz
      LIMIT $9`,
    [
      minLeadSeconds,
      horizonDays,
      entry.doctor_id,
      entry.specialty_id,
      entry.preferred_date_from,
      entry.preferred_date_to,
      entry.preferred_start,
      entry.preferred_end,
      SLOT_SCAN_LIMIT,
    ]
  );
  return rows[0]?.id || null;
}

/** Try to satisfy one entry immediately. Safe to call repeatedly. */
async function tryMatchEntry({ entryId, req }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM waitlist_entries WHERE id = $1 FOR UPDATE`,
      [entryId]
    );
    const entry = rows[0];
    if (!entry || entry.status !== 'waiting') return null;
    if (entry.expires_at && new Date(entry.expires_at) < new Date()) return null;

    const slotId = await findOpenSlotForEntry(client, entry);
    if (!slotId) return null;

    const slot = await lockSlot(client, slotId);
    if (slot.status !== 'open') return null;
    if (slot.accepting_new_patients === false) return null;

    // Patient must not already be booked at that instant.
    const clash = await client.query(
      `SELECT id FROM appointments
        WHERE patient_id = $1 AND scheduled_for = $2 AND status = ANY($3::text[]) LIMIT 1`,
      [entry.patient_id, slot.starts_at_tz, ACTIVE_STATUSES]
    );
    if (clash.rows[0]) return null;

    return assignSlot({ client, slot, entry, req, reason: 'available_slot' });
  });
}

/**
 * Sweep every waiting entry against currently open slots.
 * Backs the background interval job and the admin "run waitlist sweep" action.
 */
async function sweep({ req, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT id FROM waitlist_entries
      WHERE status = 'waiting' AND (expires_at IS NULL OR expires_at > now())
      ORDER BY joined_at
      LIMIT $1`,
    [limit]
  );

  const matched = [];
  for (const row of rows) {
    try {
      const result = await tryMatchEntry({ entryId: row.id, req });
      if (result) matched.push(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[qrus] waitlist sweep failed for entry ${row.id}:`, err.message);
    }
  }
  return matched;
}

/** Mark stale entries expired (single audit summary, not one row per entry). */
async function expireStale() {
  const { rowCount } = await query(
    `UPDATE waitlist_entries
        SET status = 'expired'
      WHERE status = 'waiting' AND expires_at IS NOT NULL AND expires_at < now()`
  );
  if (rowCount > 0) {
    await audit(
      { user: null, ctx: { requestId: 'waitlist-sweep' } },
      {
        action: ACTIONS.WAITLIST_EXPIRED,
        entityType: 'waitlist_entry',
        metadata: { expired: rowCount, ttlDays: config.waitlist.ttlDays },
      }
    );
  }
  return rowCount;
}

function hoursSince(timestamp) {
  const ms = Date.now() - new Date(timestamp).getTime();
  return Math.round((ms / 3_600_000) * 10) / 10;
}

module.exports = {
  fillSlot,
  joinWaitlist,
  leaveWaitlist,
  myEntries,
  queueForDoctor,
  tryMatchEntry,
  sweep,
  expireStale,
  pickCandidate,
};
