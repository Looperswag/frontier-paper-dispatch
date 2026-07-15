begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

select has_table('public', 'delivery_outbox', 'delivery outbox exists');
select has_function(
  'public', 'enqueue_delivery', array['date', 'text', 'text', 'text', 'jsonb'],
  'enqueue RPC has the exact signature'
);
select has_function(
  'public', 'claim_delivery', array['uuid', 'timestamp with time zone', 'integer', 'integer'],
  'claim RPC has the exact signature'
);
select has_function(
  'public', 'finish_delivery', array['uuid', 'uuid', 'text', 'text', 'text', 'timestamp with time zone'],
  'finish RPC has the exact signature'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.delivery_outbox'::regclass),
  'delivery outbox enables and forces RLS'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.delivery_outbox'::regclass
      and confrelid = 'public.digests'::regclass
      and contype = 'f'
  ),
  'outbox digest date is backed by a foreign key'
);

with rpc(signature) as (
  values
    ('public.enqueue_delivery(date,text,text,text,jsonb)'),
    ('public.claim_delivery(uuid,timestamp with time zone,integer,integer)'),
    ('public.finish_delivery(uuid,uuid,text,text,text,timestamp with time zone)')
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
    ('public.enqueue_delivery(date,text,text,text,jsonb)'::regprocedure),
    ('public.claim_delivery(uuid,timestamp with time zone,integer,integer)'::regprocedure),
    ('public.finish_delivery(uuid,uuid,text,text,text,timestamp with time zone)'::regprocedure)
)
select ok(
  (select prosecdef from pg_catalog.pg_proc where oid = rpc.signature)
    and (select pg_get_userbyid(proowner) from pg_catalog.pg_proc where oid = rpc.signature) = 'postgres'
    and (select proconfig from pg_catalog.pg_proc where oid = rpc.signature) = array['search_path=""']::text[],
  format('%s is a postgres-owned empty-search-path definer RPC', rpc.signature)
)
from rpc;

insert into public.items(id, source, external_id, title)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'outbox-test', 'outbox-item', 'Outbox item')
on conflict (id) do nothing;
insert into public.digests(id, digest_date, top5_item_ids, rendered_md)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '2099-06-01', array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid], '# outbox')
on conflict (digest_date) do update set top5_item_ids = excluded.top5_item_ids, rendered_md = excluded.rendered_md;

set local role service_role;

select results_eq(
  $$ select delivery_status, inserted
     from public.enqueue_delivery(
       '2099-06-01', 'email', 'smtp', 'outbox-test:email',
       '{"title":"Digest","markdown":"# digest"}'::jsonb
     ) $$,
  $$ values ('pending'::text, true) $$,
  'first enqueue creates one pending email job'
);
select results_eq(
  $$ select delivery_status, inserted
     from public.enqueue_delivery(
       '2099-06-01', 'email', 'smtp', 'outbox-test:email',
       '{"title":"Digest","markdown":"# digest"}'::jsonb
     ) $$,
  $$ values ('pending'::text, false) $$,
  'same idempotency key returns the existing job without duplication'
);
select delivery_id
from public.enqueue_delivery(
  '2099-06-01', 'email', 'smtp', 'outbox-test:email',
  '{"title":"Digest","markdown":"# digest"}'::jsonb
);
\gset email_
select throws_ok(
  $test$select public.enqueue_delivery(
    '2099-06-01', 'email', 'smtp', 'outbox-test:email',
    '{"title":"Different","markdown":"# digest"}'::jsonb
  )$test$,
  '23505', 'delivery idempotency key conflict',
  'idempotency key cannot be reused with different payload'
);
select results_eq(
  $$ select channel, provider_id, attempts, lease_until is not null
     from public.claim_delivery('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '2099-06-01T00:00:00Z', 300, 10) $$,
  $$ values ('email'::text, 'smtp'::text, 1, true) $$,
  'claim leases a pending job and increments attempts'
);
select throws_ok(
  format($test$select public.finish_delivery(
    %L::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'success', 'message-id'
  )$test$, :'email_delivery_id'),
  'P0001', 'delivery lease is not owned by worker',
  'a different worker cannot finish a leased job'
);
select results_eq(
  format($$ select delivery_status, attempts
     from public.finish_delivery(
       %L::uuid,
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'retry', null, 'temporary', '2099-06-01T00:05:00Z'
     ) $$, :'email_delivery_id'),
  $$ values ('pending'::text, 1) $$,
  'retry releases the lease and schedules the next attempt'
);
select is(
  (select count(*) from public.claim_delivery('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '2099-06-01T00:04:59Z', 300, 10)),
  0::bigint,
  'a job is not claimed before next_attempt_at'
);
select results_eq(
  $$ select attempts from public.claim_delivery('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '2099-06-01T00:05:00Z', 300, 10) $$,
  $$ values (2) $$,
  'a retry becomes claimable at its scheduled time'
);
select results_eq(
     format($$ select delivery_status from public.finish_delivery(
       %L::uuid,
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'success', '<message@example.com>'
     ) $$, :'email_delivery_id'),
  $$ values ('succeeded'::text) $$,
  'success records provider message id and terminal state'
);

select results_eq(
  $$ select delivery_status, inserted
     from public.enqueue_delivery(
       '2099-06-01', 'wechat', 'serverchan', 'outbox-test:wechat',
       '{"title":"Digest","markdown":"# digest"}'::jsonb
     ) $$,
  $$ values ('pending'::text, true) $$,
  'wechat uses the matching provider contract'
);
select delivery_id
from public.enqueue_delivery(
  '2099-06-01', 'wechat', 'serverchan', 'outbox-test:wechat',
  '{"title":"Digest","markdown":"# digest"}'::jsonb
);
\gset wechat_
select results_eq(
  $$ select attempts from public.claim_delivery('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', '2099-06-01T00:00:00Z', 300, 10) $$,
  $$ values (1) $$,
  'wechat job can be claimed'
);
select results_eq(
     format($$ select delivery_status from public.finish_delivery(
       %L::uuid,
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 'permanent', null, 'bad credentials'
     ) $$, :'wechat_delivery_id'),
  $$ values ('failed'::text) $$,
  'permanent provider failure is terminal and retains a bounded error'
);

select throws_ok(
  $test$select public.enqueue_delivery(
    '2099-06-01', 'email', 'serverchan', 'outbox-test:bad-provider',
    '{"title":"Digest","markdown":"# digest"}'::jsonb
  )$test$,
  '22023', 'invalid delivery payload',
  'channel and provider cannot be mixed'
);
select throws_ok(
  $test$select public.enqueue_delivery(
    '2099-06-01', 'email', 'smtp', 'outbox-test:bad-payload',
    '{"title":"","markdown":"# digest"}'::jsonb
  )$test$,
  '22023', 'invalid delivery payload',
  'empty title is rejected'
);
select throws_ok(
  $test$select public.claim_delivery('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6', '2099-06-01T00:00:00Z', 5, 10)$test$,
  '22023', 'invalid delivery completion',
  'invalid lease duration is rejected'
);

set local role postgres;
delete from public.delivery_outbox where idempotency_key like 'outbox-test:%';
delete from public.digests where digest_date = '2099-06-01';
delete from public.items where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

select * from finish();
rollback;
