const { processWebhook } = require('../services/webhookService');
const logger = require('../utils/logger');

/**
 * @swagger
 * /api/webhooks/payment:
 *   post:
 *     summary: Receive asynchronous payment status update from the gateway
 *     tags: [Webhooks]
 *     description: |
 *       The gateway calls this endpoint when a payment status changes.
 *       Requests must carry the X-Gateway-Signature header (HMAC-SHA256 of the raw body).
 *     parameters:
 *       - in: header
 *         name: X-Gateway-Signature
 *         required: true
 *         schema:
 *           type: string
 *         description: HMAC-SHA256 signature of the raw request body
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentId, status]
 *             properties:
 *               paymentId:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [APPROVED, DECLINED, PROCESSING]
 *               transactionId:
 *                 type: string
 *               errorCode:
 *                 type: string
 *               timestamp:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Webhook processed
 *       401:
 *         description: Invalid signature
 *       422:
 *         description: Invalid payload
 */
async function handlePaymentWebhook(req, res, next) {
  try {
    const signature = req.headers['x-gateway-signature'];
    // rawBody is captured by the express.json verify callback in app.js
    const rawBody = req.rawBody || JSON.stringify(req.body);

    const updatedPayment = await processWebhook(rawBody, signature, req.body);
    logger.info('Webhook handled', { paymentId: req.body.paymentId });
    res.json({ success: true, data: updatedPayment });
  } catch (err) {
    next(err);
  }
}

module.exports = { handlePaymentWebhook };
