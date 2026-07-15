-- One durable run ledger prevents concurrent/date-conflicting jobs from
-- silently overwriting a good digest and records source health per run.
create table if not exists public.pipeline_runs (
  id               uuid primary key,
  run_date         date not null unique,
  status           text not null check (status in ('running', 'succeeded', 'degraded', 'failed', 'skipped')),
  candidate_count  integer not null default 0 check (candidate_count between 0 and 100000),
  source_count     integer not null default 0 check (source_count between 0 and 100),
  error_message    text check (error_message is null or octet_length(error_message) <= 2048),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create table if not exists public.source_runs (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.pipeline_runs(id) on delete cascade,
  source         text not null check (octet_length(source) between 1 and 64),
  status         text not null check (status in ('succeeded', 'failed', 'empty')),
  item_count     integer not null default 0 check (item_count between 0 and 100000),
  error_message  text check (error_message is null or octet_length(error_message) <= 2048),
  started_at     timestamptz not null,
  finished_at    timestamptz not null,
  unique (run_id, source)
);

create index if not exists source_runs_run_idx on public.source_runs(run_id, source);
alter table public.pipeline_runs enable row level security;
alter table public.pipeline_runs force row level security;
alter table public.source_runs enable row level security;
alter table public.source_runs force row level security;
revoke all on table public.pipeline_runs, public.source_runs from anon, authenticated;
grant select, insert, update, delete on table public.pipeline_runs, public.source_runs to service_role;

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
  select * into v_existing from public.pipeline_runs where run_date = p_run_date for update;
  if found and v_existing.status = 'succeeded' then
    acquired := false; active_run_id := v_existing.id; run_status := v_existing.status; return next; return;
  end if;
  if found and v_existing.status = 'running'
    and v_existing.started_at > clock_timestamp() - interval '6 hours' then
    acquired := false; active_run_id := v_existing.id; run_status := v_existing.status; return next; return;
  end if;
  if found then
    update public.pipeline_runs
    set status = 'running', candidate_count = 0, source_count = 0,
        error_message = null, started_at = clock_timestamp(), finished_at = null
    where id = v_existing.id;
    delete from public.source_runs where run_id = v_existing.id;
    p_run_id := v_existing.id;
  else
    insert into public.pipeline_runs(id, run_date, status) values (p_run_id, p_run_date, 'running');
  end if;
  acquired := true; active_run_id := p_run_id; run_status := 'running'; return next;
end;
$$;

alter function public.start_pipeline_run(date, uuid) owner to postgres;
revoke all on function public.start_pipeline_run(date, uuid) from public, anon, authenticated, service_role;
grant execute on function public.start_pipeline_run(date, uuid) to service_role;

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
    or p_started_at is null or p_finished_at is null then
    raise exception 'invalid source run' using errcode = '22023';
  end if;
  insert into public.source_runs(run_id, source, status, item_count, error_message, started_at, finished_at)
  values (p_run_id, p_source, p_status, p_item_count, left(p_error_message, 2048), p_started_at, p_finished_at)
  on conflict (run_id, source) do update set
    status = excluded.status, item_count = excluded.item_count,
    error_message = excluded.error_message, started_at = excluded.started_at,
    finished_at = excluded.finished_at;
end;
$$;

alter function public.record_source_run(uuid, text, text, integer, text, timestamptz, timestamptz) owner to postgres;
revoke all on function public.record_source_run(uuid, text, text, integer, text, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.record_source_run(uuid, text, text, integer, text, timestamptz, timestamptz) to service_role;

create or replace function public.finish_pipeline_run(
  p_run_id uuid,
  p_status text,
  p_candidate_count integer,
  p_source_count integer,
  p_error_message text default null
)
returns table(run_id uuid, run_status text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_run_id is null or p_status not in ('succeeded', 'degraded', 'failed', 'skipped')
    or p_candidate_count is null or p_candidate_count not between 0 and 100000
    or p_source_count is null or p_source_count not between 0 and 100 then
    raise exception 'invalid pipeline completion' using errcode = '22023';
  end if;
  update public.pipeline_runs
  set status = p_status, candidate_count = p_candidate_count, source_count = p_source_count,
      error_message = left(p_error_message, 2048), finished_at = clock_timestamp()
  where id = p_run_id and status = 'running';
  if not found then raise exception 'pipeline run is not active' using errcode = 'P0001'; end if;
  run_id := p_run_id; run_status := p_status; return next;
end;
$$;

alter function public.finish_pipeline_run(uuid, text, integer, integer, text) owner to postgres;
revoke all on function public.finish_pipeline_run(uuid, text, integer, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_pipeline_run(uuid, text, integer, integer, text) to service_role;
