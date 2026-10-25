'use strict';

const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config/env');
const { queryOne, query, withTransaction } = require('../config/db');
const { ApiError, asyncHandler } = require('../utils/errors');
const { signAccessToken, signRefreshToken, verify, hashToken } = require('../utils/jwt');
const { audit, ACTIONS } = require('../services/audit.service');

const SALT_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter.')
  .regex(/[0-9]/, 'Password must contain a number.');

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  // NOTE: 'admin' is deliberately absent — admin accounts are provisioned by
  // an existing admin, never self-served through the public API.
  role: z.enum(['patient', 'doctor']).default('patient'),
  // doctor-only fields
  specialtyId: z.coerce.number().int().positive().optional(),
  licenseNumber: z.string().trim().min(3).max(60).optional(),
  bio: z.string().trim().max(1000).optional(),
  yearsExperience: z.coerce.number().int().min(0).max(60).optional(),
  consultationFee: z.coerce.number().min(0).max(100000).optional(),
  clinicName: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});

const refreshSchema = z.object({ refreshToken: z.string().min(20).max(4000) });

const PUBLIC_USER_COLUMNS = 'id, email, full_name, phone, role, status, last_login_at, created_at';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let timingHash = null;
/** Compare against a real hash when the account does not exist, so response
 *  timing does not reveal whether an email is registered. */
function equalizeTiming() {
  if (!timingHash) timingHash = bcrypt.hashSync('qrus-timing-equalizer', SALT_ROUNDS);
  return bcrypt.compare('qrus-timing-equalizer', timingHash);
}

async function issueTokens(req, user, client = null) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  const run = client ? (text, values) => client.query(text, values) : query;
  await run(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4::inet, $5)`,
    [
      user.id,
      hashToken(refreshToken),
      config.jwt.refreshTtlDays,
      req.ctx?.ip || null,
      req.ctx?.userAgent || null,
    ]
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: config.jwt.accessTtlSeconds,
    refreshExpiresInDays: config.jwt.refreshTtlDays,
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    phone: user.phone,
    role: user.role,
    status: user.status,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
  };
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
const register = asyncHandler(async (req, res) => {
  const body = req.body;
  const isDoctor = body.role === 'doctor';

  if (isDoctor && (!body.specialtyId || !body.licenseNumber)) {
    throw ApiError.badRequest('Doctors must provide a specialty and a license number.');
  }

  const existing = await queryOne(`SELECT id FROM users WHERE lower(email) = lower($1)`, [
    body.email,
  ]);
  if (existing) throw ApiError.conflict('An account with that email already exists.');

  const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);
  const status = isDoctor ? 'pending' : 'active';

  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, full_name, phone, role, status)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${PUBLIC_USER_COLUMNS}`,
      [
        body.email.toLowerCase(),
        passwordHash,
        body.fullName,
        body.phone || null,
        body.role,
        status,
      ]
    );
    const created = rows[0];

    if (isDoctor) {
      const specialty = await client.query(`SELECT id FROM specialties WHERE id = $1 AND is_active`, [
        body.specialtyId,
      ]);
      if (!specialty.rows[0]) throw ApiError.badRequest('Unknown specialty.');
      await client.query(
        `INSERT INTO doctor_profiles
           (user_id, specialty_id, license_number, bio, years_experience,
            consultation_fee, clinic_name, city)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          created.id,
          body.specialtyId,
          body.licenseNumber,
          body.bio || '',
          body.yearsExperience || 0,
          body.consultationFee || 0,
          body.clinicName || null,
          body.city || null,
        ]
      );
    }

    await audit(
      req,
      {
        action: ACTIONS.USER_REGISTERED,
        entityType: 'user',
        entityId: created.id,
        metadata: { role: created.role, status, specialtyId: body.specialtyId || null },
      },
      client
    );

    return created;
  });

  if (isDoctor) {
    return res.status(201).json({
      user: publicUser(user),
      pendingApproval: true,
      message:
        'Your doctor account was created and is awaiting administrator approval. You will be able to sign in once it is activated.',
    });
  }

  const tokens = await issueTokens(req, user);
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

  res.status(201).json({ user: publicUser(user), ...tokens });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await queryOne(
    `SELECT ${PUBLIC_USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email]
  );

  if (!user) {
    await equalizeTiming();
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

  if (user.status === 'suspended') {
    await audit(req, {
      action: ACTIONS.USER_LOGIN,
      entityType: 'user',
      entityId: user.id,
      outcome: 'failure',
      metadata: { reason: 'suspended' },
    });
    throw ApiError.forbidden('This account has been suspended. Contact your administrator.');
  }
  if (user.status === 'pending') {
    throw new ApiError(403, 'ACCOUNT_PENDING', 'This account is awaiting administrator approval.');
  }

  const tokens = await issueTokens(req, user);
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

  await audit(req, {
    action: ACTIONS.USER_LOGIN,
    entityType: 'user',
    entityId: user.id,
    metadata: { role: user.role },
  });

  res.json({ user: publicUser(user), ...tokens });
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh  (rotating refresh token)
// ---------------------------------------------------------------------------
const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  let payload;
  try {
    payload = verify(refreshToken, 'refresh');
  } catch (err) {
    throw ApiError.unauthorized('Refresh token is invalid or expired.');
  }

  const tokenHash = hashToken(refreshToken);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT rt.id, rt.user_id, u.status, u.role
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
          AND rt.revoked_at IS NULL
          AND rt.expires_at > now()
        FOR UPDATE OF rt`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row) throw ApiError.unauthorized('Refresh token is invalid or expired.');
    if (row.status !== 'active') {
      throw new ApiError(403, 'ACCOUNT_UNAVAILABLE', 'This account is not active.');
    }

    const user = {
      id: row.user_id,
      role: row.role,
    };

    const tokens = await issueTokens({ ctx: req.ctx }, user, client);

    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = (
         SELECT id FROM refresh_tokens WHERE token_hash = $2
       ) WHERE id = $1`,
      [row.id, hashToken(tokens.refreshToken)]
    );

    const fresh = await client.query(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [
      row.user_id,
    ]);
    return { tokens, user: fresh.rows[0] };
  });

  res.json({ user: publicUser(result.user), ...result.tokens });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
const logout = asyncHandler(async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (parsed.success) {
    await query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(parsed.data.refreshToken)]
    );
  }
  await audit(req, { action: ACTIONS.USER_LOGOUT, entityType: 'user', entityId: req.user.id });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
const me = asyncHandler(async (req, res) => {
  const user = await queryOne(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [
    req.user.id,
  ]);

  let profile = null;
  if (user.role === 'doctor') {
    profile = await queryOne(
      `SELECT dp.specialty_id, s.name AS specialty_name, s.slug AS specialty_slug,
              dp.license_number, dp.bio, dp.years_experience, dp.consultation_fee,
              dp.clinic_name, dp.city, dp.languages, dp.accepting_new_patients,
              dp.rating_avg, dp.rating_count
         FROM doctor_profiles dp
         JOIN specialties s ON s.id = dp.specialty_id
        WHERE dp.user_id = $1`,
      [user.id]
    );
  }

  res.json({ user: publicUser(user), profile });
});

module.exports = {
  register,
  login,
  refresh,
  logout,
  me,
  schemas: { registerSchema, loginSchema, refreshSchema },
};
