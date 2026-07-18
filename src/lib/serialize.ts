import type { Payment, Refund } from '../types.js';

/** Public (API-facing) representation of a refund. */
export function serializeRefund(r: Refund) {
  return {
    id: r.id,
    object: 'refund',
    payment_id: r.payment_id,
    amount: Number(r.amount),
    currency: r.currency,
    status: r.status,
    reason: r.reason,
    provider_reference: r.provider_reference,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

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
    amount_refunded: Number(p.amount_refunded ?? 0),
    description: p.description,
    metadata: p.metadata,
    failure_reason: p.failure_reason,
    quote_id: p.quote_id,
    client_secret: p.client_secret,
    livemode: p.livemode,
    created_at: p.created_at,
    updated_at: p.updated_at,
    completed_at: p.completed_at,
  };
}
