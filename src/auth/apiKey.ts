import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized } from '../lib/errors.js';
import { resolveApiKey } from '../repo.js';

declare module 'fastify' {
  interface FastifyRequest {
    merchantId?: string;
    livemode?: boolean;
  }
}

/**
 * Authenticates a request from its API key. Accepts either:
 *   Authorization: Bearer sk_test_...
 *   Authorization: Basic <base64(sk_test_...:)>   (Stripe-style)
 * Throws authentication_error if missing/invalid/revoked.
 */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const secret = extractKey(req.headers.authorization);
  if (!secret) throw unauthorized('No API key provided.');

  const key = await resolveApiKey(secret);
  if (!key) throw unauthorized('Invalid API key provided.');

  req.merchantId = key.merchant_id;
  req.livemode = key.livemode;
}

function extractKey(header?: string): string | null {
  if (!header) return null;
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    return decoded.split(':')[0] || null;
  }
  return null;
}
