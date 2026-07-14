import { createHash } from 'node:crypto';
import type { Network, PayCurrency } from '../types.js';
import type { BlockchainMonitor, ChainConfig } from './types.js';

// Confirmation targets & block times from the tech spec (§Layer 3 Blockchain
// Monitoring). Solana is the "fast lane"; Bitcoin the slow, high-value lane.
const CHAINS: Record<Network, ChainConfig> = {
  ethereum: { network: 'ethereum', requiredConfirmations: 12, blockTimeMs: 12_000 },
  base: { network: 'base', requiredConfirmations: 64, blockTimeMs: 2_000 },
  polygon: { network: 'polygon', requiredConfirmations: 64, blockTimeMs: 2_000 },
  solana: { network: 'solana', requiredConfirmations: 1, blockTimeMs: 400 },
  tron: { network: 'tron', requiredConfirmations: 20, blockTimeMs: 3_000 },
  bitcoin: { network: 'bitcoin', requiredConfirmations: 1, blockTimeMs: 600_000 },
};

// Address-shape prefixes so mock deposit addresses look network-appropriate.
const ADDR_PREFIX: Record<Network, string> = {
  ethereum: '0x',
  base: '0x',
  polygon: '0x',
  solana: '',
  tron: 'T',
  bitcoin: 'bc1q',
};

export class MockBlockchainMonitor implements BlockchainMonitor {
  chain(network: Network): ChainConfig {
    return CHAINS[network];
  }

  depositAddress(pay: PayCurrency, network: Network, paymentId: string): string {
    const digest = createHash('sha256')
      .update(`${network}:${pay}:${paymentId}`)
      .digest('hex');
    const prefix = ADDR_PREFIX[network];
    const len = network === 'bitcoin' ? 38 : network === 'solana' ? 44 : 40;
    return prefix + digest.slice(0, len - prefix.length);
  }
}

export const blockchainMonitor = new MockBlockchainMonitor();

/** Networks on which a given asset can be paid (MVP set). */
export const NETWORKS_FOR: Record<PayCurrency, Network[]> = {
  BTC: ['bitcoin'],
  ETH: ['ethereum', 'base'],
  SOL: ['solana'],
  MATIC: ['polygon'],
  USDC: ['ethereum', 'solana', 'polygon', 'base'],
  USDT: ['ethereum', 'tron'],
};
