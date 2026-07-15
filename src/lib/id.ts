import { randomBytes, randomUUID } from 'node:crypto';

// Base58 (Bitcoin alphabet) — unambiguous, URL-safe, familiar in crypto tooling.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Buffer): string {
  let num = BigInt('0x' + bytes.toString('hex'));
  let out = '';
  const base = BigInt(58);
  while (num > 0n) {
    const rem = Number(num % base);
    out = ALPHABET[rem] + out;
    num = num / base;
  }
  return out;
}

/** Stripe-style prefixed id, e.g. `pay_3Nk9...`. */
export function prefixedId(prefix: string, bytesLen = 18): string {
  return `${prefix}_${base58(randomBytes(bytesLen))}`;
}

export const newMerchantId = () => prefixedId('mch');
export const newApiKeyId = () => prefixedId('ak');
export const newPaymentId = () => prefixedId('pay');
export const newQuoteId = () => prefixedId('quote');
export const newRefundId = () => prefixedId('rfnd');
export const newWebhookEndpointId = () => prefixedId('whe');
export const newWebhookDeliveryId = () => prefixedId('whd');
export const newEventId = () => prefixedId('evt');

/** A raw secret API key shown once to the merchant: `sk_test_...` / `sk_live_...`. */
export function newApiSecret(live: boolean): string {
  return `sk_${live ? 'live' : 'test'}_${base58(randomBytes(24))}`;
}

/** Webhook signing secret: `whsec_...`. */
export function newWebhookSecret(): string {
  return `whsec_${base58(randomBytes(24))}`;
}

export const uuid = randomUUID;
