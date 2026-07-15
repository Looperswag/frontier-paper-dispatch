-- Explicit, auditable recovery for terminal delivery failures. Normal enqueue
-- remains idempotent and can never revive a succeeded row.
alter table public.delivery_outbox
  add column if not exists requeue_count integer not null default 0
    check (requeue_count between 0 and 1000),
  add column if not exists last_requeued_at timestamptz;

create or replace function public.requeue_failed_deliveries(
  p_digest_date date,
  p_channels text[],
  p_now timestamptz default clock_timestamp()
)
returns table(
  delivery_id uuid,
  channel text,
  delivery_status text,
  attempts integer,
  requeue_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_digest_date is null
    or p_now is null
    or not pg_catalog.isfinite(p_now)
    or p_channels is null
    or pg_catalog.cardinality(p_channels) not between 1 and 2
    or exists (
      select 1 from pg_catalog.unnest(p_channels) as requested(value)
      where requested.value is null or requested.value not in ('email', 'wechat')
    )
    or pg_catalog.cardinality(p_channels) <> (
      select pg_catalog.count(distinct requested.value)
      from pg_catalog.unnest(p_channels) as requested(value)
    ) then
    raise exception 'invalid delivery replay' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.digests as digest
    where digest.digest_date = p_digest_date
  ) then
    raise exception 'delivery digest does not exist' using errcode = '23503';
  end if;

  return query
  with replayed as (
    update public.delivery_outbox as outbox
    set status = 'pending',
        next_attempt_at = p_now,
        lease_owner = null,
        lease_until = null,
        provider_message_id = null,
        last_error = null,
        delivered_at = null,
        requeue_count = outbox.requeue_count + 1,
        last_requeued_at = p_now,
        updated_at = p_now
    where outbox.digest_date = p_digest_date
      and outbox.channel = any(p_channels)
      and outbox.status = 'failed'
      and outbox.attempts < 100
      and outbox.requeue_count < 1000
    returning outbox.*
  )
  select replayed.id, replayed.channel, replayed.status, replayed.attempts,
         replayed.requeue_count
  from replayed
  order by replayed.channel, replayed.id;
end;
$$;

alter function public.requeue_failed_deliveries(date, text[], timestamptz)
  owner to postgres;
revoke all on function public.requeue_failed_deliveries(date, text[], timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.requeue_failed_deliveries(date, text[], timestamptz)
  to service_role;

create or replace function public.claim_digest_delivery(
  p_digest_date date,
  p_worker_id uuid,
  p_now timestamptz default clock_timestamp(),
  p_lease_seconds integer default 300,
  p_limit integer default 10
)
returns table(
  delivery_id uuid,
  digest_date date,
  channel text,
  provider_id text,
  idempotency_key text,
  payload jsonb,
  attempts integer,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_digest_date is null
    or p_worker_id is null
    or p_now is null
    or not pg_catalog.isfinite(p_now)
    or p_lease_seconds not between 30 and 3600
    or p_limit not between 1 and 50 then
    raise exception 'invalid digest delivery claim' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select outbox.id
    from public.delivery_outbox as outbox
    where outbox.digest_date = p_digest_date
      and outbox.next_attempt_at <= p_now
      and outbox.attempts < 100
      and (
        outbox.status = 'pending'
        or (outbox.status = 'in_flight' and outbox.lease_until < p_now)
      )
    order by outbox.next_attempt_at, outbox.created_at, outbox.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.delivery_outbox as outbox
    set status = 'in_flight',
        attempts = outbox.attempts + 1,
        lease_owner = p_worker_id,
        lease_until = p_now + pg_catalog.make_interval(secs => p_lease_seconds),
        updated_at = p_now
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select claimed.id, claimed.digest_date, claimed.channel, claimed.provider_id,
         claimed.idempotency_key, claimed.payload, claimed.attempts,
         claimed.lease_until
  from claimed
  order by claimed.next_attempt_at, claimed.created_at, claimed.id;
end;
$$;

alter function public.claim_digest_delivery(date, uuid, timestamptz, integer, integer)
  owner to postgres;
revoke all on function public.claim_digest_delivery(date, uuid, timestamptz, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_digest_delivery(date, uuid, timestamptz, integer, integer)
  to service_role;

comment on function public.requeue_failed_deliveries(date, text[], timestamptz) is
  'Service-only explicit replay of failed digest channels; succeeded rows remain immutable.';
comment on function public.claim_digest_delivery(date, uuid, timestamptz, integer, integer) is
  'Service-only target-date delivery claim for truthful immediate and manual dispatch.';
