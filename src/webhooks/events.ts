import type pg from 'pg';
import { newWebhookDeliveryId } from '../lib/id.js';
import { serializePayment } from '../lib/serialize.js';
import type { Payment } from '../types.js';

export interface PaysEvent {
  id: string; // evt_...
  type: string; // payment.completed, ...
  created: number;
  data: { object: unknown };
}

/** Build the event envelope delivered to merchants. */
export function buildEvent(eventId: string, type: string, payment: Payment): PaysEvent {
  return {
    id: eventId,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: serializePayment(payment) },
  };
}

function eventMatches(enabled: string[], type: string): boolean {
  return enabled.includes('*') || enabled.includes(type);
}

/**
 * Fan the event out to every active endpoint of the merchant by inserting rows
 * into the webhook_deliveries outbox. Runs inside the caller's transaction so
 * an event is enqueued atomically with the state transition that produced it.
 */
export async function enqueueDeliveries(
  client: pg.PoolClient,
  merchantId: string,
  event: PaysEvent,
): Promise<void> {
  const { rows: endpoints } = await client.query<{
    id: string;
    enabled_events: string[];
  }>(
    `select id, enabled_events from webhook_endpoints
      where merchant_id = $1 and active = true`,
    [merchantId],
  );

  for (const ep of endpoints) {
    if (!eventMatches(ep.enabled_events, event.type)) continue;
    await client.query(
      `insert into webhook_deliveries
         (id, endpoint_id, event_id, event_type, payload, next_attempt_at)
       values ($1, $2, $3, $4, $5, now())`,
      [newWebhookDeliveryId(), ep.id, event.id, event.type, event],
    );
  }
}
