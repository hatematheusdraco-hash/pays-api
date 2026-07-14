import { config } from '../config.js';
import { newQuoteId } from '../lib/id.js';
import { blockchainMonitor, NETWORKS_FOR } from '../providers/blockchain.js';
import { fxProvider } from '../providers/fx.js';
import type { Network, PayCurrency, Payment, Quote, SettlementCurrency } from '../types.js';
import { selectConversionProvider } from './routingEngine.js';

/**
 * Quote Engine (§Layer 2). Produces a fixed-price quote valid for QUOTE_TTL
 * seconds. Inside that window the rate is locked and PayS carries the FX risk.
 *
 * amount_crypto is sized so that, after the provider spread and the network
 * fee, the merchant nets exactly `amount_fiat` in their settlement currency,
 * and PayS collects its take rate on top.
 */
export async function buildQuote(
  payment: Payment,
  pay: PayCurrency,
  network: Network,
): Promise<Quote> {
  if (!NETWORKS_FOR[pay]?.includes(network)) {
    throw new Error(`${pay} is not supported on network "${network}"`);
  }

  const settlement = payment.settlement_currency as SettlementCurrency;
  const provider = selectConversionProvider(pay, settlement);

  // pay units per 1 settlement unit
  const rate = await fxProvider.rate(pay, settlement);

  const amountFiat = Number(payment.amount_fiat);
  const paysFee = +(amountFiat * config.paysTakeRate).toFixed(2);
  const networkFee = fxProvider.networkFee(pay, network); // in pay units

  // Merchant net + PayS fee, converted to crypto, plus gas on top.
  const grossSettlement = amountFiat + paysFee;
  const amountCrypto = grossSettlement * rate + networkFee;

  const now = Date.now();
  const quote: Quote = {
    id: newQuoteId(),
    payment_id: payment.id,
    pay_currency: pay,
    pay_network: network,
    amount_crypto: amountCrypto.toFixed(18),
    exchange_rate: rate.toFixed(18),
    network_fee: networkFee.toFixed(18),
    pays_fee: paysFee.toFixed(2),
    provider: provider.name,
    deposit_address: blockchainMonitor.depositAddress(pay, network, payment.id),
    expires_at: new Date(now + config.quoteTtlSeconds * 1000).toISOString(),
    created_at: new Date(now).toISOString(),
  };
  return quote;
}

export function isQuoteExpired(quote: Quote): boolean {
  return new Date(quote.expires_at).getTime() <= Date.now();
}
