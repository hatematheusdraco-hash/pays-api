# PayS — Any-to-Any Payment API (MVP)

Stripe-like payment gateway where the **payer sends any crypto** and the
**merchant receives fiat or stablecoin**. One API, conversion under the hood.

This repo is the MVP backend: the API surface, payment **state machine**, quote
& routing engines, and webhook delivery are built for real. The external vendors
from the tech spec (Zero Hash, Alchemy, Sumsub, Elliptic, Railsr, Circle…) are
behind clean provider interfaces and **mocked** at MVP so the whole flow runs
end-to-end without third-party accounts.

## Stack

- **Node.js + TypeScript**, **Fastify** (HTTP)
- **PostgreSQL** (Supabase) via `pg`, ACID transactions for state transitions
- Background **payment processor** + **webhook dispatcher** (in-process pollers)
- In-process rate limiting (Redis in production)

## Architecture (4 layers, per the tech spec)

| Layer | Here |
|-------|------|
| 1 — API Gateway | `src/routes/*`, `src/auth/*` (API keys + HMAC webhooks, rate limit) |
| 2 — Payment Engine | `src/engine/*` — state machine, quote engine, routing engine, processor |
| 3 — Conversion | `src/providers/conversion.ts` (Zero Hash primary, Wert reserve — mocked) |
| 4 — Settlement | `src/providers/settlement.ts` (Railsr/SEPA, Circle/USDC, Payoneer — mocked) |

### Payment state machine

```
CREATED ─▶ QUOTE_LOCKED ─▶ PAYMENT_DETECTED ─▶ CONFIRMING ─▶ CONVERTING ─▶ SETTLING ─▶ COMPLETED
   └──────────┴────────────────┴──────────────────┴─────────────┴────────────┴──▶ FAILED
```

Every transition is applied inside a DB transaction with `SELECT … FOR UPDATE`,
writes an immutable `payment_events` row, and enqueues webhook deliveries — so a
payment can never skip a step, reverse, or be lost mid-flight.

## Setup

```bash
npm install
cp .env.example .env      # then set DATABASE_URL (Supabase "Session pooler" string)
npm run migrate           # apply supabase/migrations/*.sql
npm run dev               # start API on http://localhost:3000
```

### End-to-end demo

```bash
npm run demo
```

Boots the stack in-process, onboards a merchant, registers a webhook, creates a
49.99 EUR payment, locks an ETH quote, simulates the on-chain deposit, and prints
each state transition and each (HMAC-verified) webhook through to `COMPLETED`.

## API

All requests authenticate with `Authorization: Bearer sk_test_...` except the
merchant bootstrap.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/merchants` | Onboard a merchant, mint first API key (secret shown once) |
| `GET`  | `/v1/merchants/me` | Current merchant |
| `POST` | `/v1/payments` | Create a payment (amount + settlement currency) |
| `GET`  | `/v1/payments/:id` | Retrieve a payment |
| `GET`  | `/v1/payments` | List payments |
| `POST` | `/v1/payments/:id/quote` | Payer picks crypto → lock 30s quote (`CREATED`→`QUOTE_LOCKED`) |
| `POST` | `/v1/payments/:id/simulate_payment` | **Test only** — simulate on-chain deposit (`QUOTE_LOCKED`→`PAYMENT_DETECTED`) |
| `POST` | `/v1/webhook_endpoints` | Register a webhook (signing secret shown once) |
| `GET`  | `/v1/webhook_endpoints` | List webhooks |
| `GET`  | `/healthz` | Liveness + DB check |

### Example

```bash
# 1. Onboard
curl -sX POST localhost:3000/v1/merchants \
  -H 'content-type: application/json' \
  -d '{"name":"Acme","email":"a@acme.io","settlement_method":"sepa"}'

# 2. Create a payment  (use the returned api_key.secret as $KEY)
curl -sX POST localhost:3000/v1/payments \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"amount":49.99,"currency":"EUR","description":"Pro plan"}'

# 3. Lock a quote (payer pays in ETH)
curl -sX POST localhost:3000/v1/payments/$PAY_ID/quote \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"pay_currency":"ETH","pay_network":"ethereum"}'

# 4. Simulate the deposit; the processor settles it automatically
curl -sX POST localhost:3000/v1/payments/$PAY_ID/simulate_payment \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}'
```

### Webhook signature verification

Each delivery carries `PayS-Signature: t=<unix>,v1=<hmac-sha256>` over
`"${t}.${body}"` using the endpoint secret. Verify with
`verifySignature()` in `src/auth/hmac.ts`.

## What's mocked vs real

| Real | Mocked (swap-in later) |
|------|------------------------|
| API, auth, rate limit, state machine, quote/routing engine, webhooks, persistence | FX rates, Zero Hash/Wert conversion, Alchemy chain monitoring, Elliptic AML, Railsr/Circle/Payoneer settlement |

To go live, replace the implementations in `src/providers/*` and drive
`QUOTE_LOCKED → PAYMENT_DETECTED` from a real Alchemy webhook instead of the
`simulate_payment` endpoint. No engine code changes required.

## Security notes

- API-key secrets are stored only as SHA-256 hashes; the raw key is shown once.
- The backend connects as the Postgres `postgres` role, which **bypasses RLS**.
  Enable RLS (no policies) on all `pays-api` tables so the public Supabase
  **anon key** cannot touch them — see the deploy checklist.
- Never commit `.env`.
