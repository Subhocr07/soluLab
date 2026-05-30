/**
 * Tests: Webhook handling — signature verification, state updates,
 *        early callbacks, duplicate callbacks, conflicting states
 */

jest.mock('../src/services/gatewayService', () => ({
  simulateGatewayCall: jest.fn(),
  getCircuitBreakerStatus: jest.fn(() => ({ state: 'CLOSED', failureCount: 0 })),
  resetCircuitBreaker: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');
const { _resetState, createPayment } = require('../src/services/paymentService');
const { generateSignature } = require('../src/services/webhookService');
const { PAYMENT_STATUS, PaymentStore } = require('../src/models/paymentStore');
const { simulateGatewayCall } = require('../src/services/gatewayService');

beforeEach(async () => {
  await _resetState();
  jest.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWebhookPayload(paymentId, status, extra = {}) {
  return {
    paymentId,
    status,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

async function postWebhook(payload, signatureOverride) {
  const raw = JSON.stringify(payload);
  const sig = signatureOverride !== undefined ? signatureOverride : generateSignature(raw);
  return request(app)
    .post('/api/webhooks/payment')
    .set('Content-Type', 'application/json')
    .set('X-Gateway-Signature', sig)
    .send(payload);
}

// ── Signature verification ────────────────────────────────────────────────────

describe('Webhook signature verification', () => {
  it('accepts a valid signature', async () => {
    // Create a payment in PROCESSING state manually for webhook target
    simulateGatewayCall.mockReturnValue(new Promise(() => {})); // never resolves
    const payment = await createPayment({ amount: 100, currency: 'USD' });

    const payload = buildWebhookPayload(payment.id, 'APPROVED', {
      transactionId: 'txn_wh_001',
    });
    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
  });

  it('rejects missing signature', async () => {
    const payment = await createPayment({ amount: 100, currency: 'USD' });
    simulateGatewayCall.mockReturnValue(new Promise(() => {}));

    const payload = buildWebhookPayload(payment.id, 'APPROVED');
    const res = await request(app)
      .post('/api/webhooks/payment')
      .send(payload); // no signature header

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
  });

  it('rejects tampered signature', async () => {
    const payment = await createPayment({ amount: 100, currency: 'USD' });
    simulateGatewayCall.mockReturnValue(new Promise(() => {}));

    const payload = buildWebhookPayload(payment.id, 'APPROVED');
    const res = await postWebhook(payload, 'bad-signature-value-that-is-wrong-length-padding');

    expect(res.status).toBe(401);
  });
});

// ── Webhook state updates ─────────────────────────────────────────────────────

describe('Webhook state transitions', () => {
  beforeEach(() => {
    // Gateway never resolves so the payment stays in PROCESSING
    simulateGatewayCall.mockReturnValue(new Promise(() => {}));
  });

  it('APPROVED webhook transitions payment to SUCCESS', async () => {
    const payment = await createPayment({ amount: 50, currency: 'USD' });
    // Allow setImmediate to fire (payment enters PROCESSING)
    await new Promise((r) => setImmediate(r));

    const payload = buildWebhookPayload(payment.id, 'APPROVED', {
      transactionId: 'txn_hook_success',
    });
    const res = await postWebhook(payload);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(PAYMENT_STATUS.SUCCESS);
    expect(res.body.data.transactionId).toBe('txn_hook_success');
  });

  it('DECLINED webhook transitions payment to FAILED', async () => {
    const payment = await createPayment({ amount: 50, currency: 'USD' });
    await new Promise((r) => setImmediate(r));

    const payload = buildWebhookPayload(payment.id, 'DECLINED', {
      errorCode: 'CARD_DECLINED',
    });
    const res = await postWebhook(payload);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(PAYMENT_STATUS.FAILED);
  });
});

// ── Duplicate / idempotent webhooks ──────────────────────────────────────────

describe('Duplicate webhook handling', () => {
  beforeEach(() => {
    simulateGatewayCall.mockReturnValue(new Promise(() => {}));
  });

  it('second identical webhook is ignored (already SUCCESS)', async () => {
    const payment = await createPayment({ amount: 40, currency: 'USD' });
    await new Promise((r) => setImmediate(r));

    const payload = buildWebhookPayload(payment.id, 'APPROVED', { transactionId: 'txn_dup' });

    const res1 = await postWebhook(payload);
    const res2 = await postWebhook(payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Both should return the same terminal state
    expect(res2.body.data.status).toBe(PAYMENT_STATUS.SUCCESS);
    // Transaction ID should not change
    expect(res2.body.data.transactionId).toBe('txn_dup');
  });

  it('FAILED webhook followed by SUCCESS webhook keeps FAILED', async () => {
    const payment = await createPayment({ amount: 40, currency: 'USD' });
    await new Promise((r) => setImmediate(r));

    const failPayload = buildWebhookPayload(payment.id, 'DECLINED');
    const successPayload = buildWebhookPayload(payment.id, 'APPROVED', { transactionId: 'late' });

    await postWebhook(failPayload);
    const res = await postWebhook(successPayload);

    expect(res.body.data.status).toBe(PAYMENT_STATUS.FAILED); // terminal, not overwritten
  });
});

// ── Early / out-of-order webhooks ─────────────────────────────────────────────

describe('Early and out-of-order webhooks', () => {
  it('APPROVED webhook on PENDING payment transitions it to SUCCESS', async () => {
    // Create payment but don't let processing start
    simulateGatewayCall.mockReturnValue(new Promise(() => {}));
    const payment = await createPayment({ amount: 80, currency: 'USD' });

    // Webhook arrives before setImmediate fires
    const payload = buildWebhookPayload(payment.id, 'APPROVED', {
      transactionId: 'txn_early',
    });
    const res = await postWebhook(payload);

    expect(res.status).toBe(200);
    // Early SUCCESS is accepted (gateway is source of truth)
    expect(res.body.data.status).toBe(PAYMENT_STATUS.SUCCESS);
  });
});

// ── Webhook payload validation ────────────────────────────────────────────────

describe('Webhook payload validation', () => {
  it('rejects payload without paymentId', async () => {
    const payload = { status: 'APPROVED', timestamp: new Date().toISOString() };
    const res = await postWebhook(payload);
    expect(res.status).toBe(400);
  });

  it('rejects payload without status', async () => {
    const payload = { paymentId: 'some-id', timestamp: new Date().toISOString() };
    const res = await postWebhook(payload);
    expect(res.status).toBe(400);
  });

  it('rejects unknown status value', async () => {
    const payload = { paymentId: 'some-id', status: 'UNKNOWN_STATUS' };
    const res = await postWebhook(payload);
    expect(res.status).toBe(400);
  });
});

// ── Webhook for non-existent payment ─────────────────────────────────────────

describe('Webhook for unknown payment', () => {
  it('returns 404 for unknown paymentId', async () => {
    const payload = buildWebhookPayload('unknown-payment-id-xyz', 'APPROVED');
    const res = await postWebhook(payload);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
  });
});
