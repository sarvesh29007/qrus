'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

function parseDuration(value, fallback) {
  // Supports "15m", "30s", "7d", "12h" or a plain number of seconds.
  if (!value) return fallback;
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(String(value).trim());
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return amount * factor;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/** Strict number parse — a typo in .env must not leak NaN into SQL. */
function num(value, fallback) {
  const parsed = Number(value);
  return value === undefined || value === '' || Number.isNaN(parsed) ? fallback : parsed;
}

const secret = process.env.JWT_SECRET;

if (!secret) {
  if (isProduction) {
    throw new Error('JWT_SECRET is required in production');
  }
  if (!isTest) {
    // eslint-disable-next-line no-console
    console.warn('[qrus] JWT_SECRET not set — using an ephemeral development secret.');
  }
}

const config = {
  env: NODE_ENV,
  isProduction,
  isTest,
  port: num(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/qrus',
  dbPoolMax: num(process.env.DB_POOL_MAX, 10),

  jwt: {
    // In dev an ephemeral secret keeps the app zero-config; sessions simply
    // reset when the server restarts. Production refuses to boot without one.
    secret: secret || crypto.randomBytes(48).toString('hex'),
    accessTtlSeconds: parseDuration(process.env.JWT_ACCESS_TTL, 15 * 60),
    refreshTtlDays: num(process.env.JWT_REFRESH_TTL_DAYS, 30),
  },

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  appTz: process.env.APP_TZ || 'UTC',

  booking: {
    minLeadMinutes: num(process.env.SLOT_MIN_LEAD_MINUTES, 30),
    maxHorizonDays: num(process.env.SLOT_MAX_HORIZON_DAYS, 60),
  },

  waitlist: {
    ttlDays: num(process.env.WAITLIST_ENTRY_TTL_DAYS, 7),
    sweepIntervalMinutes: num(process.env.WAITLIST_SWEEP_INTERVAL_MINUTES, 15),
  },

  auditStrict: bool(process.env.AUDIT_STRICT, false),

  // Optional free-form phrasing classifier. Absent key => the deterministic
  // rule classifier handles every intent, so the chatbot works with zero setup.
  llm: {
    provider: (process.env.LLM_PROVIDER || 'openai').toLowerCase(),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 8000),
  },

  paths: {
    root: path.resolve(__dirname, '..', '..'),
    database: path.resolve(__dirname, '..', '..', '..', 'database'),
  },
};

module.exports = config;
