import type { Network, PayCurrency } from '../types.js';

/**
 * AML / sanctions screening (§Compliance). Real impl: Elliptic address
 * screening + Comply Advantage sanctions. Mock: deterministic pass with a low
 * risk score, except addresses on a tiny demo denylist.
 */
const DENYLIST = new Set<string>([
  // add addresses here to exercise the FAILED path
]);

export interface AmlResult {
  passed: boolean;
  riskScore: number; // 0..100
  provider: string;
  reason?: string;
}

export async function screenTransaction(args: {
  address: string;
  pay: PayCurrency;
  network: Network;
}): Promise<AmlResult> {
  if (DENYLIST.has(args.address)) {
    return {
      passed: false,
      riskScore: 95,
      provider: 'elliptic',
      reason: 'sanctioned_address',
    };
  }
  return { passed: true, riskScore: 4, provider: 'elliptic' };
}
