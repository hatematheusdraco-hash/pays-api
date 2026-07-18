import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the two hosted web surfaces:
 *   GET /dashboard      — merchant dashboard (uses the merchant API key)
 *   GET /checkout/:id   — payer-facing checkout (scoped by ?cs=client_secret)
 *
 * Both are single self-contained HTML files in public/, loaded once at startup.
 */
const publicDir = join(process.cwd(), 'public');

async function page(name: string): Promise<string> {
  return readFile(join(publicDir, name), 'utf8');
}

export async function webRoutes(app: FastifyInstance): Promise<void> {
  const [checkout, dashboard] = await Promise.all([
    page('checkout.html'),
    page('dashboard.html'),
  ]);

  const html = (reply: import('fastify').FastifyReply, body: string) =>
    reply.type('text/html; charset=utf-8').send(body);

  app.get('/dashboard', async (_req, reply) => html(reply, dashboard));
  app.get('/checkout/:id', async (_req, reply) => html(reply, checkout));
}
