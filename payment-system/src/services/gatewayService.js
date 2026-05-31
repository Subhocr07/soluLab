const http    = require('http');
const https   = require('https');
const crypto  = require('crypto');
const config  = require('../config/config');
const logger  = require('../utils/logger');
const { GatewayTimeoutError } = require('../utils/AppError');
const { CircuitBreaker }      = require('../utils/circuitBreaker');

const gatewayCircuitBreaker = new CircuitBreaker('payment-gateway', {
  failureThreshold: config.circuitBreaker.failureThreshold,
  successThreshold: config.circuitBreaker.successThreshold,
  timeoutMs:        config.circuitBreaker.timeoutMs,
});

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

// ── Gateway simulation ────────────────────────────────────────────────────────

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

      // ── Auto-fire APPROVED webhook (like Stripe calling your server back) ──
      _scheduleWebhook(paymentId, 'APPROVED', transactionId, null);

      return { success: true, transactionId, gatewayResponse: 'APPROVED' };
    }

    const errorCode = ALL_GATEWAY_ERRORS[Math.floor(Math.random() * ALL_GATEWAY_ERRORS.length)];
    logger.warn('Gateway declined payment', { paymentId, errorCode });

    const err = new Error(`Gateway rejected: ${errorCode}`);
    err.code = errorCode;
    err.isRetryable = !NON_RETRYABLE_CODES.has(errorCode);

    // ── Auto-fire DECLINED webhook only for non-retryable (terminal) failures ──
    if (!err.isRetryable) {
      _scheduleWebhook(paymentId, 'DECLINED', null, errorCode);
    }

    throw err;
  });
}

// ── Webhook auto-dispatch ─────────────────────────────────────────────────────

/**
 * Schedule the webhook delivery with setImmediate so it fires after the
 * current call stack unwinds (simulates async gateway-to-server network hop).
 */
function _scheduleWebhook(paymentId, status, transactionId, errorCode) {
  setImmediate(() =>
    _fireWebhook(paymentId, status, transactionId, errorCode).catch((err) =>
      logger.error('Auto-webhook delivery failed', { paymentId, err: err.message })
    )
  );
}

async function _fireWebhook(paymentId, status, transactionId, errorCode) {
  const payload = {
    paymentId,
    status,
    ...(transactionId && { transactionId }),
    ...(errorCode     && { errorCode }),
    timestamp: new Date().toISOString(),
  };

  const raw = JSON.stringify(payload);
  const sig = crypto
    .createHmac('sha256', config.webhook.secret)
    .update(raw)
    .digest('hex');

  const webhookUrl = config.webhook.url;
  logger.info('Gateway auto-firing webhook', { paymentId, status, url: webhookUrl });

  await _httpPost(webhookUrl, raw, sig);
}

function _httpPost(urlStr, raw, signature) {
  return new Promise((resolve, reject) => {
    const url      = new URL(urlStr);
    const isHttps  = url.protocol === 'https:';
    const lib      = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':        'application/json',
          'Content-Length':      Buffer.byteLength(raw),
          'X-Gateway-Signature': signature,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          logger.info('Webhook delivery response', {
            status:  res.statusCode,
            body:    data.slice(0, 200),
          });
          resolve(res.statusCode);
        });
      }
    );

    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

function getCircuitBreakerStatus() { return gatewayCircuitBreaker.getStatus(); }
function resetCircuitBreaker()     { gatewayCircuitBreaker.reset(); }

module.exports = { simulateGatewayCall, getCircuitBreakerStatus, resetCircuitBreaker };
