const { v4: uuidv4 } = require('uuid');
const { Mutex } = require('async-mutex');
const { PaymentStore, PAYMENT_STATUS } = require('../models/paymentStore');
const { simulateGatewayCall } = require('./gatewayService');
const { RetryQueue } = require('./retryService');
const config = require('../config/config');
const logger = require('../utils/logger');
const {
  PaymentNotFoundError,
  InvalidStateTransitionError,
  ValidationError,
} = require('../utils/AppError');

// ── Concurrency primitives ────────────────────────────────────────────────────
const processingSet = new Set();
const paymentLocks = new Map();
const pendingImmediates = new Set();   // setImmediate handles — cancelled on reset
const activeProcessing = new Set();    // in-flight processPayment promises

function _getLock(paymentId) {
  if (!paymentLocks.has(paymentId)) paymentLocks.set(paymentId, new Mutex());
  return paymentLocks.get(paymentId);
}

async function _withLock(paymentId, fn) {
  const release = await _getLock(paymentId).acquire();
  try { return await fn(); } finally { release(); }
}

// ── Payment creation ──────────────────────────────────────────────────────────

async function createPayment({ amount, currency, description, metadata, idempotencyKey }) {
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    throw new ValidationError('amount must be a positive number');
  }
  if (!currency || typeof currency !== 'string') {
    throw new ValidationError('currency is required');
  }

  if (idempotencyKey) {
    const existing = await PaymentStore.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      logger.info('Idempotent request', { idempotencyKey, paymentId: existing.id });
      return existing;
    }
  }

  const now = new Date().toISOString();
  const created = await PaymentStore.create({
    id: uuidv4(),
    amount,
    currency: currency.toUpperCase(),
    description: description || null,
    metadata: metadata || {},
    status: PAYMENT_STATUS.PENDING,
    idempotencyKey: idempotencyKey || null,
    retryCount: 0,
    maxRetries: config.payment.maxRetries,
    transactionId: null,
    gatewayError: null,
    createdAt: now,
    updatedAt: now,
    events: [{ status: PAYMENT_STATUS.PENDING, message: 'Payment created', timestamp: now }],
  });

  logger.info('Payment created', { paymentId: created.id, amount, currency: created.currency });

  const handle = setImmediate(() => {
    pendingImmediates.delete(handle);
    processPayment(created.id);
  });
  pendingImmediates.add(handle);

  return created;
}

// ── Payment processing ────────────────────────────────────────────────────────

async function processPayment(paymentId) {
  if (processingSet.has(paymentId)) {
    logger.warn('Skipping — payment already in processing', { paymentId });
    return;
  }
  processingSet.add(paymentId);

  const run = async () => {
    try {
      const payment = await PaymentStore.get(paymentId);
      if (!payment) {
        logger.info('processPayment: payment not found (cleaned up?)', { paymentId });
        return;
      }
      if (![PAYMENT_STATUS.PENDING, PAYMENT_STATUS.RETRYING].includes(payment.status)) {
        logger.info('Payment not processable', { paymentId, status: payment.status });
        return;
      }

      try {
        await _withLock(paymentId, async () => {
          await _transition(paymentId, PAYMENT_STATUS.PROCESSING, 'Gateway call initiated');
        });
      } catch (err) {
        if (err.code === 'PAYMENT_NOT_FOUND' || err.code === 'INVALID_STATE_TRANSITION') {
          logger.info('processPayment aborted', { paymentId, reason: err.message });
          return;
        }
        throw err;
      }

      logger.info('Processing payment', { paymentId, attempt: payment.retryCount + 1 });

      let gatewayResult;
      try {
        gatewayResult = await simulateGatewayCall(paymentId, payment.amount);
      } catch (gatewayError) {
        await _withLock(paymentId, async () => _onGatewayFailure(paymentId, gatewayError));
        return;
      }

      await _withLock(paymentId, async () => _onGatewaySuccess(paymentId, gatewayResult));
    } finally {
      processingSet.delete(paymentId);
    }
  };

  const p = run();
  activeProcessing.add(p);
  p.finally(() => activeProcessing.delete(p));
  return p;
}

// ── Gateway outcome handlers ──────────────────────────────────────────────────

async function _onGatewaySuccess(paymentId, result) {
  const payment = await PaymentStore.get(paymentId);
  if (!payment || PaymentStore.isTerminal(payment.status)) return;

  await PaymentStore.update(paymentId, {
    status: PAYMENT_STATUS.SUCCESS,
    transactionId: result.transactionId,
    gatewayError: null,
  });
  await PaymentStore.appendEvent(paymentId, {
    status: PAYMENT_STATUS.SUCCESS,
    message: `Payment approved. Transaction: ${result.transactionId}`,
  });
  logger.info('Payment succeeded', { paymentId, transactionId: result.transactionId });
}

async function _onGatewayFailure(paymentId, error) {
  const payment = await PaymentStore.get(paymentId);
  if (!payment || PaymentStore.isTerminal(payment.status)) return;

  const isRetryable = error.isRetryable !== false;
  const retriesLeft = payment.maxRetries - payment.retryCount;

  if (isRetryable && retriesLeft > 0) {
    const newRetryCount = payment.retryCount + 1;
    await PaymentStore.update(paymentId, {
      status: PAYMENT_STATUS.RETRYING,
      retryCount: newRetryCount,
      gatewayError: error.message,
    });
    await PaymentStore.appendEvent(paymentId, {
      status: PAYMENT_STATUS.RETRYING,
      message: `Attempt ${newRetryCount} failed: ${error.message}. Retrying (${newRetryCount}/${payment.maxRetries})`,
    });
    logger.warn('Payment queued for retry', { paymentId, attempt: newRetryCount });
    RetryQueue.schedule(paymentId, newRetryCount, processPayment);
  } else {
    const reason = isRetryable ? 'Max retries exhausted' : 'Non-retryable error';
    await PaymentStore.update(paymentId, { status: PAYMENT_STATUS.FAILED, gatewayError: error.message });
    await PaymentStore.appendEvent(paymentId, {
      status: PAYMENT_STATUS.FAILED,
      message: `${reason}: ${error.message}`,
    });
    logger.error('Payment permanently failed', { paymentId, reason, errorCode: error.code });
  }
}

async function _transition(paymentId, toStatus, message) {
  const payment = await PaymentStore.get(paymentId);
  if (!payment) throw new PaymentNotFoundError(paymentId);
  if (!PaymentStore.isValidTransition(payment.status, toStatus)) {
    throw new InvalidStateTransitionError(payment.status, toStatus);
  }
  await PaymentStore.update(paymentId, { status: toStatus });
  await PaymentStore.appendEvent(paymentId, { status: toStatus, message });
}

// ── Query methods ─────────────────────────────────────────────────────────────

async function getPayment(paymentId) {
  const payment = await PaymentStore.get(paymentId);
  if (!payment) throw new PaymentNotFoundError(paymentId);
  return payment;
}

async function listPayments(filters) { return PaymentStore.list(filters); }

// ── Webhook update ────────────────────────────────────────────────────────────

async function applyWebhookUpdate(paymentId, { status: webhookStatus, transactionId, errorCode }) {
  return _withLock(paymentId, async () => {
    const payment = await PaymentStore.get(paymentId);
    if (!payment) throw new PaymentNotFoundError(paymentId);

    if (PaymentStore.isTerminal(payment.status)) {
      logger.info('Webhook ignored — already terminal', { paymentId, currentStatus: payment.status });
      return PaymentStore.get(paymentId);
    }

    const STATUS_MAP = { APPROVED: PAYMENT_STATUS.SUCCESS, DECLINED: PAYMENT_STATUS.FAILED, PROCESSING: PAYMENT_STATUS.PROCESSING };
    const newStatus = STATUS_MAP[webhookStatus];
    if (!newStatus) {
      logger.warn('Unknown webhook status', { paymentId, webhookStatus });
      return PaymentStore.get(paymentId);
    }

    const isTerminal = PaymentStore.isTerminal(newStatus);
    if (!PaymentStore.isValidTransition(payment.status, newStatus) && !isTerminal) {
      logger.warn('Conflicting webhook transition skipped', { paymentId, from: payment.status, to: newStatus });
      return PaymentStore.get(paymentId);
    }

    if (isTerminal) RetryQueue.cancel(paymentId);

    await PaymentStore.update(paymentId, {
      status: newStatus,
      transactionId: transactionId || payment.transactionId,
      gatewayError: errorCode || payment.gatewayError,
    });
    await PaymentStore.appendEvent(paymentId, { status: newStatus, message: `Webhook: gateway reported ${webhookStatus}` });
    logger.info('Payment updated via webhook', { paymentId, newStatus });
    return PaymentStore.get(paymentId);
  });
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function _cancelPendingImmediates() {
  pendingImmediates.forEach((h) => clearImmediate(h));
  pendingImmediates.clear();
}

async function _resetState() {
  _cancelPendingImmediates();
  // Don't await activeProcessing — in-flight calls handle cleared DB gracefully
  // (appendEvent is non-throwing; _transition catches PaymentNotFoundError).
  activeProcessing.clear();
  processingSet.clear();
  paymentLocks.clear();
  await PaymentStore.clear();
  RetryQueue.clear();
}

module.exports = {
  createPayment, processPayment, getPayment, listPayments, applyWebhookUpdate,
  _resetState, _cancelPendingImmediates,
};
