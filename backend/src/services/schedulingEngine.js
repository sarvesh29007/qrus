'use strict';

/**
 * =============================================================================
 * Scheduling engine
 * =============================================================================
 * Responsibilities
 *   1. Materialise concrete slots from a doctor's recurring weekly schedule
 *      plus per-date overrides.
 *   2. Book / cancel / reschedule inside a transaction that makes
 *      double-booking impossible:
 *        - SELECT ... FOR UPDATE on the slot row (serialises concurrent books)
 *        - status guard ('open' only) with an application-level check
 *        - partial unique indexes as the database-level backstop (23505 -> 409)
 *   3. Free slots feed the waitlist queue automatically (cancel/reschedule).
 *   4. Broadcast every availability change over the SSE bus.
 */

const config = require('../config/env');
const { query, withTransaction } = require('../config/db');
const { ApiError } = require('../utils/errors');
const { zonedTimeToUtc, addDays, todayInTz, isValidDateStr } = require('../utils/time');
const { audit, ACTIONS } = require('./audit.service');
const { publishSlotChange } = require('./eventBus');
const { lockSlot, insertAppointment, setSlotStatus, ACTIVE_STATUSES } = require('./appointmentStore');
const waitlist = require('./waitlistQueue');

const DEFAULT_SLOT_MINUTES = 20;

// ---------------------------------------------------------------------------
// Time helpers (all times are 'HH:MM' / 'HH:MM:SS' clinic wall-clock strings)
// ---------------------------------------------------------------------------
const toMinutes = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};
const toHhmm = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

const weekdayOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

// ---------------------------------------------------------------------------
// Window algebra — pure functions, unit tested in tests/scheduling.test.js
// ---------------------------------------------------------------------------
function subtractWindow(win, blocker) {
  if (blocker.e <= win.s || blocker.s >= win.e) return [win];
  const out = [];
  if (blocker.s > win.s) out.push({ s: win.s, e: blocker.s, slotMinutes: win.slotMinutes });
  if (blocker.e < win.e) out.push({ s: blocker.e, e: win.e, slotMinutes: win.slotMinutes });
  return out;
}

function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a.s - b.s);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.s < last.e) {
      last.e = Math.max(last.e, w.e);
      last.slotMinutes = Math.min(last.slotMinutes, w.slotMinutes);
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

/**
 * Derive the concrete consultation windows for one clinic date.
 *
 * @param {Array} schedules  doctor_schedules rows (weekday window definitions)
 * @param {Array} overrides  schedule_overrides rows for that date
 * @returns {{ windows: Array<{s:number,e:number,slotMinutes:number}>, blockedAllDay: boolean }}
 */
function computeWindows(schedules, overrides) {
  const blockers = overrides.filter((o) => !o.is_available && o.start_time && o.end_time);
  const additions = overrides.filter((o) => o.is_available && o.start_time && o.end_time);

  if (overrides.some((o) => !o.is_available && !o.start_time)) {
    return { windows: [], blockedAllDay: true };
  }

  let windows = schedules.map((s) => ({
    s: toMinutes(s.start_time),
    e: toMinutes(s.end_time),
    slotMinutes: s.slot_minutes || DEFAULT_SLOT_MINUTES,
  }));

  for (const blocker of blockers) {
    windows = windows.flatMap((w) =>
      subtractWindow(w, { s: toMinutes(blocker.start_time), e: toMinutes(blocker.end_time) })
    );
  }

  for (const extra of additions) {
    windows.push({
      s: toMinutes(extra.start_time),
      e: toMinutes(extra.end_time),
      slotMinutes: extra.slot_minutes || DEFAULT_SLOT_MINUTES,
    });
  }

  return { windows: mergeWindows(windows), blockedAllDay: false };
}

/** Split windows into slot start times. */
function expandSlots(windows) {
  const slots = [];
  for (const w of windows) {
    const step = Math.max(5, w.slotMinutes || DEFAULT_SLOT_MINUTES);
    for (let t = w.s; t + step <= w.e; t += step) {
      slots.push({ start: toHhmm(t), end: toHhmm(t + step) });
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Slot materialisation
// ---------------------------------------------------------------------------
/** Load schedules once, then reuse them across a whole date range. */
async function fetchScheduleRowsForRange(doctorId, fromDate, toDate, client = { query }) {
  const [schedules, overrides] = await Promise.all([
    client.query(
      `SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI')   AS end_time, slot_minutes
         FROM doctor_schedules
        WHERE doctor_id = $1
        ORDER BY weekday, start_time`,
      [doctorId]
    ),
    client.query(
      `SELECT override_date, to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI')   AS end_time, is_available
         FROM schedule_overrides
        WHERE doctor_id = $1 AND override_date BETWEEN $2 AND $3`,
      [doctorId, fromDate, toDate]
    ),
  ]);

  const overridesByDate = new Map();
  for (const row of overrides.rows) {
    if (!overridesByDate.has(row.override_date)) overridesByDate.set(row.override_date, []);
    overridesByDate.get(row.override_date).push(row);
  }
  return { schedules: schedules.rows, overridesByDate };
}

/**
 * Materialise (and reconcile) every slot for one clinic date.
 * Idempotent: safe to call on every availability read.
 * @returns {Promise<{inserted:number, changed:boolean}>}
 */
async function ensureSlotsForDate(doctorId, dateStr) {
  if (!isValidDateStr(dateStr)) throw ApiError.badRequest('Invalid date.');

  return withTransaction(async (client) => {
    const { rows: schedules } = await client.query(
      `SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time, slot_minutes
         FROM doctor_schedules WHERE doctor_id = $1 AND weekday = $2`,
      [doctorId, weekdayOf(dateStr)]
    );
    const { rows: overrides } = await client.query(
      `SELECT to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time, is_available
         FROM schedule_overrides WHERE doctor_id = $1 AND override_date = $2`,
      [doctorId, dateStr]
    );

    const { windows } = computeWindows(schedules, overrides);
    const planned = expandSlots(windows);

    const { rows: profile } = await client.query(
      `SELECT specialty_id FROM doctor_profiles WHERE user_id = $1`,
      [doctorId]
    );
    const specialtyId = profile[0]?.specialty_id || null;

    // 1. Create any missing slots (absolute instants computed DST-safely in JS).
    let inserted = 0;
    if (planned.length) {
      const params = [doctorId, dateStr, specialtyId]; // $1..$3
      const tuples = planned.map((slot) => {
        const startsAt = zonedTimeToUtc(dateStr, `${slot.start}:00`, config.appTz);
        const endsAt = zonedTimeToUtc(dateStr, `${slot.end}:00`, config.appTz);
        params.push(slot.start, slot.end, startsAt.toISOString(), endsAt.toISOString());
        const i = params.length; // indexes of this tuple's four values (1-based)
        return `($1, $2, $${i - 3}, $${i - 2}, $${i - 1}::timestamptz, $${i}::timestamptz, $3)`;
      });

      const res = await client.query(
        `INSERT INTO appointment_slots
           (doctor_id, slot_date, starts_at, ends_at, starts_at_tz, ends_at_tz, specialty_id)
         VALUES ${tuples.join(',\n                ')}
         ON CONFLICT (doctor_id, slot_date, starts_at) DO NOTHING`,
        params
      );
      inserted = res.rowCount;
    }

    // 2. Re-open slots that are available again (doctor un-blocked the window).
    const startList = planned.map((s) => s.start);
    if (startList.length) {
      await client.query(
        `UPDATE appointment_slots s
            SET status = 'open'
          WHERE s.doctor_id = $1 AND s.slot_date = $2 AND s.status = 'blocked'
            AND s.starts_at = ANY($3::time[])
            AND NOT EXISTS (
                  SELECT 1 FROM appointments a
                   WHERE a.slot_id = s.id AND a.status = ANY($4::text[])
            )`,
        [doctorId, dateStr, startList, ACTIVE_STATUSES]
      );
    }

    // 3. Block slots no longer offered (day off, window carved out, hours cut).
    const changed = await client.query(
      `UPDATE appointment_slots
          SET status = 'blocked'
        WHERE doctor_id = $1 AND slot_date = $2 AND status = 'open'
          AND starts_at <> ALL($3::time[])`,
      [doctorId, dateStr, startList] // empty array blocks every open slot of the day
    );

    return { inserted, blocked: changed.rowCount, changed: inserted + changed.rowCount > 0 };
  });
}

/**
 * Availability grid for one date, safe to show to any authorised viewer:
 * only reveals whether a slot is occupied and whether it is *the caller's*.
 */
async function getDaySlots(doctorId, dateStr, viewer = {}) {
  await ensureSlotsForDate(doctorId, dateStr);

  const { rows } = await query(
    `SELECT s.id, s.slot_date, to_char(s.starts_at, 'HH24:MI') AS start_time,
            to_char(s.ends_at, 'HH24:MI')   AS end_time,
            s.starts_at_tz, s.ends_at_tz, s.status,
            (a.id IS NOT NULL) AS occupied,
            CASE WHEN a.patient_id = $3 THEN a.id END        AS my_appointment_id,
            CASE WHEN a.patient_id = $3 THEN a.status END    AS my_appointment_status
       FROM appointment_slots s
       LEFT JOIN appointments a
              ON a.slot_id = s.id AND a.status = ANY($4::text[])
      WHERE s.doctor_id = $1 AND s.slot_date = $2
      ORDER BY s.starts_at`,
    [doctorId, dateStr, viewer.patientId || -1, ACTIVE_STATUSES]
  );

  const minLeadMs = config.booking.minLeadMinutes * 60_000;
  const nowMs = Date.now();

  return rows.map((r) => {
    const startsMs = new Date(r.starts_at_tz).getTime();
    // Slots that are gone (or inside the minimum booking lead time) can never
    // be booked, so they are reported as unavailable rather than left open —
    // otherwise the grid offers times the booking engine will reject.
    const past = startsMs <= nowMs + minLeadMs;
    return {
      id: r.id,
      date: r.slot_date,
      start: r.start_time,
      end: r.end_time,
      startsAt: r.starts_at_tz,
      endsAt: r.ends_at_tz,
      status: r.status,
      past,
      available: r.status === 'open' && !r.occupied && !past,
      myAppointmentId: r.my_appointment_id,
      myAppointmentStatus: r.my_appointment_status,
    };
  });
}

/**
 * Cheap "which days have openings" summary for doctor search results.
 * Theoretical slots (from the weekly schedule + overrides) minus taken ones.
 *
 * Slots that start inside the booking lead time are excluded from both sides:
 * they can never be booked, so counting them made the summary advertise today's
 * morning as open all evening and disagree with getDaySlots.
 */
async function availabilitySummary(doctorId, { from, days = 30 } = {}) {
  const start = from && isValidDateStr(from) ? from : todayInTz(config.appTz);
  const end = addDays(start, days);
  const nowMs = Date.now();
  const leadMs = config.booking.minLeadMinutes * 60_000;

  const { schedules, overridesByDate } = await fetchScheduleRowsForRange(doctorId, start, end);
  const { rows: taken } = await query(
    `SELECT slot_date, COUNT(*) AS taken
       FROM appointment_slots
      WHERE doctor_id = $1 AND slot_date BETWEEN $2 AND $3 AND status <> 'open'
        AND starts_at_tz > now() + make_interval(mins => $4)
      GROUP BY slot_date`,
    [doctorId, start, end, config.booking.minLeadMinutes]
  );
  const takenByDate = new Map(taken.map((t) => [t.slot_date, Number(t.taken)]));

  const summary = [];
  for (let i = 0; i <= days; i += 1) {
    const date = addDays(start, i);
    // Only the windows the doctor actually works *that weekday*. The rows are
    // loaded once for the whole range, so without this filter every date gets
    // the union of Monday..Saturday and the summary advertises openings on a
    // day the doctor does not work — which the booking engine then rejects.
    const daySchedules = schedules.filter((s) => Number(s.weekday) === weekdayOf(date));
    const { windows } = computeWindows(daySchedules, overridesByDate.get(date) || []);
    const bookable = expandSlots(windows).filter(
      (s) => zonedTimeToUtc(date, `${s.start}:00`, config.appTz).getTime() > nowMs + leadMs
    ).length;
    const open = bookable - (takenByDate.get(date) || 0);
    if (bookable > 0) summary.push({ date, open: Math.max(0, open), total: bookable });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Booking policy
// ---------------------------------------------------------------------------
function assertBookable(slot, { bypassLead = false } = {}) {
  const now = Date.now();
  const start = new Date(slot.starts_at_tz).getTime();
  const minLead = config.booking.minLeadMinutes * 60_000;
  const maxHorizon = config.booking.maxHorizonDays * 86_400_000;

  if (Number.isNaN(start)) throw ApiError.unprocessable('Slot has no valid start time.');
  if (start <= now) throw ApiError.unprocessable('That time slot is in the past.');
  if (!bypassLead && start < now + minLead) {
    throw ApiError.unprocessable(
      `Appointments must be booked at least ${config.booking.minLeadMinutes} minutes in advance.`
    );
  }
  if (start > now + maxHorizon) {
    throw ApiError.unprocessable(
      `Appointments can only be booked up to ${config.booking.maxHorizonDays} days ahead.`
    );
  }
  if (slot.status !== 'open') throw ApiError.conflict('That time slot is no longer available.');
  if (slot.accepting_new_patients === false) {
    throw ApiError.unprocessable('This doctor is not accepting new patients right now.');
  }
  if (!slot.specialty_id) {
    throw ApiError.unprocessable('This doctor has no specialty configured yet.');
  }
}

async function assertNoClash(client, { patientId, doctorId, at, excludeAppointmentId }) {
  const { rows } = await client.query(
    `SELECT id FROM appointments
      WHERE status = ANY($4::text[])
        AND scheduled_for = $3
        AND (($1::bigint IS NOT NULL AND patient_id = $1)
          OR ($2::bigint IS NOT NULL AND doctor_id = $2))
        AND ($5::bigint IS NULL OR id <> $5)
      LIMIT 1`,
    [patientId ?? null, doctorId ?? null, at, ACTIVE_STATUSES, excludeAppointmentId ?? null]
  );
  if (rows[0]) {
    throw ApiError.conflict('There is already an appointment at that time.', {
      appointmentId: rows[0].id,
    });
  }
}

// ---------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------
async function bookAppointment({ req, patientId, slotId, reason, symptoms }) {
  const outcome = await withTransaction(async (client) => {
    const slot = await lockSlot(client, slotId);
    assertBookable(slot);

    await assertNoClash(client, { patientId, doctorId: slot.doctor_id, at: slot.starts_at_tz });

    const appointment = await insertAppointment(client, {
      patientId,
      doctorId: slot.doctor_id,
      slotId: slot.id,
      specialtyId: slot.specialty_id,
      status: 'pending',
      reason,
      symptoms,
      slot,
    });

    await setSlotStatus(client, slot.id, 'booked');

    await audit(
      req,
      {
        action: ACTIONS.APPOINTMENT_BOOKED,
        entityType: 'appointment',
        entityId: appointment.id,
        patientId,
        metadata: {
          doctorId: slot.doctor_id,
          slotId: slot.id,
          scheduledFor: slot.starts_at_tz,
          status: appointment.status,
        },
      },
      client
    );

    return appointment;
  });

  publishSlotChange({
    doctorId: outcome.doctor_id,
    slotId: outcome.slot_id,
    slotDate: outcome.scheduled_date,
    status: 'booked',
    reason: 'booked',
    appointmentId: outcome.id,
  });

  return outcome;
}

// ---------------------------------------------------------------------------
// Cancel  (frees the slot, then hands it to the waitlist queue)
// ---------------------------------------------------------------------------
async function cancelAppointment({ req, appointmentId, reason, actorRole }) {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM appointments WHERE id = $1 FOR UPDATE`,
      [appointmentId]
    );
    const appointment = rows[0];
    if (!appointment) throw ApiError.notFound('Appointment not found.');

    if (!ACTIVE_STATUSES.includes(appointment.status)) {
      throw ApiError.conflict(
        `An appointment that is '${appointment.status}' can no longer be cancelled.`
      );
    }

    const started = new Date(appointment.scheduled_for).getTime() <= Date.now();
    if (actorRole === 'patient' && started) {
      throw ApiError.conflict('This appointment has already started and cannot be cancelled.');
    }

    const slot = await lockSlot(client, appointment.slot_id);
    const status = actorRole === 'patient' ? 'cancelled_by_patient' : 'cancelled_by_doctor';

    const { rows: updated } = await client.query(
      `UPDATE appointments
          SET status = $2, cancelled_at = now(), cancellation_reason = $3
        WHERE id = $1
        RETURNING *`,
      [appointment.id, status, reason || null]
    );

    await setSlotStatus(client, slot.id, 'open');

    await audit(
      req,
      {
        action: ACTIONS.APPOINTMENT_CANCELLED,
        entityType: 'appointment',
        entityId: appointment.id,
        patientId: appointment.patient_id,
        metadata: {
          by: actorRole,
          previousStatus: appointment.status,
          scheduledFor: appointment.scheduled_for,
          reason: reason || 'not stated',
        },
      },
      client
    );

    // The whole point of the waitlist: the moment a slot is released it is
    // offered to the highest-priority eligible patient, atomically.
    const filled = await waitlist.fillSlot({ req, slot, client, reason: 'cancellation' });

    return { appointment: updated[0], filled };
  });

  const appt = result.appointment;
  publishSlotChange({
    doctorId: appt.doctor_id,
    slotId: appt.slot_id,
    slotDate: appt.scheduled_date,
    status: result.filled ? 'booked' : 'open',
    reason: result.filled ? 'waitlist_filled' : 'cancelled',
    appointmentId: appt.id,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Reschedule (move to another slot, atomically)
// ---------------------------------------------------------------------------
async function rescheduleAppointment({ req, appointmentId, newSlotId, actorRole, reason }) {
  const bypassLead = actorRole !== 'patient';

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM appointments WHERE id = $1 FOR UPDATE`, [
      appointmentId,
    ]);
    const appointment = rows[0];
    if (!appointment) throw ApiError.notFound('Appointment not found.');
    if (!ACTIVE_STATUSES.includes(appointment.status)) {
      throw ApiError.conflict(
        `An appointment that is '${appointment.status}' cannot be rescheduled.`
      );
    }

    // Lock both slots in a stable order to avoid deadlocks between two
    // concurrent moves that swap times.
    const ids = [...new Set([appointment.slot_id, newSlotId])].sort((a, b) => a - b);
    await client.query(`SELECT id FROM appointment_slots WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [ids]);

    const newSlot = await lockSlot(client, newSlotId);
    const oldSlot = await lockSlot(client, appointment.slot_id);

    assertBookable(newSlot, { bypassLead });

    await assertNoClash(client, {
      patientId: appointment.patient_id,
      doctorId: appointment.doctor_id,
      at: newSlot.starts_at_tz,
      excludeAppointmentId: appointment.id,
    });

    const { rows: updated } = await client.query(
      `UPDATE appointments
          SET slot_id = $2, scheduled_for = $3, scheduled_date = $4, scheduled_time = $5,
              reschedule_count = reschedule_count + 1
        WHERE id = $1
        RETURNING *`,
      [appointment.id, newSlot.id, newSlot.starts_at_tz, newSlot.slot_date, newSlot.starts_at]
    );

    await setSlotStatus(client, oldSlot.id, 'open');
    await setSlotStatus(client, newSlot.id, 'booked');

    await audit(
      req,
      {
        action: ACTIONS.APPOINTMENT_RESCHEDULED,
        entityType: 'appointment',
        entityId: appointment.id,
        patientId: appointment.patient_id,
        metadata: {
          by: actorRole,
          from: { slotId: oldSlot.id, at: oldSlot.starts_at_tz },
          to: { slotId: newSlot.id, at: newSlot.starts_at_tz },
          reason: reason || 'not stated',
        },
      },
      client
    );

    // The abandoned time becomes bookable again — hand it to the waitlist.
    const filled = await waitlist.fillSlot({
      req,
      slot: oldSlot,
      client,
      reason: 'rescheduled',
    });

    return { appointment: updated[0], filled, freedSlot: oldSlot };
  });

  const appt = result.appointment;
  publishSlotChange({
    doctorId: appt.doctor_id,
    slotId: appt.slot_id,
    slotDate: appt.scheduled_date,
    status: 'booked',
    reason: 'rescheduled',
    appointmentId: appt.id,
  });
  publishSlotChange({
    doctorId: appt.doctor_id,
    slotId: result.freedSlot.id,
    slotDate: result.freedSlot.slot_date,
    status: result.filled ? 'booked' : 'open',
    reason: result.filled ? 'waitlist_filled' : 'released',
  });

  return result;
}

module.exports = {
  ACTIVE_STATUSES,
  computeWindows,
  expandSlots,
  subtractWindow,
  mergeWindows,
  fetchScheduleRowsForRange,
  ensureSlotsForDate,
  getDaySlots,
  availabilitySummary,
  assertBookable,
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
};
