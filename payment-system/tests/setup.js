process.env.NODE_ENV = 'test';

const sequelize = require('../src/config/database');
require('../src/models/index'); // register associations

beforeAll(async () => {
  // Cancel any setImmediate callbacks left over from a previous suite
  // before dropping/recreating tables to avoid "no such table" errors.
  try {
    const { _resetState } = require('../src/services/paymentService');
    await _resetState();
  } catch (_) { /* first run — nothing to reset */ }

  await sequelize.sync({ force: true });
});
// No afterAll — connection stays open across all suites; --forceExit handles cleanup.
