'use strict';

/**
 * Apply database/schema.sql then database/seed.sql (reference data only —
 * specialties and the symptom vocabulary). Idempotent: every statement in the
 * schema uses IF NOT EXISTS / CREATE OR REPLACE.
 *
 *   npm run migrate
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config/env');
const { pool, closePool } = require('../src/config/db');

async function runFile(filename) {
  const file = path.join(config.paths.database, filename);
  const sql = fs.readFileSync(file, 'utf8');
  process.stdout.write(`  -> applying ${filename} ... `);
  await pool.query(sql);
  process.stdout.write('ok\n');
}

async function main() {
  process.stdout.write('[qrus] running migrations\n');
  try {
    await pool.query('SELECT 1');
    await runFile('schema.sql');
    await runFile('seed.sql');

    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM specialties)::int  AS specialties,
              (SELECT COUNT(*) FROM symptom_rules)::int AS rules`
    );
    process.stdout.write(
      `[qrus] schema ready — ${rows[0].specialties} specialties, ${rows[0].rules} symptom rules\n`
    );
  } catch (err) {
    console.error(`\n[qrus] migration failed: ${err.message}`);
    if (err.position) console.error(`  near: ${err.position}`);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

main();
