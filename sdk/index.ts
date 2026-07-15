import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * PayS Node SDK — a thin, dependency-free client for the PayS API.
 *
 *   const pays = new PaysClient({ apiKey: 'sk_test_...' });
 *   const payment = await pays.payments.create({ amount: 49.99, currency: 'EUR' });
 *   const quoted  = await pays.payments.quote(payment.id, { pay_currency: 'ETH', pay_network: 'ethereum' });
 */
export interface PaysClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class PaysError extends Error {
  status: number;
  type: string;
  code?: string;
  constructor(status: number, body: { error?: { type?: string; code?: string; message?: string } }) {
    super(body.error?.message ?? `Request failed with status ${status}`);
    this.status = status;
    this.type = body.error?.type ?? 'api_error';
    this.code = body.error?.code;
  }
}

export class PaysClient {
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts: PaysClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const json = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new PaysError(res.status, json ?? {});
    return json as T;
  }

  merchants = {
    me: () => this.request<Merchant>('GET', '/v1/merchants/me'),
  };

  payments = {
    create: (body: CreatePaymentParams, idempotencyKey?: string) =>
      this.request<Payment>('POST', '/v1/payments', { body, idempotencyKey }),
    retrieve: (id: string) => this.request<Payment>('GET', `/v1/payments/${id}`),
    list: () => this.request<List<Payment>>('GET', '/v1/payments'),
    quote: (id: string, body: QuoteParams) =>
      this.request<Payment & { quote: Quote }>('POST', `/v1/payments/${id}/quote`, { body }),
    cancel: (id: string, reason?: string) =>
      this.request<Payment>('POST', `/v1/payments/${id}/cancel`, { body: { reason } }),
    refund: (id: string, body: RefundParams = {}, idempotencyKey?: string) =>
      this.request<Refund>('POST', `/v1/payments/${id}/refund`, { body, idempotencyKey }),
    /** Test-mode only: simulate the on-chain deposit. */
    simulatePayment: (id: string) =>
      this.request<Payment>('POST', `/v1/payments/${id}/simulate_payment`, { body: {} }),
  };

  refunds = {
    retrieve: (id: string) => this.request<Refund>('GET', `/v1/refunds/${id}`),
  };

  webhookEndpoints = {
    create: (url: string, enabled_events: string[] = ['*']) =>
      this.request<WebhookEndpoint & { secret: string }>('POST', '/v1/webhook_endpoints', {
        body: { url, enabled_events },
      }),
  };
}

/** Verify an incoming webhook's `PayS-Signature` header. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => kv.split('=') as [string, string]),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Types (subset of the API) --------------------------------------------
export interface List<T> {
  object: 'list';
  data: T[];
}
export interface Merchant {
  id: string;
  object: 'merchant';
  name: string;
  email: string;
  settlement_method: string;
}
export interface Payment {
  id: string;
  object: 'payment';
  status: string;
  amount: number;
  currency: string;
  amount_refunded: number;
  crypto: null | {
    currency: string;
    network: string;
    amount: string;
    deposit_address: string;
    confirmations: number;
    required_confirmations: number | null;
    tx_hash: string | null;
  };
  fees: { pays_fee: number | null };
  metadata: Record<string, unknown>;
}
export interface Quote {
  id: string;
  pay_currency: string;
  pay_network: string;
  amount_crypto: string;
  deposit_address: string;
  expires_at: string;
}
export interface Refund {
  id: string;
  object: 'refund';
  payment_id: string;
  amount: number;
  currency: string;
  status: string;
}
export interface WebhookEndpoint {
  id: string;
  object: 'webhook_endpoint';
  url: string;
  enabled_events: string[];
}
export interface CreatePaymentParams {
  amount: number;
  currency: 'EUR' | 'USD' | 'USDC';
  settlement_method?: 'sepa' | 'usdc' | 'payoneer';
  description?: string;
  metadata?: Record<string, unknown>;
}
export interface QuoteParams {
  pay_currency: 'BTC' | 'ETH' | 'USDC' | 'USDT' | 'SOL' | 'MATIC';
  pay_network: 'bitcoin' | 'ethereum' | 'solana' | 'polygon' | 'tron' | 'base';
}
export interface RefundParams {
  amount?: number;
  reason?: string;
}
