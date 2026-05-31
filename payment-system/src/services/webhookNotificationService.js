const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Sends a Stripe-like signed webhook event to WEBHOOK_URL after a payment
 * reaches a terminal state (SUCCESS or FAILED).
 *
 * Event shape mirrors Stripe:
 * {
 *   id:        "evt_...",
 *   type:      "payment.succeeded" | "payment.failed" | "payment.retrying",
 *   createdAt: ISO string,
 *   data: {
 *     object: { ...full payment fields }
 *   }
 * }
 */
async function sendWebhookEvent(payment, eventType) {
  const webhookUrl = config.webhook.url;
  if (!webhookUrl) return;

  const event = {
    id:        `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    type:      eventType,
    createdAt: new Date().toISOString(),
    data: {
      object: {
        id:            payment.id,
        amount:        payment.amount,
        currency:      payment.currency,
        status:        payment.status,
        description:   payment.description,
        metadata:      payment.metadata,
        transactionId: payment.transactionId,
        gatewayError:  payment.gatewayError,
        retryCount:    payment.retryCount,
        maxRetries:    payment.maxRetries,
        idempotencyKey:payment.idempotencyKey,
        createdAt:     payment.createdAt,
        updatedAt:     payment.updatedAt,
        events:        payment.events,
      },
    },
  };

  const raw = JSON.stringify(event, null, 2);
  const sig = crypto
    .createHmac('sha256', config.webhook.secret)
    .update(raw)
    .digest('hex');

  logger.info('Sending webhook event', {
    eventType,
    paymentId: payment.id,
    url: webhookUrl,
  });

  try {
    const status = await _post(webhookUrl, raw, sig);
    logger.info('Webhook event delivered', { eventType, paymentId: payment.id, httpStatus: status });
  } catch (err) {
    logger.error('Webhook event delivery failed', {
      eventType,
      paymentId: payment.id,
      err: err.message,
    });
  }
}

function _post(urlStr, raw, signature) {
  return new Promise((resolve, reject) => {
    const url   = new URL(urlStr);
    const lib   = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  {
          'Content-Type':        'application/json',
          'Content-Length':      Buffer.byteLength(raw),
          'X-Gateway-Signature': signature,
          'X-Webhook-Event':     'payment',
          'User-Agent':          'PaymentSystem-Webhook/1.0',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(res.statusCode));
      }
    );

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Webhook delivery timed out after 10s'));
    });

    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

module.exports = { sendWebhookEvent };
