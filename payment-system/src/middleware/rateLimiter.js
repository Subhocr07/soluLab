const rateLimit = require('express-rate-limit');
const config = require('../config/config');

const paymentLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests — please try again later',
    },
  },
  skip: () => process.env.NODE_ENV === 'test',
});

// Stricter limiter for payment creation
const createPaymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many payment creation requests — slow down',
    },
  },
  skip: () => process.env.NODE_ENV === 'test',
});

module.exports = { paymentLimiter, createPaymentLimiter };
