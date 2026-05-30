'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('payments', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        allowNull: false,
      },
      amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      idempotency_key: {
        type: Sequelize.STRING(255),
        allowNull: true,
        // UNIQUE handled by index below — allows multiple NULLs in PostgreSQL
      },
      transaction_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      gateway_error: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      retry_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      max_retries: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 3,
      },
      metadata: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: '{}',
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    // Fast status lookups
    await queryInterface.addIndex('payments', ['status'], {
      name: 'payments_status_idx',
    });

    // Unique per non-null idempotency key (partial index — PostgreSQL / SQLite 3.8.9+)
    await queryInterface.addIndex('payments', ['idempotency_key'], {
      name: 'payments_idempotency_key_unique',
      unique: true,
      where: { idempotency_key: { [require('sequelize').Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('payments');
  },
};
