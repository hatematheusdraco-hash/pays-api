-- PayS — Any-to-Any Payment API — initial schema
-- Postgres 15+ (Supabase). ACID transactions are load-bearing: state-machine
-- transitions use SELECT ... FOR UPDATE to guarantee no payment is lost or
-- double-advanced even under concurrent workers (tech spec §Layer 2).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Merchants
-- ---------------------------------------------------------------------------
create table if not exists merchants (
  id                     text primary key,
  name                   text not null,
  email                  text not null,
  settlement_method      text not null default 'sepa',
  settlement_destination jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- API keys  (only a SHA-256 hash of the secret is stored; raw is shown once)
-- ---------------------------------------------------------------------------
create table if not exists api_keys (
  id           text primary key,
  merchant_id  text not null references merchants(id) on delete cascade,
  key_hash     text not null unique,
  key_prefix   text not null,           -- e.g. "sk_test_3Nk9" for dashboard display
  livemode     boolean not null default false,
  scope        text not null default 'full',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists api_keys_merchant_idx on api_keys(merchant_id);

-- ---------------------------------------------------------------------------
-- Payments (a.k.a. Payment Intents)
-- ---------------------------------------------------------------------------
create table if not exists payments (
  id                     text primary key,
  merchant_id            text not null references merchants(id),
  status                 text not null default 'CREATED',

  -- what the merchant wants to receive
  settlement_currency    text not null,               -- EUR | USD | USDC
  amount_fiat            numeric(20,2) not null check (amount_fiat > 0),
  settlement_method      text not null,
  settlement_destination jsonb not null default '{}'::jsonb,

  -- what the payer chose to pay with (null until quote)
  pay_currency           text,
  pay_network            text,

  description            text,
  metadata               jsonb not null default '{}'::jsonb,

  -- amounts populated as the flow progresses
  amount_crypto          numeric(40,18),
  exchange_rate          numeric(40,18),
  network_fee            numeric(40,18),
  pays_fee               numeric(20,2),
  deposit_address        text,
  tx_hash                text,
  confirmations          integer not null default 0,
  required_confirmations integer,
  failure_reason         text,
  quote_id               text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  completed_at           timestamptz
);
create index if not exists payments_merchant_idx on payments(merchant_id);
create index if not exists payments_status_idx   on payments(status);

-- ---------------------------------------------------------------------------
-- Quotes  (30s locked FX window)
-- ---------------------------------------------------------------------------
create table if not exists quotes (
  id              text primary key,
  payment_id      text not null references payments(id) on delete cascade,
  pay_currency    text not null,
  pay_network     text not null,
  amount_crypto   numeric(40,18) not null,
  exchange_rate   numeric(40,18) not null,
  network_fee     numeric(40,18) not null,
  pays_fee        numeric(20,2) not null,
  provider        text not null,
  deposit_address text not null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);
create index if not exists quotes_payment_idx on quotes(payment_id);

-- ---------------------------------------------------------------------------
-- Payment events  (immutable audit log of every state transition)
-- ---------------------------------------------------------------------------
create table if not exists payment_events (
  id          bigint generated always as identity primary key,
  event_id    text not null unique,        -- evt_... (referenced by webhooks)
  payment_id  text not null references payments(id) on delete cascade,
  type        text not null,               -- payment.quote_locked, payment.completed, ...
  from_status text,
  to_status   text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists payment_events_payment_idx on payment_events(payment_id);

-- ---------------------------------------------------------------------------
-- Webhook endpoints
-- ---------------------------------------------------------------------------
create table if not exists webhook_endpoints (
  id             text primary key,
  merchant_id    text not null references merchants(id) on delete cascade,
  url            text not null,
  secret         text not null,            -- whsec_... HMAC signing key
  enabled_events text[] not null default array['*'],
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists webhook_endpoints_merchant_idx on webhook_endpoints(merchant_id);

-- ---------------------------------------------------------------------------
-- Webhook deliveries  (outbox with retry / exponential backoff)
-- ---------------------------------------------------------------------------
create table if not exists webhook_deliveries (
  id              text primary key,
  endpoint_id     text not null references webhook_endpoints(id) on delete cascade,
  event_id        text not null,
  event_type      text not null,
  payload         jsonb not null,
  status          text not null default 'pending',  -- pending | succeeded | failed
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_response_code integer,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists webhook_deliveries_due_idx
  on webhook_deliveries(status, next_attempt_at);
