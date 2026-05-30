const { Payment, PaymentEvent } = require('./index');
const logger = require('../utils/logger');

const PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING',
});

const VALID_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.PENDING]: [PAYMENT_STATUS.PROCESSING],
  [PAYMENT_STATUS.PROCESSING]: [
    PAYMENT_STATUS.SUCCESS,
    PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.RETRYING,
  ],
  [PAYMENT_STATUS.RETRYING]: [PAYMENT_STATUS.PROCESSING],
  [PAYMENT_STATUS.SUCCESS]: [],
  [PAYMENT_STATUS.FAILED]: [],
});

const TERMINAL_STATUSES = [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.FAILED];

// Include without ordering — events are sorted in _serialize
const WITH_EVENTS = {
  include: [
    {
      model: PaymentEvent,
      as: 'events',
      attributes: ['status', 'message', 'createdAt'],
    },
  ],
};

class PaymentStore {
  async create(data) {
    let payment;
    try {
      payment = await Payment.create({
        id: data.id,
        amount: data.amount,
        currency: data.currency,
        description: data.description || null,
        metadata: data.metadata || {},
        status: data.status || PAYMENT_STATUS.PENDING,
        idempotencyKey: data.idempotencyKey || null,
        retryCount: data.retryCount || 0,
        maxRetries: data.maxRetries || 3,
        transactionId: data.transactionId || null,
        gatewayError: data.gatewayError || null,
      });
    } catch (err) {
      // Concurrent request with same idempotencyKey won the race
      if (err.name === 'SequelizeUniqueConstraintError' && data.idempotencyKey) {
        return this.getByIdempotencyKey(data.idempotencyKey);
      }
      throw err;
    }

    if (data.events && data.events.length > 0) {
      const first = data.events[0];
      await this.appendEvent(payment.id, { status: first.status, message: first.message });
    }

    return this.get(payment.id);
  }

  async update(id, fields) {
    const { events, createdAt, updatedAt, ...dbFields } = fields;
    const [count] = await Payment.update(dbFields, { where: { id } });
    if (count === 0) return null;
    return this.get(id);
  }

  async appendEvent(id, event) {
    try {
      await PaymentEvent.create({
        paymentId: id,
        status: event.status,
        message: event.message || null,
      });
    } catch (err) {
      // Event append is non-critical audit trail — log and continue
      logger.warn('Failed to append payment event', {
        paymentId: id,
        status: event.status,
        err: err.message,
      });
    }
  }

  async get(id) {
    const payment = await Payment.findByPk(id, WITH_EVENTS);
    return payment ? this._serialize(payment) : null;
  }

  async getByIdempotencyKey(key) {
    const payment = await Payment.findOne({ where: { idempotencyKey: key }, ...WITH_EVENTS });
    return payment ? this._serialize(payment) : null;
  }

  async list({ status, limit = 50, offset = 0 } = {}) {
    const where = status ? { status } : {};
    const payments = await Payment.findAll({
      where,
      limit,
      offset,
      order: [['createdAt', 'DESC']],
      ...WITH_EVENTS,
    });
    return payments.map((p) => this._serialize(p));
  }

  async count() {
    return Payment.count();
  }

  isValidTransition(from, to) {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  isTerminal(status) {
    return TERMINAL_STATUSES.includes(status);
  }

  async clear() {
    await PaymentEvent.destroy({ where: {} });
    await Payment.destroy({ where: {} });
  }

  _serialize(payment) {
    const plain = payment.toJSON();
    const events = (plain.events || [])
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((e) => ({ status: e.status, message: e.message, timestamp: e.createdAt }));

    return {
      id: plain.id,
      amount: payment.amount, // getter normalises DECIMAL string → number
      currency: plain.currency,
      description: plain.description,
      metadata: plain.metadata || {},
      status: plain.status,
      idempotencyKey: plain.idempotencyKey || null,
      retryCount: plain.retryCount,
      maxRetries: plain.maxRetries,
      transactionId: plain.transactionId || null,
      gatewayError: plain.gatewayError || null,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
      events,
    };
  }
}

module.exports = {
  PaymentStore: new PaymentStore(),
  PAYMENT_STATUS,
  VALID_TRANSITIONS,
  TERMINAL_STATUSES,
};
