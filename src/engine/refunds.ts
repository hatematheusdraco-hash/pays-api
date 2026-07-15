import type pg from 'pg';
import { newEventId, prefixedId } from '../lib/id.js';
import { serializeRefund } from '../lib/serialize.js';
import type { Refund, RefundStatus } from '../types.js';
import { buildObjectEvent, enqueueDeliveries } from '../webhooks/events.js';

const REFUND_EVENT: Record<RefundStatus, string> = {
  pending: 'refund.created',
  processing: 'refund.updated',
  succeeded: 'refund.succeeded',
  failed: 'refund.failed',
};

/** Log a refund event and fan it out to the merchant's webhooks (in-tx). */
export async function emitRefundEvent(
  client: pg.PoolClient,
  refund: Refund,
): Promise<void> {
  const eventId = newEventId();
  const type = REFUND_EVENT[refund.status];
  await client.query(
    `insert into payment_events (event_id, payment_id, type, data)
     values ($1, $2, $3, $4)`,
    [eventId, refund.payment_id, type, { refund_id: refund.id, status: refund.status }],
  );
  await enqueueDeliveries(
    client,
    refund.merchant_id,
    buildObjectEvent(eventId, type, serializeRefund(refund)),
  );
}

/** Move a refund one step: pending → processing → succeeded. */
export async function advanceRefund(
  client: pg.PoolClient,
  refund: Refund,
): Promise<void> {
  if (refund.status === 'pending') {
    const { rows } = await client.query<Refund>(
      `update refunds set status = 'processing', updated_at = now()
        where id = $1 returning *`,
      [refund.id],
    );
    await emitRefundEvent(client, rows[0]!);
    return;
  }
  if (refund.status === 'processing') {
    // Mock settlement reversal (Railsr/Circle payout in reverse).
    const { rows } = await client.query<Refund>(
      `update refunds set status = 'succeeded', provider_reference = $2, updated_at = now()
        where id = $1 returning *`,
      [refund.id, prefixedId('rev')],
    );
    await emitRefundEvent(client, rows[0]!);
  }
}
