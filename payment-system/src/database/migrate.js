const path = require('path');
const { Sequelize } = require('sequelize');
const { Umzug, SequelizeStorage } = require('umzug');
const sequelize = require('../config/database');
const logger = require('../utils/logger');

// ── Auto-create database ──────────────────────────────────────────────────────

async function createDatabaseIfNotExists() {
  const config = require('../config/config');

  // Parse the target DB name from the connection URL
  let url;
  try {
    url = new URL(config.database.url);
  } catch {
    throw new Error(`Invalid DATABASE_URL: ${config.database.url}`);
  }

  const dbName = url.pathname.replace(/^\//, ''); // strip leading /

  // Connect to the 'postgres' system database to issue CREATE DATABASE
  const adminUrl = `postgresql://${url.username}:${url.password}@${url.hostname}:${url.port}/postgres`;
  const admin = new Sequelize(adminUrl, { dialect: 'postgres', logging: false });

  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    logger.info(`Database "${dbName}" created`);
  } catch (err) {
    const pgCode = err.original?.code;
    if (pgCode === '42P04') {
      // 42P04 = duplicate_database — already exists, nothing to do
    } else {
      throw err;
    }
  } finally {
    await admin.close();
  }
}

// ── Umzug migration runner ────────────────────────────────────────────────────

// glob requires forward slashes — path.join uses backslashes on Windows
const migrationsGlob = path.join(__dirname, 'migrations', '*.js').replace(/\\/g, '/');

const umzug = new Umzug({
  migrations: {
    glob: migrationsGlob,
    resolve: ({ name, path: migPath, context }) => {
      const migration = require(migPath);
      return {
        name,
        up: async () => migration.up(context, Sequelize),
        down: async () => migration.down(context, Sequelize),
      };
    },
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: {
    info:  (msg) => logger.info(msg),
    warn:  (msg) => logger.warn(msg),
    error: (msg) => logger.error(msg),
    debug: () => {},
  },
});

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply all pending migrations.
 * Assumes the database already exists (call createDatabaseIfNotExists first).
 * Safe to call on every startup — already-applied migrations are skipped.
 */
async function runMigrations() {
  const pending = await umzug.pending();
  if (pending.length === 0) {
    logger.info('Database schema up to date — no pending migrations');
    return;
  }

  logger.info(`Running ${pending.length} migration(s)`, {
    migrations: pending.map((m) => m.name),
  });
  await umzug.up();
  logger.info('Migrations complete');
}

async function rollbackLast() { await umzug.down(); }
async function rollbackAll()  { await umzug.down({ to: 0 }); }

module.exports = { umzug, createDatabaseIfNotExists, runMigrations, rollbackLast, rollbackAll };
