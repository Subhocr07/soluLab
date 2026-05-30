const { createPayment, getPayment, listPayments } = require('../services/paymentService');
const { getCircuitBreakerStatus } = require('../services/gatewayService');
const { RetryQueue } = require('../services/retryService');
const { PaymentStore } = require('../models/paymentStore');

/**
 * @swagger
 * /api/payments:
 *   post:
 *     summary: Initiate a new payment
 *     tags: [Payments]
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         schema:
 *           type: string
 *         description: Optional unique key to prevent duplicate payments
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, currency]
 *             properties:
 *               amount:
 *                 type: number
 *                 example: 99.99
 *               currency:
 *                 type: string
 *                 example: USD
 *               description:
 *                 type: string
 *               metadata:
 *                 type: object
 *     responses:
 *       201:
 *         description: Payment created
 *       200:
 *         description: Existing payment returned (idempotent)
 *       400:
 *         description: Validation error
 */
async function create(req, res, next) {
  try {
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey || null;
    const payment = await createPayment({ ...req.body, idempotencyKey });

    // 200 if idempotency key matched an existing record, 201 for new
    const wasExisting = idempotencyKey && payment.events?.length > 1
      ? payment.createdAt !== payment.updatedAt
      : false;

    res.status(wasExisting ? 200 : 201).json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
}

/**
 * @swagger
 * /api/payments/{id}:
 *   get:
 *     summary: Get payment by ID
 *     tags: [Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payment found
 *       404:
 *         description: Payment not found
 */
async function getById(req, res, next) {
  try {
    const payment = await getPayment(req.params.id);
    res.json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
}

/**
 * @swagger
 * /api/payments:
 *   get:
 *     summary: List payments
 *     tags: [Payments]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, PROCESSING, SUCCESS, FAILED, RETRYING]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: List of payments
 */
async function list(req, res, next) {
  try {
    const { status, limit, offset } = req.query;
    const payments = await listPayments({
      status,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json({ success: true, data: payments, total: payments.length });
  } catch (err) {
    next(err);
  }
}

/**
 * @swagger
 * /api/metrics:
 *   get:
 *     summary: System metrics — circuit breaker, retry queue, payment counts
 *     tags: [System]
 *     responses:
 *       200:
 *         description: Metrics snapshot
 */
async function metrics(req, res, next) {
  try {
    res.json({
      success: true,
      data: {
        circuitBreaker: getCircuitBreakerStatus(),
        retryQueue: RetryQueue.getStatus(),
        payments: {
          total: await PaymentStore.count(),
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, getById, list, metrics };
