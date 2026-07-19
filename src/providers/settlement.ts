import { prefixedId } from '../lib/id.js';
import { SettlementMethod, type SettlementCurrency } from '../types.js';
import type { SettlementProvider, SettlementResult } from './types.js';

// Mock payout rails. Real impls call Railsr/Modulr (SEPA), Circle (USDC),
// Payoneer. ETAs mirror the spec's Settlement Layer table (§Layer 4).

class RailsrSepaProvider implements SettlementProvider {
  method = SettlementMethod.SEPA;
  async settle(args: {
    paymentId: string;
    amount: string;
    currency: SettlementCurrency;
    destination: Record<string, unknown>;
  }): Promise<SettlementResult> {
    return { provider: 'railsr', reference: prefixedId('sepa'), etaSeconds: 86_400 };
  }
}

class CircleUsdcProvider implements SettlementProvider {
  method = SettlementMethod.USDC;
  async settle(): Promise<SettlementResult> {
    return { provider: 'circle', reference: prefixedId('usdc'), etaSeconds: 300 };
  }
}

class PayoneerProvider implements SettlementProvider {
  method = SettlementMethod.PAYONEER;
  async settle(): Promise<SettlementResult> {
    return { provider: 'payoneer', reference: prefixedId('poyn'), etaSeconds: 172_800 };
  }
}

class CardPayoutProvider implements SettlementProvider {
  method = SettlementMethod.CARD;
  async settle(): Promise<SettlementResult> {
    return { provider: 'card_rail', reference: prefixedId('card'), etaSeconds: 3_600 };
  }
}

class AchProvider implements SettlementProvider {
  method = SettlementMethod.ACH;
  async settle(): Promise<SettlementResult> {
    return { provider: 'column', reference: prefixedId('ach'), etaSeconds: 172_800 };
  }
}

const providers: Record<string, SettlementProvider> = {
  [SettlementMethod.SEPA]: new RailsrSepaProvider(),
  [SettlementMethod.USDC]: new CircleUsdcProvider(),
  [SettlementMethod.PAYONEER]: new PayoneerProvider(),
  [SettlementMethod.CARD]: new CardPayoutProvider(),
  [SettlementMethod.ACH]: new AchProvider(),
};

export function settlementProviderFor(method: string): SettlementProvider {
  const p = providers[method];
  if (!p) throw new Error(`No settlement provider for method "${method}"`);
  return p;
}
