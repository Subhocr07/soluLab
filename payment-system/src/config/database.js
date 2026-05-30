const { Sequelize } = require('sequelize');
const config = require('./config');

let sequelize;

if (config.nodeEnv === 'test') {
  // SQLite in-memory for tests — no PostgreSQL instance required
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
} else {
  sequelize = new Sequelize(config.database.url, {
    dialect: 'postgres',
    logging: false,
    pool: {
      max: 10,
      min: 2,
      acquire: 30000,
      idle: 10000,
    },
    define: {
      underscored: true,   // snake_case columns
      timestamps: true,
    },
  });
}

module.exports = sequelize;
