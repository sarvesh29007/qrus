'use strict';

const { query } = require('../config/db');
const config = require('../config/env');

/**
 * Append-only audit trail.
 *
 * Every medical action (booking, cancelling, rescheduling, opening a patient
 * record, moderating a review, changing access) MUST call `audit()`. The row
 * records *who* did *what* to *whose* record, from *where*, with the request
 * correlation id, so an incident can be reconstructed end to end.
 *
 * Failure policy: by default a broken audit write is logged loudly but does
 * not roll back a clinical action; set AUDIT_STRICT=true to make the action
 * fail closed instead (the stricter posture for regulated deployments).
 */

const ACTIONS = Object.freeze({
  // auth / access
  USER_REGISTERED: 'user.registered',
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_STATUS_CHANGED: 'user.status_changed',
  USER_ROLE_CHANGED: 'user.role_changed',
  // scheduling
  APPOINTMENT_BOOKED: 'appointment.booked',
  APPOINTMENT_ACCEPTED: 'appointment.accepted',
  APPOINTMENT_DECLINED: 'appointment.declined',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  APPOINTMENT_RESCHEDULED: 'appointment.rescheduled',
  APPOINTMENT_COMPLETED: 'appointment.completed',
  APPOINTMENT_NO_SHOW: 'appointment.no_show',
  // sensitive reads (break-glass visibility)
  RECORD_VIEWED: 'record.viewed',
  SYMPTOMS_VIEWED: 'record.symptoms_viewed',
  // waitlist
  WAITLIST_JOINED: 'waitlist.joined',
  WAITLIST_LEFT: 'waitlist.left',
  WAITLIST_FILLED: 'waitlist.filled',
  WAITLIST_EXPIRED: 'waitlist.expired',
  // reviews
  REVIEW_CREATED: 'review.created',
  REVIEW_MODERATED: 'review.moderated',
  // pre-consultation intake (collected in chat, read by the doctor)
  INTAKE_SUBMITTED: 'intake.submitted',
  INTAKE_VIEWED: 'intake.viewed',
  // schedules
  SCHEDULE_UPDATED: 'schedule.updated',
  SCHEDULE_OVERRIDE_CREATED: 'schedule.override_created',
  SCHEDULE_OVERRIDE_DELETED: 'schedule.override_deleted',
});

/**
 * @param {import('express').Request} req  (may be a bare { user, ctx } in jobs)
 * @param {object} entry
 * @param {string} entry.action
 * @param {string} entry.entityType
 * @param {string|number|null} [entry.entityId]
 * @param {string|number|null} [entry.patientId] whose care record was touched
 * @param {'success'|'failure'} [entry.outcome]
 * @param {object} [entry.metadata]  non-secret context only
 * @param {import('pg').PoolClient} [client] write inside an open transaction so
 *        the audit row commits (or rolls back) atomically with the action
 */
async function audit(req = {}, entry, client = null) {
  const actor = req.user || null;
  const ctx = req.ctx || {};

  const params = [
    actor ? actor.id : null,
    actor ? actor.role : 'system',
    entry.action,
    entry.entityType,
    entry.entityId != null ? String(entry.entityId) : null,
    entry.patientId != null ? entry.patientId : null,
    entry.outcome || 'success',
    JSON.stringify(sanitize(entry.metadata || {})),
    ctx.ip || null,
    ctx.userAgent || null,
    ctx.requestId || null,
  ];

  const run = client ? (text, values) => client.query(text, values) : query;

  try {
    await run(
      `INSERT INTO audit_logs
         (actor_id, actor_role, action, entity_type, entity_id, patient_id,
          outcome, metadata, ip_address, user_agent, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::inet,$10,$11)`,
      params
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[qrus] AUDIT WRITE FAILED (${entry.action}):`, err.message);
    if (config.auditStrict) throw err;
  }
}

/** Strip anything that smells like a credential before it reaches the DB. */
const SENSITIVE_KEYS = /pass|secret|token|authorization|hash|otp|ssn|diagnosis/i;

function sanitize(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEYS.test(key)) continue;
    if (value instanceof Date) out[key] = value.toISOString();
    else if (value && typeof value === 'object') out[key] = sanitize(value);
    else if (typeof value === 'string') out[key] = value.slice(0, 500);
    else out[key] = value;
  }
  return out;
}

module.exports = { audit, ACTIONS, sanitize };
