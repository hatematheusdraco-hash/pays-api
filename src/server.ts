import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { config, isProd } from './config.js';
import { closePool, ping } from './db.js';
import { ApiError } from './lib/errors.js';
import { startProcessor } from './engine/processor.js';
import { startWebhookDispatcher } from './webhooks/dispatcher.js';
import { healthRoutes } from './routes/health.js';
import { merchantRoutes } from './routes/merchants.js';
import { paymentRoutes } from './routes/payments.js';
import { webhookRoutes } from './routes/webhooks.js';

export async function buildServer() {
  const app = Fastify({
    logger: isProd
      ? { level: config.logLevel }
      : {
          level: config.logLevel,
          transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
        },
    trustProxy: true,
    requestIdHeader: 'x-request-id',
  });

  // Rate limiting (§Layer 1). MVP uses an in-process store; production swaps in
  // Redis + sliding window for accurate per-key limits across instances.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.merchantId ?? req.ip,
  });

  // Uniform Stripe-like error envelope.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send(err.toJSON());
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({
        error: { type: 'rate_limit_error', message: 'Too many requests.' },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: { type: 'api_error', message: 'An internal error occurred.' },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: {
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: `Unrecognized request URL (${req.method} ${req.url}).`,
      },
    });
  });

  await app.register(healthRoutes);
  await app.register(merchantRoutes);
  await app.register(paymentRoutes);
  await app.register(webhookRoutes);

  return app;
}

async function main() {
  const app = await buildServer();

  try {
    await ping();
    app.log.info('database connection ok');
  } catch (err) {
    app.log.error({ err }, 'cannot reach database — check DATABASE_URL');
    process.exit(1);
  }

  const stopProcessor = startProcessor(app.log);
  const stopDispatcher = startWebhookDispatcher(app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stopProcessor();
    stopDispatcher();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

// Run only when executed directly (not when imported by tests/scripts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
