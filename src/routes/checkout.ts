import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { prefixedId } from '../lib/id.js';
import {
  getMerchant,
  getPaymentByClientSecret,
  getQuote,
  insertQuote,
  lockPayment,
} from '../repo.js';
import { buildQuote, isQuoteExpired } from '../engine/quoteEngine.js';
import { applyTransition } from '../engine/stateMachine.js';
import { NETWORKS_FOR } from '../providers/blockchain.js';
import { PaymentStatus, type Payment } from '../types.js';
import { createQuoteSchema } from './schemas.js';
import { parseBody } from './util.js';

/**
 * Public, payer-facing checkout endpoints. These carry NO API key — they are
 * scoped to a single payment by its `client_secret`, so the hosted checkout
 * page can run in the browser without ever seeing the merchant's secret key.
 */

const SUPPORTED = Object.entries(NETWORKS_FOR).map(([currency, networks]) => ({
  currency,
  networks,
}));

function clientSecret(req: FastifyRequest): string {
  const cs = (req.query as { cs?: string } | undefined)?.cs;
  if (typeof cs !== 'string' || cs.length === 0) {
    throw badRequest('Missing client_secret (cs) query parameter.', { code: 'missing_cs' });
  }
  return cs;
}

function serializeCheckout(p: Payment, merchantName: string) {
  return {
    id: p.id,
    object: 'checkout',
    merchant_name: merchantName,
    status: p.status,
    amount: Number(p.amount_fiat),
    currency: p.settlement_currency,
    description: p.description,
    test_mode: !p.livemode,
    supported_currencies: SUPPORTED,
    crypto:
      p.pay_currency == null
        ? null
        : {
            currency: p.pay_currency,
            network: p.pay_network,
            amount: p.amount_crypto,
            deposit_address: p.deposit_address,
            network_fee: p.network_fee,
            confirmations: p.confirmations,
            required_confirmations: p.required_confirmations,
            tx_hash: p.tx_hash,
          },
  };
}

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  // Public view of a payment.
  app.get<{ Params: { id: string } }>('/v1/checkout/:id', async (req) => {
    const payment = await getPaymentByClientSecret(req.params.id, clientSecret(req));
    if (!payment) throw notFound(`No such checkout: ${req.params.id}`);
    const merchant = await getMerchant(payment.merchant_id);
    return serializeCheckout(payment, merchant?.name ?? 'Merchant');
  });

  // Payer picks a currency → lock the quote (CREATED → QUOTE_LOCKED).
  app.post<{ Params: { id: string } }>('/v1/checkout/:id/quote', async (req) => {
    const cs = clientSecret(req);
    const body = parseBody(createQuoteSchema, req);

    return tx(async (client) => {
      const payment = await lockPayment(req.params.id, client);
      if (!payment || payment.client_secret !== cs) {
        throw notFound(`No such checkout: ${req.params.id}`);
      }
      if (payment.status !== PaymentStatus.CREATED) {
        throw conflict(`Checkout is ${payment.status}; a quote is already locked.`);
      }
      const quote = await buildQuote(payment, body.pay_currency, body.pay_network);
      await insertQuote(quote, client);
      const updated = await applyTransition(
        client,
        payment,
        PaymentStatus.QUOTE_LOCKED,
        {
          pay_currency: quote.pay_currency,
          pay_network: quote.pay_network,
          amount_crypto: quote.amount_crypto,
          exchange_rate: quote.exchange_rate,
          network_fee: quote.network_fee,
          pays_fee: quote.pays_fee,
          deposit_address: quote.deposit_address,
          quote_id: quote.id,
        },
        { quote_id: quote.id, provider: quote.provider, via: 'checkout' },
      );
      const merchant = await getMerchant(updated.merchant_id);
      return {
        ...serializeCheckout(updated, merchant?.name ?? 'Merchant'),
        expires_at: quote.expires_at,
      };
    });
  });

  // Test-mode only: simulate the on-chain deposit (QUOTE_LOCKED → PAYMENT_DETECTED).
  app.post<{ Params: { id: string } }>('/v1/checkout/:id/simulate_payment', async (req) => {
    const cs = clientSecret(req);
    return tx(async (client) => {
      const payment = await lockPayment(req.params.id, client);
      if (!payment || payment.client_secret !== cs) {
        throw notFound(`No such checkout: ${req.params.id}`);
      }
      if (payment.livemode) {
        throw badRequest('Deposits cannot be simulated on a live payment.');
      }
      if (payment.status !== PaymentStatus.QUOTE_LOCKED) {
        throw conflict(`Checkout is ${payment.status}; expected QUOTE_LOCKED.`);
      }
      if (payment.quote_id) {
        const q = await getQuote(payment.quote_id, client);
        if (q && isQuoteExpired(q)) {
          throw conflict('Quote has expired; choose a currency again.', 'quote_expired');
        }
      }
      const txHash = `0x${prefixedId('tx').slice(3)}`;
      const updated = await applyTransition(
        client,
        payment,
        PaymentStatus.PAYMENT_DETECTED,
        { tx_hash: txHash },
        { tx_hash: txHash, source: 'checkout_simulated' },
      );
      const merchant = await getMerchant(updated.merchant_id);
      return serializeCheckout(updated, merchant?.name ?? 'Merchant');
    });
  });
}
