/**
 * Tests: Core payment flow — creation, idempotency, retrieval, validation
 */

const request = require('supertest');
const app = require('../src/app');
const { _resetState } = require('../src/services/paymentService');
const { PAYMENT_STATUS } = require('../src/models/paymentStore');

// Mock gateway so tests are deterministic and fast
jest.mock('../src/services/gatewayService', () => ({
  simulateGatewayCall: jest.fn(),
  getCircuitBreakerStatus: jest.fn(() => ({ state: 'CLOSED', failureCount: 0 })),
  resetCircuitBreaker: jest.fn(),
}));

const { simulateGatewayCall } = require('../src/services/gatewayService');

beforeEach(async () => {
  await _resetState();
  jest.clearAllMocks();
});

// ── Helper ────────────────────────────────────────────────────────────────────

function waitFor(conditionFn, timeout = 5000, interval = 50) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        const result = await conditionFn();
        if (result) return resolve(result);
      } catch (_) {}
      if (Date.now() - start > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(check, interval);
    };
    check();
  });
}

// ── Health check ──────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns healthy status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('healthy');
  });
});

// ── Payment creation ──────────────────────────────────────────────────────────

describe('POST /api/payments', () => {
  beforeEach(() => {
    simulateGatewayCall.mockResolvedValue({
      success: true,
      transactionId: 'txn_test_123',
      gatewayResponse: 'APPROVED',
    });
  });

  it('creates a payment and returns 201', async () => {
    const res = await request(app).post('/api/payments').send({
      amount: 100.0,
      currency: 'USD',
      description: 'Test payment',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      amount: 100.0,
      currency: 'USD',
      status: PAYMENT_STATUS.PENDING,
    });
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.createdAt).toBeDefined();
  });

  it('payment eventually transitions to SUCCESS', async () => {
    const res = await request(app).post('/api/payments').send({
      amount: 50,
      currency: 'EUR',
    });
    const { id } = res.body.data;

    const payment = await waitFor(async () => {
      const r = await request(app).get(`/api/payments/${id}`);
      const p = r.body.data;
      return p.status === PAYMENT_STATUS.SUCCESS ? p : null;
    });

    expect(payment.status).toBe(PAYMENT_STATUS.SUCCESS);
    expect(payment.transactionId).toBe('txn_test_123');
  });

  it('stores metadata on the payment', async () => {
    const res = await request(app).post('/api/payments').send({
      amount: 25,
      currency: 'GBP',
      metadata: { orderId: 'order_abc', userId: 'user_42' },
    });

    expect(res.status).toBe(201);
    expect(res.body.data.metadata).toEqual({ orderId: 'order_abc', userId: 'user_42' });
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('POST /api/payments — validation', () => {
  it('rejects missing amount', async () => {
    const res = await request(app).post('/api/payments').send({ currency: 'USD' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects negative amount', async () => {
    const res = await request(app).post('/api/payments').send({ amount: -10, currency: 'USD' });
    expect(res.status).toBe(400);
  });

  it('rejects zero amount', async () => {
    const res = await request(app).post('/api/payments').send({ amount: 0, currency: 'USD' });
    expect(res.status).toBe(400);
  });

  it('rejects missing currency', async () => {
    const res = await request(app).post('/api/payments').send({ amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unsupported currency', async () => {
    const res = await request(app).post('/api/payments').send({ amount: 100, currency: 'XYZ' });
    expect(res.status).toBe(400);
  });

  it('rejects amount exceeding maximum', async () => {
    const res = await request(app).post('/api/payments').send({ amount: 2_000_000, currency: 'USD' });
    expect(res.status).toBe(400);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('Idempotency', () => {
  beforeEach(() => {
    simulateGatewayCall.mockResolvedValue({
      success: true,
      transactionId: 'txn_idem_001',
      gatewayResponse: 'APPROVED',
    });
  });

  it('returns same payment for repeated requests with same Idempotency-Key', async () => {
    const key = `idem-${Date.now()}`;

    const res1 = await request(app)
      .post('/api/payments')
      .set('Idempotency-Key', key)
      .send({ amount: 75, currency: 'USD' });

    const res2 = await request(app)
      .post('/api/payments')
      .set('Idempotency-Key', key)
      .send({ amount: 75, currency: 'USD' });

    expect(res1.body.data.id).toBe(res2.body.data.id);
    expect(res1.body.data.createdAt).toBe(res2.body.data.createdAt);
  });

  it('does not reprocess payment for duplicate idempotency key', async () => {
    const key = `idem-dedup-${Date.now()}`;

    await request(app)
      .post('/api/payments')
      .set('Idempotency-Key', key)
      .send({ amount: 20, currency: 'USD' });

    await request(app)
      .post('/api/payments')
      .set('Idempotency-Key', key)
      .send({ amount: 20, currency: 'USD' });

    // Even though created twice, gateway should have been called only once per payment
    // (second request should return cached result without initiating new processing)
    // Allow some delay for async processing
    await new Promise((r) => setTimeout(r, 200));

    // Only 1 unique payment should exist for this key
    const listRes = await request(app).get('/api/payments');
    const forKey = listRes.body.data.filter(
      (p) => p.idempotencyKey === key
    );
    expect(forKey).toHaveLength(1);
  });

  it('creates separate payments for different idempotency keys', async () => {
    const key1 = `idem-a-${Date.now()}`;
    const key2 = `idem-b-${Date.now()}`;

    const res1 = await request(app)
      .post('/api/payments')
      .set('Idempotency-Key', key1)
      .send({ amount: 10, currency: 'USD' });

    const res2 = await request(app)
      .post('/api/payments')
      .set('Idempotency-Key', key2)
      .send({ amount: 10, currency: 'USD' });

    expect(res1.body.data.id).not.toBe(res2.body.data.id);
  });
});

// ── Get payment ───────────────────────────────────────────────────────────────

describe('GET /api/payments/:id', () => {
  beforeEach(() => {
    simulateGatewayCall.mockResolvedValue({
      success: true,
      transactionId: 'txn_get_001',
      gatewayResponse: 'APPROVED',
    });
  });

  it('returns payment by ID', async () => {
    const create = await request(app).post('/api/payments').send({ amount: 30, currency: 'INR' });
    const { id } = create.body.data;

    const res = await request(app).get(`/api/payments/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });

  it('returns 404 for unknown ID', async () => {
    const res = await request(app).get('/api/payments/non-existent-id');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
  });
});

// ── List payments ─────────────────────────────────────────────────────────────

describe('GET /api/payments', () => {
  beforeEach(() => {
    simulateGatewayCall.mockResolvedValue({
      success: true,
      transactionId: 'txn_list_001',
      gatewayResponse: 'APPROVED',
    });
  });

  it('returns all payments', async () => {
    await request(app).post('/api/payments').send({ amount: 10, currency: 'USD' });
    await request(app).post('/api/payments').send({ amount: 20, currency: 'USD' });

    const res = await request(app).get('/api/payments');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by status', async () => {
    await request(app).post('/api/payments').send({ amount: 10, currency: 'USD' });

    const res = await request(app).get('/api/payments?status=PENDING');
    expect(res.status).toBe(200);
    res.body.data.forEach((p) => {
      expect(p.status).toBe(PAYMENT_STATUS.PENDING);
    });
  });
});

// ── Metrics ───────────────────────────────────────────────────────────────────

describe('GET /api/metrics', () => {
  it('returns system metrics', async () => {
    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('circuitBreaker');
    expect(res.body.data).toHaveProperty('retryQueue');
    expect(res.body.data).toHaveProperty('payments');
  });
});
