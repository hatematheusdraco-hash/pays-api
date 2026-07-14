import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures (Stripe-compatible scheme). We sign `${timestamp}.${body}`
 * with the endpoint secret and send:
 *
 *   PayS-Signature: t=<unix>,v1=<hex hmac-sha256>
 *
 * Receivers recompute the HMAC and compare in constant time, rejecting
 * timestamps outside a tolerance window to prevent replay.
 */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.split('=') as [string, string]),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}
