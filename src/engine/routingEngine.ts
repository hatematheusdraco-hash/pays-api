import type { PayCurrency, SettlementCurrency } from '../types.js';
import { conversionProviders } from '../providers/conversion.js';
import type { ConversionProvider } from '../providers/types.js';

/**
 * Routing Engine (§Layer 2). Picks the optimal conversion provider for a
 * payment in real time. At MVP the score considers support + health + a static
 * priority; a production impl also weighs live spread, settlement time, per-
 * jurisdiction limits and historical success rate.
 */
export function selectConversionProvider(
  pay: PayCurrency,
  settlement: SettlementCurrency,
): ConversionProvider {
  const candidates = conversionProviders.filter(
    (p) => p.supports(pay, settlement) && p.healthy(),
  );
  if (candidates.length === 0) {
    throw new Error(`No healthy conversion provider for ${pay} -> ${settlement}`);
  }
  // Providers are declared primary-first; keep that order as the priority.
  return candidates[0]!;
}
