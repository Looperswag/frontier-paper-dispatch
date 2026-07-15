-- Persist one stable work identity across providers and retain immutable,
-- source-specific observations. This migration is safe for populated legacy
-- databases: legacy duplicate rows remain addressable while aliases resolve
-- them to the shared canonical identity.

create or replace function public.source_identity_hash(p_source text, p_external_id text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.lower(pg_catalog.btrim(coalesce(p_source, '')))
        || pg_catalog.chr(31)
        || pg_catalog.btrim(coalesce(p_external_id, '')),
      'UTF8'
    )),
    'hex'
  )
$$;

alter function public.source_identity_hash(text, text) owner to postgres;
revoke all on function public.source_identity_hash(text, text) from public, anon, authenticated;
grant execute on function public.source_identity_hash(text, text) to service_role;

create or replace function public.canonical_item_key(
  p_source text,
  p_external_id text,
  p_url text
)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_source text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source, '')));
  v_external text := pg_catalog.btrim(coalesce(p_external_id, ''));
  v_lower_external text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_external_id, '')));
  v_url text := pg_catalog.btrim(coalesce(p_url, ''));
  v_identity text;
begin
  if v_source in ('arxiv', 'huggingface')
    and v_lower_external ~ '^(\d{4}\.\d{1,5}|[a-z][a-z0-9.-]*/\d{7})v?[0-9]*$' then
    return 'arxiv:' || pg_catalog.regexp_replace(v_lower_external, 'v[0-9]+$', '');
  end if;

  if pg_catalog.lower(v_url) ~ '^https?://(www\.)?doi\.org(:443)?/10\.[0-9]{4,9}/' then
    v_identity := pg_catalog.regexp_replace(v_url, '^https?://(www\.)?doi\.org(:443)?/', '', 'i');
    v_identity := pg_catalog.split_part(pg_catalog.split_part(v_identity, '?', 1), '#', 1);
    return 'doi:' || pg_catalog.lower(v_identity);
  end if;

  if pg_catalog.lower(v_url) ~ '^https?://(www\.)?openreview\.net(:443)?/[^?#]*[?&]id=' then
    v_identity := substring(v_url from '(?i)[?&]id=([^&#]+)');
    if v_identity is not null and v_identity <> '' then
      return 'openreview:' || v_identity;
    end if;
  end if;

  if pg_catalog.lower(v_url) ~ '^https?://(www\.)?aclanthology\.org(:443)?/[^/?#]+' then
    v_identity := pg_catalog.regexp_replace(v_url, '^https?://(www\.)?aclanthology\.org(:443)?/', '', 'i');
    v_identity := pg_catalog.split_part(pg_catalog.split_part(pg_catalog.split_part(v_identity, '/', 1), '?', 1), '#', 1);
    return 'acl:' || pg_catalog.lower(v_identity);
  end if;

  if v_source ~ '^[a-z0-9._-]+$'
    and pg_catalog.octet_length(v_source) between 1 and 64
    and pg_catalog.octet_length(v_external) between 3 and 256
    and v_external ~ '^[A-Za-z0-9._/-]+$' then
    return v_source || ':' || v_external;
  end if;

  return case
    when v_source ~ '^[a-z0-9._-]+$' and pg_catalog.octet_length(v_source) between 1 and 64
      then v_source
    else 'source'
  end || ':id:' || public.source_identity_hash(v_source, v_external);
end;
$$;

alter function public.canonical_item_key(text, text, text) owner to postgres;
revoke all on function public.canonical_item_key(text, text, text) from public, anon, authenticated;
grant execute on function public.canonical_item_key(text, text, text) to service_role;

-- Upgrade the provenance validator before adding per-source signals. Keeping
-- this here also makes the migration safe when the previous migration was
-- already applied from an older release.
create or replace function public.valid_item_provenance(p_value jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_typeof(p_value) = 'array'
      and pg_catalog.jsonb_array_length(p_value) <= 32
      and pg_catalog.octet_length(p_value::text) <= 16384
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_value) as entry(observation)
        where pg_catalog.jsonb_typeof(observation) <> 'object'
          or (select count(*) from pg_catalog.jsonb_object_keys(observation)) not between 3 and 4
          or pg_catalog.jsonb_typeof(observation -> 'source') <> 'string'
          or pg_catalog.octet_length(observation ->> 'source') not between 1 and 64
          or pg_catalog.jsonb_typeof(observation -> 'externalId') <> 'string'
          or pg_catalog.octet_length(observation ->> 'externalId') not between 1 and 512
          or pg_catalog.jsonb_typeof(observation -> 'url') <> 'string'
          or pg_catalog.octet_length(observation ->> 'url') not between 1 and 2048
          or (observation ->> 'url') !~ '^https://'
          or (
            observation ? 'signals'
            and (
              pg_catalog.jsonb_typeof(observation -> 'signals') <> 'object'
              or pg_catalog.octet_length((observation -> 'signals')::text) > 32768
            )
          )
      ),
    false
  )
$$;

alter function public.valid_item_provenance(jsonb) owner to postgres;
revoke all on function public.valid_item_provenance(jsonb) from public, anon, authenticated;
grant execute on function public.valid_item_provenance(jsonb) to service_role;
alter table public.items drop constraint if exists items_provenance_check;
alter table public.items add constraint items_provenance_check
  check (public.valid_item_provenance(provenance));

-- Legacy rows received an empty provenance array in the previous migration.
-- Recover their primary source observation before building history.
update public.items
set provenance = pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
  'source', source,
  'externalId', external_id,
  'url', pg_catalog.regexp_replace(url, '^http:', 'https:', 'i'),
  'signals', case
    when pg_catalog.octet_length(signals::text) <= 32768 then signals
    else '{}'::jsonb
  end
))
where provenance = '[]'::jsonb
  and pg_catalog.octet_length(source) between 1 and 64
  and pg_catalog.octet_length(external_id) between 1 and 512
  and pg_catalog.octet_length(url) between 1 and 2048
  and url ~ '^https?://';

alter table public.items add column if not exists canonical_key text;

with identities as (
  select id,
         public.canonical_item_key(source, external_id, url) as desired_key,
         pg_catalog.row_number() over (
           partition by public.canonical_item_key(source, external_id, url)
           order by fetched_at, id
         ) as position
  from public.items
)
update public.items as item
set canonical_key = case
  when identities.position = 1 then identities.desired_key
  else 'legacy:' || item.id::text
end
from identities
where identities.id = item.id and item.canonical_key is null;

alter table public.items alter column canonical_key set not null;
alter table public.items drop constraint if exists items_canonical_key_check;
alter table public.items add constraint items_canonical_key_check check (
  pg_catalog.octet_length(canonical_key) between 3 and 512
  and canonical_key !~ '[[:cntrl:]]'
);
alter table public.items drop constraint if exists items_canonical_key_key;
alter table public.items add constraint items_canonical_key_key unique (canonical_key);

-- The old uniqueness constraint can conflict with a canonical upsert targeting
-- a different keeper row. Source identity uniqueness now lives in the alias
-- ledger, which also resolves historical legacy rows for novelty checks.
alter table public.items drop constraint if exists items_source_external_id_key;

create table if not exists public.item_identity_aliases (
  identity_hash   text primary key check (identity_hash ~ '^[a-f0-9]{64}$'),
  item_id         uuid not null references public.items(id) on delete restrict,
  canonical_key   text not null check (pg_catalog.octet_length(canonical_key) between 3 and 512),
  first_seen_at   timestamptz not null default clock_timestamp(),
  last_seen_at    timestamptz not null default clock_timestamp()
);

create index if not exists item_identity_aliases_item_idx
  on public.item_identity_aliases(item_id);

insert into public.item_identity_aliases(
  identity_hash, item_id, canonical_key, first_seen_at, last_seen_at
)
select public.source_identity_hash(observed.source, observed.external_id),
       keeper.id,
       public.canonical_item_key(observed.source, observed.external_id, observed.url),
       observed.fetched_at, observed.fetched_at
from public.items as observed
join public.items as keeper
  on keeper.canonical_key = public.canonical_item_key(
    observed.source, observed.external_id, observed.url
  )
on conflict (identity_hash) do update set
  last_seen_at = greatest(public.item_identity_aliases.last_seen_at, excluded.last_seen_at)
where public.item_identity_aliases.item_id = excluded.item_id;

alter table public.item_identity_aliases enable row level security;
alter table public.item_identity_aliases force row level security;
revoke all on table public.item_identity_aliases from public, anon, authenticated, service_role;

create table if not exists public.item_observations (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references public.items(id) on delete cascade,
  canonical_key     text not null check (pg_catalog.octet_length(canonical_key) between 3 and 512),
  source            text not null check (pg_catalog.octet_length(source) between 1 and 64),
  external_id       text not null check (pg_catalog.octet_length(external_id) between 1 and 512),
  url               text not null check (pg_catalog.octet_length(url) between 1 and 2048 and url ~ '^https://'),
  signals           jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(signals) = 'object' and pg_catalog.octet_length(signals::text) <= 32768
  ),
  observation_date  date not null,
  observed_at       timestamptz not null default clock_timestamp(),
  unique (item_id, source, external_id, observation_date)
);

create index if not exists item_observations_item_date_idx
  on public.item_observations(item_id, observation_date desc);
create index if not exists item_observations_canonical_date_idx
  on public.item_observations(canonical_key, observation_date desc);

alter table public.item_observations enable row level security;
alter table public.item_observations force row level security;
revoke all on table public.item_observations from public, anon, authenticated, service_role;

-- Record only the observations supplied by this write. Persisted provenance is
-- a merged history and must never be replayed as if every source was seen today.
create or replace function public.record_incoming_item_observations(
  p_item_id uuid,
  p_canonical_key text,
  p_provenance jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_observation jsonb;
  v_alias_key text;
  v_affected integer;
begin
  for v_observation in
    select entry.observation
    from pg_catalog.jsonb_array_elements(p_provenance) as entry(observation)
  loop
    v_alias_key := case
      when p_canonical_key like 'legacy:%' then public.canonical_item_key(
        v_observation ->> 'source',
        v_observation ->> 'externalId',
        v_observation ->> 'url'
      )
      else p_canonical_key
    end;

    insert into public.item_identity_aliases(identity_hash, item_id, canonical_key)
    values (
      public.source_identity_hash(
        v_observation ->> 'source', v_observation ->> 'externalId'
      ),
      p_item_id,
      v_alias_key
    )
    on conflict (identity_hash) do update set
      last_seen_at = clock_timestamp()
    where public.item_identity_aliases.item_id = excluded.item_id;

    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'source identity is already bound to another item'
        using errcode = '23505';
    end if;

    insert into public.item_observations(
      item_id, canonical_key, source, external_id, url, signals,
      observation_date, observed_at
    ) values (
      p_item_id,
      v_alias_key,
      v_observation ->> 'source',
      v_observation ->> 'externalId',
      v_observation ->> 'url',
      coalesce(v_observation -> 'signals', '{}'::jsonb),
      (clock_timestamp() at time zone 'Asia/Shanghai')::date,
      clock_timestamp()
    )
    on conflict (item_id, source, external_id, observation_date) do update set
      canonical_key = excluded.canonical_key,
      url = excluded.url,
      signals = excluded.signals,
      observed_at = excluded.observed_at;
  end loop;
end;
$$;

alter function public.record_incoming_item_observations(uuid, text, jsonb) owner to postgres;
revoke all on function public.record_incoming_item_observations(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.prepare_item_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_bound_key text;
begin
  if tg_op = 'INSERT' then
    select item.canonical_key
    into v_bound_key
    from public.item_identity_aliases as alias
    join public.items as item on item.id = alias.item_id
    where alias.identity_hash = public.source_identity_hash(new.source, new.external_id);

    if v_bound_key is not null then
      new.canonical_key := v_bound_key;
    elsif new.canonical_key is null or new.canonical_key = '' then
      new.canonical_key := public.canonical_item_key(new.source, new.external_id, new.url);
    end if;
  else
    -- A source alias is immutable; ordinary metadata refreshes cannot move an
    -- existing row onto a different canonical identity.
    new.canonical_key := old.canonical_key;
  end if;

  if new.provenance = '[]'::jsonb and new.url ~ '^https?://' then
    v_url := pg_catalog.regexp_replace(new.url, '^http:', 'https:', 'i');
    new.provenance := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'source', new.source,
      'externalId', new.external_id,
      'url', v_url,
      'signals', case
        when pg_catalog.octet_length(new.signals::text) <= 32768 then new.signals
        else '{}'::jsonb
      end
    ));
  end if;

  if tg_op = 'UPDATE' then
    perform public.record_incoming_item_observations(
      old.id, old.canonical_key, new.provenance
    );

    if pg_catalog.octet_length(coalesce(new.abstract, ''))
      < pg_catalog.octet_length(coalesce(old.abstract, '')) then
      new.abstract := old.abstract;
    end if;
    if pg_catalog.octet_length(coalesce(new.content, ''))
      < pg_catalog.octet_length(coalesce(old.content, '')) then
      new.content := old.content;
    end if;

    select coalesce(
      pg_catalog.jsonb_agg(observation order by observation ->> 'source', observation ->> 'externalId'),
      '[]'::jsonb
    )
    into new.provenance
    from (
      select distinct on (entry.observation ->> 'source', entry.observation ->> 'externalId')
             entry.observation
      from pg_catalog.jsonb_array_elements(old.provenance || new.provenance)
        with ordinality as entry(observation, position)
      order by entry.observation ->> 'source', entry.observation ->> 'externalId', entry.position desc
      limit 32
    ) as latest_observations;
  end if;
  return new;
end;
$$;

alter function public.prepare_item_identity() owner to postgres;
revoke all on function public.prepare_item_identity() from public, anon, authenticated, service_role;
drop trigger if exists prepare_item_identity on public.items;
create trigger prepare_item_identity
before insert or update on public.items
for each row execute function public.prepare_item_identity();

create or replace function public.capture_item_observations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.record_incoming_item_observations(
    new.id, new.canonical_key, new.provenance
  );
  return new;
end;
$$;

alter function public.capture_item_observations() owner to postgres;
revoke all on function public.capture_item_observations() from public, anon, authenticated, service_role;
drop trigger if exists capture_item_observations on public.items;
create trigger capture_item_observations
after insert on public.items
for each row execute function public.capture_item_observations();

-- Backfill source-specific history for every recoverable legacy row.
insert into public.item_observations(
  item_id, canonical_key, source, external_id, url, signals, observation_date, observed_at
)
select item.id,
       public.canonical_item_key(
         observation ->> 'source', observation ->> 'externalId', observation ->> 'url'
       ),
       observation ->> 'source', observation ->> 'externalId', observation ->> 'url',
       coalesce(observation -> 'signals', '{}'::jsonb),
       (item.fetched_at at time zone 'Asia/Shanghai')::date,
       item.fetched_at
from public.items as item
cross join lateral pg_catalog.jsonb_array_elements(item.provenance) as entry(observation)
on conflict (item_id, source, external_id, observation_date) do nothing;

create or replace function public.successful_delivery_canonical_keys(
  p_since timestamptz,
  p_until timestamptz
)
returns table(canonical_key text, identity_hash text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct
         coalesce(alias.canonical_key, item.canonical_key),
         coalesce(alias.identity_hash, public.source_identity_hash(item.source, item.external_id))
  from public.delivery_outbox as delivery
  join public.digests as digest on digest.digest_date = delivery.digest_date
  cross join lateral pg_catalog.unnest(digest.top5_item_ids) as selected(item_id)
  join public.items as item on item.id = selected.item_id
  left join public.item_identity_aliases as alias
    on alias.item_id = item.id
    or alias.identity_hash = public.source_identity_hash(item.source, item.external_id)
  where p_since is not null
    and p_until is not null
    and p_since < p_until
    and delivery.status = 'succeeded'
    and delivery.delivered_at >= p_since
    and delivery.delivered_at <= p_until
  order by coalesce(alias.canonical_key, item.canonical_key),
           coalesce(alias.identity_hash, public.source_identity_hash(item.source, item.external_id))
$$;

alter function public.successful_delivery_canonical_keys(timestamptz, timestamptz) owner to postgres;
revoke all on function public.successful_delivery_canonical_keys(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.successful_delivery_canonical_keys(timestamptz, timestamptz)
  to service_role;
