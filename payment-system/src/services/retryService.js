const config = require('../config/config');
const logger = require('../utils/logger');

class RetryQueue {
  constructor() {
    this._timers = new Map(); // paymentId -> TimerID
    this._queue = [];         // for visibility/metrics
  }

  /**
   * Schedule a retry for paymentId.
   * @param {string} paymentId
   * @param {number} attemptNumber  1-based retry attempt number
   * @param {Function} callback     async (paymentId) => void
   */
  schedule(paymentId, attemptNumber, callback) {
    this.cancel(paymentId); // clear any existing timer

    const delay = this._backoff(attemptNumber);
    logger.info('Retry scheduled', { paymentId, attemptNumber, delayMs: delay });

    const timer = setTimeout(async () => {
      this._timers.delete(paymentId);
      this._queue = this._queue.filter((e) => e.paymentId !== paymentId);
      try {
        await callback(paymentId);
      } catch (err) {
        logger.error('Retry callback threw unexpectedly', { paymentId, err: err.message });
      }
    }, delay);

    this._timers.set(paymentId, timer);
    this._queue.push({ paymentId, attemptNumber, scheduledAt: Date.now(), delayMs: delay });
  }

  cancel(paymentId) {
    if (this._timers.has(paymentId)) {
      clearTimeout(this._timers.get(paymentId));
      this._timers.delete(paymentId);
      this._queue = this._queue.filter((e) => e.paymentId !== paymentId);
      logger.info('Retry cancelled', { paymentId });
    }
  }

  isPending(paymentId) {
    return this._timers.has(paymentId);
  }

  getStatus() {
    return {
      pendingRetries: this._queue.length,
      items: [...this._queue],
    };
  }

  // Exponential backoff with full jitter: delay = rand(0, min(cap, base * 2^attempt))
  _backoff(attempt) {
    const { initialBackoffMs, maxBackoffMs } = config.payment;
    const cap = Math.min(maxBackoffMs, initialBackoffMs * Math.pow(2, attempt - 1));
    const jitter = Math.random() * cap;
    return Math.floor(jitter);
  }

  // Test helper
  clear() {
    this._timers.forEach((t) => clearTimeout(t));
    this._timers.clear();
    this._queue = [];
  }
}

module.exports = { RetryQueue: new RetryQueue() };
