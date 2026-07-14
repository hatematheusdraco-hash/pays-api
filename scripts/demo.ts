import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildServer } from '../src/server.js';
import { startProcessor } from '../src/engine/processor.js';
import { startWebhookDispatcher } from '../src/webhooks/dispatcher.js';
import { verifySignature } from '../src/auth/hmac.js';
import { closePool } from '../src/db.js';

/**
 * End-to-end demo: onboards a merchant, registers a webhook, creates a payment,
 * locks a quote, simulates an on-chain deposit, then watches the payment march
 * through the state machine to COMPLETED — printing every webhook (with a live
 * HMAC-signature check) as it arrives.
 *
 * Runs the whole stack in-process so `npm run demo` needs nothing but a
 * reachable DATABASE_URL.
 */

const received: string[] = [];
let webhookSecret = '';

async function main() {
  // 1. Local webhook receiver ------------------------------------------------
  const receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const sig = req.headers['pays-signature'] as string;
      const valid = webhookSecret ? verifySignature(webhookSecret, body, sig) : false;
      const evt = JSON.parse(body);
      received.push(evt.type);
      console.log(
        `   📨 webhook  ${evt.type.padEnd(26)} sig=${valid ? '✓ valid' : '✗ INVALID'}  ` +
          `status=${evt.data.object.status}`,
      );
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, r));
  const receiverPort = (receiver.address() as { port: number }).port;
  const receiverUrl = `http://127.0.0.1:${receiverPort}/webhooks`;

  // 2. API server + background workers --------------------------------------
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const stopProcessor = startProcessor(app.log);
  const stopDispatcher = startWebhookDispatcher(app.log);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const api = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
    return json as any;
  };

  const hr = () => console.log('─'.repeat(70));

  // 3. Onboard a merchant ---------------------------------------------------
  hr();
  console.log('1. Create merchant + API key');
  const onboard = await api('POST', '/v1/merchants', {
    body: {
      name: 'Acme SaaS GmbH',
      email: 'billing@acme.example',
      settlement_method: 'sepa',
      settlement_destination: { iban: 'DE89 3704 0044 0532 0130 00' },
    },
  });
  const token = onboard.api_key.secret as string;
  console.log(`   merchant ${onboard.merchant.id}  key ${token.slice(0, 16)}…`);

  // 4. Register webhook -----------------------------------------------------
  console.log('2. Register webhook endpoint ->', receiverUrl);
  const wh = await api('POST', '/v1/webhook_endpoints', {
    token,
    body: { url: receiverUrl, enabled_events: ['*'] },
  });
  webhookSecret = wh.secret;
  console.log(`   endpoint ${wh.id}  secret ${wh.secret.slice(0, 14)}…`);

  // 5. Create payment -------------------------------------------------------
  console.log('3. Create payment: charge merchant 49.99 EUR');
  const payment = await api('POST', '/v1/payments', {
    token,
    body: { amount: 49.99, currency: 'EUR', description: 'Pro plan — monthly' },
  });
  console.log(`   ${payment.id}  status=${payment.status}`);

  // 6. Lock a quote (payer chooses to pay in ETH) ---------------------------
  console.log('4. Payer picks ETH on Ethereum → lock quote (30s FX window)');
  const quoted = await api('POST', `/v1/payments/${payment.id}/quote`, {
    token,
    body: { pay_currency: 'ETH', pay_network: 'ethereum' },
  });
  console.log(
    `   status=${quoted.status}  pay ${quoted.quote.amount_crypto} ETH  ` +
      `→ deposit ${quoted.quote.deposit_address.slice(0, 14)}…  via ${quoted.quote.provider}`,
  );
  console.log(`   PayS fee: ${quoted.quote.pays_fee} EUR  expires ${quoted.quote.expires_at}`);

  // 7. Simulate the on-chain deposit ---------------------------------------
  console.log('5. Simulate on-chain deposit (test helper)');
  const detected = await api('POST', `/v1/payments/${payment.id}/simulate_payment`, {
    token,
    body: {},
  });
  console.log(`   status=${detected.status}  tx=${detected.crypto.tx_hash.slice(0, 14)}…`);

  // 8. Watch it settle ------------------------------------------------------
  console.log('6. Processor advances the payment through the state machine:');
  let last = detected.status;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const p = await api('GET', `/v1/payments/${payment.id}`, { token });
    if (p.status !== last) {
      const conf = p.crypto?.confirmations ?? 0;
      const req = p.crypto?.required_confirmations ?? 0;
      console.log(
        `   → ${p.status.padEnd(18)}${req ? `  confirmations ${conf}/${req}` : ''}`,
      );
      last = p.status;
    }
    if (p.status === 'COMPLETED' || p.status === 'FAILED') break;
    await sleep(400);
  }

  await sleep(1200); // let final webhooks flush
  hr();
  const final = await api('GET', `/v1/payments/${payment.id}`, { token });
  console.log(`RESULT: payment ${final.status} in ${final.currency} ${final.amount}`);
  console.log(`Webhooks received (${received.length}): ${received.join(' → ')}`);
  hr();

  // Cleanup
  stopProcessor();
  stopDispatcher();
  await app.close();
  await new Promise<void>((r) => receiver.close(() => r()));
  await closePool();
  process.exit(final.status === 'COMPLETED' ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await closePool().catch(() => {});
  process.exit(1);
});
