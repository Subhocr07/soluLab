const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Payment extends Model {}

Payment.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      get() {
        // pg driver returns DECIMAL as string — normalise to number
        const val = this.getDataValue('amount');
        return val !== null && val !== undefined ? parseFloat(val) : null;
      },
    },

    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
    },

    // STRING(20) instead of ENUM so it works with both PostgreSQL and SQLite (tests)
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'PENDING',
    },

    idempotencyKey: {
      type: DataTypes.STRING(255),
      unique: true,
      allowNull: true,
    },

    transactionId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },

    gatewayError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    retryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    maxRetries: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 3,
    },

    metadata: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },

    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: 'Payment',
    tableName: 'payments',
    underscored: true,
    indexes: [
      { fields: ['status'] },
      { fields: ['idempotency_key'], unique: true, where: { idempotency_key: { [require('sequelize').Op.ne]: null } } },
    ],
  }
);

module.exports = Payment;
