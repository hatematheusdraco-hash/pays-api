import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/apiKey.js';
import { tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { serializePayment, serializeRefund } from '../lib/serialize.js';
import { prefixedId } from '../lib/id.js';
import { idempotencyOnSend, idempotencyPreHandler } from '../lib/idempotency.js';
import {
  createPayment,
  getMerchant,
  getPayment,
  getQuote,
  getRefund,
  insertQuote,
  insertRefund,
  listPayments,
  listRefundsForPayment,
  lockPayment,
} from '../repo.js';
import { buildQuote, isQuoteExpired } from '../engine/quoteEngine.js';
import { emitRefundEvent } from '../engine/refunds.js';
import { applyTransition } from '../engine/stateMachine.js';
import { PaymentStatus } from '../types.js';
import {
  cancelPaymentSchema,
  createPaymentSchema,
  createQuoteSchema,
  createRefundSchema,
  simulatePaymentSchema,
} from './schemas.js';
import { merchantId, parseBody } from './util.js';

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', idempotencyPreHandler);
  app.addHook('onSend', idempotencyOnSend);

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

  // --- Cancel a payment (before funds land: CREATED / QUOTE_LOCKED) --------
  app.post<{ Params: { id: string } }>('/v1/payments/:id/cancel', async (req, reply) => {
    const body = parseBody(cancelPaymentSchema, req);
    const mId = merchantId(req);

    const result = await tx(async (client) => {
      const payment = await lockPayment(req.params.id, client);
      if (!payment || payment.merchant_id !== mId) {
        throw notFound(`No such payment: ${req.params.id}`);
      }
      if (
        payment.status !== PaymentStatus.CREATED &&
        payment.status !== PaymentStatus.QUOTE_LOCKED
      ) {
        throw conflict(
          `Payment is ${payment.status} and can no longer be canceled.`,
          'payment_not_cancelable',
        );
      }
      const updated = await applyTransition(
        client,
        payment,
        PaymentStatus.CANCELED,
        { failure_reason: body.reason ?? 'canceled_by_merchant' },
        { reason: body.reason ?? 'canceled_by_merchant' },
      );
      return serializePayment(updated);
    });
    return reply.code(200).send(result);
  });

  // --- Refund a completed payment (full or partial) -----------------------
  app.post<{ Params: { id: string } }>('/v1/payments/:id/refund', async (req, reply) => {
    const body = parseBody(createRefundSchema, req);
    const mId = merchantId(req);

    const result = await tx(async (client) => {
      const payment = await lockPayment(req.params.id, client);
      if (!payment || payment.merchant_id !== mId) {
        throw notFound(`No such payment: ${req.params.id}`);
      }
      if (payment.status !== PaymentStatus.COMPLETED) {
        throw conflict(
          `Only COMPLETED payments can be refunded (payment is ${payment.status}).`,
          'payment_not_refundable',
        );
      }

      const total = Number(payment.amount_fiat);
      const alreadyRefunded = Number(payment.amount_refunded);
      const remaining = +(total - alreadyRefunded).toFixed(2);
      const amount = body.amount ?? remaining;
      if (amount > remaining + 1e-9) {
        throw badRequest(
          `Refund amount ${amount} exceeds refundable balance ${remaining}.`,
          { code: 'amount_too_large', param: 'amount' },
        );
      }

      const refund = await insertRefund(
        {
          payment_id: payment.id,
          merchant_id: mId,
          amount: amount.toFixed(2),
          currency: payment.settlement_currency,
          reason: body.reason ?? null,
        },
        client,
      );
      await client.query(
        `update payments set amount_refunded = amount_refunded + $2, updated_at = now()
          where id = $1`,
        [payment.id, amount.toFixed(2)],
      );
      await emitRefundEvent(client, refund);
      return serializeRefund(refund);
    });
    return reply.code(201).send(result);
  });

  app.get<{ Params: { id: string } }>('/v1/payments/:id/refunds', async (req) => {
    const payment = await getPayment(req.params.id, merchantId(req));
    if (!payment) throw notFound(`No such payment: ${req.params.id}`);
    const refunds = await listRefundsForPayment(payment.id);
    return { object: 'list', data: refunds.map(serializeRefund) };
  });

  app.get<{ Params: { id: string } }>('/v1/refunds/:id', async (req) => {
    const refund = await getRefund(req.params.id, merchantId(req));
    if (!refund) throw notFound(`No such refund: ${req.params.id}`);
    return serializeRefund(refund);
  });
}
