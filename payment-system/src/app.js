const express = require('express');
const config = require('./config/config');
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { paymentLimiter } = require('./middleware/rateLimiter');
const { setupSwagger } = require('./swagger');
const { metrics } = require('./controllers/paymentController');
const paymentRoutes = require('./routes/paymentRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf-8');
    },
  })
);

// ── Global rate limiter ───────────────────────────────────────────────────────
app.use('/api', paymentLimiter);

// ── API docs ──────────────────────────────────────────────────────────────────
setupSwagger(app);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/payments', paymentRoutes);
app.use('/api/webhooks', webhookRoutes);
app.get('/api/metrics', metrics);

// Developer utilities — not available in production
if (config.nodeEnv !== 'production') {
  app.use('/api/dev', require('./routes/devRoutes'));
}

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

// ── Database initialisation + server start ────────────────────────────────────
async function startServer() {
  require('./models/index'); // register associations before any query

  const { createDatabaseIfNotExists, runMigrations } = require('./database/migrate');

  // Step 1: create the database via the postgres system DB (safe before any pool connection)
  await createDatabaseIfNotExists();

  // Step 2: now that the database exists, open the main connection pool
  const sequelize = require('./config/database');
  await sequelize.authenticate();
  logger.info('Database connection established');

  // Step 3: apply pending migrations
  await runMigrations();

  const server = app.listen(config.port, () => {
    logger.info(`Payment service running on port ${config.port}`, {
      env: config.nodeEnv,
      docs: `http://localhost:${config.port}/api-docs`,
    });
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(async () => {
      await sequelize.close();
      logger.info('Server and DB connection closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  startServer().catch((err) => {
    require('./utils/logger').error('Failed to start server', { err: err.message });
    process.exit(1);
  });
}

module.exports = app;
