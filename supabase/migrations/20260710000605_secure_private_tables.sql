-- All application data is private and currently accessed only by trusted server code.
-- RLS remains enabled as a second boundary even though anon/authenticated receive no grants.
alter table public.items enable row level security;
alter table public.summaries enable row level security;
alter table public.digests enable row level security;
alter table public.annotations enable row level security;
alter table public.chats enable row level security;
alter table public.embeddings enable row level security;
alter table public.feedback enable row level security;

revoke all privileges on table
  public.items,
  public.summaries,
  public.digests,
  public.annotations,
  public.chats,
  public.embeddings,
  public.feedback
from public, anon, authenticated, service_role;

grant select, insert, update, delete on table
  public.items,
  public.summaries,
  public.digests,
  public.annotations,
  public.chats,
  public.embeddings,
  public.feedback
to service_role;

revoke create on schema public from public, anon, authenticated, service_role;
grant usage on schema public to service_role;

revoke all privileges on all sequences in schema public
  from public, anon, authenticated, service_role;
grant usage, select on all sequences in schema public to service_role;

-- Preserve the same least-privilege posture for future tables created by migrations.
alter default privileges for role postgres in schema public
  revoke all privileges on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges for role postgres in schema public
  revoke all privileges on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to service_role;
-- Function EXECUTE is granted to PUBLIC by PostgreSQL's global default. A
-- schema-scoped REVOKE cannot subtract that global grant, so this one must be
-- global for functions created by the migration owner.
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;
