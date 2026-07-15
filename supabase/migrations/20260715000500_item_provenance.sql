-- Preserve every source observation while keeping one canonical item row.
alter table public.items
  add column if not exists provenance jsonb not null default '[]'::jsonb;

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

alter table public.items
  drop constraint if exists items_provenance_check;
alter table public.items
  add constraint items_provenance_check check (public.valid_item_provenance(provenance));
