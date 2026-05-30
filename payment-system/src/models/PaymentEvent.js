const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class PaymentEvent extends Model {}

PaymentEvent.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },

    paymentId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },

    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: 'PaymentEvent',
    tableName: 'payment_events',
    underscored: true,
    updatedAt: false, // events are immutable — no updatedAt column
    indexes: [{ fields: ['payment_id'] }],
  }
);

module.exports = PaymentEvent;
