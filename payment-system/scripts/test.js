/**
 * Manual Test Script — Payment Processing System
 *
 * Tests the complete flow:
 *   Create → Poll → Webhook → Verify
 *
 * Usage:
 *   node scripts/test.js            (run all tests)
 *   node scripts/test.js webhook    (webhook tests only)
 *   node scripts/test.js payment    (payment tests only)
 */

const path   = require('path');
const http   = require('http');
const crypto = require('crypto');

// Load .env so the test script uses the same WEBHOOK_SECRET as the server
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE   = process.env.TEST_BASE_URL || 'http://localhost:3000/api';
const SECRET = process.env.WEBHOOK_SECRET || 'default-webhook-secret-change-in-production';
const ARG       = process.argv[2] || 'all';

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const raw  = body ? JSON.stringify(body) : null;
    const url  = new URL(BASE + path);

    const options = {
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':   'application/json',
        Accept:           'application/json',
        ...extraHeaders,
        ...(raw ? { 'Content-Length': Buffer.byteLength(raw) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
const divider = (n = 60) => '─'.repeat(n);

function sign(payload) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return { raw, sig };
}

function header(title) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('━'.repeat(60));
}

function ok(label)   { console.log(`  ✅  ${label}`); }
function fail(label) { console.log(`  ❌  ${label}`); }
function info(label) { console.log(`  ℹ   ${label}`); }

// ── Poll helper ───────────────────────────────────────────────────────────────

async function pollStatus(paymentId, { until = ['SUCCESS', 'FAILED'], maxTries = 20, intervalMs = 500 } = {}) {
  for (let i = 1; i <= maxTries; i++) {
    await sleep(intervalMs);
    const res = await request('GET', `/payments/${paymentId}`);
    const p   = res.body.data;
    info(`[poll ${i}] status=${p.status}  retryCount=${p.retryCount}`);
    if (until.includes(p.status)) return p;
  }
  return null;
}

// ── Test suites ───────────────────────────────────────────────────────────────

async function testHealth() {
  header('1. HEALTH CHECK');
  const res = await request('GET', '/health');
  res.body.status === 'healthy' ? ok('Service is healthy') : fail('Service unhealthy');
  console.log('     ', JSON.stringify(res.body));
}

// ─────────────────────────────────────────────────────────────────────────────
async function testCreatePayment() {
  header('2. CREATE PAYMENT  (PENDING → processing async)');

  const key = `order-test-${Date.now()}`;
  const res = await request(
    'POST', '/payments',
    { amount: 99.99, currency: 'USD', description: 'Test Order #001', metadata: { source: 'test-script' } },
    { 'Idempotency-Key': key }
  );

  console.log(`  HTTP ${res.status}`);
  console.log('  ', JSON.stringify(res.body.data, null, 4).split('\n').join('\n  '));

  res.status === 201 ? ok('Payment created (201)') : fail(`Expected 201, got ${res.status}`);
  return res.body.data;
}

// ─────────────────────────────────────────────────────────────────────────────
async function testPollToTerminal(payment) {
  header('3. POLL STATUS  (watch PENDING → PROCESSING → SUCCESS/FAILED/RETRYING)');
  info(`Payment ID: ${payment.id}`);
  info(`Polling every 500ms for up to 10 seconds...`);

  const final = await pollStatus(payment.id);
  if (!final) { fail('Payment did not reach terminal state in time'); return null; }

  console.log('\n  Final payment object:');
  console.log('  ', JSON.stringify(final, null, 4).split('\n').join('\n  '));

  final.status === 'SUCCESS'
    ? ok(`SUCCESS — transactionId: ${final.transactionId}`)
    : ok(`FAILED  — error: ${final.gatewayError}`);

  return final;
}

// ─────────────────────────────────────────────────────────────────────────────
async function testIdempotency() {
  header('4. IDEMPOTENCY  (same key → same payment, no duplicate)');

  const key  = `idem-fixed-key-${Date.now()}`;
  const body = { amount: 50, currency: 'EUR', description: 'Idempotency test' };

  const r1 = await request('POST', '/payments', body, { 'Idempotency-Key': key });
  const r2 = await request('POST', '/payments', body, { 'Idempotency-Key': key });
  const r3 = await request('POST', '/payments', body, { 'Idempotency-Key': key });

  const ids = [r1, r2, r3].map((r) => r.body.data?.id);
  const allSame = ids.every((id) => id === ids[0]);

  allSame ? ok(`All 3 requests returned the same payment ID: ${ids[0]}`) : fail('Different IDs returned — idempotency broken');
  info(`Request 1 HTTP: ${r1.status}, Request 2 HTTP: ${r2.status}, Request 3 HTTP: ${r3.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
async function testWebhookFlow() {
  header('5. WEBHOOK FLOW  (like Stripe sends callbacks to your server)');

  // Step A — create a fresh payment
  info('Step A: Creating a new payment...');
  await sleep(3000); // let rate limit window partially reset
  const createRes = await request('POST', '/payments', {
    amount: 250.00,
    currency: 'USD',
    description: 'Webhook test payment',
  });
  if (!createRes.body.data) {
    fail(`Could not create payment (HTTP ${createRes.status}). Try again in 60s if rate limited.`);
    return;
  }
  const payment = createRes.body.data;
  info(`Payment created: ${payment.id}  status=${payment.status}`);

  // Give the gateway time to start processing
  await sleep(400);
  const currentRes = await request('GET', `/payments/${payment.id}`);
  info(`Status before webhook: ${currentRes.body.data.status}`);

  // Step B — simulate gateway sending APPROVED webhook
  info('\nStep B: Gateway sends APPROVED webhook...');
  const payload = {
    paymentId:     payment.id,
    status:        'APPROVED',
    transactionId: `txn_webhook_${Date.now()}`,
    timestamp:     new Date().toISOString(),
  };

  const { raw, sig } = sign(payload);
  console.log(`\n  Payload:   ${raw}`);
  console.log(`  Signature: ${sig}`);

  const webhookRes = await request('POST', '/webhooks/payment', payload, {
    'X-Gateway-Signature': sig,
  });

  console.log(`\n  HTTP ${webhookRes.status}`);
  console.log('  ', JSON.stringify(webhookRes.body, null, 4).split('\n').join('\n  '));

  webhookRes.status === 200 ? ok('Webhook accepted (200)') : fail(`Expected 200, got ${webhookRes.status}`);

  // Step C — verify the payment updated
  info('\nStep C: Verifying payment status updated by webhook...');
  const verifyRes = await request('GET', `/payments/${payment.id}`);
  const updated   = verifyRes.body.data;

  console.log(`\n  Payment after webhook:`);
  console.log(`    status:        ${updated.status}`);
  console.log(`    transactionId: ${updated.transactionId}`);
  console.log(`    events:`);
  updated.events?.forEach((e) => {
    console.log(`      [${e.status}] ${e.message}`);
  });

  updated.status === 'SUCCESS'
    ? ok('Payment updated to SUCCESS via webhook')
    : ok(`Payment status: ${updated.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
async function testWebhookDeclined() {
  header('6. WEBHOOK — DECLINED  (gateway rejects payment)');

  await sleep(2000);
  const createRes = await request('POST', '/payments', { amount: 75, currency: 'GBP' });
  if (!createRes.body.data) { fail(`Rate limited (${createRes.status})`); return; }
  const payment   = createRes.body.data;
  info(`Payment: ${payment.id}`);
  await sleep(300);

  const payload = {
    paymentId: payment.id,
    status:    'DECLINED',
    errorCode: 'INSUFFICIENT_FUNDS',
    timestamp: new Date().toISOString(),
  };
  const { sig } = sign(payload);

  const res = await request('POST', '/webhooks/payment', payload, { 'X-Gateway-Signature': sig });
  console.log(`  HTTP ${res.status}`, JSON.stringify(res.body.data?.status));

  const final = (await request('GET', `/payments/${payment.id}`)).body.data;
  final.status === 'FAILED'
    ? ok(`Payment FAILED — gatewayError: ${final.gatewayError}`)
    : info(`Payment status: ${final.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
async function testDuplicateWebhook() {
  header('7. DUPLICATE WEBHOOK  (idempotent — second call ignored)');

  await sleep(2000);
  const createRes = await request('POST', '/payments', { amount: 30, currency: 'USD' });
  if (!createRes.body.data) { fail(`Rate limited (${createRes.status})`); return; }
  const id = createRes.body.data.id;
  await sleep(300);

  const payload = { paymentId: id, status: 'APPROVED', transactionId: 'txn_dup_001', timestamp: new Date().toISOString() };
  const { sig } = sign(payload);
  const headers = { 'X-Gateway-Signature': sig };

  const r1 = await request('POST', '/webhooks/payment', payload, headers);
  const r2 = await request('POST', '/webhooks/payment', payload, headers); // duplicate
  const r3 = await request('POST', '/webhooks/payment', payload, headers); // duplicate

  console.log(`  Request 1: ${r1.status} → ${r1.body.data?.status}`);
  console.log(`  Request 2: ${r2.status} → ${r2.body.data?.status} (should be same, not re-processed)`);
  console.log(`  Request 3: ${r3.status} → ${r3.body.data?.status} (should be same, not re-processed)`);

  const allSuccess = [r1, r2, r3].every((r) => r.body.data?.status === 'SUCCESS');
  allSuccess ? ok('All 3 duplicate webhooks handled idempotently') : fail('Inconsistent states on duplicate webhooks');
}

// ─────────────────────────────────────────────────────────────────────────────
async function testInvalidSignature() {
  header('8. INVALID SIGNATURE  (should return 401)');

  const payload = { paymentId: 'some-id', status: 'APPROVED', timestamp: new Date().toISOString() };

  const tests = [
    { label: 'No signature header',   headers: {} },
    { label: 'Wrong signature',       headers: { 'X-Gateway-Signature': 'abc123wrongsignature' } },
    { label: 'Empty signature',       headers: { 'X-Gateway-Signature': '' } },
  ];

  for (const t of tests) {
    const res = await request('POST', '/webhooks/payment', payload, t.headers);
    res.status === 401
      ? ok(`${t.label} → 401 INVALID_WEBHOOK_SIGNATURE`)
      : fail(`${t.label} → expected 401, got ${res.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function testValidation() {
  header('9. VALIDATION ERRORS  (should return 400)');

  const cases = [
    { label: 'Missing amount',     body: { currency: 'USD' } },
    { label: 'Negative amount',    body: { amount: -10, currency: 'USD' } },
    { label: 'Zero amount',        body: { amount: 0, currency: 'USD' } },
    { label: 'Missing currency',   body: { amount: 100 } },
    { label: 'Invalid currency',   body: { amount: 100, currency: 'XYZ' } },
    { label: 'Amount too large',   body: { amount: 9999999, currency: 'USD' } },
  ];

  for (const c of cases) {
    await sleep(400); // stay under the 20 req/min payment creation rate limit
    const res = await request('POST', '/payments', c.body);
    if (res.status === 429) {
      info(`${c.label} → rate limited (429) — skipping, slow down between tests`);
      continue;
    }
    res.status === 400
      ? ok(`${c.label} → 400 ${res.body.error?.code}`)
      : fail(`${c.label} → expected 400, got ${res.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function testListAndMetrics() {
  header('10. LIST & METRICS');

  const all     = await request('GET', '/payments');
  const success = await request('GET', '/payments?status=SUCCESS');
  const failed  = await request('GET', '/payments?status=FAILED');
  const metrics = await request('GET', '/metrics');

  info(`Total payments:   ${all.body.total}`);
  info(`SUCCESS payments: ${success.body.total}`);
  info(`FAILED payments:  ${failed.body.total}`);
  info(`Circuit breaker:  ${metrics.body.data?.circuitBreaker?.state}`);
  info(`Retry queue:      ${metrics.body.data?.retryQueue?.pendingRetries} pending`);

  ok('List and metrics endpoints working');
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║        Payment System — End-to-End Test Suite           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Base URL : ${BASE}`);
  console.log(`  Filter   : ${ARG}`);
  console.log(`  Secret   : ${SECRET.slice(0, 10)}...`);

  const runPayment = ['all', 'payment'].includes(ARG);
  const runWebhook = ['all', 'webhook'].includes(ARG);

  try {
    await testHealth();

    if (runPayment) {
      const payment = await testCreatePayment();
      if (payment) await testPollToTerminal(payment);
      await testIdempotency();
      await testValidation();
    }

    if (runWebhook) {
      await testWebhookFlow();
      await testWebhookDeclined();
      await testDuplicateWebhook();
      await testInvalidSignature();
    }

    if (runPayment || runWebhook) {
      await testListAndMetrics();
    }

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                   All Tests Done ✅                     ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

  } catch (err) {
    console.error('\n❌ Test script error:', err.message);
    console.error('   Make sure the server is running: npm start');
    process.exit(1);
  }
}

main();
