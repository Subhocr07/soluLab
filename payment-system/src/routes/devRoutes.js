/**
 * Developer utilities — only mounted in non-production environments.
 *
 * Mirrors Stripe's "Send test webhook" / CLI trigger workflow:
 *   POST /api/dev/trigger-webhook  → signs payload with server secret, fires webhook
 *   GET  /api/dev/webhook-secret   → shows current signing secret (for reference)
 */

const express = require('express');
const crypto  = require('http');
const http    = require('http');
const config  = require('../config/config');

const router = express.Router();

// ── Sign helper ───────────────────────────────────────────────────────────────

function sign(payload) {
  const raw = JSON.stringify(payload);
  const sig = require('crypto')
    .createHmac('sha256', config.webhook.secret)
    .update(raw)
    .digest('hex');
  return { raw, sig };
}

// ── Internal HTTP call to our own webhook endpoint ────────────────────────────

function fireWebhook(payload, signature) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port:     config.port,
        path:     '/api/webhooks/payment',
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
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );

    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/dev/trigger-webhook
 *
 * Simulates the payment gateway sending a signed webhook callback.
 * Equivalent to Stripe CLI: stripe trigger payment_intent.succeeded
 *
 * Body:
 *   paymentId     string   required
 *   status        string   required  APPROVED | DECLINED | PROCESSING
 *   transactionId string   optional  (for APPROVED)
 *   errorCode     string   optional  (for DECLINED)
 */
router.post('/trigger-webhook', async (req, res, next) => {
  try {
    const { paymentId, status, transactionId, errorCode } = req.body;

    if (!paymentId || !status) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'paymentId and status are required' },
      });
    }

    if (!['APPROVED', 'DECLINED', 'PROCESSING'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'status must be APPROVED, DECLINED, or PROCESSING' },
      });
    }

    // Build the webhook payload (exactly what a real gateway would send)
    const payload = {
      paymentId,
      status,
      ...(transactionId && { transactionId }),
      ...(errorCode     && { errorCode }),
      timestamp: new Date().toISOString(),
    };

    // Sign it with the server secret (what the gateway does on their side)
    const { raw, sig } = sign(payload);

    // Fire it at our own webhook endpoint
    const webhookResponse = await fireWebhook(payload, sig);

    res.json({
      success: true,
      message: `Webhook "${status}" triggered for payment ${paymentId}`,
      debug: {
        payload,
        signature:    sig,
        rawBody:      raw,
        webhookHttpStatus: webhookResponse.status,
      },
      data: webhookResponse.body?.data ?? webhookResponse.body,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dev/webhook-secret
 *
 * Returns the current signing secret so you can manually verify signatures.
 * Equivalent to Stripe Dashboard → Developers → Webhooks → Signing secret.
 */
router.get('/webhook-secret', (req, res) => {
  res.json({
    success: true,
    data: {
      secret: config.webhook.secret,
      usage: 'Use this secret to generate X-Gateway-Signature = HMAC-SHA256(rawBody, secret)',
      algorithm: 'HMAC-SHA256',
      encoding: 'hex',
    },
  });
});

module.exports = router;
