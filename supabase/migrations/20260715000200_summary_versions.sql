-- Immutable, versioned summary cache. The current summaries projection remains
-- the digest's atomic write target; this table only avoids repeated LLM work.
create table if not exists public.summary_versions (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references public.items(id) on delete cascade,
  content_hash   text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  profile_hash   text not null check (profile_hash ~ '^[0-9a-f]{64}$'),
  prompt_version text not null check (octet_length(prompt_version) between 1 and 64),
  one_liner      text not null check (octet_length(one_liner) between 1 and 240),
  summary_md     text not null check (octet_length(summary_md) between 1 and 16384),
  impact_md      text not null check (octet_length(impact_md) between 1 and 16384),
  model          text not null check (octet_length(model) between 1 and 100),
  created_at     timestamptz not null default now(),
  unique (item_id, content_hash, profile_hash, prompt_version)
);

create index if not exists summary_versions_lookup_idx
  on public.summary_versions(item_id, content_hash, profile_hash, prompt_version);

alter table public.summary_versions enable row level security;
alter table public.summary_versions force row level security;
revoke all on table public.summary_versions from anon, authenticated, service_role;

create or replace function public.get_summary_version(
  p_item_id uuid,
  p_content_hash text,
  p_profile_hash text,
  p_prompt_version text
)
returns table(
  one_liner text,
  summary_md text,
  impact_md text,
  model text
)
language sql
security definer
set search_path = ''
as $$
  select one_liner, summary_md, impact_md, model
  from public.summary_versions
  where item_id = p_item_id
    and content_hash = p_content_hash
    and profile_hash = p_profile_hash
    and prompt_version = p_prompt_version
  limit 1;
$$;

alter function public.get_summary_version(uuid, text, text, text) owner to postgres;
revoke all on function public.get_summary_version(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_summary_version(uuid, text, text, text) to service_role;

create or replace function public.store_summary_version(
  p_item_id uuid,
  p_content_hash text,
  p_profile_hash text,
  p_prompt_version text,
  p_one_liner text,
  p_summary_md text,
  p_impact_md text,
  p_model text
)
returns table(stored boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_item_id is null
    or p_content_hash is null
    or p_profile_hash is null
    or p_content_hash !~ '^[0-9a-f]{64}$'
    or p_profile_hash !~ '^[0-9a-f]{64}$'
    or p_prompt_version is null
    or pg_catalog.octet_length(p_prompt_version) not between 1 and 64
    or p_one_liner is null
    or pg_catalog.octet_length(p_one_liner) not between 1 and 240
    or p_summary_md is null
    or pg_catalog.octet_length(p_summary_md) not between 1 and 16384
    or p_impact_md is null
    or pg_catalog.octet_length(p_impact_md) not between 1 and 16384
    or p_model is null
    or pg_catalog.octet_length(p_model) not between 1 and 100 then
    raise exception 'invalid summary version' using errcode = '22023';
  end if;
  if not exists (select 1 from public.items where id = p_item_id) then
    raise exception 'summary item does not exist' using errcode = '23503';
  end if;
  insert into public.summary_versions(
    item_id, content_hash, profile_hash, prompt_version,
    one_liner, summary_md, impact_md, model
  ) values (
    p_item_id, p_content_hash, p_profile_hash, p_prompt_version,
    p_one_liner, p_summary_md, p_impact_md, p_model
  ) on conflict (item_id, content_hash, profile_hash, prompt_version) do nothing;
  stored := found;
  return next;
end;
$$;

alter function public.store_summary_version(uuid, text, text, text, text, text, text, text) owner to postgres;
revoke all on function public.store_summary_version(uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.store_summary_version(uuid, text, text, text, text, text, text, text) to service_role;

comment on table public.summary_versions is
  'Immutable server-only summaries keyed by item content, profile, and prompt version.';
