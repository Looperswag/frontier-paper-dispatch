-- Keep the exact summary shown for every digest. The existing summaries table
-- is a latest-item projection; this relation is the historical source of truth.
create table if not exists public.digest_items (
  digest_id   uuid not null references public.digests(id) on delete cascade,
  item_id     uuid not null references public.items(id) on delete restrict,
  rank        integer not null check (rank between 1 and 5),
  score       integer not null check (score between 0 and 100),
  one_liner   text not null check (octet_length(one_liner) between 1 and 16384),
  summary_md  text not null check (octet_length(summary_md) between 1 and 1048576),
  impact_md   text not null check (octet_length(impact_md) between 1 and 1048576),
  model       text not null check (octet_length(model) between 1 and 128),
  created_at  timestamptz not null default now(),
  primary key (digest_id, item_id),
  unique (digest_id, rank)
);

alter table public.digest_items enable row level security;
alter table public.digest_items force row level security;
revoke all on table public.digest_items from anon, authenticated, service_role;

-- The trigger is deliberately postgres-owned and not executable by API roles.
-- It only fills a missing historical row, so reruns are idempotent and an
-- existing digest snapshot can never be rewritten.
create or replace function public.capture_digest_item_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.digest_items(
    digest_id, item_id, rank, score, one_liner, summary_md, impact_md, model
  )
  select digest.id, new.item_id, selected.position::integer, new.score,
         new.one_liner, new.summary_md, new.impact_md, new.model
  from public.digests as digest
  cross join lateral pg_catalog.unnest(digest.top5_item_ids)
    with ordinality as selected(item_id, position)
  where selected.item_id = new.item_id
    and not exists (
      select 1 from public.digest_items as existing
      where existing.digest_id = digest.id and existing.item_id = new.item_id
    )
  on conflict do nothing;
  return new;
end;
$$;

alter function public.capture_digest_item_history() owner to postgres;
revoke all on function public.capture_digest_item_history() from public, anon, authenticated, service_role;
drop trigger if exists capture_digest_item_history on public.summaries;
create trigger capture_digest_item_history
after insert on public.summaries
for each row execute function public.capture_digest_item_history();

-- Seed/upgrade existing snapshots where the latest projection already has a
-- matching summary. New bundle writes are captured by the same trigger.
insert into public.digest_items(
  digest_id, item_id, rank, score, one_liner, summary_md, impact_md, model
)
select digest.id, selected.item_id, selected.position::integer,
       summary.score, summary.one_liner, summary.summary_md,
       summary.impact_md, summary.model
from public.digests as digest
cross join lateral pg_catalog.unnest(digest.top5_item_ids)
  with ordinality as selected(item_id, position)
join public.summaries as summary on summary.item_id = selected.item_id
on conflict (digest_id, item_id) do nothing;
