'use strict';

const { Pool } = require('pg');
const config = require('./env');

const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(String(value));

// Deterministic type mapping:
//  numeric -> number (fees, ratings), int8 -> number (BIGSERIAL ids)
//  date/time -> 'YYYY-MM-DD' / 'HH:MM:SS' strings, never Date objects, so a
//  clinic wall-clock time is never silently shifted through the server TZ.
require('pg').types.setTypeParser(1700, (value) => parseFloat(value)); // numeric
require('pg').types.setTypeParser(20, (value) => Number(value)); // int8
require('pg').types.setTypeParser(1082, (value) => value); // date
require('pg').types.setTypeParser(1083, (value) => value); // time

function buildPoolConfig() {
  const base = {
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Declare UTF-8 explicitly. Chat replies, doctor bios and patient-entered
    // text routinely contain non-ASCII characters; without this the client
    // encoding falls back to whatever the server cluster was built with.
    client_encoding: 'UTF8',
  };

  // Managed Postgres (Fly, Render, RDS, …) always speaks TLS, usually with a
  // private CA that node cannot verify out of the box — so verification is
  // opt-in via DB_SSL_VERIFY=true. TLS is enabled when the URL carries an
  // `sslmode=` (every provider connection string does; disable = plain TCP
  // for local dev) or when DATABASE_SSL=true is set explicitly. TLS is never
  // assumed from NODE_ENV alone: plenty of production databases are plain
  // TCP inside a private network.
  const urlSsl = /sslmode=([^&]+)/i.exec(config.databaseUrl);
  if (urlSsl) {
    if (urlSsl[1].toLowerCase() !== 'disable') {
      base.ssl = { rejectUnauthorized: bool(process.env.DB_SSL_VERIFY, false) };
    }
    return base;
  }
  if (bool(process.env.DATABASE_SSL, false)) {
    base.ssl = { rejectUnauthorized: bool(process.env.DB_SSL_VERIFY, false) };
  }
  return base;
}

const pool = new Pool(buildPoolConfig());

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[qrus] unexpected idle client error:', err.message);
});

/**
 * A database created with a legacy encoding (WIN1252, LATIN1) silently rejects
 * any Unicode a handler tries to store — the write fails deep inside a request
 * as a 500. Warn once at startup so a mis-encoded database is obvious before
 * a patient hits it.
 */
let encodingWarned = false;
async function checkEncoding() {
  if (encodingWarned) return;
  encodingWarned = true;
  try {
    const { rows } = await pool.query('SHOW server_encoding');
    const encoding = String(rows[0]?.server_encoding || '');
    if (encoding && encoding.toLowerCase() !== 'utf8') {
      // eslint-disable-next-line no-console
      console.warn(
        `[qrus] WARNING: database server encoding is ${encoding}, not UTF8.\n` +
          '         Unicode in stored text (chat replies, patient input) will fail.\n' +
          `         Recreate the database with: CREATE DATABASE <name> ENCODING 'UTF8' TEMPLATE template0;`
      );
    }
  } catch (err) {
    encodingWarned = false; // let a later query retry; never mask the real one
  }
}

/**
 * Run a parameterised query.
 * Never interpolate values into SQL text — $1..$n only.
 */
async function query(text, params) {
  const started = Date.now();
  await checkEncoding();
  try {
    const res = await pool.query(text, params);
    if (process.env.NODE_ENV !== 'test' && Date.now() - started > 500) {
      // eslint-disable-next-line no-console
      console.warn(`[qrus] slow query (${Date.now() - started}ms): ${text.slice(0, 120)}`);
    }
    return res;
  } catch (err) {
    err.query = text;
    throw err;
  }
}

/** Convenience: first row or null. */
async function queryOne(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

/**
 * Execute `fn(client)` inside a transaction.
 * Commits on success, rolls back on any throw, always releases the client.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' }} [options]
 * @returns {Promise<T>}
 */
async function withTransaction(fn, options = {}) {
  const client = await pool.connect();
  const isolation = options.isolation || 'READ COMMITTED';
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      err.rollbackError = rollbackErr;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function healthcheck() {
  const res = await query('SELECT 1 AS ok');
  return res.rows[0].ok === 1;
}

async function closePool() {
  await pool.end();
}

module.exports = { pool, query, queryOne, withTransaction, healthcheck, closePool };
