import type { PayCurrency, SettlementCurrency } from '../types.js';
import { fxProvider } from './fx.js';
import type { ConversionProvider, ConversionResult } from './types.js';

/**
 * Zero Hash — primary crypto→fiat converter (§Layer 3, Priority 1).
 * Mock: converts at the current FX rate minus a small provider spread.
 */
export class ZeroHashProvider implements ConversionProvider {
  name = 'zero_hash';
  private spread = 0.002; // 0.2% provider cost, per spec

  supports(_pay: PayCurrency, settlement: SettlementCurrency): boolean {
    return settlement === 'USD' || settlement === 'EUR' || settlement === 'USDC';
  }

  healthy(): boolean {
    return true;
  }

  async convert(args: {
    paymentId: string;
    amountCrypto: string;
    pay: PayCurrency;
    settlement: SettlementCurrency;
  }): Promise<ConversionResult> {
    const rate = await fxProvider.rate(args.pay, args.settlement); // pay per settlement
    const settlementPerPay = 1 / rate;
    const gross = Number(args.amountCrypto) * settlementPerPay;
    const net = gross * (1 - this.spread);
    return {
      provider: this.name,
      settledAmount: net.toFixed(2),
      rate: settlementPerPay.toFixed(8),
    };
  }
}

/**
 * Wert — reserve provider (§Layer 3). Slightly wider spread; only used when the
 * primary is unhealthy. Present from day one per the risk-mitigation plan.
 */
export class WertProvider implements ConversionProvider {
  name = 'wert';
  private spread = 0.004;
  private up = true;

  supports(_pay: PayCurrency, settlement: SettlementCurrency): boolean {
    return settlement === 'USD' || settlement === 'EUR';
  }

  healthy(): boolean {
    return this.up;
  }

  async convert(args: {
    paymentId: string;
    amountCrypto: string;
    pay: PayCurrency;
    settlement: SettlementCurrency;
  }): Promise<ConversionResult> {
    const rate = await fxProvider.rate(args.pay, args.settlement);
    const settlementPerPay = 1 / rate;
    const net = Number(args.amountCrypto) * settlementPerPay * (1 - this.spread);
    return {
      provider: this.name,
      settledAmount: net.toFixed(2),
      rate: settlementPerPay.toFixed(8),
    };
  }
}

export const conversionProviders: ConversionProvider[] = [
  new ZeroHashProvider(),
  new WertProvider(),
];
