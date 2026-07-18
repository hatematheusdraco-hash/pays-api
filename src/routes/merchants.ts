import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/apiKey.js';
import type { Merchant } from '../types.js';
import {
  createMerchant,
  getMerchant,
  issueApiKey,
  updateMerchantSettlement,
} from '../repo.js';
import { createMerchantSchema, updateMerchantSchema } from './schemas.js';
import { merchantId, parseBody } from './util.js';

function serializeMerchant(m: Merchant) {
  return {
    id: m.id,
    object: 'merchant',
    name: m.name,
    email: m.email,
    settlement_method: m.settlement_method,
    settlement_destination: m.settlement_destination,
    created_at: m.created_at,
  };
}

export async function merchantRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Onboard a merchant and mint their first API key. This bootstrap endpoint is
   * unauthenticated (in production it sits behind the signup/dashboard). The raw
   * secret is returned exactly once — only its hash is stored.
   */
  app.post('/v1/merchants', async (req, reply) => {
    const body = parseBody(createMerchantSchema, req);
    const merchant = await createMerchant(body);
    const key = await issueApiKey(merchant.id, false);
    return reply.code(201).send({
      merchant: {
        id: merchant.id,
        object: 'merchant',
        name: merchant.name,
        email: merchant.email,
        settlement_method: merchant.settlement_method,
        settlement_destination: merchant.settlement_destination,
        created_at: merchant.created_at,
      },
      api_key: {
        id: key.id,
        secret: key.secret, // shown once
        livemode: false,
      },
    });
  });

  // Authenticated: who am I.
  app.get('/v1/merchants/me', { preHandler: authenticate }, async (req) => {
    const m = await getMerchant(merchantId(req));
    return serializeMerchant(m!);
  });

  // Update payout settings (where the merchant receives funds).
  app.patch('/v1/merchants/me', { preHandler: authenticate }, async (req) => {
    const body = parseBody(updateMerchantSchema, req);
    const m = await updateMerchantSettlement(
      merchantId(req),
      body.settlement_method ?? null,
      body.settlement_destination ?? null,
    );
    return serializeMerchant(m);
  });
}
