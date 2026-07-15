import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { getQuote, lockPayment, lockRefund } from '../repo.js';
import { advanceRefund } from './refunds.js';
import { blockchainMonitor } from '../providers/blockchain.js';
import { screenTransaction } from '../providers/compliance.js';
import { settlementProviderFor } from '../providers/settlement.js';
import { selectConversionProvider } from './routingEngine.js';
import { isQuoteExpired } from './quoteEngine.js';
import { applyTransition } from './stateMachine.js';
import {
  PaymentStatus,
  type Network,
  type PayCurrency,
  type Payment,
  type SettlementCurrency,
} from '../types.js';

/**
 * Background payment processor. Drives every in-flight payment through the
 * state machine one step per tick. Providers are mocked, so confirmations are
 * advanced on an accelerated demo clock rather than real block time.
 *
 * Concurrency-safe: each payment is re-locked with SELECT ... FOR UPDATE and
 * its status re-checked inside the transaction before any transition.
 */

// States the processor actively advances (QUOTE_LOCKED waits for a deposit but
// is polled so expired quotes can be failed).
const ACTIVE_STATES = [
  PaymentStatus.QUOTE_LOCKED,
  PaymentStatus.PAYMENT_DETECTED,
  PaymentStatus.CONFIRMING,
  PaymentStatus.CONVERTING,
  PaymentStatus.SETTLING,
];

async function step(paymentId: string, log: FastifyBaseLogger): Promise<void> {
  await tx(async (client) => {
    const p = await lockPayment(paymentId, client);
    if (!p) return;

    switch (p.status) {
      case PaymentStatus.QUOTE_LOCKED:
        return handleQuoteLocked(client, p);
      case PaymentStatus.PAYMENT_DETECTED:
        return handlePaymentDetected(client, p);
      case PaymentStatus.CONFIRMING:
        return handleConfirming(client, p);
      case PaymentStatus.CONVERTING:
        return handleConverting(client, p);
      case PaymentStatus.SETTLING:
        return handleSettling(client, p);
      default:
        return;
    }
  }).catch((err) => log.error({ err, paymentId }, 'processor step failed'));
}

async function handleQuoteLocked(client: pg.PoolClient, p: Payment): Promise<void> {
  if (!p.quote_id) return;
  const quote = await getQuote(p.quote_id, client);
  // No deposit arrived before the lock expired → FX window closed, fail it.
  if (quote && isQuoteExpired(quote)) {
    await applyTransition(
      client,
      p,
      PaymentStatus.FAILED,
      { failure_reason: 'quote_expired' },
      { reason: 'quote_expired', quote_id: p.quote_id },
    );
  }
}

async function handlePaymentDetected(client: pg.PoolClient, p: Payment): Promise<void> {
  const chain = blockchainMonitor.chain(p.pay_network as Network);
  await applyTransition(
    client,
    p,
    PaymentStatus.CONFIRMING,
    { required_confirmations: chain.requiredConfirmations, confirmations: 0 },
    { network: p.pay_network, required_confirmations: chain.requiredConfirmations },
  );
}

async function handleConfirming(client: pg.PoolClient, p: Payment): Promise<void> {
  const required = p.required_confirmations ?? 1;
  // Accelerated demo clock: reach the target in ~5 ticks regardless of chain.
  const perTick = Math.max(1, Math.ceil(required / 5));
  const next = Math.min(required, p.confirmations + perTick);

  if (next < required) {
    await client.query(
      `update payments set confirmations = $2, updated_at = now() where id = $1`,
      [p.id, next],
    );
    return;
  }

  // Fully confirmed → AML screening before conversion (§Compliance).
  const aml = await screenTransaction({
    address: p.deposit_address!,
    pay: p.pay_currency as PayCurrency,
    network: p.pay_network as Network,
  });
  if (!aml.passed) {
    await applyTransition(
      client,
      { ...p, confirmations: required },
      PaymentStatus.FAILED,
      { confirmations: required, failure_reason: `aml_${aml.reason}` },
      { aml },
    );
    return;
  }

  await applyTransition(
    client,
    { ...p, confirmations: required },
    PaymentStatus.CONVERTING,
    { confirmations: required },
    { aml, confirmations: required },
  );
}

async function handleConverting(client: pg.PoolClient, p: Payment): Promise<void> {
  const settlement = p.settlement_currency as SettlementCurrency;
  const provider = selectConversionProvider(p.pay_currency as PayCurrency, settlement);
  const result = await provider.convert({
    paymentId: p.id,
    amountCrypto: p.amount_crypto!,
    pay: p.pay_currency as PayCurrency,
    settlement,
  });
  await applyTransition(client, p, PaymentStatus.SETTLING, {}, { conversion: result });
}

async function handleSettling(client: pg.PoolClient, p: Payment): Promise<void> {
  const provider = settlementProviderFor(p.settlement_method);
  const result = await provider.settle({
    paymentId: p.id,
    amount: p.amount_fiat,
    currency: p.settlement_currency as SettlementCurrency,
    destination: p.settlement_destination,
  });
  await applyTransition(
    client,
    p,
    PaymentStatus.COMPLETED,
    { completed_at: new Date().toISOString() },
    { settlement: result },
  );
}

async function refundStep(refundId: string, log: FastifyBaseLogger): Promise<void> {
  await tx(async (client) => {
    const refund = await lockRefund(refundId, client);
    if (!refund) return;
    await advanceRefund(client, refund);
  }).catch((err) => log.error({ err, refundId }, 'refund step failed'));
}

export function startProcessor(log: FastifyBaseLogger): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // don't overlap ticks
    running = true;
    try {
      const { rows } = await pool.query<{ id: string }>(
        `select id from payments where status = any($1) order by updated_at asc limit 50`,
        [ACTIVE_STATES],
      );
      for (const row of rows) await step(row.id, log);

      // Advance in-flight refunds too.
      const { rows: refundRows } = await pool.query<{ id: string }>(
        `select id from refunds where status in ('pending','processing')
          order by updated_at asc limit 50`,
      );
      for (const r of refundRows) await refundStep(r.id, log);
    } catch (err) {
      log.error({ err }, 'processor tick failed');
    } finally {
      running = false;
    }
  }, config.processorIntervalMs);
  timer.unref();
  log.info('payment processor started');
  return () => clearInterval(timer);
}
