import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { signPayload } from '../auth/hmac.js';

const MAX_ATTEMPTS = 8;
// Exponential backoff (seconds) per attempt number, capped. Matches the spec's
// "reliable delivery with retry logic" (§Layer 1 Webhook Engine).
const BACKOFF_SECONDS = [0, 5, 30, 120, 300, 1800, 7200, 18000];

interface DueDelivery {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
}

async function claimDue(limit: number): Promise<DueDelivery[]> {
  // Atomically claim due rows by flipping them to 'delivering' in a single
  // statement. The inner FOR UPDATE SKIP LOCKED means concurrent dispatchers
  // never grab the same row, so a delivery is never double-sent.
  const { rows } = await pool.query<DueDelivery>(
    `update webhook_deliveries d
        set status = 'delivering', updated_at = now()
       from webhook_endpoints e
      where e.id = d.endpoint_id
        and d.id in (
          select id from webhook_deliveries
           where status = 'pending' and next_attempt_at <= now()
           order by next_attempt_at asc
           limit $1
           for update skip locked
        )
     returning d.id, d.endpoint_id, d.event_type, d.payload, d.attempts, e.url, e.secret`,
    [limit],
  );
  return rows;
}

async function deliver(d: DueDelivery, log: FastifyBaseLogger): Promise<void> {
  const body = JSON.stringify(d.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(d.secret, body, timestamp);
  const attempt = d.attempts + 1;

  let responseCode: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(d.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PayS-Signature': signature,
        'PayS-Event-Type': d.event_type,
        'user-agent': 'PayS-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    responseCode = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const succeeded = responseCode !== null && responseCode >= 200 && responseCode < 300;
  if (succeeded) {
    await pool.query(
      `update webhook_deliveries
          set status = 'succeeded', attempts = $2, last_response_code = $3,
              last_error = null, updated_at = now()
        where id = $1`,
      [d.id, attempt, responseCode],
    );
    return;
  }

  const exhausted = attempt >= MAX_ATTEMPTS;
  const backoff = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)]!;
  await pool.query(
    `update webhook_deliveries
        set status = $2, attempts = $3, last_response_code = $4, last_error = $5,
            next_attempt_at = now() + ($6 || ' seconds')::interval, updated_at = now()
      where id = $1`,
    [d.id, exhausted ? 'failed' : 'pending', attempt, responseCode, error, backoff],
  );
  log.warn(
    { deliveryId: d.id, attempt, responseCode, error, exhausted },
    'webhook delivery attempt failed',
  );
}

export function startWebhookDispatcher(log: FastifyBaseLogger): () => void {
  // Recover deliveries left mid-flight by a previous crash.
  void pool.query(
    `update webhook_deliveries set status = 'pending'
      where status = 'delivering' and updated_at < now() - interval '1 minute'`,
  );

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const due = await claimDue(25);
      await Promise.all(due.map((d) => deliver(d, log)));
    } catch (err) {
      log.error({ err }, 'webhook dispatcher tick failed');
    } finally {
      running = false;
    }
  }, config.webhookDispatchIntervalMs);
  timer.unref();
  log.info('webhook dispatcher started');
  return () => clearInterval(timer);
}
