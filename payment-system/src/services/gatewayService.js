const config = require('../config/config');
const logger = require('../utils/logger');
const { GatewayTimeoutError } = require('../utils/AppError');
const { CircuitBreaker } = require('../utils/circuitBreaker');

const gatewayCircuitBreaker = new CircuitBreaker('payment-gateway', {
  failureThreshold: config.circuitBreaker.failureThreshold,
  successThreshold: config.circuitBreaker.successThreshold,
  timeoutMs: config.circuitBreaker.timeoutMs,
});

// Errors that should not be retried
const NON_RETRYABLE_CODES = new Set([
  'INSUFFICIENT_FUNDS',
  'FRAUD_DETECTED',
  'INVALID_CARD',
  'CARD_EXPIRED',
]);

const ALL_GATEWAY_ERRORS = [
  'INSUFFICIENT_FUNDS',
  'CARD_DECLINED',
  'INVALID_CARD',
  'FRAUD_DETECTED',
  'PROCESSING_ERROR',
  'NETWORK_ERROR',
  'CARD_EXPIRED',
];

async function simulateGatewayCall(paymentId, amount) {
  return gatewayCircuitBreaker.execute(async () => {
    const { timeoutRate, minDelayMs, maxDelayMs, successRate, timeoutMs } = config.gateway;

    // Simulate random gateway timeout
    if (Math.random() < timeoutRate) {
      logger.warn('Simulating gateway timeout', { paymentId });
      await new Promise((_, reject) =>
        setTimeout(() => reject(new GatewayTimeoutError()), timeoutMs)
      );
    }

    // Simulate network latency
    const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
    await new Promise((resolve) => setTimeout(resolve, delay));

    if (Math.random() < successRate) {
      const transactionId = `txn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      logger.info('Gateway approved payment', { paymentId, transactionId });
      return { success: true, transactionId, gatewayResponse: 'APPROVED' };
    }

    const errorCode = ALL_GATEWAY_ERRORS[Math.floor(Math.random() * ALL_GATEWAY_ERRORS.length)];
    logger.warn('Gateway declined payment', { paymentId, errorCode });
    const err = new Error(`Gateway rejected: ${errorCode}`);
    err.code = errorCode;
    err.isRetryable = !NON_RETRYABLE_CODES.has(errorCode);
    throw err;
  });
}

function getCircuitBreakerStatus() {
  return gatewayCircuitBreaker.getStatus();
}

function resetCircuitBreaker() {
  gatewayCircuitBreaker.reset();
}

module.exports = { simulateGatewayCall, getCircuitBreakerStatus, resetCircuitBreaker };
