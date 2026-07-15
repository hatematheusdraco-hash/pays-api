import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { badRequest, conflict } from './errors.js';

/**
 * Idempotency keys (Stripe-style). A client may send `Idempotency-Key: <uuid>`
 * on any POST; retries with the same key return the original response instead
 * of performing the action twice — essential so a network retry never creates
 * a duplicate payment or refund.
 *
 * - First request with a key: claim it, run the handler, cache the response.
 * - Replay (same key + same body): return the cached response.
 * - Same key, different body: 400 (misuse).
 * - Same key while the first is still in flight: 409.
 */

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { key: string; replayed: boolean };
  }
}

function hashRequest(req: FastifyRequest): string {
  return createHash('sha256')
    .update(`${req.method}:${req.url}:${JSON.stringify(req.body ?? {})}`)
    .digest('hex');
}

export async function idempotencyPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || req.method !== 'POST') return;
  const merchantId = req.merchantId;
  if (!merchantId) return;

  const requestHash = hashRequest(req);

  // Atomically claim the key. rowCount === 1 means we're the first.
  const claim = await pool.query(
    `insert into idempotency_keys (merchant_id, key, request_hash)
     values ($1, $2, $3)
     on conflict (merchant_id, key) do nothing`,
    [merchantId, key, requestHash],
  );
  if (claim.rowCount === 1) {
    req.idempotency = { key, replayed: false };
    return;
  }

  // Key already exists — inspect it.
  const { rows } = await pool.query<{
    request_hash: string;
    status_code: number | null;
    response: unknown;
  }>(
    `select request_hash, status_code, response
       from idempotency_keys where merchant_id = $1 and key = $2`,
    [merchantId, key],
  );
  const row = rows[0]!;
  if (row.request_hash !== requestHash) {
    throw badRequest(
      'Idempotency-Key was reused with different request parameters.',
      { code: 'idempotency_key_reuse' },
    );
  }
  if (row.status_code == null) {
    throw conflict(
      'A request with this Idempotency-Key is still being processed.',
      'idempotency_in_progress',
    );
  }
  // Replay the stored response.
  req.idempotency = { key, replayed: true };
  reply.header('Idempotent-Replayed', 'true');
  return reply.code(row.status_code).send(row.response);
}

export async function idempotencyOnSend(
  req: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  const ctx = req.idempotency;
  if (!ctx || ctx.replayed || !req.merchantId) return payload;
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    await pool.query(
      `update idempotency_keys set status_code = $3, response = $4
        where merchant_id = $1 and key = $2`,
      [req.merchantId, ctx.key, reply.statusCode, parsed],
    );
  } catch {
    // Non-JSON payloads aren't cached; the key stays open for a genuine retry.
  }
  return payload;
}
