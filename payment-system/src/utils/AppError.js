class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class PaymentNotFoundError extends AppError {
  constructor(paymentId) {
    super(`Payment ${paymentId} not found`, 404, 'PAYMENT_NOT_FOUND');
  }
}

class DuplicatePaymentError extends AppError {
  constructor(idempotencyKey) {
    super(`Payment with idempotency key ${idempotencyKey} already exists`, 409, 'DUPLICATE_PAYMENT');
  }
}

class InvalidStateTransitionError extends AppError {
  constructor(from, to) {
    super(`Invalid state transition from ${from} to ${to}`, 422, 'INVALID_STATE_TRANSITION');
  }
}

class ConcurrentProcessingError extends AppError {
  constructor(paymentId) {
    super(`Payment ${paymentId} is already being processed`, 409, 'CONCURRENT_PROCESSING');
  }
}

class GatewayTimeoutError extends AppError {
  constructor() {
    super('Payment gateway timed out', 504, 'GATEWAY_TIMEOUT');
    this.isRetryable = true;
  }
}

class CircuitOpenError extends AppError {
  constructor() {
    super('Payment gateway circuit breaker is open — too many recent failures', 503, 'CIRCUIT_OPEN');
    this.isRetryable = true;
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

class WebhookSignatureError extends AppError {
  constructor() {
    super('Invalid webhook signature', 401, 'INVALID_WEBHOOK_SIGNATURE');
  }
}

module.exports = {
  AppError,
  PaymentNotFoundError,
  DuplicatePaymentError,
  InvalidStateTransitionError,
  ConcurrentProcessingError,
  GatewayTimeoutError,
  CircuitOpenError,
  ValidationError,
  WebhookSignatureError,
};
