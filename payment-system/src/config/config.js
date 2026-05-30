require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  payment: {
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
    initialBackoffMs: parseInt(process.env.INITIAL_BACKOFF_MS) || 1000,
    maxBackoffMs: parseInt(process.env.MAX_BACKOFF_MS) || 30000,
  },

  gateway: {
    successRate: parseFloat(process.env.GATEWAY_SUCCESS_RATE) || 0.7,
    minDelayMs: parseInt(process.env.GATEWAY_MIN_DELAY_MS) || 100,
    maxDelayMs: parseInt(process.env.GATEWAY_MAX_DELAY_MS) || 2000,
    timeoutRate: parseFloat(process.env.GATEWAY_TIMEOUT_RATE) || 0.1,
    timeoutMs: parseInt(process.env.GATEWAY_TIMEOUT_MS) || 5000,
  },

  circuitBreaker: {
    failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD) || 5,
    successThreshold: parseInt(process.env.CB_SUCCESS_THRESHOLD) || 2,
    timeoutMs: parseInt(process.env.CB_TIMEOUT_MS) || 60000,
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  },

  webhook: {
    secret: process.env.WEBHOOK_SECRET || 'default-webhook-secret-change-in-production',
  },

  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/payments_db',
  },
};
