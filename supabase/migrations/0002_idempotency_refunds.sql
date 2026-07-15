-- PayS — idempotency keys, refunds, and payment cancellation support.

-- ---------------------------------------------------------------------------
-- Idempotency keys — safe retries for POST requests (Stripe-style).
-- The stored response is replayed for a repeated key; reusing a key with a
-- different request body is rejected.
-- ---------------------------------------------------------------------------
create table if not exists idempotency_keys (
  merchant_id  text not null references merchants(id) on delete cascade,
  key          text not null,
  request_hash text not null,
  status_code  integer,
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (merchant_id, key)
);

-- ---------------------------------------------------------------------------
-- Refunds — a refund reverses all or part of a COMPLETED payment.
-- ---------------------------------------------------------------------------
create table if not exists refunds (
  id                 text primary key,
  payment_id         text not null references payments(id) on delete cascade,
  merchant_id        text not null references merchants(id),
  amount             numeric(20,2) not null check (amount > 0),
  currency           text not null,
  reason             text,
  status             text not null default 'pending',  -- pending | processing | succeeded | failed
  provider_reference text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists refunds_payment_idx  on refunds(payment_id);
create index if not exists refunds_merchant_idx on refunds(merchant_id);
create index if not exists refunds_status_idx   on refunds(status);

-- Track how much of a payment has already been refunded.
alter table payments add column if not exists amount_refunded numeric(20,2) not null default 0;
