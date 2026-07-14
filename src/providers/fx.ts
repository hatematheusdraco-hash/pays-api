import type { Network, PayCurrency, SettlementCurrency } from '../types.js';
import type { FxProvider } from './types.js';

// Indicative USD reference prices (MVP mock). A real impl pulls live rates from
// Zero Hash / an FX feed. A small deterministic jitter simulates a moving market
// so successive quotes differ, exercising the 30s lock window.
const USD_PRICE: Record<PayCurrency, number> = {
  BTC: 68_000,
  ETH: 3_500,
  SOL: 155,
  MATIC: 0.72,
  USDC: 1,
  USDT: 1,
};

const SETTLEMENT_PER_USD: Record<SettlementCurrency, number> = {
  USD: 1,
  USDC: 1,
  EUR: 0.92,
};

// Flat gas/network fee per chain, expressed in USD then converted to pay units.
const NETWORK_FEE_USD: Record<Network, number> = {
  ethereum: 4.0,
  base: 0.05,
  polygon: 0.02,
  solana: 0.001,
  tron: 1.0,
  bitcoin: 1.5,
};

export class MockFxProvider implements FxProvider {
  async rate(pay: PayCurrency, settlement: SettlementCurrency): Promise<number> {
    const jitter = 1 + (Math.random() - 0.5) * 0.002; // ±0.1%
    const payUsd = USD_PRICE[pay] * jitter;
    const settlementUsd = SETTLEMENT_PER_USD[settlement];
    // units of `pay` per 1 unit of `settlement`
    return settlementUsd / payUsd;
  }

  networkFee(pay: PayCurrency, network: Network): number {
    const feeUsd = NETWORK_FEE_USD[network];
    return feeUsd / USD_PRICE[pay];
  }
}

export const fxProvider = new MockFxProvider();
