begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(60);

select has_function(
  'public',
  'store_digest_snapshot',
  array['date', 'uuid[]', 'text'],
  'immutable digest snapshot RPC exists'
);
select ok(
  (select prosecdef from pg_catalog.pg_proc
   where oid = 'public.store_digest_snapshot(date,uuid[],text)'::regprocedure),
  'snapshot RPC is security definer'
);
select is(
  (select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
   where oid = 'public.store_digest_snapshot(date,uuid[],text)'::regprocedure),
  'postgres',
  'snapshot RPC is owned by postgres'
);
select is(
  (select proconfig from pg_catalog.pg_proc
   where oid = 'public.store_digest_snapshot(date,uuid[],text)'::regprocedure),
  array['search_path=""']::text[],
  'snapshot RPC fixes an empty search path'
);
select ok(
  not pg_catalog.has_function_privilege(
    'anon', 'public.store_digest_snapshot(date,uuid[],text)', 'EXECUTE'
  ),
  'anon cannot store snapshots'
);
select ok(
  not pg_catalog.has_function_privilege(
    'authenticated', 'public.store_digest_snapshot(date,uuid[],text)', 'EXECUTE'
  ),
  'authenticated cannot store snapshots'
);
select ok(
  not pg_catalog.has_function_privilege(
    'service_role', 'public.store_digest_snapshot(date,uuid[],text)', 'EXECUTE'
  ),
  'service role cannot bypass atomic summary and snapshot persistence'
);
select has_function(
  'public',
  'store_digest_bundle',
  array['date', 'uuid[]', 'text[]', 'text[]', 'text[]', 'integer[]', 'integer[]', 'text'],
  'atomic digest bundle RPC exists'
);
select ok(
  (select prosecdef from pg_catalog.pg_proc
   where oid = 'public.store_digest_bundle(date,uuid[],text[],text[],text[],integer[],integer[],text)'::regprocedure),
  'bundle RPC is security definer'
);
select is(
  (select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
   where oid = 'public.store_digest_bundle(date,uuid[],text[],text[],text[],integer[],integer[],text)'::regprocedure),
  'postgres',
  'bundle RPC is owned by postgres'
);
select is(
  (select proconfig from pg_catalog.pg_proc
   where oid = 'public.store_digest_bundle(date,uuid[],text[],text[],text[],integer[],integer[],text)'::regprocedure),
  array['search_path=""']::text[],
  'bundle RPC fixes an empty search path'
);
select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.store_digest_bundle(date,uuid[],text[],text[],text[],integer[],integer[],text)',
    'EXECUTE'
  ),
  'anon cannot store digest bundles'
);
select ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.store_digest_bundle(date,uuid[],text[],text[],text[],integer[],integer[],text)',
    'EXECUTE'
  ),
  'authenticated cannot store digest bundles'
);
select ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.store_digest_bundle(date,uuid[],text[],text[],text[],integer[],integer[],text)',
    'EXECUTE'
  ),
  'service role can store digest bundles'
);
select has_trigger(
  'public', 'digests', 'prevent_digest_snapshot_mutation',
  'digest immutability trigger exists'
);

insert into public.items(id, source, external_id, title)
values
  ('88888888-8888-4888-8888-888888888881', 'digest-test', 'one', 'One'),
  ('88888888-8888-4888-8888-888888888882', 'digest-test', 'two', 'Two');

select results_eq(
  $test$select outcome from public.store_digest_snapshot(
    '2099-03-01',
    array['88888888-8888-4888-8888-888888888881'::uuid],
    '# first immutable snapshot'
  )$test$,
  $expected$values ('inserted'::text)$expected$,
  'first call inserts the snapshot'
);
select is(
  (select rendered_md from public.digests where digest_date = '2099-03-01'),
  '# first immutable snapshot',
  'inserted snapshot is persisted exactly'
);
select results_eq(
  $test$select outcome from public.store_digest_snapshot(
    '2099-03-01',
    array['88888888-8888-4888-8888-888888888881'::uuid],
    '# first immutable snapshot'
  )$test$,
  $expected$values ('existing'::text)$expected$,
  'an identical rerun reuses the snapshot'
);
select results_eq(
  $test$select outcome from public.store_digest_snapshot(
    '2099-03-01',
    array['88888888-8888-4888-8888-888888888882'::uuid],
    '# conflicting snapshot'
  )$test$,
  $expected$values ('conflict'::text)$expected$,
  'a different same-day rerun reports conflict'
);
select is(
  (select top5_item_ids from public.digests where digest_date = '2099-03-01'),
  array['88888888-8888-4888-8888-888888888881'::uuid],
  'a conflict leaves the first item mapping unchanged'
);
select throws_ok(
  $test$update public.digests
    set rendered_md = '# overwritten'
    where digest_date = '2099-03-01'$test$,
  '23514', 'digest snapshot is immutable',
  'direct snapshot mutation is rejected'
);
select throws_ok(
  $test$select public.store_digest_snapshot('2099-03-02', '{}'::uuid[], '# empty')$test$,
  '22023', 'invalid digest snapshot',
  'empty item arrays are rejected'
);
select throws_ok(
  $test$select public.store_digest_snapshot(
    '2099-03-02',
    array[
      '88888888-8888-4888-8888-888888888881'::uuid,
      '88888888-8888-4888-8888-888888888881'::uuid
    ],
    '# duplicate'
  )$test$,
  '22023', 'invalid digest snapshot',
  'duplicate item ids are rejected'
);
select throws_ok(
  $test$select public.store_digest_snapshot(
    '2099-03-02',
    array['88888888-8888-4888-8888-888888888889'::uuid],
    '# missing item'
  )$test$,
  '23503', 'digest item does not exist',
  'missing items are rejected'
);
select throws_ok(
  $test$select public.store_digest_snapshot(
    '2099-03-02',
    array['88888888-8888-4888-8888-888888888881'::uuid],
    ''
  )$test$,
  '22023', 'invalid digest snapshot',
  'empty markdown is rejected'
);
select throws_ok(
  $test$select public.store_digest_snapshot(
    '2099-03-02',
    array['88888888-8888-4888-8888-888888888881'::uuid, null::uuid],
    '# null item'
  )$test$,
  '22023', 'invalid digest snapshot',
  'null item ids are rejected'
);
select throws_ok(
  $test$select public.store_digest_snapshot(
    '2099-03-02',
    array[
      '88888888-8888-4888-8888-888888888881'::uuid,
      '88888888-8888-4888-8888-888888888882'::uuid,
      '88888888-8888-4888-8888-888888888883'::uuid,
      '88888888-8888-4888-8888-888888888884'::uuid,
      '88888888-8888-4888-8888-888888888885'::uuid,
      '88888888-8888-4888-8888-888888888886'::uuid
    ],
    '# too many'
  )$test$,
  '22023', 'invalid digest snapshot',
  'more than five item ids are rejected before item lookup'
);
select throws_ok(
  $test$select public.store_digest_snapshot(
    '2099-03-02',
    array[
      array['88888888-8888-4888-8888-888888888881'::uuid],
      array['88888888-8888-4888-8888-888888888882'::uuid]
    ],
    '# multidimensional'
  )$test$,
  '22023', 'invalid digest snapshot',
  'multidimensional item arrays are rejected'
);
select lives_ok(
  $test$update public.digests
    set emailed_at = clock_timestamp()
    where digest_date = '2099-03-01'$test$,
  'delivery metadata can still be updated'
);

select results_eq(
  $test$select outcome, persisted_summary_count from public.store_digest_bundle(
    '2099-03-03',
    array[
      '88888888-8888-4888-8888-888888888881'::uuid,
      '88888888-8888-4888-8888-888888888882'::uuid
    ],
    array['atomic one', 'atomic two'],
    array['summary one', 'summary two'],
    array['impact one', 'impact two'],
    array[99, 98],
    array[1, 2],
    '# atomic bundle'
  )$test$,
  $expected$values ('inserted'::text, 2::integer)$expected$,
  'first bundle call inserts summaries and snapshot together'
);
select results_eq(
  $test$select item_id, one_liner, rank from public.summaries
    where item_id in (
      '88888888-8888-4888-8888-888888888881',
      '88888888-8888-4888-8888-888888888882'
    ) order by rank$test$,
  $expected$values
    ('88888888-8888-4888-8888-888888888881'::uuid, 'atomic one'::text, 1::integer),
    ('88888888-8888-4888-8888-888888888882'::uuid, 'atomic two'::text, 2::integer)
  $expected$,
  'bundle summaries are persisted exactly once and in rank order'
);
select throws_ok(
  $test$select * from public.store_digest_bundle(
    '2099-03-02',
    array['88888888-8888-4888-8888-888888888881'::uuid],
    array['stale one'],
    array['stale summary'],
    array['stale impact'],
    array[96],
    array[1],
    '# stale bundle'
  )$test$,
  '23514', 'digest date is older than latest snapshot',
  'a late older-date bundle is rejected'
);
select is(
  (select count(*)::integer from public.digests where digest_date = '2099-03-02'),
  0,
  'a rejected stale bundle creates no historical snapshot'
);
select is(
  (select one_liner from public.summaries
   where item_id = '88888888-8888-4888-8888-888888888881'),
  'atomic one',
  'a rejected stale bundle cannot overwrite the latest summary'
);

select has_function(
  'public',
  'get_latest_digest_bundle',
  array[]::text[],
  'atomic latest-bundle read RPC exists'
);
select ok(
  (select prosecdef from pg_catalog.pg_proc
   where oid = 'public.get_latest_digest_bundle()'::regprocedure),
  'latest-bundle read RPC is security definer'
);
select is(
  (select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
   where oid = 'public.get_latest_digest_bundle()'::regprocedure),
  'postgres',
  'latest-bundle read RPC is owned by postgres'
);
select is(
  (select proconfig from pg_catalog.pg_proc
   where oid = 'public.get_latest_digest_bundle()'::regprocedure),
  array['search_path=""']::text[],
  'latest-bundle read RPC fixes an empty search path'
);
select is(
  (select provolatile from pg_catalog.pg_proc
   where oid = 'public.get_latest_digest_bundle()'::regprocedure),
  's'::"char",
  'latest-bundle read RPC is declared stable'
);
select ok(
  not pg_catalog.has_function_privilege(
    'anon', 'public.get_latest_digest_bundle()', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'authenticated', 'public.get_latest_digest_bundle()', 'EXECUTE'
  ),
  'untrusted API roles cannot read the private latest bundle'
);
select ok(
  pg_catalog.has_function_privilege(
    'service_role', 'public.get_latest_digest_bundle()', 'EXECUTE'
  ),
  'service role can read the latest bundle'
);
create temporary table latest_bundle_service_role_probe(row_count integer not null);
grant insert on latest_bundle_service_role_probe to service_role;
set local role service_role;
insert into latest_bundle_service_role_probe(row_count)
select pg_catalog.count(*)::integer
from public.get_latest_digest_bundle();
reset role;
select is(
  (select row_count from latest_bundle_service_role_probe),
  1,
  'service role actually invokes the latest-bundle read RPC'
);
select results_eq(
  $test$select digest_date, top5_item_ids, pg_catalog.jsonb_array_length(papers)
    from public.get_latest_digest_bundle()$test$,
  $expected$values (
    '2099-03-03'::date,
    array[
      '88888888-8888-4888-8888-888888888881'::uuid,
      '88888888-8888-4888-8888-888888888882'::uuid
    ],
    2::integer
  )$expected$,
  'latest-bundle read returns one complete digest envelope'
);
select results_eq(
  $test$select paper ->> 'id', (paper ->> 'rank')::integer
    from public.get_latest_digest_bundle() as bundle
    cross join lateral pg_catalog.jsonb_array_elements(bundle.papers) as paper$test$,
  $expected$values
    ('88888888-8888-4888-8888-888888888881'::text, 1::integer),
    ('88888888-8888-4888-8888-888888888882'::text, 2::integer)
  $expected$,
  'latest-bundle read preserves digest order and exact summary ranks'
);
select results_eq(
  $test$select outcome from public.store_digest_bundle(
    '2099-03-03',
    array[
      '88888888-8888-4888-8888-888888888881'::uuid,
      '88888888-8888-4888-8888-888888888882'::uuid
    ],
    array['atomic one', 'atomic two'],
    array['summary one', 'summary two'],
    array['impact one', 'impact two'],
    array[99, 98],
    array[1, 2],
    '# atomic bundle'
  )$test$,
  $expected$values ('existing'::text)$expected$,
  'an exact bundle rerun is idempotent'
);
select results_eq(
  $test$select outcome from public.store_digest_bundle(
    '2099-03-03',
    array['88888888-8888-4888-8888-888888888882'::uuid],
    array['conflicting'],
    array['conflicting summary'],
    array['conflicting impact'],
    array[1],
    array[1],
    '# conflicting bundle'
  )$test$,
  $expected$values ('conflict'::text)$expected$,
  'a different same-day bundle reports conflict'
);
select is(
  (select rendered_md from public.digests where digest_date = '2099-03-03'),
  '# atomic bundle',
  'a bundle conflict leaves the immutable snapshot unchanged'
);
select results_eq(
  $test$select item_id, one_liner, rank from public.summaries
    where item_id in (
      '88888888-8888-4888-8888-888888888881',
      '88888888-8888-4888-8888-888888888882'
    ) order by rank$test$,
  $expected$values
    ('88888888-8888-4888-8888-888888888881'::uuid, 'atomic one'::text, 1::integer),
    ('88888888-8888-4888-8888-888888888882'::uuid, 'atomic two'::text, 2::integer)
  $expected$,
  'a bundle conflict leaves every prior summary unchanged'
);

delete from public.summaries
where item_id = '88888888-8888-4888-8888-888888888882';
insert into public.summaries(item_id, one_liner, summary_md, impact_md, score, rank, model)
values (
  '88888888-8888-4888-8888-888888888881',
  'atomic one', 'summary one', 'impact one', 99, 1, 'deepseek'
);
select results_eq(
  $test$select outcome from public.store_digest_bundle(
    '2099-03-03',
    array[
      '88888888-8888-4888-8888-888888888881'::uuid,
      '88888888-8888-4888-8888-888888888882'::uuid
    ],
    array['atomic one', 'atomic two'],
    array['summary one', 'summary two'],
    array['impact one', 'impact two'],
    array[99, 98],
    array[1, 2],
    '# atomic bundle'
  )$test$,
  $expected$values ('conflict'::text)$expected$,
  'a duplicate match for one item cannot hide another missing summary'
);
delete from public.summaries
where item_id in (
  '88888888-8888-4888-8888-888888888881',
  '88888888-8888-4888-8888-888888888882'
);
insert into public.summaries(item_id, one_liner, summary_md, impact_md, score, rank, model)
values
  ('88888888-8888-4888-8888-888888888881', 'atomic one', 'summary one', 'impact one', 99, 1, 'deepseek'),
  ('88888888-8888-4888-8888-888888888882', 'atomic two', 'summary two', 'impact two', 98, 2, 'deepseek');

select throws_ok(
  $test$select * from public.store_digest_bundle(
    '2099-03-06', array['88888888-8888-4888-8888-888888888881'::uuid],
    null::text[], array['summary'], array['impact'], array[99], array[1], '# null one liner'
  )$test$,
  '22023', 'invalid digest bundle',
  'null one-liner arrays are rejected explicitly'
);
select throws_ok(
  $test$select * from public.store_digest_bundle(
    '2099-03-06', array['88888888-8888-4888-8888-888888888881'::uuid],
    array['one'], null::text[], array['impact'], array[99], array[1], '# null summary'
  )$test$,
  '22023', 'invalid digest bundle',
  'null summary arrays are rejected explicitly'
);
select throws_ok(
  $test$select * from public.store_digest_bundle(
    '2099-03-06', array['88888888-8888-4888-8888-888888888881'::uuid],
    array['one'], array['summary'], null::text[], array[99], array[1], '# null impact'
  )$test$,
  '22023', 'invalid digest bundle',
  'null impact arrays are rejected explicitly'
);
select throws_ok(
  $test$select * from public.store_digest_bundle(
    '2099-03-06', array['88888888-8888-4888-8888-888888888881'::uuid],
    array['one'], array['summary'], array['impact'], null::integer[], array[1], '# null scores'
  )$test$,
  '22023', 'invalid digest bundle',
  'null score arrays are rejected explicitly'
);
select throws_ok(
  $test$select * from public.store_digest_bundle(
    '2099-03-06', array['88888888-8888-4888-8888-888888888881'::uuid],
    array['one'], array['summary'], array['impact'], array[99], null::integer[], '# null ranks'
  )$test$,
  '22023', 'invalid digest bundle',
  'null rank arrays are rejected explicitly'
);
select throws_ok(
  $test$select * from public.store_digest_bundle(
    '2099-03-06', array['88888888-8888-4888-8888-888888888881'::uuid],
    array['one'], array['summary'], array['impact'], array[101], array[1], '# invalid score'
  )$test$,
  '22023', 'invalid digest bundle',
  'scores outside the documented zero-to-one-hundred range are rejected'
);

create or replace function public.force_digest_summary_failure()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.one_liner = 'explode' then
    raise exception 'forced summary failure';
  end if;
  return new;
end;
$$;
create trigger force_digest_summary_failure
before insert on public.summaries
for each row execute function public.force_digest_summary_failure();

select throws_ok(
  $test$select * from public.store_digest_bundle(
    '2099-03-04',
    array['88888888-8888-4888-8888-888888888881'::uuid],
    array['explode'],
    array['must roll back'],
    array['must roll back'],
    array[97],
    array[1],
    '# must roll back'
  )$test$,
  'P0001', 'forced summary failure',
  'a summary write failure aborts the whole bundle transaction'
);
select is(
  (select count(*)::integer from public.digests where digest_date = '2099-03-04'),
  0,
  'a failed summary write rolls back the new digest snapshot'
);
select is(
  (select one_liner from public.summaries
   where item_id = '88888888-8888-4888-8888-888888888881'),
  'atomic one',
  'a failed summary write restores the prior summary'
);

drop trigger force_digest_summary_failure on public.summaries;
drop function public.force_digest_summary_failure();

select results_eq(
  $test$select outcome from public.store_digest_bundle(
    '2099-03-05',
    array['11111111-1111-4111-8111-111111111111'::uuid],
    array['newest one'],
    array['newest summary'],
    array['newest impact'],
    array[95],
    array[1],
    '# newest bundle'
  )$test$,
  $expected$values ('inserted'::text)$expected$,
  'a newer bundle can advance the latest snapshot'
);
select throws_ok(
  $test$select * from public.store_digest_bundle(
    '2099-03-03',
    array[
      '88888888-8888-4888-8888-888888888881'::uuid,
      '88888888-8888-4888-8888-888888888882'::uuid
    ],
    array['atomic one', 'atomic two'],
    array['summary one', 'summary two'],
    array['impact one', 'impact two'],
    array[99, 98],
    array[1, 2],
    '# atomic bundle'
  )$test$,
  '23514', 'digest date is older than latest snapshot',
  'an exact older bundle is rejected instead of triggering stale delivery'
);

select * from finish();
rollback;
