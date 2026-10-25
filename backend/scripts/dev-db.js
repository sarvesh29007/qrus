// Local development database: boots an embedded PostgreSQL against
// ./.tmp-pgdata so the Qrus stack can run on a machine with no system
// Postgres installed (`npm run dev:db`). Requires the devDependency
// `embedded-postgres`, which downloads a PostgreSQL build on first install.
// Not used in production — production points DATABASE_URL at real Postgres.
const EmbeddedPostgres = require('embedded-postgres').default;

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: './.tmp-pgdata',
    user: 'postgres',
    password: 'postgres',
    port: 5433,
    persistent: true,
  });
  await pg.initialise();
  await pg.start();

  // The chatbot stores emoji (✅ ⚠️) in its replies, and a cluster initialised
  // from a WIN1252 Windows locale rejects those inserts outright. `createDatabase`
  // cannot set an encoding, so create the app database explicitly as UTF8 from
  // template0; an existing one is left untouched.
  const { Client } = require('pg');
  const admin = new Client({
    connectionString: 'postgresql://postgres:postgres@localhost:5433/postgres',
  });
  await admin.connect();
  try {
    const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'qrus_utf8'`);
    if (rows.length) {
      console.log('db exists: qrus_utf8');
    } else {
      await admin.query(`CREATE DATABASE qrus_utf8 WITH ENCODING 'UTF8' TEMPLATE template0`);
      console.log('created UTF8 database qrus_utf8');
    }
  } finally {
    await admin.end();
  }
  console.log('PG_READY');
  console.log('DATABASE_URL=postgresql://postgres:postgres@localhost:5433/qrus_utf8');
  process.on('SIGTERM', async () => {
    await pg.stop();
    process.exit(0);
  });
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error('PG_FAILED', err);
  process.exit(1);
});
