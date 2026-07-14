import type { Payment } from '../types.js';

/** Public (API-facing) representation of a payment. */
export function serializePayment(p: Payment) {
  return {
    id: p.id,
    object: 'payment',
    status: p.status,
    amount: Number(p.amount_fiat),
    currency: p.settlement_currency,
    settlement: {
      method: p.settlement_method,
      destination: p.settlement_destination,
    },
    crypto:
      p.pay_currency == null
        ? null
        : {
            currency: p.pay_currency,
            network: p.pay_network,
            amount: p.amount_crypto,
            deposit_address: p.deposit_address,
            exchange_rate: p.exchange_rate,
            network_fee: p.network_fee,
            tx_hash: p.tx_hash,
            confirmations: p.confirmations,
            required_confirmations: p.required_confirmations,
          },
    fees: {
      pays_fee: p.pays_fee == null ? null : Number(p.pays_fee),
    },
    description: p.description,
    metadata: p.metadata,
    failure_reason: p.failure_reason,
    quote_id: p.quote_id,
    created_at: p.created_at,
    updated_at: p.updated_at,
    completed_at: p.completed_at,
  };
}
