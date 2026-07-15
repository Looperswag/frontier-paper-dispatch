begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(15);

select has_table('public', 'summary_versions', 'summary version cache exists');
select has_function(
  'public', 'get_summary_version', array['uuid', 'text', 'text', 'text'],
  'summary cache read RPC has the exact signature'
);
select has_function(
  'public', 'store_summary_version', array['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
  'summary cache write RPC has the exact signature'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.summary_versions'::regclass),
  'summary version cache enables and forces RLS'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.summary_versions'::regclass
      and confrelid = 'public.items'::regclass
      and contype = 'f'
  ),
  'summary versions are backed by an item foreign key'
);

with rpc(signature) as (
  values
    ('public.get_summary_version(uuid,text,text,text)'),
    ('public.store_summary_version(uuid,text,text,text,text,text,text,text)')
)
select ok(
  not has_function_privilege('anon', rpc.signature, 'EXECUTE')
    and not has_function_privilege('authenticated', rpc.signature, 'EXECUTE')
    and has_function_privilege('service_role', rpc.signature, 'EXECUTE'),
  format('%s is service-role only', rpc.signature)
)
from rpc;

with rpc(signature) as (
  values
    ('public.get_summary_version(uuid,text,text,text)'::regprocedure),
    ('public.store_summary_version(uuid,text,text,text,text,text,text,text)'::regprocedure)
)
select ok(
  (select prosecdef from pg_catalog.pg_proc where oid = rpc.signature)
    and (select pg_get_userbyid(proowner) from pg_catalog.pg_proc where oid = rpc.signature) = 'postgres'
    and (select proconfig from pg_catalog.pg_proc where oid = rpc.signature) = array['search_path=""']::text[],
  format('%s is a postgres-owned empty-search-path definer RPC', rpc.signature)
)
from rpc;

set local role service_role;

select results_eq(
  $$ select stored from public.store_summary_version(
    '11111111-1111-4111-8111-111111111111',
    repeat('a', 64), repeat('b', 64), 'summary-v1',
    'One line', 'Summary body', 'Impact body', 'deepseek'
  ) $$,
  $$ values (true) $$,
  'first summary version is stored'
);
select results_eq(
  $$ select one_liner, summary_md, impact_md, model
     from public.get_summary_version(
       '11111111-1111-4111-8111-111111111111', repeat('a', 64), repeat('b', 64), 'summary-v1'
     ) $$,
  $$ values ('One line'::text, 'Summary body'::text, 'Impact body'::text, 'deepseek'::text) $$,
  'summary version lookup returns the exact cached output'
);
select results_eq(
  $$ select stored from public.store_summary_version(
    '11111111-1111-4111-8111-111111111111',
    repeat('a', 64), repeat('b', 64), 'summary-v1',
    'One line', 'Summary body', 'Impact body', 'deepseek'
  ) $$,
  $$ values (false) $$,
  'same content/profile/prompt version is idempotent'
);
select throws_ok(
  $test$select public.store_summary_version(
    '11111111-1111-4111-8111-111111111111', 'bad', repeat('b', 64), 'summary-v1',
    'One line', 'Summary body', 'Impact body', 'deepseek'
  )$test$,
  '22023', 'invalid summary version',
  'invalid content hash is rejected'
);
select throws_ok(
  $test$select public.store_summary_version(
    '11111111-1111-4111-8111-111111111111', repeat('a', 64), repeat('b', 64), 'summary-v1',
    '', 'Summary body', 'Impact body', 'deepseek'
  )$test$,
  '22023', 'invalid summary version',
  'empty summary output is rejected'
);
select throws_ok(
  $test$select public.store_summary_version(
    '99999999-9999-4999-8999-999999999999', repeat('a', 64), repeat('b', 64), 'summary-v1',
    'One line', 'Summary body', 'Impact body', 'deepseek'
  )$test$,
  '23503', 'summary item does not exist',
  'unknown item cannot receive a cached version'
);

set local role postgres;
delete from public.summary_versions where item_id = '11111111-1111-4111-8111-111111111111';
select * from finish();
rollback;
