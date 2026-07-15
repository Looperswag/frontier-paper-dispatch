begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(60);

select has_table('public', 'pipeline_runs', 'pipeline run ledger exists');
select has_table('public', 'source_runs', 'source run ledger exists');
select has_column('public', 'pipeline_runs', 'heartbeat_at', 'pipeline attempts retain a heartbeat');
select ok(
  (select attnotnull
   from pg_catalog.pg_attribute
   where attrelid = 'public.pipeline_runs'::regclass and attname = 'heartbeat_at')
  and (
    select attrdef.adbin is not null
    from pg_catalog.pg_attribute as attribute
    join pg_catalog.pg_attrdef as attrdef
      on attrdef.adrelid = attribute.attrelid and attrdef.adnum = attribute.attnum
    where attribute.attrelid = 'public.pipeline_runs'::regclass
      and attribute.attname = 'heartbeat_at'
  ),
  'pipeline heartbeat is required and database-clock defaulted'
);

select has_function('public', 'start_pipeline_run', array['date', 'uuid'], 'start run RPC exists');
select has_function('public', 'heartbeat_pipeline_run', array['date', 'uuid'], 'heartbeat RPC exists');
select has_function(
  'public', 'record_source_run',
  array['uuid', 'text', 'text', 'integer', 'text', 'timestamp with time zone', 'timestamp with time zone'],
  'source run RPC exists'
);
select has_function(
  'public', 'finish_pipeline_run', array['uuid', 'text', 'integer', 'integer', 'text'],
  'finish run RPC exists'
);
select has_function(
  'public', 'upsert_pipeline_items', array['uuid', 'date', 'jsonb'],
  'pipeline-fenced item upsert RPC exists'
);
select has_function(
  'public', 'store_pipeline_digest_bundle',
  array['uuid', 'date', 'uuid[]', 'text[]', 'text[]', 'text[]', 'integer[]', 'integer[]', 'text'],
  'pipeline-fenced digest RPC exists'
);
select has_function(
  'public', 'enqueue_pipeline_delivery',
  array['uuid', 'date', 'text', 'text', 'text', 'jsonb'],
  'pipeline-fenced delivery RPC exists'
);

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class where oid = 'public.pipeline_runs'::regclass)
  and
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class where oid = 'public.source_runs'::regclass),
  'run ledgers force RLS'
);

with rpc(signature) as (
  values
    ('public.start_pipeline_run(date,uuid)'),
    ('public.heartbeat_pipeline_run(date,uuid)'),
    ('public.record_source_run(uuid,text,text,integer,text,timestamp with time zone,timestamp with time zone)'),
    ('public.finish_pipeline_run(uuid,text,integer,integer,text)'),
    ('public.upsert_pipeline_items(uuid,date,jsonb)'),
    ('public.store_pipeline_digest_bundle(uuid,date,uuid[],text[],text[],text[],integer[],integer[],text)'),
    ('public.enqueue_pipeline_delivery(uuid,date,text,text,text,jsonb)')
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
    ('public.start_pipeline_run(date,uuid)'::regprocedure),
    ('public.heartbeat_pipeline_run(date,uuid)'::regprocedure),
    ('public.record_source_run(uuid,text,text,integer,text,timestamp with time zone,timestamp with time zone)'::regprocedure),
    ('public.finish_pipeline_run(uuid,text,integer,integer,text)'::regprocedure),
    ('public.upsert_pipeline_items(uuid,date,jsonb)'::regprocedure),
    ('public.store_pipeline_digest_bundle(uuid,date,uuid[],text[],text[],text[],integer[],integer[],text)'::regprocedure),
    ('public.enqueue_pipeline_delivery(uuid,date,text,text,text,jsonb)'::regprocedure)
)
select ok(
  (select prosecdef from pg_catalog.pg_proc where oid = rpc.signature)
    and (select pg_get_userbyid(proowner) from pg_catalog.pg_proc where oid = rpc.signature) = 'postgres'
    and (select proconfig from pg_catalog.pg_proc where oid = rpc.signature)
      = array['search_path=""']::text[],
  format('%s is a postgres-owned empty-search-path definer RPC', rpc.signature)
)
from rpc;

select ok(
  exists (
    select 1
    from pg_catalog.pg_index as index
    where index.indrelid = 'public.pipeline_runs'::regclass
      and index.indisunique
      and pg_catalog.pg_get_expr(index.indpred, index.indrelid) = '(status = ''running''::text)'
  )
  and exists (
    select 1
    from pg_catalog.pg_index as index
    where index.indrelid = 'public.pipeline_runs'::regclass
      and index.indisunique
      and pg_catalog.pg_get_expr(index.indpred, index.indrelid) = '(status = ''succeeded''::text)'
  ),
  'partial uniqueness allows audit history but only one live and one successful attempt per date'
);

insert into public.items(id, source, external_id, url, title)
values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'pipeline-test',
  'fenced-item',
  'https://example.com/pipeline-fenced-item',
  'Pipeline fencing fixture'
);

set local role service_role;

select results_eq(
  $$ select acquired, active_run_id, run_status
     from public.start_pipeline_run('2099-01-03', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$,
  $$ values (true, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'running'::text) $$,
  'first worker acquires the date lease'
);
select results_eq(
  $$ select acquired, active_run_id, run_status
     from public.start_pipeline_run('2099-01-03', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') $$,
  $$ values (false, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'running'::text) $$,
  'a fresh active lease rejects a duplicate worker'
);
select throws_ok(
  $$ select public.start_pipeline_run(null, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') $$,
  '22023', 'invalid pipeline run identity',
  'a null run date is rejected'
);
select throws_ok(
  $$ select public.record_source_run(
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'arxiv', 'bad', 0,
       null, now(), now()
     ) $$,
  '22023', 'invalid source run',
  'an invalid source status is rejected'
);
select throws_ok(
  $$ select public.finish_pipeline_run(
       'ffffffff-ffff-4fff-8fff-ffffffffffff', 'failed', 0, 0, null
     ) $$,
  'P0001', 'pipeline run is not active',
  'an unknown run cannot be completed'
);
select lives_ok(
  $$ select public.record_source_run(
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'arxiv', 'succeeded', 1,
       null, now(), now()
     ) $$,
  'the first worker records source audit before takeover'
);
select lives_ok(
  $$ select public.record_source_run(
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'arxiv', 'empty', 0,
       'no fresh items', now(), now()
     ) $$,
  'an active worker can update source audit idempotently'
);
select results_eq(
  $$ select status, item_count, error_message
     from public.source_runs
     where run_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and source = 'arxiv' $$,
  $$ values ('empty'::text, 0, 'no fresh items'::text) $$,
  'source audit update replaces the stale observation'
);

set local role postgres;
update public.pipeline_runs
set heartbeat_at = '2099-01-03T00:00:00Z'
where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
set local role service_role;
select lives_ok(
  $$ select public.heartbeat_pipeline_run(
       '2099-01-03', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     ) $$,
  'an active worker can refresh its heartbeat'
);
select is(
  (select count(*)
   from public.source_runs
   where run_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and source = 'arxiv'),
  1::bigint,
  'heartbeat refresh leaves source audit intact'
);

set local role postgres;
update public.pipeline_runs
set heartbeat_at = pg_catalog.clock_timestamp() - interval '7 hours'
where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
set local role service_role;
select results_eq(
  $$ select acquired, active_run_id, run_status
     from public.start_pipeline_run('2099-01-03', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') $$,
  $$ values (true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'running'::text) $$,
  'a replacement UUID acquires a stale date lease'
);

set local role postgres;
select results_eq(
  $$ select id, status
     from public.pipeline_runs
     where run_date = '2099-01-03'
     order by started_at, id $$,
  $$ values
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'failed'::text),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'running'::text) $$,
  'stale takeover preserves the failed attempt and starts a distinct live attempt'
);
select results_eq(
  $$ select error_message, finished_at is not null
     from public.pipeline_runs
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
  $$ values ('lease_replaced_after_timeout'::text, true) $$,
  'the replaced attempt retains an explicit terminal audit reason'
);
select results_eq(
  $$ select source, status, item_count
     from public.source_runs
     where run_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
  $$ values ('arxiv'::text, 'empty'::text, 0) $$,
  'stale takeover preserves the replaced worker source audit'
);

set local role service_role;
select throws_ok(
  $$ select public.heartbeat_pipeline_run(
       '2099-01-03', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     ) $$,
  'P0001', 'pipeline run is not active',
  'the fenced worker cannot refresh its heartbeat'
);
select throws_ok(
  $$ select public.record_source_run(
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'github', 'succeeded', 1,
       null, now(), now()
     ) $$,
  'P0001', 'pipeline run is not active',
  'the fenced worker cannot append source health'
);
select throws_ok(
  $$ select public.finish_pipeline_run(
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'succeeded', 1, 1, null
     ) $$,
  'P0001', 'pipeline run is not active',
  'the fenced worker cannot finish the replacement run'
);
select throws_ok(
  $test$ select * from public.upsert_pipeline_items(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '2099-01-03',
    '[{
      "canonical_key":"pipeline-test:fenced-rpc-item",
      "source":"pipeline-test",
      "external_id":"fenced-rpc-item",
      "url":"https://example.com/pipeline-fenced-rpc-item",
      "title":"Pipeline fenced RPC item",
      "authors":["Test Author"],
      "abstract":"Atomic fencing fixture.",
      "content":null,
      "published_at":"2099-01-03",
      "signals":{"score":1},
      "provenance":[{
        "source":"pipeline-test",
        "externalId":"fenced-rpc-item",
        "url":"https://example.com/pipeline-fenced-rpc-item",
        "signals":{"score":1}
      }],
      "raw_json":null
    }]'::jsonb
  ) $test$,
  'P0001', 'pipeline run is not active',
  'the fenced worker cannot upsert candidate items'
);
set local role postgres;
select is(
  (select count(*)
   from public.items
   where canonical_key = 'pipeline-test:fenced-rpc-item'),
  0::bigint,
  'a rejected fenced upsert leaves no item side effect'
);
set local role service_role;
select throws_ok(
  $$ select * from public.store_pipeline_digest_bundle(
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-03',
       array['cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid],
       array['one line'], array['summary'], array['impact'],
       array[91], array[1], '# fenced digest'
     ) $$,
  'P0001', 'pipeline run is not active',
  'the fenced worker cannot persist a digest'
);
select throws_ok(
  $$ select * from public.enqueue_pipeline_delivery(
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-03',
       'email', 'smtp', 'pipeline-fence:old-worker',
       '{"title":"Digest","markdown":"# fenced digest"}'::jsonb
     ) $$,
  'P0001', 'pipeline run is not active',
  'the fenced worker cannot enqueue delivery'
);

select results_eq(
  $test$ select id is not null, canonical_key, source, external_id
  from public.upsert_pipeline_items(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '2099-01-03',
    '[{
      "canonical_key":"pipeline-test:fenced-rpc-item",
      "source":"pipeline-test",
      "external_id":"fenced-rpc-item",
      "url":"https://example.com/pipeline-fenced-rpc-item",
      "title":"Pipeline fenced RPC item",
      "authors":["Test Author"],
      "abstract":"Atomic fencing fixture.",
      "content":null,
      "published_at":"2099-01-03",
      "signals":{"score":1},
      "provenance":[{
        "source":"pipeline-test",
        "externalId":"fenced-rpc-item",
        "url":"https://example.com/pipeline-fenced-rpc-item",
        "signals":{"score":1}
      }],
      "raw_json":null
    }]'::jsonb
  ) $test$,
  $$ values (
    true,
    'pipeline-test:fenced-rpc-item'::text,
    'pipeline-test'::text,
    'fenced-rpc-item'::text
  ) $$,
  'the replacement worker upserts and receives its candidate row'
);
set local role postgres;
select results_eq(
  $$ select title, authors, abstract, raw_json is null
     from public.items
     where canonical_key = 'pipeline-test:fenced-rpc-item' $$,
  $$ values (
    'Pipeline fenced RPC item'::text,
    array['Test Author']::text[],
    'Atomic fencing fixture.'::text,
    true
  ) $$,
  'the replacement candidate row is persisted exactly once'
);
set local role service_role;
select results_eq(
  $$ select outcome, persisted_digest_date, persisted_summary_count
     from public.store_pipeline_digest_bundle(
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2099-01-03',
       array['cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid],
       array['one line'], array['summary'], array['impact'],
       array[91], array[1], '# fenced digest'
     ) $$,
  $$ values ('inserted'::text, '2099-01-03'::date, 1) $$,
  'the replacement worker can atomically store its digest'
);
select results_eq(
  $$ select digest.digest_date, summary.score, summary.rank
     from public.digests as digest
     join public.summaries as summary
       on summary.item_id = digest.top5_item_ids[1]
     where digest.digest_date = '2099-01-03' $$,
  $$ values ('2099-01-03'::date, 91, 1) $$,
  'the replacement digest and summary are durably paired'
);
select results_eq(
  $$ select delivery_status, inserted
     from public.enqueue_pipeline_delivery(
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2099-01-03',
       'email', 'smtp', 'pipeline-fence:new-worker',
       '{"title":"Digest","markdown":"# fenced digest"}'::jsonb
     ) $$,
  $$ values ('pending'::text, true) $$,
  'the replacement worker can enqueue delivery'
);
set local role postgres;
select results_eq(
  $$ select channel, provider_id, status
     from public.delivery_outbox
     where idempotency_key = 'pipeline-fence:new-worker' $$,
  $$ values ('email'::text, 'smtp'::text, 'pending'::text) $$,
  'the replacement delivery is the only fenced outbox side effect'
);
set local role service_role;
select results_eq(
  $$ select run_id, run_status
     from public.finish_pipeline_run(
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'succeeded', 1, 1, null
     ) $$,
  $$ values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'succeeded'::text) $$,
  'the replacement worker can finish its own run'
);
select results_eq(
  $$ select status, candidate_count, source_count, finished_at is not null
     from public.pipeline_runs
     where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' $$,
  $$ values ('succeeded'::text, 1, 1, true) $$,
  'completion counters and terminal timestamp are audited'
);
select throws_ok(
  $$ select public.finish_pipeline_run(
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'succeeded', 1, 1, null
     ) $$,
  'P0001', 'pipeline run is not active',
  'a completed run cannot be finished twice'
);
select throws_ok(
  $$ select public.heartbeat_pipeline_run(
       '2099-01-03', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
     ) $$,
  'P0001', 'pipeline run is not active',
  'a completed worker cannot extend its lease'
);
select results_eq(
  $$ select acquired, active_run_id, run_status
     from public.start_pipeline_run('2099-01-03', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') $$,
  $$ values (false, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'succeeded'::text) $$,
  'a completed date rejects every later duplicate run'
);
select is(
  (select count(*) from public.pipeline_runs where run_date = '2099-01-03'),
  2::bigint,
  'the ledger retains both attempts after successful replacement'
);

select * from finish();
rollback;
