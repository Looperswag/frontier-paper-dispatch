-- Keep every attempt for audit, while allowing only one live and one completed
-- owner per date. A heartbeat-backed UUID is the fencing token for every
-- pipeline-owned digest and delivery side effect.
alter table public.pipeline_runs
  add column if not exists heartbeat_at timestamptz;

update public.pipeline_runs
set heartbeat_at = started_at
where heartbeat_at is null;

alter table public.pipeline_runs
  alter column heartbeat_at set default pg_catalog.clock_timestamp(),
  alter column heartbeat_at set not null;

alter table public.pipeline_runs
  drop constraint if exists pipeline_runs_run_date_key;

create unique index if not exists pipeline_runs_one_running_per_date_idx
  on public.pipeline_runs(run_date)
  where status = 'running';

create unique index if not exists pipeline_runs_one_succeeded_per_date_idx
  on public.pipeline_runs(run_date)
  where status = 'succeeded';

create index if not exists pipeline_runs_attempts_idx
  on public.pipeline_runs(run_date desc, started_at desc);

create or replace function public.start_pipeline_run(p_run_date date, p_run_id uuid)
returns table(acquired boolean, active_run_id uuid, run_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.pipeline_runs%rowtype;
begin
  if p_run_date is null or p_run_id is null then
    raise exception 'invalid pipeline run identity' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('frontier:pipeline-run:' || p_run_date::text, 0)
  );

  select attempt.* into v_existing
  from public.pipeline_runs as attempt
  where attempt.run_date = p_run_date and attempt.status = 'succeeded'
  order by attempt.finished_at desc nulls last, attempt.started_at desc, attempt.id
  limit 1
  for update;
  if found then
    acquired := false;
    active_run_id := v_existing.id;
    run_status := v_existing.status;
    return next;
    return;
  end if;

  select attempt.* into v_existing
  from public.pipeline_runs as attempt
  where attempt.run_date = p_run_date and attempt.status = 'running'
  limit 1
  for update;
  if found and v_existing.heartbeat_at > pg_catalog.clock_timestamp() - interval '6 hours' then
    acquired := false;
    active_run_id := v_existing.id;
    run_status := v_existing.status;
    return next;
    return;
  end if;

  if found then
    if p_run_id = v_existing.id then
      raise exception 'replacement pipeline run must use a new identity' using errcode = '22023';
    end if;
    update public.pipeline_runs
    set status = 'failed',
        error_message = 'lease_replaced_after_timeout',
        finished_at = pg_catalog.clock_timestamp()
    where id = v_existing.id and status = 'running';
  end if;

  insert into public.pipeline_runs(id, run_date, status, heartbeat_at)
  values (p_run_id, p_run_date, 'running', pg_catalog.clock_timestamp());

  acquired := true;
  active_run_id := p_run_id;
  run_status := 'running';
  return next;
end;
$$;

alter function public.start_pipeline_run(date, uuid) owner to postgres;
revoke all on function public.start_pipeline_run(date, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.start_pipeline_run(date, uuid) to service_role;

create or replace function public.heartbeat_pipeline_run(p_run_date date, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_run_date is null or p_run_id is null then
    raise exception 'invalid pipeline run identity' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('frontier:pipeline-run:' || p_run_date::text, 0)
  );
  update public.pipeline_runs
  set heartbeat_at = pg_catalog.clock_timestamp()
  where id = p_run_id and run_date = p_run_date and status = 'running';
  if not found then
    raise exception 'pipeline run is not active' using errcode = 'P0001';
  end if;
end;
$$;

alter function public.heartbeat_pipeline_run(date, uuid) owner to postgres;
revoke all on function public.heartbeat_pipeline_run(date, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.heartbeat_pipeline_run(date, uuid) to service_role;

-- Source observations also refresh the lease and must belong to the exact
-- currently-running attempt. Failed/replaced attempts remain queryable.
create or replace function public.record_source_run(
  p_run_id uuid,
  p_source text,
  p_status text,
  p_item_count integer,
  p_error_message text,
  p_started_at timestamptz,
  p_finished_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_run_id is null or p_source is null or p_status not in ('succeeded', 'failed', 'empty')
    or p_item_count is null or p_item_count not between 0 and 100000
    or p_started_at is null or p_finished_at is null or p_finished_at < p_started_at then
    raise exception 'invalid source run' using errcode = '22023';
  end if;

  update public.pipeline_runs
  set heartbeat_at = pg_catalog.clock_timestamp()
  where id = p_run_id and status = 'running';
  if not found then
    raise exception 'pipeline run is not active' using errcode = 'P0001';
  end if;

  insert into public.source_runs(
    run_id, source, status, item_count, error_message, started_at, finished_at
  ) values (
    p_run_id, p_source, p_status, p_item_count,
    pg_catalog.left(p_error_message, 2048), p_started_at, p_finished_at
  )
  on conflict (run_id, source) do update set
    status = excluded.status,
    item_count = excluded.item_count,
    error_message = excluded.error_message,
    started_at = excluded.started_at,
    finished_at = excluded.finished_at;
end;
$$;

alter function public.record_source_run(
  uuid, text, text, integer, text, timestamptz, timestamptz
) owner to postgres;
revoke all on function public.record_source_run(
  uuid, text, text, integer, text, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.record_source_run(
  uuid, text, text, integer, text, timestamptz, timestamptz
) to service_role;

-- The run-token check and every candidate write share one transaction. A
-- worker paused after an earlier heartbeat cannot resume into this upsert once
-- a replacement UUID owns the date.
create or replace function public.upsert_pipeline_items(
  p_run_id uuid,
  p_run_date date,
  p_items jsonb
)
returns table(id uuid, canonical_key text, source text, external_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry jsonb;
  v_persisted public.items%rowtype;
begin
  perform public.heartbeat_pipeline_run(p_run_date, p_run_id);

  if p_items is null
    or pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) not between 1 and 500
    or pg_catalog.octet_length(p_items::text) > 16777216 then
    raise exception 'invalid pipeline item batch' using errcode = '22023';
  end if;

  if (
    select pg_catalog.count(distinct entry.value ->> 'canonical_key')
      <> pg_catalog.jsonb_array_length(p_items)
    from pg_catalog.jsonb_array_elements(p_items) as entry(value)
  ) or (
    select pg_catalog.count(distinct public.source_identity_hash(
      entry.value ->> 'source', entry.value ->> 'external_id'
    )) <> pg_catalog.jsonb_array_length(p_items)
    from pg_catalog.jsonb_array_elements(p_items) as entry(value)
  ) then
    raise exception 'invalid pipeline item batch' using errcode = '22023';
  end if;

  for v_entry in
    select entry.value
    from pg_catalog.jsonb_array_elements(p_items) with ordinality as entry(value, position)
    order by entry.position
  loop
    if pg_catalog.jsonb_typeof(v_entry) <> 'object'
      or not (v_entry ?& array[
        'canonical_key', 'source', 'external_id', 'url', 'title', 'authors',
        'abstract', 'content', 'published_at', 'signals', 'provenance', 'raw_json'
      ]) then
      raise exception 'invalid pipeline item batch' using errcode = '22023';
    end if;

    if pg_catalog.jsonb_typeof(v_entry -> 'canonical_key') <> 'string'
      or pg_catalog.octet_length(v_entry ->> 'canonical_key') not between 3 and 512
      or pg_catalog.jsonb_typeof(v_entry -> 'source') <> 'string'
      or pg_catalog.octet_length(v_entry ->> 'source') not between 1 and 64
      or pg_catalog.jsonb_typeof(v_entry -> 'external_id') <> 'string'
      or pg_catalog.octet_length(v_entry ->> 'external_id') not between 1 and 512
      or pg_catalog.jsonb_typeof(v_entry -> 'url') <> 'string'
      or pg_catalog.octet_length(v_entry ->> 'url') not between 1 and 2048
      or (v_entry ->> 'url') !~ '^https://'
      or pg_catalog.jsonb_typeof(v_entry -> 'title') <> 'string'
      or pg_catalog.octet_length(v_entry ->> 'title') not between 1 and 16384
      or pg_catalog.jsonb_typeof(v_entry -> 'abstract') <> 'string'
      or pg_catalog.octet_length(v_entry ->> 'abstract') > 1048576
      or pg_catalog.jsonb_typeof(v_entry -> 'published_at') <> 'string'
      or pg_catalog.octet_length(v_entry ->> 'published_at') not between 1 and 64
      or pg_catalog.jsonb_typeof(v_entry -> 'authors') <> 'array'
      or pg_catalog.jsonb_array_length(v_entry -> 'authors') > 100
      or pg_catalog.jsonb_typeof(v_entry -> 'signals') <> 'object'
      or pg_catalog.octet_length((v_entry -> 'signals')::text) > 32768
      or not public.valid_item_provenance(v_entry -> 'provenance')
      or pg_catalog.jsonb_typeof(v_entry -> 'content') not in ('string', 'null')
      or (
        pg_catalog.jsonb_typeof(v_entry -> 'content') = 'string'
        and pg_catalog.octet_length(v_entry ->> 'content') > 1048576
      ) then
      raise exception 'invalid pipeline item batch' using errcode = '22023';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_entry -> 'authors') as author(value)
      where pg_catalog.jsonb_typeof(author.value) <> 'string'
        or pg_catalog.octet_length(author.value #>> '{}') > 1024
    ) then
      raise exception 'invalid pipeline item batch' using errcode = '22023';
    end if;

    insert into public.items(
      canonical_key, source, external_id, url, title, authors, abstract,
      content, published_at, signals, provenance, raw_json
    ) values (
      v_entry ->> 'canonical_key',
      v_entry ->> 'source',
      v_entry ->> 'external_id',
      v_entry ->> 'url',
      v_entry ->> 'title',
      array(
        select author.value
        from pg_catalog.jsonb_array_elements_text(v_entry -> 'authors')
          with ordinality as author(value, position)
        order by author.position
      ),
      v_entry ->> 'abstract',
      case when pg_catalog.jsonb_typeof(v_entry -> 'content') = 'null'
        then null else v_entry ->> 'content' end,
      v_entry ->> 'published_at',
      v_entry -> 'signals',
      v_entry -> 'provenance',
      case when pg_catalog.jsonb_typeof(v_entry -> 'raw_json') = 'null'
        then null else v_entry -> 'raw_json' end
    )
    on conflict on constraint items_canonical_key_key do update set
      source = excluded.source,
      external_id = excluded.external_id,
      url = excluded.url,
      title = excluded.title,
      authors = excluded.authors,
      abstract = excluded.abstract,
      content = excluded.content,
      published_at = excluded.published_at,
      signals = excluded.signals,
      provenance = excluded.provenance,
      raw_json = excluded.raw_json
    returning public.items.* into strict v_persisted;

    id := v_persisted.id;
    canonical_key := v_persisted.canonical_key;
    source := v_persisted.source;
    external_id := v_persisted.external_id;
    return next;
  end loop;
end;
$$;

alter function public.upsert_pipeline_items(uuid, date, jsonb) owner to postgres;
revoke all on function public.upsert_pipeline_items(uuid, date, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_pipeline_items(uuid, date, jsonb)
  to service_role;

create or replace function public.store_pipeline_digest_bundle(
  p_run_id uuid,
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
begin
  perform public.heartbeat_pipeline_run(p_digest_date, p_run_id);
  return query
  select bundle.*
  from public.store_digest_bundle(
    p_digest_date, p_item_ids, p_one_liners, p_summary_mds, p_impact_mds,
    p_scores, p_ranks, p_rendered_md
  ) as bundle;
end;
$$;

alter function public.store_pipeline_digest_bundle(
  uuid, date, uuid[], text[], text[], text[], integer[], integer[], text
) owner to postgres;
revoke all on function public.store_pipeline_digest_bundle(
  uuid, date, uuid[], text[], text[], text[], integer[], integer[], text
) from public, anon, authenticated, service_role;
grant execute on function public.store_pipeline_digest_bundle(
  uuid, date, uuid[], text[], text[], text[], integer[], integer[], text
) to service_role;

create or replace function public.enqueue_pipeline_delivery(
  p_run_id uuid,
  p_digest_date date,
  p_channel text,
  p_provider_id text,
  p_idempotency_key text,
  p_payload jsonb
)
returns table(delivery_id uuid, delivery_status text, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.heartbeat_pipeline_run(p_digest_date, p_run_id);
  return query
  select delivery.*
  from public.enqueue_delivery(
    p_digest_date, p_channel, p_provider_id, p_idempotency_key, p_payload
  ) as delivery;
end;
$$;

alter function public.enqueue_pipeline_delivery(
  uuid, date, text, text, text, jsonb
) owner to postgres;
revoke all on function public.enqueue_pipeline_delivery(
  uuid, date, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_pipeline_delivery(
  uuid, date, text, text, text, jsonb
) to service_role;

comment on column public.pipeline_runs.heartbeat_at is
  'Last database-verified activity for stale-run takeover decisions.';
comment on function public.heartbeat_pipeline_run(date, uuid) is
  'Refreshes an exact active pipeline fencing token or fails closed.';
comment on function public.upsert_pipeline_items(uuid, date, jsonb) is
  'Atomically verifies a pipeline fencing token and upserts its bounded candidate batch.';
comment on function public.store_pipeline_digest_bundle(
  uuid, date, uuid[], text[], text[], text[], integer[], integer[], text
) is 'Stores a digest only while the exact pipeline fencing token is active.';
comment on function public.enqueue_pipeline_delivery(
  uuid, date, text, text, text, jsonb
) is 'Enqueues delivery only while the exact pipeline fencing token is active.';
