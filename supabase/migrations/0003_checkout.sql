-- PayS — hosted checkout support.
-- client_secret scopes the public payer-facing endpoints to a single payment
-- (so the merchant's secret key never touches the browser); livemode gates the
-- test-only "simulate deposit" action.

alter table payments add column if not exists client_secret text;
alter table payments add column if not exists livemode boolean not null default false;

create index if not exists payments_client_secret_idx on payments(client_secret);
