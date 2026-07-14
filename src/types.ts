/** Payment lifecycle states — the state machine from the tech spec (§Layer 2). */
export const PaymentStatus = {
  CREATED: 'CREATED',
  QUOTE_LOCKED: 'QUOTE_LOCKED',
  PAYMENT_DETECTED: 'PAYMENT_DETECTED',
  CONFIRMING: 'CONFIRMING',
  CONVERTING: 'CONVERTING',
  SETTLING: 'SETTLING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Settlement methods a merchant can receive funds through (§Layer 4). */
export const SettlementMethod = {
  SEPA: 'sepa', // Railsr / Modulr — EUR bank transfer
  USDC: 'usdc', // Circle — stablecoin to wallet
  PAYONEER: 'payoneer',
} as const;
export type SettlementMethod = (typeof SettlementMethod)[keyof typeof SettlementMethod];

/** Fiat/stablecoin currencies a merchant can settle in. */
export type SettlementCurrency = 'EUR' | 'USD' | 'USDC';

/** Crypto assets accepted at MVP (§Layer 3 — ~85% of demand). */
export const PayCurrency = {
  BTC: 'BTC',
  ETH: 'ETH',
  USDC: 'USDC',
  USDT: 'USDT',
  SOL: 'SOL',
  MATIC: 'MATIC',
} as const;
export type PayCurrency = (typeof PayCurrency)[keyof typeof PayCurrency];

export type Network = 'bitcoin' | 'ethereum' | 'solana' | 'polygon' | 'tron' | 'base';

export interface Merchant {
  id: string;
  name: string;
  email: string;
  settlement_method: SettlementMethod;
  settlement_destination: Record<string, unknown>;
  created_at: string;
}

export interface Payment {
  id: string;
  merchant_id: string;
  status: PaymentStatus;
  settlement_currency: SettlementCurrency;
  amount_fiat: string; // numeric as string to preserve precision
  pay_currency: PayCurrency | null;
  pay_network: Network | null;
  description: string | null;
  metadata: Record<string, unknown>;
  settlement_method: SettlementMethod;
  settlement_destination: Record<string, unknown>;
  amount_crypto: string | null;
  exchange_rate: string | null;
  network_fee: string | null;
  pays_fee: string | null;
  deposit_address: string | null;
  tx_hash: string | null;
  confirmations: number;
  required_confirmations: number | null;
  failure_reason: string | null;
  quote_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Quote {
  id: string;
  payment_id: string;
  pay_currency: PayCurrency;
  pay_network: Network;
  amount_crypto: string;
  exchange_rate: string;
  network_fee: string;
  pays_fee: string;
  provider: string;
  deposit_address: string;
  expires_at: string;
  created_at: string;
}

export interface WebhookEndpoint {
  id: string;
  merchant_id: string;
  url: string;
  secret: string;
  enabled_events: string[];
  active: boolean;
  created_at: string;
}
