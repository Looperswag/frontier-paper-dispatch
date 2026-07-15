-- A digest date is an immutable capability context once first persisted.

create or replace function public.prevent_digest_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.digest_date is distinct from old.digest_date
    or new.top5_item_ids is distinct from old.top5_item_ids
    or new.rendered_md is distinct from old.rendered_md then
    raise exception 'digest snapshot is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_digest_snapshot_mutation() from public, anon, authenticated, service_role;

drop trigger if exists prevent_digest_snapshot_mutation on public.digests;
create trigger prevent_digest_snapshot_mutation
before update on public.digests
for each row execute function public.prevent_digest_snapshot_mutation();

create or replace function public.store_digest_snapshot(
  p_digest_date date,
  p_top5_item_ids uuid[],
  p_rendered_md text
)
returns table(
  outcome text,
  persisted_digest_date date,
  persisted_top5_item_ids uuid[],
  persisted_rendered_md text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_digest public.digests%rowtype;
  persisted_digest public.digests%rowtype;
begin
  if p_digest_date is null
    or p_top5_item_ids is null
    or pg_catalog.array_ndims(p_top5_item_ids) <> 1
    or pg_catalog.cardinality(p_top5_item_ids) not between 1 and 5
    or pg_catalog.array_position(p_top5_item_ids, null) is not null
    or p_rendered_md is null
    or pg_catalog.octet_length(p_rendered_md) not between 1 and 1048576
    or (
      select pg_catalog.count(distinct item_id)
      from pg_catalog.unnest(p_top5_item_ids) as item_id
    ) <> pg_catalog.cardinality(p_top5_item_ids) then
    raise exception 'invalid digest snapshot' using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(p_top5_item_ids) as requested(item_id)
    left join public.items as item on item.id = requested.item_id
    where item.id is null
  ) then
    raise exception 'digest item does not exist' using errcode = '23503';
  end if;

  insert into public.digests(digest_date, top5_item_ids, rendered_md)
  values (p_digest_date, p_top5_item_ids, p_rendered_md)
  on conflict (digest_date) do nothing
  returning * into inserted_digest;

  if inserted_digest.id is not null then
    persisted_digest := inserted_digest;
    outcome := 'inserted';
  else
    select digest.* into strict persisted_digest
    from public.digests as digest
    where digest.digest_date = p_digest_date;
    outcome := case
      when persisted_digest.top5_item_ids = p_top5_item_ids
        and persisted_digest.rendered_md = p_rendered_md
      then 'existing'
      else 'conflict'
    end;
  end if;

  persisted_digest_date := persisted_digest.digest_date;
  persisted_top5_item_ids := persisted_digest.top5_item_ids;
  persisted_rendered_md := persisted_digest.rendered_md;
  return next;
end;
$$;

alter function public.store_digest_snapshot(date, uuid[], text) owner to postgres;
revoke all on function public.store_digest_snapshot(date, uuid[], text) from public, anon, authenticated;
grant execute on function public.store_digest_snapshot(date, uuid[], text) to service_role;
