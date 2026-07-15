-- Persist the summaries shown by the latest digest and its immutable snapshot
-- in one database transaction. Conflicting same-day reruns are read-only.

revoke all privileges on function public.store_digest_snapshot(date, uuid[], text)
  from public, anon, authenticated, service_role;

create or replace function public.store_digest_bundle(
  p_digest_date date,
  p_item_ids uuid[],
  p_one_liners text[],
  p_summary_mds text[],
  p_impact_mds text[],
  p_scores integer[],
  p_ranks integer[],
  p_rendered_md text
)
returns table(
  outcome text,
  persisted_digest_date date,
  persisted_top5_item_ids uuid[],
  persisted_rendered_md text,
  persisted_summary_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := pg_catalog.cardinality(p_item_ids);
  v_exact_summary_count integer;
  v_persisted public.digests%rowtype;
  v_summary_count integer;
begin
  if p_digest_date is null
    or not pg_catalog.isfinite(p_digest_date)
    or p_item_ids is null
    or pg_catalog.array_ndims(p_item_ids) <> 1
    or v_count not between 1 and 5
    or pg_catalog.array_position(p_item_ids, null) is not null
    or p_one_liners is null
    or pg_catalog.array_ndims(p_one_liners) <> 1
    or pg_catalog.cardinality(p_one_liners) <> v_count
    or pg_catalog.array_position(p_one_liners, null) is not null
    or p_summary_mds is null
    or pg_catalog.array_ndims(p_summary_mds) <> 1
    or pg_catalog.cardinality(p_summary_mds) <> v_count
    or pg_catalog.array_position(p_summary_mds, null) is not null
    or p_impact_mds is null
    or pg_catalog.array_ndims(p_impact_mds) <> 1
    or pg_catalog.cardinality(p_impact_mds) <> v_count
    or pg_catalog.array_position(p_impact_mds, null) is not null
    or p_scores is null
    or pg_catalog.array_ndims(p_scores) <> 1
    or pg_catalog.cardinality(p_scores) <> v_count
    or pg_catalog.array_position(p_scores, null) is not null
    or exists (
      select 1 from pg_catalog.unnest(p_scores) as score
      where score not between 0 and 100
    )
    or p_ranks is null
    or pg_catalog.array_ndims(p_ranks) <> 1
    or pg_catalog.cardinality(p_ranks) <> v_count
    or pg_catalog.array_position(p_ranks, null) is not null
    or p_ranks <> (
      select pg_catalog.array_agg(expected_rank order by expected_rank)
      from pg_catalog.generate_series(1, v_count) as expected_rank
    )
    or p_rendered_md is null
    or pg_catalog.octet_length(p_rendered_md) not between 1 and 1048576
    or exists (
      select 1
      from pg_catalog.generate_subscripts(p_item_ids, 1) as position
      where pg_catalog.octet_length(p_one_liners[position]) > 1048576
        or pg_catalog.octet_length(p_summary_mds[position]) > 1048576
        or pg_catalog.octet_length(p_impact_mds[position]) > 1048576
    )
    or (
      select pg_catalog.count(distinct item_id)
      from pg_catalog.unnest(p_item_ids) as item_id
    ) <> v_count then
    raise exception 'invalid digest bundle' using errcode = '22023';
  end if;

  if (
    select pg_catalog.count(*)
    from public.items as item
    where item.id = any(p_item_ids)
  ) <> v_count then
    raise exception 'digest item does not exist' using errcode = '23503';
  end if;

  -- Serialize all bundle writers. This closes same-day and cross-midnight
  -- delete/insert races in the non-versioned summaries table.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('frontier-paper-dispatch:digest-bundle:v1', 0)
  );

  -- A delayed job for an older date must neither replace current summaries
  -- nor return "existing" and continue into a stale delivery. Explicit
  -- resend behavior belongs to the separate push:last command.
  if exists (
    select 1
    from public.digests as newer_digest
    where newer_digest.digest_date > p_digest_date
  ) then
    raise exception 'digest date is older than latest snapshot'
      using errcode = '23514';
  end if;

  select digest.* into v_persisted
  from public.digests as digest
  where digest.digest_date = p_digest_date;

  if found then
    select pg_catalog.count(*)::integer into v_summary_count
    from public.summaries as summary
    where summary.item_id = any(v_persisted.top5_item_ids);

    if v_persisted.top5_item_ids = p_item_ids
      and v_persisted.rendered_md = p_rendered_md
      and v_summary_count = v_count then
      select pg_catalog.count(*)::integer into v_exact_summary_count
      from pg_catalog.generate_subscripts(p_item_ids, 1) as position
      where (
        select pg_catalog.count(*)
        from public.summaries as summary
        where summary.item_id = p_item_ids[position]
          and summary.one_liner = p_one_liners[position]
          and summary.summary_md = p_summary_mds[position]
          and summary.impact_md = p_impact_mds[position]
          and summary.score = p_scores[position]
          and summary.rank = p_ranks[position]
          and summary.model = 'deepseek'
      ) = 1;
    else
      v_exact_summary_count := 0;
    end if;

    outcome := case
      when v_exact_summary_count = v_count then 'existing'
      else 'conflict'
    end;
    persisted_digest_date := v_persisted.digest_date;
    persisted_top5_item_ids := v_persisted.top5_item_ids;
    persisted_rendered_md := v_persisted.rendered_md;
    persisted_summary_count := v_summary_count;
    return next;
    return;
  end if;

  insert into public.digests(digest_date, top5_item_ids, rendered_md)
  values (p_digest_date, p_item_ids, p_rendered_md)
  returning * into strict v_persisted;

  delete from public.summaries as summary
  where summary.item_id = any(p_item_ids);

  insert into public.summaries(
    item_id,
    one_liner,
    summary_md,
    impact_md,
    score,
    rank,
    model
  )
  select
    p_item_ids[position],
    p_one_liners[position],
    p_summary_mds[position],
    p_impact_mds[position],
    p_scores[position],
    p_ranks[position],
    'deepseek'
  from pg_catalog.generate_subscripts(p_item_ids, 1) as position;
  get diagnostics v_summary_count = row_count;

  if v_summary_count <> v_count then
    raise exception 'digest summary persistence mismatch' using errcode = 'P0001';
  end if;

  outcome := 'inserted';
  persisted_digest_date := v_persisted.digest_date;
  persisted_top5_item_ids := v_persisted.top5_item_ids;
  persisted_rendered_md := v_persisted.rendered_md;
  persisted_summary_count := v_summary_count;
  return next;
end;
$$;

alter function public.store_digest_bundle(
  date, uuid[], text[], text[], text[], integer[], integer[], text
) owner to postgres;
revoke all privileges on function public.store_digest_bundle(
  date, uuid[], text[], text[], text[], integer[], integer[], text
) from public, anon, authenticated, service_role;
grant execute on function public.store_digest_bundle(
  date, uuid[], text[], text[], text[], integer[], integer[], text
) to service_role;

comment on function public.store_digest_bundle(
  date, uuid[], text[], text[], text[], integer[], integer[], text
) is
  'Atomically stores exact Top-N summaries and an immutable digest snapshot; conflicting reruns do not mutate either relation.';

-- Return the complete latest bundle from one SQL statement and therefore one
-- MVCC snapshot. The envelope remains present when its joins are incomplete so
-- application validation can distinguish corruption from a genuinely empty DB.
create or replace function public.get_latest_digest_bundle()
returns table(
  digest_date date,
  top5_item_ids uuid[],
  papers jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with latest_digest as materialized (
    select digest.digest_date, digest.top5_item_ids
    from public.digests as digest
    order by digest.digest_date desc
    limit 1
  )
  select
    latest.digest_date,
    latest.top5_item_ids,
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', item.id,
            'item_id', summary.item_id,
            'source', item.source,
            'external_id', item.external_id,
            'url', item.url,
            'title', item.title,
            'authors', item.authors,
            'abstract', item.abstract,
            'published_at', item.published_at,
            'signals', item.signals,
            'one_liner', summary.one_liner,
            'summary_md', summary.summary_md,
            'impact_md', summary.impact_md,
            'score', summary.score,
            'rank', summary.rank,
            'rating', feedback.rating
          )
          order by selected.position, summary.rank, summary.id
        )
        from pg_catalog.unnest(latest.top5_item_ids)
          with ordinality as selected(item_id, position)
        join public.items as item on item.id = selected.item_id
        join public.summaries as summary on summary.item_id = selected.item_id
        left join public.feedback as feedback on feedback.item_id = selected.item_id
      ),
      '[]'::jsonb
    ) as papers
  from latest_digest as latest;
$$;

alter function public.get_latest_digest_bundle() owner to postgres;
revoke all privileges on function public.get_latest_digest_bundle()
  from public, anon, authenticated, service_role;
grant execute on function public.get_latest_digest_bundle() to service_role;

comment on function public.get_latest_digest_bundle() is
  'Returns the latest digest, exact summaries, items, and ratings in one statement snapshot; service-role only.';

-- Reads stay available to trusted server code, but all summary/snapshot writes
-- must cross the atomic RPC above. Delivery state will get a separate RPC when
-- the outbox work is implemented.
revoke insert, update, delete on table public.summaries, public.digests from service_role;
grant select on table public.summaries, public.digests to service_role;
