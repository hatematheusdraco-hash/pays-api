import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/apiKey.js';
import { tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { serializePayment } from '../lib/serialize.js';
import { prefixedId } from '../lib/id.js';
import {
  createPayment,
  getMerchant,
  getPayment,
  getQuote,
  insertQuote,
  listPayments,
  lockPayment,
} from '../repo.js';
import { buildQuote, isQuoteExpired } from '../engine/quoteEngine.js';
import { applyTransition } from '../engine/stateMachine.js';
import { PaymentStatus } from '../types.js';
import {
  createPaymentSchema,
  createQuoteSchema,
  simulatePaymentSchema,
} from './schemas.js';
import { merchantId, parseBody } from './util.js';

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // --- Create a payment (Payment Intent) ----------------------------------
  app.post('/v1/payments', async (req, reply) => {
    const body = parseBody(createPaymentSchema, req);
    const merchant = await getMerchant(merchantId(req));
    if (!merchant) throw notFound('Merchant not found.');

    const payment = await createPayment({
      merchant_id: merchant.id,
      settlement_currency: body.currency,
      amount_fiat: body.amount.toFixed(2),
      settlement_method: body.settlement_method ?? merchant.settlement_method,
      settlement_destination:
        body.settlement_destination ?? merchant.settlement_destination,
      description: body.description ?? null,
      metadata: body.metadata,
    });
    return reply.code(201).send(serializePayment(payment));
  });

  // --- Retrieve / list ----------------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/payments/:id', async (req) => {
    const payment = await getPayment(req.params.id, merchantId(req));
    if (!payment) throw notFound(`No such payment: ${req.params.id}`);
    return serializePayment(payment);
  });

  app.get('/v1/payments', async (req) => {
    const data = await listPayments(merchantId(req));
    return { object: 'list', data: data.map(serializePayment) };
  });

  // --- Lock a quote: payer picks currency (CREATED -> QUOTE_LOCKED) --------
  app.post<{ Params: { id: string } }>('/v1/payments/:id/quote', async (req) => {
    const body = parseBody(createQuoteSchema, req);
    const mId = merchantId(req);

    return tx(async (client) => {
      const payment = await lockPayment(req.params.id, client);
      if (!payment || payment.merchant_id !== mId) {
        throw notFound(`No such payment: ${req.params.id}`);
      }
      if (payment.status !== PaymentStatus.CREATED) {
        throw conflict(
          `Payment is ${payment.status}; a quote can only be locked from CREATED.`,
        );
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
        { quote_id: quote.id, provider: quote.provider },
      );

      return {
        ...serializePayment(updated),
        quote: {
          id: quote.id,
          object: 'quote',
          pay_currency: quote.pay_currency,
          pay_network: quote.pay_network,
          amount_crypto: quote.amount_crypto,
          deposit_address: quote.deposit_address,
          exchange_rate: quote.exchange_rate,
          network_fee: quote.network_fee,
          pays_fee: Number(quote.pays_fee),
          provider: quote.provider,
          expires_at: quote.expires_at,
        },
      };
    });
  });

  /**
   * TEST HELPER — simulate the payer sending crypto on-chain.
   * In production this transition is triggered by an Alchemy webhook when a
   * deposit hits the address; here it's exposed for test-mode merchants so the
   * whole flow can be exercised end-to-end. (QUOTE_LOCKED -> PAYMENT_DETECTED)
   */
  app.post<{ Params: { id: string } }>(
    '/v1/payments/:id/simulate_payment',
    async (req) => {
      if (req.livemode) {
        throw badRequest('simulate_payment is only available for test-mode keys.');
      }
      const body = parseBody(simulatePaymentSchema, req);
      const mId = merchantId(req);

      return tx(async (client) => {
        const payment = await lockPayment(req.params.id, client);
        if (!payment || payment.merchant_id !== mId) {
          throw notFound(`No such payment: ${req.params.id}`);
        }
        if (payment.status !== PaymentStatus.QUOTE_LOCKED) {
          throw conflict(
            `Payment is ${payment.status}; a deposit can only be simulated from QUOTE_LOCKED.`,
          );
        }
        if (payment.quote_id) {
          const q = await getQuote(payment.quote_id, client);
          if (q && isQuoteExpired(q)) {
            throw conflict('Quote has expired; create a new quote.', 'quote_expired');
          }
        }

        const txHash = body.tx_hash ?? `0x${prefixedId('tx').slice(3)}`;
        const updated = await applyTransition(
          client,
          payment,
          PaymentStatus.PAYMENT_DETECTED,
          { tx_hash: txHash },
          { tx_hash: txHash, source: 'simulated' },
        );
        return serializePayment(updated);
      });
    },
  );
}
