begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

create temporary table private_tables on commit drop as
select c.relname::text as name
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and c.relpersistence = 'p';

select plan(((select count(*) from private_tables) * 4 + 16)::integer);

create sequence public.permission_probe;
create table public.permission_probe_table(id bigint);
create function public.permission_probe_function()
returns integer
language sql
as $$ select 1 $$;

select ok(
  coalesce(c.relrowsecurity, false),
  format('public.%I has row-level security enabled', private_tables.name)
)
from private_tables
left join pg_catalog.pg_class c
  on c.oid = format('public.%I', private_tables.name)::regclass;

select ok(
  not exists (
    select 1
    from unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ]) privilege
    where has_table_privilege('anon', format('public.%I', name), privilege)
  ),
  format('anon has no CRUD privileges on public.%I', name)
)
from private_tables;

select ok(
  not exists (
    select 1
    from unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ]) privilege
    where has_table_privilege('authenticated', format('public.%I', name), privilege)
  ),
  format('authenticated has no direct CRUD privileges on public.%I', name)
)
from private_tables;

select ok(
  case
    when name in (
      'api_rate_limit_buckets',
      'feedback_token_redemptions',
      'llm_budget_days',
      'llm_budget_reservations',
      'delivery_outbox',
      'delivery_alerts',
      'summary_versions',
      'digest_items',
      'item_identity_aliases',
      'item_observations'
    ) then not exists (
      select 1
      from unnest(array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE',
        'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
      ]) privilege
      where has_table_privilege('service_role', format('public.%I', name), privilege)
    )
    when name in ('summaries', 'digests') then
      has_table_privilege('service_role', format('public.%I', name), 'SELECT')
      and not exists (
        select 1
        from unnest(array[
          'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
          'REFERENCES', 'TRIGGER', 'MAINTAIN'
        ]) privilege
        where has_table_privilege('service_role', format('public.%I', name), privilege)
      )
    else not exists (
      select 1
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege
      where not has_table_privilege('service_role', format('public.%I', name), privilege)
    ) and not exists (
      select 1
      from unnest(array['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) privilege
      where has_table_privilege('service_role', format('public.%I', name), privilege)
    )
  end,
  format('service_role has least privilege on public.%I', name)
)
from private_tables;

select ok(
  not exists (
    select 1
    from unnest(array['USAGE', 'SELECT', 'UPDATE']) privilege
    where has_sequence_privilege('anon', 'public.permission_probe', privilege)
  ),
  'anon has no privileges on future sequences'
);
select ok(
  not exists (
    select 1
    from unnest(array['USAGE', 'SELECT', 'UPDATE']) privilege
    where has_sequence_privilege('authenticated', 'public.permission_probe', privilege)
  ),
  'authenticated has no privileges on future sequences'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ]) privilege
    where has_table_privilege('anon', 'public.permission_probe_table', privilege)
  ),
  'anon has no privileges on future tables'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ]) privilege
    where has_table_privilege('authenticated', 'public.permission_probe_table', privilege)
  ),
  'authenticated has no privileges on future tables'
);
select ok(
  not exists (
    select 1
    from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege
    where not has_table_privilege('service_role', 'public.permission_probe_table', privilege)
  ) and not exists (
    select 1
    from unnest(array['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) privilege
    where has_table_privilege('service_role', 'public.permission_probe_table', privilege)
  ),
  'service_role receives only CRUD on future tables'
);
select ok(
  has_sequence_privilege('service_role', 'public.permission_probe', 'USAGE')
    and has_sequence_privilege('service_role', 'public.permission_probe', 'SELECT')
    and not has_sequence_privilege('service_role', 'public.permission_probe', 'UPDATE'),
  'service_role receives only usage/select on future sequences'
);
select ok(
  has_schema_privilege('service_role', 'public', 'USAGE')
    and not has_schema_privilege('service_role', 'public', 'CREATE'),
  'service_role can use but cannot create in the public schema'
);
select ok(
  not has_schema_privilege('anon', 'public', 'CREATE')
    and not has_schema_privilege('authenticated', 'public', 'CREATE'),
  'anon and authenticated cannot create in the public schema'
);
select ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated', 'service_role']) role_name
    where has_function_privilege(
      role_name,
      'public.permission_probe_function()',
      'EXECUTE'
    )
  ),
  'future functions are not executable by API roles, including via PUBLIC'
);

select has_function(
  'public',
  'redeem_feedback_token',
  array['smallint', 'text', 'date', 'uuid', 'text', 'timestamp with time zone'],
  'feedback redemption RPC exists with the exact signature'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.redeem_feedback_token(smallint,text,date,uuid,text,timestamp with time zone)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.redeem_feedback_token(smallint,text,date,uuid,text,timestamp with time zone)',
    'EXECUTE'
  ),
  'untrusted API roles cannot execute feedback redemption'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.redeem_feedback_token(smallint,text,date,uuid,text,timestamp with time zone)',
    'EXECUTE'
  ),
  'service_role can execute feedback redemption'
);
select ok(
  (select prosecdef from pg_catalog.pg_proc where oid =
    'public.redeem_feedback_token(smallint,text,date,uuid,text,timestamp with time zone)'::regprocedure),
  'feedback redemption is security definer'
);
select is(
  (select pg_get_userbyid(proowner) from pg_catalog.pg_proc where oid =
    'public.redeem_feedback_token(smallint,text,date,uuid,text,timestamp with time zone)'::regprocedure),
  'postgres',
  'feedback redemption is owned by postgres'
);
select is(
  (select proconfig from pg_catalog.pg_proc where oid =
    'public.redeem_feedback_token(smallint,text,date,uuid,text,timestamp with time zone)'::regprocedure),
  array['search_path=""']::text[],
  'feedback redemption fixes an empty search path'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class
   where oid = 'public.feedback_token_redemptions'::regclass),
  'feedback redemption ledger enables and forces RLS'
);

select * from finish();
rollback;
