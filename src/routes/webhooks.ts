import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/apiKey.js';
import { createWebhookEndpoint, listWebhookEndpoints } from '../repo.js';
import { createWebhookSchema } from './schemas.js';
import { merchantId, parseBody } from './util.js';

function serialize(e: {
  id: string;
  url: string;
  enabled_events: string[];
  active: boolean;
  created_at: string;
  secret?: string;
}) {
  return {
    id: e.id,
    object: 'webhook_endpoint',
    url: e.url,
    enabled_events: e.enabled_events,
    active: e.active,
    created_at: e.created_at,
    ...(e.secret ? { secret: e.secret } : {}),
  };
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // Register an endpoint; the signing secret is returned once on creation.
  app.post('/v1/webhook_endpoints', async (req, reply) => {
    const body = parseBody(createWebhookSchema, req);
    const endpoint = await createWebhookEndpoint({
      merchant_id: merchantId(req),
      url: body.url,
      enabled_events: body.enabled_events,
    });
    return reply.code(201).send(serialize(endpoint));
  });

  app.get('/v1/webhook_endpoints', async (req) => {
    const endpoints = await listWebhookEndpoints(merchantId(req));
    return {
      object: 'list',
      data: endpoints.map((e) => serialize({ ...e, secret: undefined })),
    };
  });
}
