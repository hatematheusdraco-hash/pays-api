import { createHash } from 'node:crypto';
import { one, query, type Sql } from './db.js';
import type { Merchant, Payment, Quote, Refund, WebhookEndpoint } from './types.js';
import {
  newApiKeyId,
  newApiSecret,
  newClientSecret,
  newMerchantId,
  newPaymentId,
  newRefundId,
  newWebhookEndpointId,
  newWebhookSecret,
} from './lib/id.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// --- Merchants ------------------------------------------------------------

export async function createMerchant(input: {
  name: string;
  email: string;
  settlement_method: string;
  settlement_destination: Record<string, unknown>;
}): Promise<Merchant> {
  const row = await one<Merchant>(
    `insert into merchants (id, name, email, settlement_method, settlement_destination)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [
      newMerchantId(),
      input.name,
      input.email,
      input.settlement_method,
      input.settlement_destination,
    ],
  );
  return row!;
}

export async function getMerchant(id: string): Promise<Merchant | null> {
  return one<Merchant>(`select * from merchants where id = $1`, [id]);
}

/** Update where a merchant receives payouts (method and/or destination). */
export async function updateMerchantSettlement(
  id: string,
  method: string | null,
  destination: Record<string, unknown> | null,
): Promise<Merchant> {
  const row = await one<Merchant>(
    `update merchants
        set settlement_method = coalesce($2, settlement_method),
            settlement_destination = coalesce($3::jsonb, settlement_destination)
      where id = $1
      returning *`,
    [id, method, destination ? JSON.stringify(destination) : null],
  );
  return row!;
}

// --- API keys -------------------------------------------------------------

export async function issueApiKey(
  merchantId: string,
  livemode = false,
): Promise<{ id: string; secret: string; prefix: string }> {
  const secret = newApiSecret(livemode);
  const prefix = secret.slice(0, 12); // "sk_test_XXXX"
  const id = newApiKeyId();
  await query(
    `insert into api_keys (id, merchant_id, key_hash, key_prefix, livemode)
     values ($1, $2, $3, $4, $5)`,
    [id, merchantId, sha256(secret), prefix, livemode],
  );
  return { id, secret, prefix };
}

export interface ApiKeyRow {
  id: string;
  merchant_id: string;
  livemode: boolean;
  scope: string;
  revoked_at: string | null;
}

/** Resolve a raw `sk_...` secret to its (non-revoked) key row, or null. */
export async function resolveApiKey(secret: string): Promise<ApiKeyRow | null> {
  const row = await one<ApiKeyRow>(
    `select id, merchant_id, livemode, scope, revoked_at
       from api_keys
      where key_hash = $1 and revoked_at is null`,
    [sha256(secret)],
  );
  if (row) {
    // fire-and-forget last-used stamp
    void query(`update api_keys set last_used_at = now() where id = $1`, [row.id]);
  }
  return row;
}

// --- Payments -------------------------------------------------------------

export async function createPayment(input: {
  merchant_id: string;
  settlement_currency: string;
  amount_fiat: string;
  settlement_method: string;
  settlement_destination: Record<string, unknown>;
  description: string | null;
  metadata: Record<string, unknown>;
  livemode: boolean;
}): Promise<Payment> {
  const id = newPaymentId();
  const row = await one<Payment>(
    `insert into payments
       (id, merchant_id, status, settlement_currency, amount_fiat,
        settlement_method, settlement_destination, description, metadata,
        client_secret, livemode)
     values ($1, $2, 'CREATED', $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      id,
      input.merchant_id,
      input.settlement_currency,
      input.amount_fiat,
      input.settlement_method,
      input.settlement_destination,
      input.description,
      input.metadata,
      newClientSecret(id),
      input.livemode,
    ],
  );
  return row!;
}

/** Look up a payment by id, verifying the client_secret matches (checkout auth). */
export async function getPaymentByClientSecret(
  id: string,
  clientSecret: string,
  client?: Sql,
): Promise<Payment | null> {
  return one<Payment>(
    `select * from payments where id = $1 and client_secret = $2`,
    [id, clientSecret],
    client,
  );
}

export async function getPayment(
  id: string,
  merchantId?: string,
  client?: Sql,
): Promise<Payment | null> {
  if (merchantId) {
    return one<Payment>(
      `select * from payments where id = $1 and merchant_id = $2`,
      [id, merchantId],
      client,
    );
  }
  return one<Payment>(`select * from payments where id = $1`, [id], client);
}

/** Lock a payment row for a state transition (SELECT ... FOR UPDATE). */
export async function lockPayment(id: string, client: Sql): Promise<Payment | null> {
  return one<Payment>(`select * from payments where id = $1 for update`, [id], client);
}

export async function listPayments(
  merchantId: string,
  limit = 20,
): Promise<Payment[]> {
  return query<Payment>(
    `select * from payments where merchant_id = $1 order by created_at desc limit $2`,
    [merchantId, limit],
  );
}

// --- Quotes ---------------------------------------------------------------

export async function insertQuote(q: Quote, client?: Sql): Promise<Quote> {
  const row = await one<Quote>(
    `insert into quotes
       (id, payment_id, pay_currency, pay_network, amount_crypto, exchange_rate,
        network_fee, pays_fee, provider, deposit_address, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [
      q.id, q.payment_id, q.pay_currency, q.pay_network, q.amount_crypto,
      q.exchange_rate, q.network_fee, q.pays_fee, q.provider, q.deposit_address,
      q.expires_at,
    ],
    client,
  );
  return row!;
}

export async function getQuote(id: string, client?: Sql): Promise<Quote | null> {
  return one<Quote>(`select * from quotes where id = $1`, [id], client);
}

// --- Refunds --------------------------------------------------------------

export async function insertRefund(
  input: {
    payment_id: string;
    merchant_id: string;
    amount: string;
    currency: string;
    reason: string | null;
  },
  client?: Sql,
): Promise<Refund> {
  const row = await one<Refund>(
    `insert into refunds (id, payment_id, merchant_id, amount, currency, reason)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [
      newRefundId(),
      input.payment_id,
      input.merchant_id,
      input.amount,
      input.currency,
      input.reason,
    ],
    client,
  );
  return row!;
}

export async function getRefund(
  id: string,
  merchantId?: string,
  client?: Sql,
): Promise<Refund | null> {
  if (merchantId) {
    return one<Refund>(
      `select * from refunds where id = $1 and merchant_id = $2`,
      [id, merchantId],
      client,
    );
  }
  return one<Refund>(`select * from refunds where id = $1`, [id], client);
}

export async function listRefundsForPayment(paymentId: string): Promise<Refund[]> {
  return query<Refund>(
    `select * from refunds where payment_id = $1 order by created_at desc`,
    [paymentId],
  );
}

export async function lockRefund(id: string, client: Sql): Promise<Refund | null> {
  return one<Refund>(`select * from refunds where id = $1 for update`, [id], client);
}

// --- Webhook endpoints ----------------------------------------------------

export async function createWebhookEndpoint(input: {
  merchant_id: string;
  url: string;
  enabled_events: string[];
}): Promise<WebhookEndpoint> {
  const row = await one<WebhookEndpoint>(
    `insert into webhook_endpoints (id, merchant_id, url, secret, enabled_events)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [
      newWebhookEndpointId(),
      input.merchant_id,
      input.url,
      newWebhookSecret(),
      input.enabled_events,
    ],
  );
  return row!;
}

export async function listWebhookEndpoints(
  merchantId: string,
): Promise<WebhookEndpoint[]> {
  return query<WebhookEndpoint>(
    `select * from webhook_endpoints where merchant_id = $1 and active = true`,
    [merchantId],
  );
}
