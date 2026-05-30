const { ValidationError } = require('../utils/AppError');

const SUPPORTED_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD', 'SGD',
]);

function validateCreatePayment(req, res, next) {
  const { amount, currency, description, metadata } = req.body;

  if (amount === undefined || amount === null) {
    return next(new ValidationError('amount is required'));
  }
  if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
    return next(new ValidationError('amount must be a positive finite number'));
  }
  if (amount > 1_000_000) {
    return next(new ValidationError('amount exceeds maximum allowed value of 1,000,000'));
  }

  if (!currency) {
    return next(new ValidationError('currency is required'));
  }
  if (typeof currency !== 'string') {
    return next(new ValidationError('currency must be a string'));
  }
  if (!SUPPORTED_CURRENCIES.has(currency.toUpperCase())) {
    return next(
      new ValidationError(
        `Unsupported currency. Supported: ${[...SUPPORTED_CURRENCIES].join(', ')}`
      )
    );
  }

  if (description !== undefined && typeof description !== 'string') {
    return next(new ValidationError('description must be a string'));
  }
  if (description && description.length > 255) {
    return next(new ValidationError('description must be 255 characters or fewer'));
  }

  if (metadata !== undefined && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    return next(new ValidationError('metadata must be a plain object'));
  }

  next();
}

function validateWebhookPayload(req, res, next) {
  const { paymentId, status, timestamp } = req.body;

  if (!paymentId || typeof paymentId !== 'string') {
    return next(new ValidationError('paymentId is required'));
  }
  if (!status || typeof status !== 'string') {
    return next(new ValidationError('status is required'));
  }
  if (!['APPROVED', 'DECLINED', 'PROCESSING'].includes(status)) {
    return next(new ValidationError('status must be APPROVED, DECLINED, or PROCESSING'));
  }
  if (timestamp && isNaN(Date.parse(timestamp))) {
    return next(new ValidationError('timestamp must be a valid ISO-8601 date'));
  }

  next();
}

module.exports = { validateCreatePayment, validateWebhookPayload };
