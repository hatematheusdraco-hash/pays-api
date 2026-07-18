import type { FastifyInstance } from 'fastify';
import { ping } from '../db.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => ({
    name: 'PayS — Any-to-Any Payment API',
    version: '0.1.0',
    links: { dashboard: '/dashboard', docs: '/docs', openapi: '/openapi.json' },
  }));

  app.get('/healthz', async (_req, reply) => {
    try {
      const ok = await ping();
      return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded' });
    } catch {
      return reply.code(503).send({ status: 'down', db: false });
    }
  });
}
