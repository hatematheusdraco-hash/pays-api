import type { Network, PayCurrency, SettlementCurrency } from '../types.js';

/**
 * Provider interfaces. At MVP every implementation is a deterministic mock, but
 * the shape mirrors the real vendors named in the tech spec so they can be
 * swapped in without touching the payment engine:
 *
 *   FxProvider          -> internal rates / Zero Hash quote API
 *   ConversionProvider  -> Zero Hash (primary), Wert (reserve)
 *   BlockchainMonitor   -> Alchemy Webhooks
 *   SettlementProvider  -> Railsr / Modulr (SEPA), Circle (USDC), Payoneer
 */

export interface FxProvider {
  /** How many `pay` units equal one unit of the settlement currency. */
  rate(pay: PayCurrency, settlement: SettlementCurrency): Promise<number>;
  /** Flat network/gas fee, denominated in the pay currency. */
  networkFee(pay: PayCurrency, network: Network): number;
}

export interface ConversionResult {
  provider: string;
  settledAmount: string; // in settlement currency
  rate: string;
}

export interface ConversionProvider {
  name: string;
  supports(pay: PayCurrency, settlement: SettlementCurrency): boolean;
  /** Health signal used by the routing engine. */
  healthy(): boolean;
  convert(args: {
    paymentId: string;
    amountCrypto: string;
    pay: PayCurrency;
    settlement: SettlementCurrency;
  }): Promise<ConversionResult>;
}

export interface SettlementResult {
  provider: string;
  reference: string;
  etaSeconds: number;
}

export interface SettlementProvider {
  method: string; // matches SettlementMethod
  settle(args: {
    paymentId: string;
    amount: string;
    currency: SettlementCurrency;
    destination: Record<string, unknown>;
  }): Promise<SettlementResult>;
}

export interface ChainConfig {
  network: Network;
  requiredConfirmations: number;
  blockTimeMs: number;
}

export interface BlockchainMonitor {
  chain(network: Network): ChainConfig;
  /** Allocate a deposit address for a payment (mock: deterministic). */
  depositAddress(pay: PayCurrency, network: Network, paymentId: string): string;
}
