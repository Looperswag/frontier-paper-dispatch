begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(77);

select has_table(
  'public', 'api_rate_limit_buckets',
  'distributed API rate-limit buckets exist'
);
select has_table(
  'public', 'llm_budget_days',
  'daily LLM budget counters exist'
);
select has_table(
  'public', 'llm_budget_reservations',
  'LLM budget reservations exist'
);

select has_function(
  'public', 'consume_api_rate_limits', array['text', 'uuid', 'text'],
  'rate-limit RPC has the exact signature'
);
select has_function(
  'public', 'reserve_llm_budget', array['text', 'text', 'uuid', 'integer'],
  'LLM reservation RPC has the exact signature'
);
select has_function(
  'public', 'settle_llm_budget', array['uuid', 'text', 'integer'],
  'LLM settlement RPC has the exact signature'
);
select has_function(
  'public', 'quota_shanghai_date', array['timestamp with time zone'],
  'the daily budget calendar helper has the exact signature'
);
select ok(
  not has_function_privilege(
    'anon', 'public.quota_shanghai_date(timestamp with time zone)', 'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated', 'public.quota_shanghai_date(timestamp with time zone)', 'EXECUTE'
    )
    and not has_function_privilege(
      'service_role', 'public.quota_shanghai_date(timestamp with time zone)', 'EXECUTE'
    ),
  'the internal calendar helper is not exposed to API roles'
);
select results_eq(
  $$ values
       (public.quota_shanghai_date('2026-07-13 15:59:59.999999+00'::timestamptz)),
       (public.quota_shanghai_date('2026-07-13 16:00:00+00'::timestamptz)) $$,
  $$ values ('2026-07-13'::date), ('2026-07-14'::date) $$,
  'the hard budget changes date exactly at Shanghai midnight'
);

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class
   where oid = 'public.api_rate_limit_buckets'::regclass),
  'rate-limit buckets enable and force RLS'
);
select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class
   where oid = 'public.llm_budget_days'::regclass),
  'daily LLM counters enable and force RLS'
);
select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class
   where oid = 'public.llm_budget_reservations'::regclass),
  'LLM reservations enable and force RLS'
);

with protected_relation(name) as (
  values
    ('api_rate_limit_buckets'),
    ('llm_budget_days'),
    ('llm_budget_reservations')
), api_role(name) as (
  values ('anon'), ('authenticated'), ('service_role')
)
select ok(
  not exists (
    select 1
    from protected_relation
    cross join api_role
    cross join unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ]) as privilege
    where has_table_privilege(
      api_role.name,
      format('public.%I', protected_relation.name),
      privilege
    )
  ),
  'API roles have no direct quota-ledger privileges'
);

with rpc(signature) as (
  values
    ('public.consume_api_rate_limits(text,uuid,text)'),
    ('public.reserve_llm_budget(text,text,uuid,integer)'),
    ('public.settle_llm_budget(uuid,text,integer)')
)
select ok(
  not has_function_privilege('anon', rpc.signature, 'EXECUTE')
    and not has_function_privilege('authenticated', rpc.signature, 'EXECUTE')
    and has_function_privilege('service_role', rpc.signature, 'EXECUTE'),
  format('%s is executable only by service_role', rpc.signature)
)
from rpc;

with rpc(signature) as (
  values
    ('public.consume_api_rate_limits(text,uuid,text)'::regprocedure),
    ('public.reserve_llm_budget(text,text,uuid,integer)'::regprocedure),
    ('public.settle_llm_budget(uuid,text,integer)'::regprocedure)
)
select ok(
  (select prosecdef from pg_catalog.pg_proc where oid = rpc.signature),
  format('%s is security definer', rpc.signature)
)
from rpc;

with rpc(signature) as (
  values
    ('public.consume_api_rate_limits(text,uuid,text)'::regprocedure),
    ('public.reserve_llm_budget(text,text,uuid,integer)'::regprocedure),
    ('public.settle_llm_budget(uuid,text,integer)'::regprocedure)
)
select is(
  (select pg_get_userbyid(proowner) from pg_catalog.pg_proc where oid = rpc.signature),
  'postgres',
  format('%s is owned by postgres', rpc.signature)
)
from rpc;

with rpc(signature) as (
  values
    ('public.consume_api_rate_limits(text,uuid,text)'::regprocedure),
    ('public.reserve_llm_budget(text,text,uuid,integer)'::regprocedure),
    ('public.settle_llm_budget(uuid,text,integer)'::regprocedure)
)
select is(
  (select proconfig from pg_catalog.pg_proc where oid = rpc.signature),
  array['search_path=""']::text[],
  format('%s fixes an empty search path', rpc.signature)
)
from rpc;

set local role service_role;

select results_eq(
  $$ select outcome, retry_after_seconds is null
     from generate_series(1, 5) as attempt
     cross join lateral public.consume_api_rate_limits(
       'auth_login',
       null,
       'v1:' || repeat('1', 63) || ((attempt * 0) + 1)::text
     ) $$,
  $$ values
       ('allowed'::text, true),
       ('allowed'::text, true),
       ('allowed'::text, true),
       ('allowed'::text, true),
       ('allowed'::text, true) $$,
  'the exact configured login burst is allowed'
);

select results_eq(
  $$ select outcome, retry_after_seconds between 1 and 900
     from public.consume_api_rate_limits(
       'auth_login', null, 'v1:' || repeat('1', 64)
     ) $$,
  $$ values ('rate_limited'::text, true) $$,
  'the next login attempt is denied with a bounded Retry-After'
);

select results_eq(
  $$ select outcome
     from generate_series(1, 5) as attempt
     cross join lateral public.consume_api_rate_limits(
       'web_chat',
       '10000000-0000-4000-8000-000000000001'::uuid,
       'v1:' || repeat(attempt::text, 64)
     ) $$,
  $$ values
       ('allowed'::text),
       ('allowed'::text),
       ('allowed'::text),
       ('allowed'::text),
       ('allowed'::text) $$,
  'one owner can consume exactly five chat requests across different IPs'
);

select results_eq(
  $$ select outcome, retry_after_seconds between 1 and 60
     from public.consume_api_rate_limits(
       'web_chat',
       '10000000-0000-4000-8000-000000000001'::uuid,
       'v1:' || repeat('6', 64)
     ) $$,
  $$ values ('rate_limited'::text, true) $$,
  'the owner dimension denies a sixth chat even from a fresh IP'
);

select results_eq(
  $$ select outcome
     from generate_series(1, 10) as attempt
     cross join lateral public.consume_api_rate_limits(
       'web_chat',
       ('20000000-0000-4000-8000-' || lpad(attempt::text, 12, '0'))::uuid,
       'v1:' || repeat('6', 64)
     ) $$,
  $$ values
       ('allowed'::text), ('allowed'::text), ('allowed'::text),
       ('allowed'::text), ('allowed'::text), ('allowed'::text),
       ('allowed'::text), ('allowed'::text), ('allowed'::text),
       ('allowed'::text) $$,
  'a user-denied request did not partially consume its fresh IP bucket'
);

select results_eq(
  $$ select outcome, retry_after_seconds between 1 and 60
     from public.consume_api_rate_limits(
       'web_chat',
       '30000000-0000-4000-8000-000000000001'::uuid,
       'v1:' || repeat('6', 64)
     ) $$,
  $$ values ('rate_limited'::text, true) $$,
  'the shared IP dimension denies an eleventh owner'
);

select results_eq(
  $$ select
       count(*) filter (where outcome = 'allowed'),
       count(*) filter (where outcome <> 'allowed')
     from generate_series(1, 60) as attempt
     cross join lateral public.consume_api_rate_limits(
       'owner_write',
       '31000000-0000-4000-8000-000000000001'::uuid,
       'v1:' || lpad(to_hex(2000 + attempt), 64, '0')
     ) $$,
  $$ values (60::bigint, 0::bigint) $$,
  'one owner can consume the exact owner-write user burst'
);

select results_eq(
  $$ select outcome, retry_after_seconds between 1 and 60
     from public.consume_api_rate_limits(
       'owner_write',
       '31000000-0000-4000-8000-000000000001'::uuid,
       'v1:' || repeat('8', 64)
     ) $$,
  $$ values ('rate_limited'::text, true) $$,
  'the owner-write user dimension denies request sixty-one'
);

reset role;
select is(
  (
    select tokens
    from public.api_rate_limit_buckets
    where policy = 'owner_write'
      and dimension = 'ip'
      and subject = 'v1:' || repeat('8', 64)
  ),
  120::numeric,
  'a user-denied owner write does not partially consume its fresh IP bucket'
);
set local role service_role;

select throws_ok(
  $$ select * from public.consume_api_rate_limits(
       'unknown_policy', null, 'v1:' || repeat('7', 64)
     ) $$,
  '22023', 'invalid API quota request',
  'an unknown rate policy fails closed'
);
select throws_ok(
  $$ select * from public.consume_api_rate_limits(
       'web_chat', null, 'v1:' || repeat('7', 64)
     ) $$,
  '22023', 'invalid API quota request',
  'an owner policy requires a verified owner UUID'
);
select throws_ok(
  $$ select * from public.consume_api_rate_limits(
       'web_chat', '30000000-0000-4000-8000-000000000002', null
     ) $$,
  '22023', 'invalid API quota request',
  'a missing IP subject fails closed'
);
select throws_ok(
  $$ select * from public.consume_api_rate_limits(
       'web_chat', '30000000-0000-4000-8000-000000000002',
       'v1:' || repeat('A', 64)
     ) $$,
  '22023', 'invalid API quota request',
  'a non-canonical IP fingerprint fails closed'
);
select throws_ok(
  $$ select * from public.consume_api_rate_limits(
       'web_chat', '30000000-0000-4000-8000-000000000002',
       'v1:' || repeat('7', 64) || ',v1:' || repeat('8', 64)
     ) $$,
  '22023', 'invalid API quota request',
  'a fingerprint list fails closed'
);

select results_eq(
  $$ select outcome, reserved_tokens, retry_after_seconds is null
     from public.reserve_llm_budget(
       'web_chat',
       '40000000-0000-4000-8000-000000000001',
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       50000
     ) $$,
  $$ values ('reserved'::text, 50000, true) $$,
  'LLM tokens are reserved before provider dispatch'
);

select results_eq(
  $$ with first as (
       select reservation_id
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         50000
       )
     )
     select repeated.outcome,
            repeated.reserved_tokens,
            repeated.reservation_id = first.reservation_id
     from first
     cross join lateral public.reserve_llm_budget(
       'web_chat',
       '40000000-0000-4000-8000-000000000001',
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       50000
     ) as repeated $$,
  $$ values ('existing'::text, 50000, true) $$,
  'a repeated request id returns the exact same reservation idempotently'
);

select throws_ok(
  $$ select * from public.reserve_llm_budget(
       'web_chat',
       '40000000-0000-4000-8000-000000000002',
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       50000
     ) $$,
  '22023', 'invalid LLM budget reservation',
  'a request id cannot be rebound to another subject'
);
select throws_ok(
  $$ select * from public.reserve_llm_budget(
       'root_rank',
       'system:ingest',
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       50000
     ) $$,
  '22023', 'invalid LLM budget reservation',
  'a request id cannot be rebound to another policy'
);
select throws_ok(
  $$ select * from public.reserve_llm_budget(
       'web_chat',
       '40000000-0000-4000-8000-000000000001',
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       49999
     ) $$,
  '22023', 'invalid LLM budget reservation',
  'a request id cannot be rebound to another token amount'
);

select results_eq(
  $$ with reservation as (
       select reservation_id
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         50000
       )
     )
     select outcome, charged_tokens
     from reservation
     cross join lateral public.settle_llm_budget(
       reservation.reservation_id,
       '40000000-0000-4000-8000-000000000001',
       1200
     ) $$,
  $$ values ('settled'::text, 1200) $$,
  'actual provider usage releases the unused reservation'
);

select results_eq(
  $$ with reservation as (
       select reservation_id
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         50000
       )
     )
     select outcome, charged_tokens
     from reservation
     cross join lateral public.settle_llm_budget(
       reservation.reservation_id,
       '40000000-0000-4000-8000-000000000001',
       1200
     ) $$,
  $$ values ('existing'::text, 1200) $$,
  'settlement is idempotent for the same usage'
);

select throws_ok(
  $$ with reservation as (
       select reservation_id
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         50000
       )
     )
     select * from reservation
     cross join lateral public.settle_llm_budget(
       reservation.reservation_id,
       '40000000-0000-4000-8000-000000000001',
       1201
     ) $$,
  '22023', 'invalid LLM budget settlement',
  'a conflicting settlement fails closed'
);
select throws_ok(
  $$ with reservation as (
       select reservation_id
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         50000
       )
     )
     select * from reservation
     cross join lateral public.settle_llm_budget(
       reservation.reservation_id,
       '40000000-0000-4000-8000-000000000002',
       1200
     ) $$,
  '22023', 'invalid LLM budget settlement',
  'a different subject cannot settle a reservation'
);

select throws_ok(
  $$ with reservation as (
       select reservation_id
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         50000
       )
     )
     select * from reservation
     cross join lateral public.settle_llm_budget(
       reservation.reservation_id,
       '40000000-0000-4000-8000-000000000001', 0
     ) $$,
  '22023', 'invalid LLM budget settlement',
  'zero actual usage is rejected'
);
select throws_ok(
  $$ with reservation as (
       select reservation_id
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         50000
       )
     )
     select * from reservation
     cross join lateral public.settle_llm_budget(
       reservation.reservation_id,
       '40000000-0000-4000-8000-000000000001', -1
     ) $$,
  '22023', 'invalid LLM budget settlement',
  'negative actual usage is rejected'
);
select throws_ok(
  $$ with reservation as (
       select reservation_id
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         50000
       )
     )
     select * from reservation
     cross join lateral public.settle_llm_budget(
       reservation.reservation_id,
       '40000000-0000-4000-8000-000000000001', 50001
     ) $$,
  '22023', 'invalid LLM budget settlement',
  'usage above the reservation is rejected'
);

select results_eq(
  $$ with reservation as (
       select reservation_id
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
         50000
       )
     )
     select outcome, charged_tokens
     from reservation
     cross join lateral public.settle_llm_budget(
       reservation.reservation_id,
       '40000000-0000-4000-8000-000000000001',
       null
     ) $$,
  $$ values ('settled'::text, 50000) $$,
  'unknown usage is conservatively charged at the reserved maximum'
);

select results_eq(
  $$ select outcome
     from (values
       ('c0000000-0000-4000-8000-000000000001'::uuid),
       ('c0000000-0000-4000-8000-000000000002'::uuid)
     ) as request(request_id)
     cross join lateral public.reserve_llm_budget(
       'web_chat',
       '40000000-0000-4000-8000-000000000001',
       request.request_id,
       65000
     ) $$,
  $$ values ('reserved'::text), ('reserved'::text) $$,
  'unsettled reservations continue to occupy the daily subject budget'
);

select results_eq(
  $$ with decision as materialized (
       select *
       from public.reserve_llm_budget(
         'web_chat',
         '40000000-0000-4000-8000-000000000001',
         'c0000000-0000-4000-8000-000000000003',
         20000
       )
     )
     select
       outcome,
       retry_after_seconds between 1 and 86400,
       abs(
         retry_after_seconds - greatest(
           1,
           ceil(extract(epoch from (
             ((budget_date + 1)::timestamp at time zone 'Asia/Shanghai')
               - clock_timestamp()
           )))::integer
         )
       ) <= 2
     from decision $$,
  $$ values ('budget_exhausted'::text, true, true) $$,
  'subject-budget Retry-After stably targets its own next Shanghai midnight'
);

select results_eq(
  $$ select outcome
     from (values
       ('d0000000-0000-4000-8000-000000000001'::uuid, 'root_rank'::text),
       ('d0000000-0000-4000-8000-000000000002'::uuid, 'root_rank'::text),
       ('d0000000-0000-4000-8000-000000000003'::uuid, 'root_rank'::text),
       ('d0000000-0000-4000-8000-000000000004'::uuid, 'root_rank'::text),
       ('d0000000-0000-4000-8000-000000000005'::uuid, 'root_summary'::text)
     ) as request(request_id, policy)
     cross join lateral public.reserve_llm_budget(
       request.policy, 'system:ingest', request.request_id, 60000
     ) $$,
  $$ values
       ('reserved'::text), ('reserved'::text), ('reserved'::text),
       ('reserved'::text), ('reserved'::text) $$,
  'Root rank and summary share one system-subject budget'
);

select results_eq(
  $$ select outcome, retry_after_seconds between 1 and 86400
     from public.reserve_llm_budget(
       'root_refine',
       'system:refine',
       'e0000000-0000-4000-8000-000000000001',
       20000
     ) $$,
  $$ values ('budget_exhausted'::text, true) $$,
  'Root and Web reservations atomically share the project-global daily budget'
);

select throws_ok(
  $$ select * from public.reserve_llm_budget(
       'web_chat',
       'system:ingest',
       'f0000000-0000-4000-8000-000000000001',
       1
     ) $$,
  '22023', 'invalid LLM budget reservation',
  'a Web policy cannot use a system subject'
);
select throws_ok(
  $$ select * from public.reserve_llm_budget(
       'root_rank',
       '40000000-0000-4000-8000-000000000001',
       'f0000000-0000-4000-8000-000000000002',
       1
     ) $$,
  '22023', 'invalid LLM budget reservation',
  'a Root policy cannot use an owner subject'
);
select throws_ok(
  $$ select * from public.reserve_llm_budget(
       'unknown_policy', 'system:ingest',
       'f0000000-0000-4000-8000-000000000003', 1
     ) $$,
  '22023', 'invalid LLM budget reservation',
  'an unknown LLM policy fails closed'
);
select throws_ok(
  $$ select * from public.reserve_llm_budget(
       'root_rank', 'system:ingest',
       'f0000000-0000-4000-8000-000000000004', 0
     ) $$,
  '22023', 'invalid LLM budget reservation',
  'a zero-token reservation fails closed'
);
select throws_ok(
  $$ select * from public.reserve_llm_budget(
       'root_rank', 'system:ingest',
       'f0000000-0000-4000-8000-000000000005', 65537
     ) $$,
  '22023', 'invalid LLM budget reservation',
  'a reservation above one-dispatch maximum fails closed'
);

reset role;
delete from public.llm_budget_reservations
where subject = '40000000-0000-4000-8000-000000000001'
  and budget_date = public.quota_shanghai_date(clock_timestamp());
delete from public.llm_budget_days
where dimension = 'subject'
  and subject = '40000000-0000-4000-8000-000000000001'
  and budget_date = public.quota_shanghai_date(clock_timestamp());
update public.llm_budget_days
set reserved_tokens = 300000,
    consumed_tokens = 0,
    updated_at = greatest(updated_at, clock_timestamp())
where dimension = 'global'
  and subject = 'global'
  and budget_date = public.quota_shanghai_date(clock_timestamp());

set local role service_role;
select results_eq(
  $$ select outcome
     from (values
       ('e1000000-0000-4000-8000-000000000001'::uuid, 65536),
       ('e1000000-0000-4000-8000-000000000002'::uuid, 34464)
     ) as request(request_id, tokens)
     cross join lateral public.reserve_llm_budget(
       'root_refine', 'system:refine', request.request_id, request.tokens
     ) $$,
  $$ values ('reserved'::text), ('reserved'::text) $$,
  'Root refine can reserve exactly its isolated 100k subject allowance'
);
select results_eq(
  $$ select outcome, retry_after_seconds between 1 and 86400
     from public.reserve_llm_budget(
       'root_refine', 'system:refine',
       'e1000000-0000-4000-8000-000000000003', 1
     ) $$,
  $$ values ('budget_exhausted'::text, true) $$,
  'Root refine rejects one token above its subject allowance'
);
reset role;
select results_eq(
  $$ select dimension, subject, reserved_tokens
     from public.llm_budget_days
     where budget_date = public.quota_shanghai_date(clock_timestamp())
       and (
         (dimension = 'global' and subject = 'global')
         or (dimension = 'subject' and subject = 'system:refine')
       )
     order by dimension, subject $$,
  $$ values
       ('global'::text, 'global'::text, 400000::bigint),
       ('subject'::text, 'system:refine'::text, 100000::bigint) $$,
  'the refine denial occurs with 100k of project-global headroom remaining'
);

delete from public.llm_budget_reservations
where subject = 'system:refine'
  and budget_date = public.quota_shanghai_date(clock_timestamp());
delete from public.llm_budget_days
where dimension = 'subject'
  and subject = 'system:refine'
  and budget_date = public.quota_shanghai_date(clock_timestamp());
update public.llm_budget_days
set reserved_tokens = 300000,
    consumed_tokens = 0,
    updated_at = greatest(updated_at, clock_timestamp())
where dimension = 'global'
  and subject = 'global'
  and budget_date = public.quota_shanghai_date(clock_timestamp());

set local role service_role;
select results_eq(
  $$ select outcome
     from (values
       ('d1000000-0000-4000-8000-000000000001'::uuid, 65536),
       ('d1000000-0000-4000-8000-000000000002'::uuid, 34464)
     ) as request(request_id, tokens)
     cross join lateral public.reserve_llm_budget(
       'root_summary', 'system:ingest', request.request_id, request.tokens
     ) $$,
  $$ values ('reserved'::text), ('reserved'::text) $$,
  'Root ingest can reserve exactly its isolated 400k subject allowance'
);
select results_eq(
  $$ select outcome, retry_after_seconds between 1 and 86400
     from public.reserve_llm_budget(
       'root_rank', 'system:ingest',
       'd1000000-0000-4000-8000-000000000003', 1
     ) $$,
  $$ values ('budget_exhausted'::text, true) $$,
  'Root ingest rejects one token above its shared rank-summary allowance'
);
reset role;
select results_eq(
  $$ select dimension, subject, reserved_tokens
     from public.llm_budget_days
     where budget_date = public.quota_shanghai_date(clock_timestamp())
       and (
         (dimension = 'global' and subject = 'global')
         or (dimension = 'subject' and subject = 'system:ingest')
       )
     order by dimension, subject $$,
  $$ values
       ('global'::text, 'global'::text, 400000::bigint),
       ('subject'::text, 'system:ingest'::text, 400000::bigint) $$,
  'the ingest denial occurs with 100k of project-global headroom remaining'
);

insert into public.api_rate_limit_buckets (
  policy,
  dimension,
  subject,
  tokens,
  last_refilled_at,
  expires_at
) values
  (
    'auth_login',
    'ip',
    'v1:' || repeat('f', 64),
    0,
    '2099-01-01T00:00:00Z',
    '2100-01-01T00:00:00Z'
  ),
  (
    'auth_login',
    'ip',
    'v1:' || repeat('c', 64),
    5,
    clock_timestamp(),
    clock_timestamp() + interval '10 seconds'
  );
set local role service_role;
select results_eq(
  $$ select outcome
     from public.consume_api_rate_limits(
       'auth_login', null, 'v1:' || repeat('f', 64)
     ) $$,
  $$ values ('rate_limited'::text) $$,
  'a future bucket clock fails closed instead of minting tokens'
);
reset role;
select ok(
  (
    select last_refilled_at >= '2099-01-01T00:00:00Z'::timestamptz
    from public.api_rate_limit_buckets
    where policy = 'auth_login'
      and dimension = 'ip'
      and subject = 'v1:' || repeat('f', 64)
  ),
  'lock wait or clock skew never moves a bucket clock backwards'
);
select ok(
  exists (
    select 1
    from public.api_rate_limit_buckets
    where policy = 'auth_login'
      and dimension = 'ip'
      and subject = 'v1:' || repeat('c', 64)
      and expires_at > clock_timestamp()
  ),
  'a future target clock cannot make cleanup delete another physically active bucket'
);

insert into public.api_rate_limit_buckets (
  policy, dimension, subject, tokens, last_refilled_at, expires_at
)
select
  'auth_login',
  'ip',
  'v1:' || lpad(to_hex(identifier), 64, '0'),
  0,
  clock_timestamp() - interval '2 hours',
  clock_timestamp() - interval '1 hour'
from generate_series(1000, 1039) as identifier;
set local role service_role;
do $$
begin
  perform *
  from public.consume_api_rate_limits(
    'auth_login', null, 'v1:' || repeat('e', 64)
  );
end;
$$;
reset role;
select is(
  (
    select count(*)
    from public.api_rate_limit_buckets
    where policy = 'auth_login'
      and dimension = 'ip'
      and subject in (
        select 'v1:' || lpad(to_hex(identifier), 64, '0')
        from generate_series(1000, 1039) as identifier
      )
      and expires_at < clock_timestamp()
  ),
  8::bigint,
  'one request prunes at most one bounded batch of expired high-cardinality IP buckets'
);

insert into public.llm_budget_days (
  budget_date,
  dimension,
  subject,
  token_limit,
  reserved_tokens,
  consumed_tokens,
  created_at,
  updated_at
) values
  (
    '2000-01-01', 'global', 'global', 500000, 50000, 0,
    '2000-01-01T00:00:00+08', '2000-01-01T00:00:00+08'
  ),
  (
    '2000-01-01', 'subject',
    '60000000-0000-4000-8000-000000000001',
    200000, 50000, 0,
    '2000-01-01T00:00:00+08', '2000-01-01T00:00:00+08'
  );
insert into public.llm_budget_reservations (
  id,
  request_id,
  policy,
  subject,
  budget_date,
  reserved_tokens,
  created_at
) values (
  '61111111-1111-4111-8111-111111111111',
  '62222222-2222-4222-8222-222222222222',
  'web_chat',
  '60000000-0000-4000-8000-000000000001',
  '2000-01-01',
  50000,
  '2000-01-01T00:00:00+08'
);
set local role service_role;
select results_eq(
  $$ select outcome, reservation_id, budget_date
     from public.reserve_llm_budget(
       'web_chat',
       '60000000-0000-4000-8000-000000000001',
       '62222222-2222-4222-8222-222222222222',
       50000
     ) $$,
  $$ values (
       'existing'::text,
       '61111111-1111-4111-8111-111111111111'::uuid,
       '2000-01-01'::date
     ) $$,
  'request-id idempotency survives a Shanghai date change'
);
select results_eq(
  $$ select outcome, charged_tokens, budget_date
     from public.settle_llm_budget(
       '61111111-1111-4111-8111-111111111111',
       '60000000-0000-4000-8000-000000000001',
       1200
     ) $$,
  $$ values ('settled'::text, 1200, '2000-01-01'::date) $$,
  'a delayed settlement updates the original budget day exactly once'
);
reset role;
select results_eq(
  $$ select dimension, reserved_tokens, consumed_tokens
     from public.llm_budget_days
     where budget_date = '2000-01-01'
     order by dimension $$,
  $$ values
       ('global'::text, 0::bigint, 1200::bigint),
       ('subject'::text, 0::bigint, 1200::bigint) $$,
  'a delayed settlement cannot debit the current day'
);

select is(
  (
    select count(*)
    from public.llm_budget_reservations
    where request_id = 'd1000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'a surviving Root reservation persists exactly one sealed row'
);
select ok(
  not exists (
    select 1
    from public.llm_budget_days
    where budget_date <> public.quota_shanghai_date(created_at)
  ),
  'every daily counter retains its immutable Shanghai creation date'
);
select is(
  (
    select count(*)
    from public.llm_budget_reservations
    where policy in ('root_rank', 'root_summary')
      and subject = 'system:ingest'
  ),
  7::bigint,
  'cross-policy Root reservations remain distinct and auditable'
);

select * from finish();
rollback;
