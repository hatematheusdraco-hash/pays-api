import type pg from 'pg';
import { newEventId } from '../lib/id.js';
import { PaymentStatus, type Payment } from '../types.js';
import { buildEvent, enqueueDeliveries } from '../webhooks/events.js';

/**
 * Allowed transitions (§Layer 2 state machine). Any state may go to FAILED.
 * A transition not listed here is rejected — this is what guarantees a payment
 * can never skip or reverse a step.
 */
const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED: [PaymentStatus.QUOTE_LOCKED, PaymentStatus.FAILED],
  QUOTE_LOCKED: [PaymentStatus.PAYMENT_DETECTED, PaymentStatus.FAILED],
  PAYMENT_DETECTED: [PaymentStatus.CONFIRMING, PaymentStatus.FAILED],
  CONFIRMING: [PaymentStatus.CONVERTING, PaymentStatus.FAILED],
  CONVERTING: [PaymentStatus.SETTLING, PaymentStatus.FAILED],
  SETTLING: [PaymentStatus.COMPLETED, PaymentStatus.FAILED],
  COMPLETED: [],
  FAILED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Maps a target status to the webhook event type emitted on entering it. */
const EVENT_TYPE: Record<PaymentStatus, string> = {
  CREATED: 'payment.created',
  QUOTE_LOCKED: 'payment.quote_locked',
  PAYMENT_DETECTED: 'payment.payment_detected',
  CONFIRMING: 'payment.confirming',
  CONVERTING: 'payment.converting',
  SETTLING: 'payment.settling',
  COMPLETED: 'payment.completed',
  FAILED: 'payment.failed',
};

// Columns the engine is allowed to patch during a transition.
const PATCHABLE = new Set([
  'pay_currency', 'pay_network', 'amount_crypto', 'exchange_rate', 'network_fee',
  'pays_fee', 'deposit_address', 'tx_hash', 'confirmations',
  'required_confirmations', 'failure_reason', 'quote_id', 'completed_at',
]);

export class InvalidTransition extends Error {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(`Illegal payment transition ${from} -> ${to}`);
  }
}

/**
 * Atomically move a payment to `to`, applying `patch`, logging an immutable
 * payment_event, and enqueueing webhook deliveries — all in one transaction.
 * The row is locked FOR UPDATE by the caller (see lockPayment) before this runs.
 */
export async function applyTransition(
  client: pg.PoolClient,
  payment: Payment,
  to: PaymentStatus,
  patch: Partial<Record<string, unknown>> = {},
  eventData: Record<string, unknown> = {},
): Promise<Payment> {
  const from = payment.status;
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);

  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const values: unknown[] = [payment.id, to];
  let i = 3;
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE.has(key)) throw new Error(`Column "${key}" is not patchable`);
    sets.push(`${key} = $${i++}`);
    values.push(value);
  }

  const { rows } = await client.query<Payment>(
    `update payments set ${sets.join(', ')} where id = $1 returning *`,
    values,
  );
  const updated = rows[0]!;

  const eventId = newEventId();
  const type = EVENT_TYPE[to];
  await client.query(
    `insert into payment_events (event_id, payment_id, type, from_status, to_status, data)
     values ($1, $2, $3, $4, $5, $6)`,
    [eventId, updated.id, type, from, to, eventData],
  );

  await enqueueDeliveries(client, updated.merchant_id, buildEvent(eventId, type, updated));
  return updated;
}
