'use strict';

const { ApiError } = require('../utils/errors');

/**
 * Role-Based Access Control.
 *
 * Layer 1 — route gate:   requireRole('doctor')
 * Layer 2 — ownership:    assertOwnership(...) inside controllers, because a
 *                         valid patient token must never read another
 *                         patient's record just by guessing an id.
 *
 * Roles are mutually exclusive and hierarchical only in the sense that an
 * admin is granted explicit routes; there is no implicit elevation.
 */

const ROLES = Object.freeze(['patient', 'doctor', 'admin']);

function requireRole(...allowedRoles) {
  const allowed = allowedRoles.flat();
  for (const role of allowed) {
    if (!ROLES.includes(role)) throw new Error(`Unknown role in requireRole: ${role}`);
  }

  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!allowed.includes(req.user.role)) {
      return next(
        new ApiError(403, 'FORBIDDEN', `This area is restricted to: ${allowed.join(', ')}.`)
      );
    }
    return next();
  };
}

/**
 * Guard for routes addressed to a user id (`/users/:userId` style).
 * The user may act on themselves, or on anyone if they hold an allowed role.
 */
function requireSelfOrRole(paramName, ...allowedRoles) {
  const allowed = allowedRoles.flat();
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    const targetId = String(req.params[paramName] ?? '');
    const isSelf = targetId === String(req.user.id);
    if (isSelf || allowed.includes(req.user.role)) return next();
    return next(new ApiError(403, 'FORBIDDEN', 'You may only access your own records.'));
  };
}

/** Throws unless `ownerId` belongs to the caller (admins always pass). */
function assertOwnership(req, ownerId, message = 'You may only access your own records.') {
  if (req.user.role === 'admin') return;
  if (String(ownerId) !== String(req.user.id)) throw ApiError.forbidden(message);
}

/** Throws unless the caller is an admin. Used for admin-only data exports. */
function assertAdmin(req) {
  if (req.user?.role !== 'admin') throw ApiError.forbidden();
}

/**
 * Load an appointment and prove the caller may act on it.
 * Returns 404 (not 403) for a record the caller cannot touch, so ids cannot be
 * probed for existence by iterating over them.
 *
 * @param {import('express').Request} req
 * @param {number|string} appointmentId
 * @param {'patient'|'doctor'} expected  which side of the encounter must own it
 * @returns {Promise<object>} the appointment row
 */
async function loadOwnedAppointment(req, appointmentId, expected) {
  const { queryOne } = require('../config/db');
  const appointment = await queryOne(`SELECT * FROM appointments WHERE id = $1`, [appointmentId]);
  if (!appointment) throw ApiError.notFound('Appointment not found.');

  const owns =
    req.user.role === 'admin' ||
    (expected === 'patient' && appointment.patient_id === req.user.id) ||
    (expected === 'doctor' && appointment.doctor_id === req.user.id);

  if (!owns) throw ApiError.notFound('Appointment not found.');
  return appointment;
}

module.exports = {
  ROLES,
  requireRole,
  requireSelfOrRole,
  assertOwnership,
  assertAdmin,
  loadOwnedAppointment,
};
