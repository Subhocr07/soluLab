require('dotenv').config();

/**
 * sequelize-cli reads this file for connection details.
 * The same DATABASE_URL is used for development and production.
 */
module.exports = {
  development: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:root@localhost:5432/payments_db',
    dialect: 'postgres',
    logging: false,
  },
  test: {
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  },
  production: {
    url: process.env.DATABASE_URL,
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
      ssl: { require: true, rejectUnauthorized: false },
    },
  },
};
