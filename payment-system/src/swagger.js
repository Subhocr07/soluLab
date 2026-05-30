const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Payment Processing System API',
      version: '1.0.0',
      description: `
A robust payment processing system that simulates real-world gateway behaviour.

**Key Features:**
- Full payment lifecycle: \`PENDING → PROCESSING → SUCCESS / FAILED / RETRYING\`
- Exponential backoff retry with configurable max attempts
- Idempotency via \`Idempotency-Key\` header
- Per-payment mutex lock for concurrency safety
- Circuit breaker on the gateway client
- Async webhook / callback handling with HMAC-SHA256 signature verification
- Rate limiting on all endpoints

**Payment States:**
| State | Meaning |
|-------|---------|
| PENDING | Payment created, queued for processing |
| PROCESSING | Gateway call in-flight |
| SUCCESS | Gateway approved |
| FAILED | Terminal failure (non-retryable or max retries exhausted) |
| RETRYING | Gateway failed, scheduled for retry with exponential backoff |
      `,
    },
    // No servers entry — Swagger UI uses the current host (localhost:3000)
    // and each path below carries the /api prefix explicitly.
    tags: [
      { name: 'Payments', description: 'Payment lifecycle endpoints' },
      { name: 'Webhooks', description: 'Gateway callback endpoint' },
      { name: 'System', description: 'Health and metrics' },
    ],

    // ── Reusable schemas ────────────────────────────────────────────────────
    components: {
      schemas: {

        CreatePaymentRequest: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: {
              type: 'number',
              format: 'float',
              minimum: 0.01,
              maximum: 1000000,
              example: 99.99,
              description: 'Payment amount (positive number)',
            },
            currency: {
              type: 'string',
              minLength: 3,
              maxLength: 3,
              example: 'USD',
              description: 'ISO 4217 currency code',
              enum: ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD', 'SGD'],
            },
            description: {
              type: 'string',
              maxLength: 255,
              example: 'Order #ORD-2026-001',
              description: 'Optional human-readable description',
            },
            metadata: {
              type: 'object',
              example: { orderId: 'ORD-2026-001', userId: 'USR-42' },
              description: 'Arbitrary key-value pairs attached to the payment',
            },
          },
        },

        Payment: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
            amount: { type: 'number', example: 99.99 },
            currency: { type: 'string', example: 'USD' },
            description: { type: 'string', example: 'Order #ORD-2026-001' },
            metadata: { type: 'object', example: { orderId: 'ORD-2026-001' } },
            status: {
              type: 'string',
              enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'RETRYING'],
              example: 'SUCCESS',
            },
            idempotencyKey: { type: 'string', nullable: true, example: 'order-ORD-2026-001' },
            retryCount: { type: 'integer', example: 1 },
            maxRetries: { type: 'integer', example: 3 },
            transactionId: { type: 'string', nullable: true, example: 'txn_1234567890_abc' },
            gatewayError: { type: 'string', nullable: true, example: 'Gateway rejected: CARD_DECLINED' },
            createdAt: { type: 'string', format: 'date-time', example: '2026-05-30T14:00:00.000Z' },
            updatedAt: { type: 'string', format: 'date-time', example: '2026-05-30T14:00:02.000Z' },
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'PROCESSING' },
                  message: { type: 'string', example: 'Gateway call initiated' },
                  timestamp: { type: 'string', format: 'date-time', example: '2026-05-30T14:00:01.000Z' },
                },
              },
            },
          },
        },

        WebhookRequest: {
          type: 'object',
          required: ['paymentId', 'status'],
          properties: {
            paymentId: {
              type: 'string',
              format: 'uuid',
              example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              description: 'ID of the payment being updated',
            },
            status: {
              type: 'string',
              enum: ['APPROVED', 'DECLINED', 'PROCESSING'],
              example: 'APPROVED',
              description: 'New status reported by the gateway',
            },
            transactionId: {
              type: 'string',
              example: 'txn_gateway_1234567890',
              description: 'Gateway transaction reference (for APPROVED)',
            },
            errorCode: {
              type: 'string',
              example: 'INSUFFICIENT_FUNDS',
              description: 'Gateway error code (for DECLINED)',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              example: '2026-05-30T14:00:05.000Z',
            },
          },
        },

        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'object' },
          },
        },

        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: 'amount must be a positive number' },
              },
            },
          },
        },
      },

      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string', example: 'order-ORD-2026-001' },
          description: 'Unique key to prevent duplicate payments. Same key always returns the same payment without re-processing.',
        },
        PaymentId: {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
          description: 'Payment UUID',
        },
        GatewaySignature: {
          name: 'X-Gateway-Signature',
          in: 'header',
          required: true,
          schema: { type: 'string', example: 'abc123def456...' },
          description: 'HMAC-SHA256 of the raw JSON body using the shared webhook secret',
        },
      },
    },

    // ── Paths ───────────────────────────────────────────────────────────────
    paths: {

      '/payments': {
        post: {
          tags: ['Payments'],
          summary: 'Create a payment',
          description: `
Initiates a new payment. Processing starts asynchronously — the response returns immediately with status \`PENDING\`.

Poll \`GET /payments/{id}\` to track the payment through its lifecycle.

**Idempotency:** Supply the same \`Idempotency-Key\` header to safely retry a request without creating a duplicate payment.
          `,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreatePaymentRequest' },
                examples: {
                  basic: {
                    summary: 'Simple USD payment',
                    value: { amount: 99.99, currency: 'USD', description: 'Order #ORD-2026-001' },
                  },
                  withMetadata: {
                    summary: 'Payment with metadata',
                    value: {
                      amount: 250.00,
                      currency: 'EUR',
                      description: 'Premium subscription',
                      metadata: { userId: 'USR-42', plan: 'premium', billingCycle: 'monthly' },
                    },
                  },
                  gbp: {
                    summary: 'GBP payment',
                    value: { amount: 49.99, currency: 'GBP' },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Payment created — processing started in background',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: { $ref: '#/components/schemas/Payment' },
                    },
                  },
                  example: {
                    success: true,
                    data: {
                      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                      amount: 99.99,
                      currency: 'USD',
                      description: 'Order #ORD-2026-001',
                      metadata: {},
                      status: 'PENDING',
                      idempotencyKey: null,
                      retryCount: 0,
                      maxRetries: 3,
                      transactionId: null,
                      gatewayError: null,
                      createdAt: '2026-05-30T14:00:00.000Z',
                      updatedAt: '2026-05-30T14:00:00.000Z',
                      events: [{ status: 'PENDING', message: 'Payment created', timestamp: '2026-05-30T14:00:00.000Z' }],
                    },
                  },
                },
              },
            },
            200: { description: 'Existing payment returned (idempotent duplicate request)' },
            400: {
              description: 'Validation error',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                  example: { success: false, error: { code: 'VALIDATION_ERROR', message: 'amount must be a positive number' } },
                },
              },
            },
            429: { description: 'Rate limit exceeded' },
          },
        },

        get: {
          tags: ['Payments'],
          summary: 'List payments',
          description: 'Returns a paginated list of payments, optionally filtered by status.',
          parameters: [
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'RETRYING'] },
              description: 'Filter by payment status',
              example: 'SUCCESS',
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
              description: 'Max records to return',
            },
            {
              name: 'offset',
              in: 'query',
              schema: { type: 'integer', default: 0, minimum: 0 },
              description: 'Number of records to skip',
            },
          ],
          responses: {
            200: {
              description: 'List of payments',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: { type: 'array', items: { $ref: '#/components/schemas/Payment' } },
                      total: { type: 'integer', example: 3 },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/payments/{id}': {
        get: {
          tags: ['Payments'],
          summary: 'Get payment by ID',
          description: 'Returns the full payment object including status and event log. Poll this endpoint to track async processing.',
          parameters: [{ $ref: '#/components/parameters/PaymentId' }],
          responses: {
            200: {
              description: 'Payment found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: { $ref: '#/components/schemas/Payment' },
                    },
                  },
                  example: {
                    success: true,
                    data: {
                      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                      amount: 99.99,
                      currency: 'USD',
                      status: 'SUCCESS',
                      retryCount: 1,
                      maxRetries: 3,
                      transactionId: 'txn_1748613600000_abc1234',
                      gatewayError: null,
                      createdAt: '2026-05-30T14:00:00.000Z',
                      updatedAt: '2026-05-30T14:00:02.000Z',
                      events: [
                        { status: 'PENDING', message: 'Payment created', timestamp: '2026-05-30T14:00:00.000Z' },
                        { status: 'PROCESSING', message: 'Gateway call initiated', timestamp: '2026-05-30T14:00:00.100Z' },
                        { status: 'RETRYING', message: 'Attempt 1 failed: Gateway rejected: CARD_DECLINED. Retrying (1/3)', timestamp: '2026-05-30T14:00:01.000Z' },
                        { status: 'PROCESSING', message: 'Gateway call initiated', timestamp: '2026-05-30T14:00:01.500Z' },
                        { status: 'SUCCESS', message: 'Payment approved. Transaction: txn_1748613600000_abc1234', timestamp: '2026-05-30T14:00:02.000Z' },
                      ],
                    },
                  },
                },
              },
            },
            404: {
              description: 'Payment not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                  example: { success: false, error: { code: 'PAYMENT_NOT_FOUND', message: 'Payment a1b2c3d4-... not found' } },
                },
              },
            },
          },
        },
      },

      '/webhooks/payment': {
        post: {
          tags: ['Webhooks'],
          summary: 'Receive gateway callback',
          description: `
The payment gateway calls this endpoint asynchronously when a payment status changes.

**Signature verification:** Every request must include the \`X-Gateway-Signature\` header — an HMAC-SHA256 hex digest of the raw JSON body using the shared \`WEBHOOK_SECRET\`.

**Idempotent:** Duplicate callbacks for an already-terminal payment are safely ignored.

**Generate a test signature (PowerShell):**
\`\`\`powershell
$body   = '{"paymentId":"YOUR-ID","status":"APPROVED","transactionId":"txn_001","timestamp":"2026-05-30T14:00:00Z"}'
$secret = "default-webhook-secret-change-in-production"
$hmac   = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($secret)
$hash   = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($body))
[BitConverter]::ToString($hash).Replace("-","").ToLower()
\`\`\`
          `,
          parameters: [{ $ref: '#/components/parameters/GatewaySignature' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookRequest' },
                examples: {
                  approved: {
                    summary: 'Payment approved by gateway',
                    value: {
                      paymentId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                      status: 'APPROVED',
                      transactionId: 'txn_gateway_1234567890',
                      timestamp: '2026-05-30T14:00:05.000Z',
                    },
                  },
                  declined: {
                    summary: 'Payment declined by gateway',
                    value: {
                      paymentId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                      status: 'DECLINED',
                      errorCode: 'INSUFFICIENT_FUNDS',
                      timestamp: '2026-05-30T14:00:05.000Z',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Webhook processed — updated payment returned',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: { $ref: '#/components/schemas/Payment' },
                    },
                  },
                },
              },
            },
            400: { description: 'Invalid payload', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            401: {
              description: 'Invalid or missing signature',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                  example: { success: false, error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Invalid webhook signature' } },
                },
              },
            },
            404: { description: 'Payment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },

      '/health': {
        get: {
          tags: ['System'],
          summary: 'Health check',
          responses: {
            200: {
              description: 'Service is healthy',
              content: {
                'application/json': {
                  example: { success: true, status: 'healthy', timestamp: '2026-05-30T14:00:00.000Z' },
                },
              },
            },
          },
        },
      },

      '/metrics': {
        get: {
          tags: ['System'],
          summary: 'System metrics',
          description: 'Returns circuit breaker state, retry queue depth, and total payment count.',
          responses: {
            200: {
              description: 'Metrics snapshot',
              content: {
                'application/json': {
                  example: {
                    success: true,
                    data: {
                      circuitBreaker: { name: 'payment-gateway', state: 'CLOSED', failureCount: 0, successCount: 0, lastFailureTime: null },
                      retryQueue: { pendingRetries: 2, items: [{ paymentId: 'a1b2...', attemptNumber: 1, delayMs: 750 }] },
                      payments: { total: 15 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  apis: [], // all paths defined inline above
};

const swaggerSpec = swaggerJsdoc(options);

function setupSwagger(app) {
  // Static swagger-ui assets
  app.use('/api-docs', swaggerUi.serve);

  // Each GET to /api-docs injects the correct absolute server URL at request time
  app.get('/api-docs', (req, res, next) => {
    const spec = {
      ...swaggerSpec,
      servers: [{ url: `${req.protocol}://${req.get('host')}/api` }],
    };
    swaggerUi.setup(spec, {
      customSiteTitle: 'Payment System API',
      swaggerOptions: { displayRequestDuration: true },
    })(req, res, next);
  });

  // Raw spec endpoint (useful for imports / curl)
  app.get('/api-docs.json', (req, res) => {
    res.json({
      ...swaggerSpec,
      servers: [{ url: `${req.protocol}://${req.get('host')}/api` }],
    });
  });
}

module.exports = { setupSwagger };
