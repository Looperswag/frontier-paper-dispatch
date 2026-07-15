-- Durable, cross-process deadline alert dedupe for the independent delivery
-- worker. API roles cannot read or mutate this operational ledger directly.
create table public.delivery_alerts (
  alert_date    date not null,
  alert_key     text not null check (
    pg_catalog.octet_length(alert_key) between 1 and 128
    and alert_key ~ '^[a-z0-9:,_-]+$'
  ),
  status        text not null default 'pending'
                check (status in ('pending', 'in_flight', 'succeeded')),
  attempts      integer not null default 0 check (attempts between 0 and 1000),
  lease_owner   uuid,
  lease_until   timestamptz,
  last_error    text check (last_error is null or pg_catalog.octet_length(last_error) <= 2048),
  sent_at       timestamptz,
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  primary key (alert_date, alert_key),
  check (
    (status = 'in_flight' and lease_owner is not null and lease_until is not null and sent_at is null)
    or (status = 'succeeded' and lease_owner is null and lease_until is null and sent_at is not null)
    or (status = 'pending' and lease_owner is null and lease_until is null and sent_at is null)
  )
);

create index delivery_alerts_retention_idx
  on public.delivery_alerts(updated_at)
  where status = 'succeeded';

alter table public.delivery_alerts enable row level security;
alter table public.delivery_alerts force row level security;
revoke all on table public.delivery_alerts from public, anon, authenticated, service_role;

create or replace function public.get_delivery_health(p_digest_date date)
returns table(
  channel text,
  status text,
  attempts integer,
  delivered_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select delivery.channel, delivery.status, delivery.attempts, delivery.delivered_at
  from public.delivery_outbox as delivery
  where p_digest_date is not null and delivery.digest_date = p_digest_date
  order by delivery.channel
$$;

alter function public.get_delivery_health(date) owner to postgres;
revoke all on function public.get_delivery_health(date) from public, anon, authenticated, service_role;
grant execute on function public.get_delivery_health(date) to service_role;

create or replace function public.claim_delivery_alert(
  p_alert_date date,
  p_alert_key text,
  p_worker_id uuid,
  p_now timestamptz,
  p_lease_seconds integer
)
returns table(claimed boolean, alert_status text, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_attempts integer;
  v_lease_until timestamptz;
begin
  if p_alert_date is null
    or p_alert_key is null
    or pg_catalog.octet_length(p_alert_key) not between 1 and 128
    or p_alert_key !~ '^[a-z0-9:,_-]+$'
    or p_worker_id is null
    or p_now is null
    or p_lease_seconds not between 30 and 3600 then
    raise exception 'invalid delivery alert claim' using errcode = '22023';
  end if;

  insert into public.delivery_alerts(alert_date, alert_key)
  values (p_alert_date, p_alert_key)
  on conflict (alert_date, alert_key) do nothing;

  select ledger.status, ledger.attempts, ledger.lease_until
  into strict v_status, v_attempts, v_lease_until
  from public.delivery_alerts as ledger
  where ledger.alert_date = p_alert_date and ledger.alert_key = p_alert_key
  for update;

  if v_status = 'succeeded'
    or (v_status = 'in_flight' and v_lease_until > p_now) then
    return query select false, v_status, v_attempts;
    return;
  end if;

  update public.delivery_alerts as ledger
  set status = 'in_flight',
      attempts = ledger.attempts + 1,
      lease_owner = p_worker_id,
      lease_until = p_now + pg_catalog.make_interval(secs => p_lease_seconds),
      last_error = null,
      updated_at = p_now
  where ledger.alert_date = p_alert_date and ledger.alert_key = p_alert_key
  returning ledger.status, ledger.attempts into v_status, v_attempts;

  return query select true, v_status, v_attempts;
end;
$$;

alter function public.claim_delivery_alert(date, text, uuid, timestamptz, integer) owner to postgres;
revoke all on function public.claim_delivery_alert(date, text, uuid, timestamptz, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_delivery_alert(date, text, uuid, timestamptz, integer)
  to service_role;

create or replace function public.finish_delivery_alert(
  p_alert_date date,
  p_alert_key text,
  p_worker_id uuid,
  p_outcome text,
  p_error text
)
returns table(alert_status text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_alert_date is null
    or p_alert_key is null
    or p_worker_id is null
    or p_outcome not in ('success', 'retry')
    or (p_error is not null and pg_catalog.octet_length(p_error) > 2048) then
    raise exception 'invalid delivery alert completion' using errcode = '22023';
  end if;

  update public.delivery_alerts as ledger
  set status = case when p_outcome = 'success' then 'succeeded' else 'pending' end,
      lease_owner = null,
      lease_until = null,
      last_error = case when p_outcome = 'retry' then p_error else null end,
      sent_at = case when p_outcome = 'success' then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where ledger.alert_date = p_alert_date
    and ledger.alert_key = p_alert_key
    and ledger.status = 'in_flight'
    and ledger.lease_owner = p_worker_id;

  if not found then
    raise exception 'delivery alert lease mismatch';
  end if;

  return query
  select ledger.status
  from public.delivery_alerts as ledger
  where ledger.alert_date = p_alert_date and ledger.alert_key = p_alert_key;
end;
$$;

alter function public.finish_delivery_alert(date, text, uuid, text, text) owner to postgres;
revoke all on function public.finish_delivery_alert(date, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_delivery_alert(date, text, uuid, text, text)
  to service_role;
