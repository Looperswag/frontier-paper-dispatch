-- Durable delivery state. Providers are invoked by server-only workers; the
-- database owns leases and idempotency so a crash can be safely recovered.
create table if not exists public.delivery_outbox (
  id                    uuid primary key default gen_random_uuid(),
  digest_date           date not null references public.digests(digest_date) on delete cascade,
  channel               text not null check (channel in ('email', 'wechat')),
  provider_id           text not null check (provider_id in ('smtp', 'serverchan')),
  idempotency_key       text not null unique check (octet_length(idempotency_key) between 1 and 200),
  payload               jsonb not null,
  status                text not null default 'pending' check (status in ('pending', 'in_flight', 'succeeded', 'failed')),
  attempts              integer not null default 0 check (attempts between 0 and 100),
  next_attempt_at       timestamptz not null default now(),
  lease_owner           uuid,
  lease_until           timestamptz,
  provider_message_id   text,
  last_error            text check (last_error is null or octet_length(last_error) <= 2048),
  delivered_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check ((status = 'in_flight') = (lease_owner is not null and lease_until is not null)),
  check (status <> 'succeeded' or delivered_at is not null)
);

create index if not exists delivery_outbox_claim_idx
  on public.delivery_outbox(status, next_attempt_at, lease_until, created_at);
create index if not exists delivery_outbox_digest_idx
  on public.delivery_outbox(digest_date, channel);

alter table public.delivery_outbox enable row level security;
alter table public.delivery_outbox force row level security;
revoke all on table public.delivery_outbox from anon, authenticated, service_role;

create or replace function public.enqueue_delivery(
  p_digest_date date,
  p_channel text,
  p_provider_id text,
  p_idempotency_key text,
  p_payload jsonb
)
returns table(
  delivery_id uuid,
  delivery_status text,
  inserted boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.delivery_outbox%rowtype;
  v_inserted boolean := false;
begin
  if p_digest_date is null
    or p_channel is null
    or p_provider_id is null
    or p_channel not in ('email', 'wechat')
    or p_provider_id not in ('smtp', 'serverchan')
    or (p_channel = 'email' and p_provider_id <> 'smtp')
    or (p_channel = 'wechat' and p_provider_id <> 'serverchan')
    or p_idempotency_key is null
    or pg_catalog.octet_length(p_idempotency_key) not between 1 and 200
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or not (p_payload ? 'title')
    or not (p_payload ? 'markdown')
    or jsonb_typeof(p_payload -> 'title') <> 'string'
    or jsonb_typeof(p_payload -> 'markdown') <> 'string'
    or pg_catalog.octet_length(p_payload ->> 'title') not between 1 and 200
    or pg_catalog.octet_length(p_payload ->> 'markdown') not between 1 and 1048576 then
    raise exception 'invalid delivery payload' using errcode = '22023';
  end if;

  if not exists (select 1 from public.digests where digest_date = p_digest_date) then
    raise exception 'delivery digest does not exist' using errcode = '23503';
  end if;

  insert into public.delivery_outbox(
    digest_date, channel, provider_id, idempotency_key, payload
  ) values (
    p_digest_date, p_channel, p_provider_id, p_idempotency_key, p_payload
  )
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  if found then
    v_inserted := true;
  else
    select * into strict v_row
    from public.delivery_outbox
    where idempotency_key = p_idempotency_key;
    if v_row.digest_date <> p_digest_date
      or v_row.channel <> p_channel
      or v_row.provider_id <> p_provider_id
      or v_row.payload <> p_payload then
      raise exception 'delivery idempotency key conflict' using errcode = '23505';
    end if;
  end if;

  delivery_id := v_row.id;
  delivery_status := v_row.status;
  inserted := v_inserted;
  return next;
end;
$$;

alter function public.enqueue_delivery(date, text, text, text, jsonb) owner to postgres;
revoke all on function public.enqueue_delivery(date, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_delivery(date, text, text, text, jsonb) to service_role;

create or replace function public.claim_delivery(
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
  if p_worker_id is null or p_now is null or p_lease_seconds not between 30 and 3600 or p_limit not between 1 and 50 then
    raise exception 'invalid delivery completion' using errcode = '22023';
  end if;
  return query
  with candidates as (
    select outbox.id
    from public.delivery_outbox as outbox
    where p_worker_id is not null
      and p_now is not null
      and p_lease_seconds between 30 and 3600
      and p_limit between 1 and 50
      and outbox.next_attempt_at <= p_now
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
        lease_until = p_now + make_interval(secs => p_lease_seconds),
        updated_at = p_now
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select claimed.id, claimed.digest_date, claimed.channel, claimed.provider_id,
         claimed.idempotency_key, claimed.payload, claimed.attempts, claimed.lease_until
  from claimed
  order by claimed.next_attempt_at, claimed.created_at, claimed.id;
end;
$$;

alter function public.claim_delivery(uuid, timestamptz, integer, integer) owner to postgres;
revoke all on function public.claim_delivery(uuid, timestamptz, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_delivery(uuid, timestamptz, integer, integer) to service_role;

create or replace function public.finish_delivery(
  p_delivery_id uuid,
  p_worker_id uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error text default null,
  p_next_attempt_at timestamptz default null
)
returns table(
  delivery_id uuid,
  delivery_status text,
  attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.delivery_outbox%rowtype;
begin
  if p_delivery_id is null
    or p_worker_id is null
    or p_outcome not in ('success', 'retry', 'permanent')
    or (p_outcome = 'retry' and p_next_attempt_at is null)
    or (p_error is not null and pg_catalog.octet_length(p_error) > 2048)
    or (p_provider_message_id is not null and pg_catalog.octet_length(p_provider_message_id) > 200) then
    raise exception 'invalid delivery completion' using errcode = '22023';
  end if;

  begin
    select * into strict v_row
    from public.delivery_outbox
    where id = p_delivery_id
      and status = 'in_flight'
      and lease_owner = p_worker_id
    for update;
  exception when no_data_found then
    raise exception 'delivery lease is not owned by worker' using errcode = 'P0001';
  end;

  if p_outcome = 'success' then
    update public.delivery_outbox
    set status = 'succeeded', lease_owner = null, lease_until = null,
        provider_message_id = p_provider_message_id,
        last_error = null, delivered_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = p_delivery_id;
  elsif p_outcome = 'retry' then
    update public.delivery_outbox
    set status = 'pending', lease_owner = null, lease_until = null,
        last_error = p_error, next_attempt_at = p_next_attempt_at,
        updated_at = clock_timestamp()
    where id = p_delivery_id;
  else
    update public.delivery_outbox
    set status = 'failed', lease_owner = null, lease_until = null,
        last_error = p_error, updated_at = clock_timestamp()
    where id = p_delivery_id;
  end if;

  delivery_id := p_delivery_id;
  delivery_status := case p_outcome when 'success' then 'succeeded' when 'retry' then 'pending' else 'failed' end;
  attempts := v_row.attempts;
  return next;
end;
$$;

alter function public.finish_delivery(uuid, uuid, text, text, text, timestamptz) owner to postgres;
revoke all on function public.finish_delivery(uuid, uuid, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_delivery(uuid, uuid, text, text, text, timestamptz) to service_role;

comment on table public.delivery_outbox is
  'Leased, idempotent server-only delivery jobs for email and WeChat providers.';
