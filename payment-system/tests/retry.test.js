/**
 * Tests: Retry logic — exponential backoff scheduling, max attempts, non-retryable errors.
 *
 * Strategy: mock RetryQueue.schedule (prevent auto-firing) and call processPayment
 * directly for each attempt. This avoids fake-timer / Sequelize-async conflicts.
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
  _resetState,
  _cancelPendingImmediates,
} = require('../src/services/paymentService');
const { RetryQueue } = require('../src/services/retryService');
const { PAYMENT_STATUS } = require('../src/models/paymentStore');

beforeEach(async () => {
  await _resetState();
  jest.clearAllMocks();
  // Prevent auto-retry scheduling — tests call processPayment directly
  jest.spyOn(RetryQueue, 'schedule').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGatewayError(code, retryable = true) {
  const err = new Error(`Gateway error: ${code}`);
  err.code = code;
  err.isRetryable = retryable;
  return err;
}

async function setupPayment(overrides = {}) {
  const payment = await createPayment({ amount: 100, currency: 'USD', ...overrides });
  // Cancel the setImmediate from createPayment so the test controls processing
  _cancelPendingImmediates();
  return payment;
}

// ── Basic retry ───────────────────────────────────────────────────────────────

describe('Retry on gateway failure', () => {
  it('retries after a retryable failure and eventually succeeds', async () => {
    simulateGatewayCall
      .mockRejectedValueOnce(makeGatewayError('PROCESSING_ERROR', true))
      .mockResolvedValueOnce({ success: true, transactionId: 'txn_retry_ok' });

    const payment = await setupPayment();
    await processPayment(payment.id); // attempt 1 → RETRYING

    let p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.RETRYING);
    expect(p.retryCount).toBe(1);

    await processPayment(payment.id); // attempt 2 → SUCCESS

    p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.SUCCESS);
    expect(p.transactionId).toBe('txn_retry_ok');
  });

  it('increments retryCount for each failure', async () => {
    simulateGatewayCall
      .mockRejectedValueOnce(makeGatewayError('NETWORK_ERROR', true))
      .mockRejectedValueOnce(makeGatewayError('NETWORK_ERROR', true))
      .mockResolvedValueOnce({ success: true, transactionId: 'txn_third_try' });

    const payment = await setupPayment();

    await processPayment(payment.id);
    let p = await getPayment(payment.id);
    expect(p.retryCount).toBe(1);
    expect(p.status).toBe(PAYMENT_STATUS.RETRYING);

    await processPayment(payment.id);
    p = await getPayment(payment.id);
    expect(p.retryCount).toBe(2);
    expect(p.status).toBe(PAYMENT_STATUS.RETRYING);

    await processPayment(payment.id);
    p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.SUCCESS);
    expect(p.transactionId).toBe('txn_third_try');
  });
});

// ── Max retries ───────────────────────────────────────────────────────────────

describe('Max retries exhaustion', () => {
  it('marks payment FAILED after exhausting max retries', async () => {
    simulateGatewayCall.mockRejectedValue(makeGatewayError('CARD_DECLINED', true));

    const payment = await setupPayment();

    // initial + maxRetries calls
    for (let i = 0; i <= payment.maxRetries; i++) {
      await processPayment(payment.id);
    }

    const p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.FAILED);
    expect(p.retryCount).toBe(payment.maxRetries);
    expect(p.gatewayError).toContain('CARD_DECLINED');
  });

  it('does not call gateway beyond maxRetries + 1 times', async () => {
    simulateGatewayCall.mockRejectedValue(makeGatewayError('NETWORK_ERROR', true));

    const payment = await setupPayment();

    for (let i = 0; i <= payment.maxRetries + 5; i++) {
      await processPayment(payment.id);
    }

    expect(simulateGatewayCall).toHaveBeenCalledTimes(payment.maxRetries + 1);
  });

  it('does not schedule further retries once FAILED', async () => {
    simulateGatewayCall.mockRejectedValue(makeGatewayError('NETWORK_ERROR', true));

    const payment = await setupPayment();

    for (let i = 0; i <= payment.maxRetries; i++) {
      await processPayment(payment.id);
    }

    const p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.FAILED);
    // schedule was called maxRetries times (not on the final terminal failure)
    expect(RetryQueue.schedule).toHaveBeenCalledTimes(payment.maxRetries);
  });
});

// ── Non-retryable errors ──────────────────────────────────────────────────────

describe('Non-retryable errors', () => {
  it('immediately fails for INSUFFICIENT_FUNDS', async () => {
    simulateGatewayCall.mockRejectedValue(makeGatewayError('INSUFFICIENT_FUNDS', false));

    const payment = await setupPayment();
    await processPayment(payment.id);

    const p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.FAILED);
    expect(p.retryCount).toBe(0);
    expect(simulateGatewayCall).toHaveBeenCalledTimes(1);
  });

  it('does not call RetryQueue.schedule for non-retryable error', async () => {
    simulateGatewayCall.mockRejectedValue(makeGatewayError('FRAUD_DETECTED', false));

    const payment = await setupPayment();
    await processPayment(payment.id);

    expect(RetryQueue.schedule).not.toHaveBeenCalled();
  });

  it('immediately fails for INVALID_CARD', async () => {
    simulateGatewayCall.mockRejectedValue(makeGatewayError('INVALID_CARD', false));

    const payment = await setupPayment();
    await processPayment(payment.id);

    const p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.FAILED);
    expect(p.retryCount).toBe(0);
  });
});

// ── Event log ─────────────────────────────────────────────────────────────────

describe('Payment event log', () => {
  it('records each state transition in the events array', async () => {
    simulateGatewayCall
      .mockRejectedValueOnce(makeGatewayError('NETWORK_ERROR', true))
      .mockResolvedValueOnce({ success: true, transactionId: 'txn_events' });

    const payment = await setupPayment();
    await processPayment(payment.id);
    await processPayment(payment.id);

    const p = await getPayment(payment.id);
    const statuses = p.events.map((e) => e.status);
    expect(statuses).toContain(PAYMENT_STATUS.PENDING);
    expect(statuses).toContain(PAYMENT_STATUS.PROCESSING);
    expect(statuses).toContain(PAYMENT_STATUS.RETRYING);
    expect(statuses).toContain(PAYMENT_STATUS.SUCCESS);
  });

  it('events are ordered chronologically', async () => {
    simulateGatewayCall.mockResolvedValue({ success: true, transactionId: 'txn_order' });

    const payment = await setupPayment();
    await processPayment(payment.id);

    const p = await getPayment(payment.id);
    const times = p.events.map((e) => new Date(e.timestamp).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });
});

// ── Successful first attempt ──────────────────────────────────────────────────

describe('Successful first attempt', () => {
  it('goes directly to SUCCESS without scheduling a retry', async () => {
    simulateGatewayCall.mockResolvedValue({ success: true, transactionId: 'txn_first_ok' });

    const payment = await setupPayment();
    await processPayment(payment.id);

    const p = await getPayment(payment.id);
    expect(p.status).toBe(PAYMENT_STATUS.SUCCESS);
    expect(p.retryCount).toBe(0);
    expect(RetryQueue.schedule).not.toHaveBeenCalled();
  });
});
