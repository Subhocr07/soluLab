const logger = require('./logger');

const STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      successThreshold: options.successThreshold || 2,
      timeoutMs: options.timeoutMs || 60000,
    };
  }

  async execute(fn) {
    if (this.state === STATES.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.options.timeoutMs) {
        const { CircuitOpenError } = require('./AppError');
        throw new CircuitOpenError();
      }
      this._transitionTo(STATES.HALF_OPEN);
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error);
      throw error;
    }
  }

  _onSuccess() {
    this.failureCount = 0;
    if (this.state === STATES.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        this._transitionTo(STATES.CLOSED);
      }
    }
  }

  _onFailure(error) {
    this.lastFailureTime = Date.now();
    // Don't count validation/business errors toward circuit failures
    if (error && error.statusCode && error.statusCode < 500) return;

    this.failureCount++;
    if (
      this.state === STATES.HALF_OPEN ||
      this.failureCount >= this.options.failureThreshold
    ) {
      this._transitionTo(STATES.OPEN);
    }
  }

  _transitionTo(newState) {
    if (this.state === newState) return;
    logger.warn(`Circuit breaker [${this.name}]: ${this.state} → ${newState}`);
    this.state = newState;
    if (newState === STATES.CLOSED) {
      this.failureCount = 0;
      this.successCount = 0;
    }
    if (newState === STATES.HALF_OPEN) {
      this.successCount = 0;
    }
  }

  reset() {
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

module.exports = { CircuitBreaker, CIRCUIT_STATES: STATES };
