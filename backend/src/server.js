'use strict';

/**
 * Process entry point: verify the database, start HTTP, run the waitlist
 * maintenance sweep, and shut down cleanly.
 */

const config = require('./config/env');
const app = require('./app');
const { pool, closePool } = require('./config/db');
const waitlist = require('./services/waitlistQueue');

const SWEEP_INTERVAL_MS = config.waitlist.sweepIntervalMinutes * 60_000;

async function assertDatabase(retries = 10) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt === retries) {
        // eslint-disable-next-line no-console
        console.error(
          `\n[qrus] Cannot reach PostgreSQL.\n` +
            `  DATABASE_URL = ${config.databaseUrl.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')}\n` +
            `  Start PostgreSQL, create the database, then run:  npm run migrate && npm run seed\n` +
            `  Underlying error: ${err.message}\n`
        );
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

function startWaitlistSweep() {
  if (config.isTest) return null;

  const timer = setInterval(async () => {
    try {
      await waitlist.expireStale();
      const matched = await waitlist.sweep({ limit: 25 });
      if (matched.length) {
        // eslint-disable-next-line no-console
        console.log(`[qrus] waitlist sweep matched ${matched.length} patient(s) to open slots`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[qrus] waitlist sweep error:', err.message);
    }
  }, SWEEP_INTERVAL_MS);

  timer.unref();
  return timer;
}

async function main() {
  await assertDatabase();

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `\n  Qrus API listening on http://localhost:${config.port}  (${config.env})\n` +
        `  Health:  http://localhost:${config.port}/health\n` +
        `  Timezone: ${config.appTz} | booking lead ${config.booking.minLeadMinutes}m | ` +
        `horizon ${config.booking.maxHorizonDays}d | waitlist sweep ${config.waitlist.sweepIntervalMinutes}m\n`
    );
  });

  // SSE needs the socket kept alive; clients also rely on server timeouts being
  // longer than the 25s heartbeat.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  const sweepTimer = startWaitlistSweep();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`\n[qrus] ${signal} received — draining connections...`);

    if (sweepTimer) clearInterval(sweepTimer);
    server.close(async () => {
      await closePool().catch(() => {});
      // eslint-disable-next-line no-console
      console.log('[qrus] shutdown complete');
      process.exit(0);
    });

    // Never hang forever on a stuck SSE connection.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[qrus] unhandled rejection:', reason);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[qrus] fatal startup error:', err);
  process.exit(1);
});
