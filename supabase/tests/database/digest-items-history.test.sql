begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(11);

select has_table('public', 'digest_items', 'historical digest items exist');
select has_function('public', 'capture_digest_item_history', array[]::text[], 'summary history trigger function exists');
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.digest_items'::regclass),
  'historical digest items force RLS'
);
select ok(
  not has_table_privilege('service_role', 'public.digest_items', 'SELECT')
    and not has_table_privilege('anon', 'public.digest_items', 'SELECT')
    and not has_table_privilege('authenticated', 'public.digest_items', 'SELECT'),
  'historical rows are not directly readable by API roles'
);
select is(
  (select count(*) from public.digest_items where digest_id = '33333333-3333-4333-8333-333333333333'),
  1::bigint,
  'seed digest has a historical summary row'
);

set local role service_role;
select throws_ok(
  $$ insert into public.digest_items(digest_id, item_id, rank, score, one_liner, summary_md, impact_md, model)
     values ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 1, 1, 'x', 'y', 'z', 'test') $$,
  '42501', null,
  'service role cannot bypass history trigger'
);

select results_eq(
  $$ select outcome from public.store_digest_bundle(
    '2099-05-01', array['11111111-1111-4111-8111-111111111111'::uuid],
    array['历史一句话'], array['历史摘要'], array['历史影响'], array[88], array[1], '# history'
  ) $$,
  $$ values ('inserted'::text) $$,
  'bundle inserts a digest snapshot'
);
set local role postgres;
select results_eq(
  $$ select rank, score, one_liner, summary_md, impact_md, model
     from public.digest_items
     where digest_id = (select id from public.digests where digest_date = '2099-05-01') $$,
  $$ values (1, 88, '历史一句话'::text, '历史摘要'::text, '历史影响'::text, 'deepseek'::text) $$,
  'bundle preserves the exact historical summary'
);
select is(
  (select count(*) from public.digest_items where digest_id = (select id from public.digests where digest_date = '2099-05-01')),
  1::bigint,
  'history is one row per digest item'
);
select throws_ok(
  $$ select * from public.store_digest_bundle(
    '2099-05-02', array['11111111-1111-4111-8111-111111111111'::uuid],
    array[''], array['summary'], array['impact'], array[88], array[1], '# invalid'
  ) $$,
  '23514', 'new row for relation "digest_items" violates check constraint "digest_items_one_liner_check"',
  'empty one-liners are rejected by historical content constraints'
);
select is(
  (select count(*) from public.digest_items where digest_id = (select id from public.digests where digest_date = '2099-05-02')),
  0::bigint,
  'rejected bundle creates no history'
);

set local role postgres;
delete from public.digest_items where digest_id in (select id from public.digests where digest_date in ('2099-05-01', '2099-05-02'));
delete from public.digests where digest_date in ('2099-05-01', '2099-05-02');
select * from finish();
rollback;
