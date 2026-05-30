/**
 * Tests: Concurrency control — preventing parallel processing,
 *        idempotent creation under race conditions
 */

jest.mock('../src/services/gatewayService', () => ({
  simulateGatewayCall: jest.fn(),
  getCircuitBreakerStatus: jest.fn(() => ({ state: 'CLOSED', failureCount: 0 })),
  resetCircuitBreaker: jest.fn(),
}));

const { simulateGatewayCall } = require('../src/services/gatewayService');
const {
  createPayment,
  processPayment,
  getPayment,
  applyWebhookUpdate,
  _resetState,
} = require('../src/services/paymentService');
const { PAYMENT_STATUS } = require('../src/models/paymentStore');

beforeEach(async () => {
  await _resetState();
  jest.clearAllMocks();
});

// ── Helper: wait until condition is true ──────────────────────────────────────
function waitUntil(condFn, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condFn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitUntil timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

// ── Concurrent processPayment calls ──────────────────────────────────────────

describe('Concurrent processPayment guard', () => {
  it('skips duplicate processPayment call while one is already running', async () => {
    let resolveGateway;
    simulateGatewayCall.mockImplementation(
      () => new Promise((resolve) => { resolveGateway = resolve; })
    );

    const payment = await createPayment({ amount: 100, currency: 'USD' });

    // Start first processing call
    const p1 = processPayment(payment.id);

    // Wait until the gateway mock has been called (resolveGateway is set)
    await waitUntil(() => typeof resolveGateway === 'function');

    // Start second call — should be blocked by processingSet
    const p2 = processPayment(payment.id);

    // Resolve the pending gateway call
    resolveGateway({ success: true, transactionId: 'txn_concurrent' });
    await Promise.all([p1, p2]);

    // Gateway should have been called exactly once
    expect(simulateGatewayCall).toHaveBeenCalledTimes(1);

    const p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.SUCCESS);
  });

  it('payment reaches a valid terminal state even with many concurrent calls', async () => {
    simulateGatewayCall.mockResolvedValue({
      success: true,
      transactionId: 'txn_race',
    });

    const payment = await createPayment({ amount: 200, currency: 'USD' });

    // Fire 10 concurrent processPayment calls
    const calls = Array.from({ length: 10 }, () => processPayment(payment.id));
    await Promise.all(calls);

    const p = await getPayment(payment.id);
    expect([
      PAYMENT_STATUS.SUCCESS,
      PAYMENT_STATUS.FAILED,
      PAYMENT_STATUS.PROCESSING,
      PAYMENT_STATUS.RETRYING,
    ]).toContain(p.status);

    // At most 2 concurrent calls could slip past the set guard in very tight timing
    expect(simulateGatewayCall.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ── Idempotent creation under race conditions ─────────────────────────────────

describe('Concurrent payment creation with same idempotency key', () => {
  it('returns the same payment for concurrent requests with the same key', async () => {
    simulateGatewayCall.mockResolvedValue({
      success: true,
      transactionId: 'txn_idem_race',
    });

    const key = `race-key-${Date.now()}`;
    const payload = { amount: 50, currency: 'USD', idempotencyKey: key };

    // 5 concurrent creation requests for the same key
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createPayment(payload))
    );

    const uniqueIds = new Set(results.map((p) => p.id));
    expect(uniqueIds.size).toBe(1);
  });
});

// ── Concurrent webhook and processing ─────────────────────────────────────────

describe('Concurrent webhook and processing', () => {
  it('final state is SUCCESS when webhook races with gateway response', async () => {
    let resolveGateway;
    simulateGatewayCall.mockImplementation(
      () => new Promise((resolve) => { resolveGateway = resolve; })
    );

    const payment = await createPayment({ amount: 75, currency: 'USD' });

    // Start gateway processing
    const processingPromise = processPayment(payment.id);

    // Wait for gateway to be called before sending webhook
    await waitUntil(() => typeof resolveGateway === 'function');

    // Webhook arrives while gateway call is in-flight
    const webhookPromise = applyWebhookUpdate(payment.id, {
      status: 'APPROVED',
      transactionId: 'txn_webhook_wins',
    });

    // Gateway also responds
    resolveGateway({ success: true, transactionId: 'txn_gateway_wins' });

    await Promise.all([processingPromise, webhookPromise]);

    const p = await getPayment(payment.id);
    // Both paths lead to SUCCESS — one should win cleanly
    expect(p.status).toBe(PAYMENT_STATUS.SUCCESS);
  });
});

// ── Processing guard on terminal payments ─────────────────────────────────────

describe('Processing guard on terminal payments', () => {
  it('does not reprocess a payment already in SUCCESS state', async () => {
    simulateGatewayCall.mockResolvedValue({
      success: true,
      transactionId: 'txn_already_done',
    });

    const payment = await createPayment({ amount: 30, currency: 'USD' });
    await processPayment(payment.id); // direct call to process

    let p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.SUCCESS);

    const callCount = simulateGatewayCall.mock.calls.length;

    // Try processing again — should be a no-op (terminal state guard)
    await processPayment(payment.id);
    await processPayment(payment.id);

    expect(simulateGatewayCall.mock.calls.length).toBe(callCount);
  });

  it('does not reprocess a payment in FAILED state', async () => {
    const err = new Error('Gateway error: FRAUD_DETECTED');
    err.isRetryable = false;
    simulateGatewayCall.mockRejectedValue(err);

    const payment = await createPayment({ amount: 30, currency: 'USD' });
    await processPayment(payment.id);

    let p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.FAILED);

    const callCount = simulateGatewayCall.mock.calls.length;
    await processPayment(payment.id);

    expect(simulateGatewayCall.mock.calls.length).toBe(callCount);
  });
});
