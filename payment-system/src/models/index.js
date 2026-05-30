const Payment = require('./Payment');
const PaymentEvent = require('./PaymentEvent');

// One payment has many ordered events (append-only audit trail)
Payment.hasMany(PaymentEvent, {
  foreignKey: 'paymentId',
  as: 'events',
  onDelete: 'CASCADE',
});
PaymentEvent.belongsTo(Payment, {
  foreignKey: 'paymentId',
});

module.exports = { Payment, PaymentEvent };
