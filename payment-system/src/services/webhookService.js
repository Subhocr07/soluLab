const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../utils/logger');
const { applyWebhookUpdate } = require('./paymentService');
const { WebhookSignatureError } = require('../utils/AppError');

/**
 * Generate a webhook signature for testing / gateway simulation.
 * HMAC-SHA256 over the raw JSON body using the shared secret.
 */
function generateSignature(rawBody) {
  return crypto
    .createHmac('sha256', config.webhook.secret)
    .update(rawBody)
    .digest('hex');
}

/**
 * Verify the signature sent in the X-Gateway-Signature header.
 */
function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const expected = generateSignature(rawBody);
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Process an inbound webhook event.
 *
 * Expected payload:
 * {
 *   paymentId: string,
 *   status: 'APPROVED' | 'DECLINED' | 'PROCESSING',
 *   transactionId?: string,
 *   errorCode?: string,
 *   timestamp: string   (ISO-8601)
 * }
 */
async function processWebhook(rawBody, signature, payload) {
  if (!verifySignature(rawBody, signature)) {
    logger.warn('Webhook signature verification failed', {
      paymentId: payload?.paymentId,
    });
    throw new WebhookSignatureError();
  }

  const { paymentId, status, transactionId, errorCode, timestamp } = payload;

  if (!paymentId || !status) {
    const { ValidationError } = require('../utils/AppError');
    throw new ValidationError('Webhook payload must include paymentId and status');
  }

  logger.info('Webhook received', { paymentId, status, transactionId, timestamp });

  const updated = await applyWebhookUpdate(paymentId, { status, transactionId, errorCode });
  return updated;
}

module.exports = { processWebhook, generateSignature, verifySignature };
