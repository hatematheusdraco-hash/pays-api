import { z } from 'zod';
import { PayCurrency, SettlementMethod } from '../types.js';

const settlementCurrency = z.enum(['EUR', 'USD', 'USDC']);
const settlementMethod = z.enum([
  SettlementMethod.SEPA,
  SettlementMethod.USDC,
  SettlementMethod.PAYONEER,
]);

export const createMerchantSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  settlement_method: settlementMethod.default(SettlementMethod.SEPA),
  settlement_destination: z.record(z.unknown()).default({}),
});

export const createPaymentSchema = z.object({
  // amount in the settlement currency's major unit (e.g. 49.99 EUR)
  amount: z.number().positive().max(1_000_000),
  currency: settlementCurrency,
  settlement_method: settlementMethod.optional(),
  settlement_destination: z.record(z.unknown()).optional(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const createQuoteSchema = z.object({
  pay_currency: z.enum([
    PayCurrency.BTC, PayCurrency.ETH, PayCurrency.USDC,
    PayCurrency.USDT, PayCurrency.SOL, PayCurrency.MATIC,
  ]),
  pay_network: z.enum(['bitcoin', 'ethereum', 'solana', 'polygon', 'tron', 'base']),
});

export const createWebhookSchema = z.object({
  url: z.string().url(),
  enabled_events: z.array(z.string()).default(['*']),
});

export const simulatePaymentSchema = z.object({
  tx_hash: z.string().optional(),
});

export const createRefundSchema = z.object({
  // Omit `amount` for a full refund of the remaining balance.
  amount: z.number().positive().max(1_000_000).optional(),
  reason: z.string().max(500).optional(),
});

export const cancelPaymentSchema = z.object({
  reason: z.string().max(500).optional(),
});
