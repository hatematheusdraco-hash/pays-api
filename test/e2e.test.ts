import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { FastifyInstance } from 'fastify';

// Speed up the background workers for tests. Must be set before app modules load.
process.env.PROCESSOR_INTERVAL_MS = '120';
process.env.WEBHOOK_DISPATCH_INTERVAL_MS = '120';
process.env.LOG_LEVEL = 'silent';

const PG_PORT = 54330;
let pg: EmbeddedPostgres;
let dataDir: string;
let app: FastifyInstance;
let stopProcessor: () => void;
let stopDispatcher: () => void;
let closePool: () => Promise<void>;
let base = '';

// Global webhook sink: endpointSecret is set per-test that needs it.
const hooks: { type: string; valid: boolean; status: string }[] = [];
let hookSecret = '';
let verify: (s: string, b: string, h: string) => boolean;
let receiver: Server;
let receiverUrl = '';

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pays-test-'));
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('pays');
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:${PG_PORT}/pays`;

  const { runMigrations } = await import('../scripts/migrate.js');
  await runMigrations();

  const { buildServer } = await import('../src/server.js');
  const { startProcessor } = await import('../src/engine/processor.js');
  const { startWebhookDispatcher } = await import('../src/webhooks/dispatcher.js');
  verify = (await import('../sdk/index.js')).verifyWebhookSignature;
  closePool = (await import('../src/db.js')).closePool;

  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  stopProcessor = startProcessor(app.log);
  stopDispatcher = startWebhookDispatcher(app.log);

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const sig = req.headers['pays-signature'] as string;
      const evt = JSON.parse(body);
      hooks.push({
        type: evt.type,
        valid: hookSecret ? verify(hookSecret, body, sig) : false,
        status: evt.data?.object?.status,
      });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/wh`;
});

after(async () => {
  stopProcessor?.();
  stopDispatcher?.();
  await app?.close();
  await new Promise<void>((r) => receiver?.close(() => r()));
  await closePool?.();
  await pg?.stop();
  await rm(dataDir, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------
async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

async function onboard() {
  const r = await api('POST', '/v1/merchants', {
    body: { name: 'Test Co', email: `t${Date.now()}@x.io`, settlement_method: 'sepa' },
  });
  assert.equal(r.status, 201);
  return r.json.api_key.secret as string;
}

async function waitForStatus(token: string, id: string, target: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const p = await api('GET', `/v1/payments/${id}`, { token });
    if (p.json.status === target) return p.json;
    if (p.json.status === 'FAILED') throw new Error(`payment FAILED: ${p.json.failure_reason}`);
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${target}`);
}

// --- tests -----------------------------------------------------------------

test('health check reports ok', async () => {
  const r = await api('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('openapi docs are served', async () => {
  const r = await api('GET', '/openapi.json');
  assert.equal(r.status, 200);
  assert.equal(r.json.info.title, 'PayS — Any-to-Any Payment API');
});

test('rejects requests without an API key', async () => {
  const r = await api('GET', '/v1/payments');
  assert.equal(r.status, 401);
  assert.equal(r.json.error.type, 'authentication_error');
});

test('rejects an invalid API key', async () => {
  const r = await api('GET', '/v1/payments', { token: 'sk_test_bogus' });
  assert.equal(r.status, 401);
});

test('onboard + retrieve merchant', async () => {
  const token = await onboard();
  const me = await api('GET', '/v1/merchants/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.object, 'merchant');
});

test('validation rejects a bad payment body', async () => {
  const token = await onboard();
  const r = await api('POST', '/v1/payments', { token, body: { amount: -5, currency: 'EUR' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.type, 'invalid_request_error');
});

test('idempotency: replays the first response, rejects body mismatch', async () => {
  const token = await onboard();
  const key = `idem_${Date.now()}`;
  const first = await api('POST', '/v1/payments', {
    token,
    headers: { 'idempotency-key': key },
    body: { amount: 10, currency: 'EUR' },
  });
  const replay = await api('POST', '/v1/payments', {
    token,
    headers: { 'idempotency-key': key },
    body: { amount: 10, currency: 'EUR' },
  });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.json.id, first.json.id, 'replay returns the same payment');
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');

  const mismatch = await api('POST', '/v1/payments', {
    token,
    headers: { 'idempotency-key': key },
    body: { amount: 999, currency: 'EUR' },
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.error.code, 'idempotency_key_reuse');
});

test('cannot quote a payment that is not in CREATED', async () => {
  const token = await onboard();
  const p = await api('POST', '/v1/payments', { token, body: { amount: 20, currency: 'EUR' } });
  const q1 = await api('POST', `/v1/payments/${p.json.id}/quote`, {
    token,
    body: { pay_currency: 'ETH', pay_network: 'ethereum' },
  });
  assert.equal(q1.status, 200);
  assert.equal(q1.json.status, 'QUOTE_LOCKED');
  const q2 = await api('POST', `/v1/payments/${p.json.id}/quote`, {
    token,
    body: { pay_currency: 'ETH', pay_network: 'ethereum' },
  });
  assert.equal(q2.status, 409);
});

test('cancel a payment before funds land', async () => {
  const token = await onboard();
  const p = await api('POST', '/v1/payments', { token, body: { amount: 15, currency: 'EUR' } });
  const c = await api('POST', `/v1/payments/${p.json.id}/cancel`, { token, body: {} });
  assert.equal(c.status, 200);
  assert.equal(c.json.status, 'CANCELED');
});

test('full happy path settles to COMPLETED and delivers signed webhooks', async () => {
  const token = await onboard();
  const wh = await api('POST', '/v1/webhook_endpoints', {
    token,
    body: { url: receiverUrl, enabled_events: ['*'] },
  });
  hookSecret = wh.json.secret;
  hooks.length = 0;

  const p = await api('POST', '/v1/payments', {
    token,
    body: { amount: 49.99, currency: 'EUR', description: 'Pro' },
  });
  await api('POST', `/v1/payments/${p.json.id}/quote`, {
    token,
    body: { pay_currency: 'ETH', pay_network: 'ethereum' },
  });
  await api('POST', `/v1/payments/${p.json.id}/simulate_payment`, { token, body: {} });

  const done = await waitForStatus(token, p.json.id, 'COMPLETED');
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.fees.pays_fee, 1); // 2% of 49.99, rounded

  await sleep(600); // let webhooks flush
  const completed = hooks.find((h) => h.type === 'payment.completed');
  assert.ok(completed, 'received payment.completed webhook');
  assert.ok(completed!.valid, 'webhook signature verified');
  assert.ok(hooks.every((h) => h.valid), 'all webhook signatures valid');
});

test('refund a completed payment; over-refund is rejected', async () => {
  const token = await onboard();
  const p = await api('POST', '/v1/payments', { token, body: { amount: 30, currency: 'EUR' } });
  await api('POST', `/v1/payments/${p.json.id}/quote`, {
    token,
    body: { pay_currency: 'USDC', pay_network: 'solana' },
  });
  await api('POST', `/v1/payments/${p.json.id}/simulate_payment`, { token, body: {} });
  await waitForStatus(token, p.json.id, 'COMPLETED');

  // Partial refund
  const partial = await api('POST', `/v1/payments/${p.json.id}/refund`, {
    token,
    body: { amount: 10, reason: 'partial' },
  });
  assert.equal(partial.status, 201);
  assert.equal(partial.json.object, 'refund');

  // Over-refund the remaining balance
  const over = await api('POST', `/v1/payments/${p.json.id}/refund`, {
    token,
    body: { amount: 25 },
  });
  assert.equal(over.status, 400);
  assert.equal(over.json.error.code, 'amount_too_large');

  // Refund reaches succeeded
  const deadline = Date.now() + 8000;
  let status = partial.json.status;
  while (Date.now() < deadline && status !== 'succeeded') {
    await sleep(150);
    const r = await api('GET', `/v1/refunds/${partial.json.id}`, { token });
    status = r.json.status;
  }
  assert.equal(status, 'succeeded');
});

test('cannot refund a payment that is not COMPLETED', async () => {
  const token = await onboard();
  const p = await api('POST', '/v1/payments', { token, body: { amount: 12, currency: 'EUR' } });
  const r = await api('POST', `/v1/payments/${p.json.id}/refund`, { token, body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'payment_not_refundable');
});

test('checkout: public flow works with client_secret, rejects wrong secret', async () => {
  const token = await onboard();
  const p = await api('POST', '/v1/payments', { token, body: { amount: 25, currency: 'EUR' } });
  const cs = p.json.client_secret as string;
  assert.ok(cs && cs.startsWith(p.json.id), 'payment exposes a client_secret');

  // wrong secret is rejected
  const bad = await api('GET', `/v1/checkout/${p.json.id}?cs=nope`);
  assert.equal(bad.status, 404);

  // public view (no bearer token) works
  const view = await api('GET', `/v1/checkout/${p.json.id}?cs=${encodeURIComponent(cs)}`);
  assert.equal(view.status, 200);
  assert.equal(view.json.object, 'checkout');
  assert.equal(view.json.amount, 25);
  assert.ok(Array.isArray(view.json.supported_currencies));

  // lock a quote publicly
  const quote = await api('POST', `/v1/checkout/${p.json.id}/quote?cs=${encodeURIComponent(cs)}`, {
    body: { pay_currency: 'ETH', pay_network: 'ethereum' },
  });
  assert.equal(quote.status, 200);
  assert.equal(quote.json.status, 'QUOTE_LOCKED');
  assert.ok(quote.json.crypto.deposit_address);

  // simulate deposit publicly, then it settles
  const sim = await api('POST', `/v1/checkout/${p.json.id}/simulate_payment?cs=${encodeURIComponent(cs)}`, {
    body: {},
  });
  assert.equal(sim.status, 200);
  await waitForStatus(token, p.json.id, 'COMPLETED');
});

test('web pages are served', async () => {
  const dash = await fetch(base + '/dashboard');
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), /Merchant Dashboard/);
  const co = await fetch(base + '/checkout/pay_x');
  assert.equal(co.status, 200);
  assert.match(await co.text(), /PayS Checkout/);
});
